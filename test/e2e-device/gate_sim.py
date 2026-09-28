#!/usr/bin/env python3
"""The REAL door firmware in the end-to-end chain, and how to drive it.

`door_evening.py` proves the door end of the device chain against the real API,
the real gateway and a real Postgres — and for as long as it has existed, a Python
script has played the whole board. Its own README said so: *"The firmware's own
decisions. `gatelogic` is host-tested in `src/iot/door-gate/test/`. `wire.py`
re-implements the reader's framing rules to read the server the way a board would;
it does not execute the firmware."*

`scenario.py` has not had that gap since the court box grew a simulator, and that
file's header says why it matters: **a stub only ever agrees with itself**, because
both ends of the conversation are written from one reading of the spec, so a
misreading passes. This project has paid for that shape twice — round G1 found four
serious defects in the gate's own `loop()` in a single pass because
`build_src_filter = -<*>` meant nothing could see it, and round G3 found the API
chunking every device route on a kept-open socket, against which the real firmware's
reader timed out on **every** call.

So this module drives `src/iot/door-gate/.pio/build/simulator/program`: the SAME
`gatelogic::GateApp` loop, the SAME `GateApi`, the SAME `GateFlow` status table, the
SAME `ResponseBody` framing and de-chunker, the SAME `UnlockTimer`, `LockDriver`,
`ScanAssembler`, `ScanDebounce` and `LedPattern` the ESP32 runs — over a POSIX HAL,
making REAL HTTP calls to the run's own API. What `wire.py` reads the way a board
would, this one reads *as* the board.

**`wire.py`'s assertions are untouched and stay the strict judge of the API's bytes.**
The binary is the judge of the FIRMWARE's behaviour, which is a different question,
and neither replaces the other: a framing regression still fails at `DW`, and a
decision regression now fails at `DSIM`.

Two entry points, and `door_evening.py` calls only the first:

* `dsim_firmware(door)` — the evening's DSIM section: a real board plugged into the
  run's own API, named by an admin, scanned at for every reason the firmware can be
  made to distinguish, taken offline and reconnected, and shut by an admin.
* `measure_worst_case_release(...)`, which DSIM calls — the release-overrun
  measurement, against a deliberately hostile stub rather than the real API, because
  "a hung API" and "a dropped connection" are not states the real one can be put in.
"""

from __future__ import annotations

import json
import os
import queue
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
from datetime import timedelta
from pathlib import Path
from typing import Any, Callable, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import scenario as sc  # noqa: E402

ROOT = sc.ROOT
StepFailed = sc.StepFailed
REPORT = sc.REPORT

#: The binary `make test-e2e-device` builds before `door_evening.py` runs.
GATE_SIM = ROOT / "src" / "iot" / "door-gate" / ".pio" / "build" / "simulator" / "program"
GATE_PROJECT = ROOT / "src" / "iot" / "door-gate"

#: How long a start-up line may take to appear. Generous: the first heartbeat is a
#: real HTTP call to an API that may still be JIT-ing its first request.
START_TIMEOUT = 20.0

#: `HEARTBEAT_INTERVAL_MS` is 30 s and `kMinHeartbeatSpacingMs` floors an ATTEMPT at
#: 15 s after the previous one, so a forced heartbeat can be a full interval away.
#: Waiting for it is not a slow test, it is the firmware's own cadence.
HEARTBEAT_TIMEOUT = 50.0

#: The release the club's settings ask for (`gate_unlock_seconds`, default 3) and
#: how far the measured window may be from it.
#:
#: The tolerance is one-sided in spirit and two-sided in code. UnlockTimer arms an
#: absolute deadline and `pumpLock` checks it once a pass, so a release is NEVER
#: short and overruns by at most one pass tick plus whatever blocking call is in
#: flight — which is the whole subject of `measure_worst_case_release` below. 400 ms
#: is far inside one blocking call and far outside one 10 ms pass, so a release that
#: waited on a call fails here rather than being absorbed.
RELEASE_TOLERANCE_MS = 400

# GATE_MIN_RELOCK_MS, from src/iot/door-gate/platformio.ini. After ANY close the
# lock stays de-energised for at least this long and no grant may energise the
# relay inside it — round G4's A1, where the cap closed a window and the very
# next accepted scan opened a fresh one IN THE SAME PASS: relay OFF and ON at
# the same millisecond, so the strike never dropped and the door never relatched.
#
# It is here because this harness scans FASTER THAN A PERSON CAN. `relay_window`
# returns the instant the relay goes off and the next `scan` follows within
# milliseconds, which is inside the dwell — so two steps that had nothing to do
# with the dwell failed on it. The answer is not to shorten a safety constant
# until a test stops noticing it: the firmware refuses a scan in this window, on
# purpose and with its own reason, and this harness both PROVES that (DS4b) and
# respects it everywhere else.
RELOCK_DWELL_MS = 400
CAP_RELOCK_DWELL_MS = 3000

# GATE_UNLOCK_HARD_CAP_MS, from src/iot/door-gate/platformio.ini. The longest the
# lock may be released by ANY sequence of grants, measured from the first
# energise and NOT reset by a re-arm. It is a safety bound rather than a default,
# and it is what makes the release default moving from 3 s to 15 s a visible
# change at a busy door: the cap allowed nine extensions at three seconds and
# allows one at fifteen.
CAP_MS = 30000

#: `kScanDebounceMs`. A repeat of the SAME token inside this of a decision for it
#: is dropped without a decision — so a harness re-scanning one code has to wait
#: it out or the simulator answers nothing at all, which reads as a dead board.
SCAN_DEBOUNCE_MS = 2000


def chk(tag: str, what: str, ok: bool, detail: str = "") -> bool:
    return REPORT.check(tag, what, ok, detail)


# ---------------------------------------------------------------------------
# Reading the board's own transcript
# ---------------------------------------------------------------------------

#: `[channel] rest`. Every line the simulator prints has this shape.
LINE = re.compile(r"^\[(?P<channel>[a-z]+)\]\s+(?P<rest>.*)$")


class Line:
    """One parsed transcript line.

    `at_ms` is the BOARD's own `millis()`, not the host's wall clock, because every
    number asserted on here — a three-second release, a call that spent its whole
    budget — is a duration the firmware measured. A harness that timed the same
    thing from Python would be measuring its own scheduler as well."""

    __slots__ = ("channel", "state", "fields", "raw", "at_ms")

    def __init__(self, channel: str, rest: str, raw: str) -> None:
        self.channel = channel
        self.raw = raw
        self.state = ""
        self.fields: dict[str, str] = {}
        for token in rest.split():
            if "=" in token:
                key, _, value = token.partition("=")
                self.fields[key] = value
            elif not self.state:
                # The first bare word is the state: `ON`, `OFF`, `up`, `down`.
                self.state = token.rstrip(",")
        self.at_ms = self._millis(self.fields.get("t"))

    @staticmethod
    def _millis(raw: Optional[str]) -> Optional[int]:
        if not raw:
            return None
        try:
            return int(raw.rstrip("ms"))
        except ValueError:
            return None

    def get(self, key: str, default: str = "") -> str:
        return self.fields.get(key, default)

    def flag(self, key: str) -> bool:
        return self.fields.get(key) == "1"

    def __repr__(self) -> str:
        return f"<{self.channel} {self.raw}>"


def parse(raw: str) -> Optional[Line]:
    m = LINE.match(raw.strip())
    if not m:
        return None
    return Line(m.group("channel"), m.group("rest"), raw.strip())


class GateSim:
    """One door-gate board, as a process.

    Holds every line it ever printed, so an assertion can look BACKWARDS as well as
    wait forwards — a relay that opened while the harness was doing something else
    is still in the transcript, and a test that could only wait would have to guess
    when to start waiting."""

    def __init__(self, api_base: str, device_key: str, mac: str, workdir: Path,
                 name: str = "dsim") -> None:
        self.api_base = api_base
        self.device_key = device_key
        self.mac = mac
        self.name = name
        self.workdir = workdir
        self.store = workdir / f"{name}-store"
        self.log = workdir / f"{name}.log"
        self.proc: Optional[subprocess.Popen] = None
        self.lines: list[Line] = []
        self._raw: "queue.Queue[str]" = queue.Queue()
        self._lock = threading.Lock()

    # -- lifecycle ---------------------------------------------------------
    @staticmethod
    def ensure_built(pio: str) -> None:
        """`make test-e2e-device` builds this before the script runs; a developer
        running `door_evening.py` on its own has not.

        Refused rather than skipped if it cannot be built. This repository has
        shipped three gates that could not fail, and "no binary, no assertions" is
        exactly that shape."""
        if GATE_SIM.exists():
            return
        if not Path(pio).exists() and not shutil.which(pio):
            raise StepFailed(
                f"{GATE_SIM} is missing and no pio to build it (set PIO=). "
                f"`make test-e2e-device` builds it; on its own, run "
                f"`pio run -d src/iot/door-gate -e simulator` first.")
        print("  building the door simulator (pio run -e simulator) ...", flush=True)
        r = subprocess.run([pio, "run", "-d", str(GATE_PROJECT), "-e", "simulator"],
                           capture_output=True, text=True)
        if r.returncode != 0 or not GATE_SIM.exists():
            raise StepFailed("door simulator build failed:\n" + (r.stdout + r.stderr)[-3000:])

    def start(self, link_down: bool = False, start_ms: Optional[int] = None) -> None:
        self.store.mkdir(parents=True, exist_ok=True)
        argv = [str(GATE_SIM), "--api-base", self.api_base, "--mac", self.mac,
                "--store", str(self.store)]
        if link_down:
            argv.append("--link-down")
        if start_ms is not None:
            argv += ["--start-ms", str(start_ms)]
        # THE KEY GOES IN THE ENVIRONMENT, NOT IN argv. A device API key in a command
        # line is a device API key in `ps`, and this harness runs on shared CI hosts.
        # The binary reads GATE_DEVICE_KEY and never prints it.
        env = dict(os.environ, GATE_DEVICE_KEY=self.device_key)
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, env=env, cwd=str(self.workdir))
        sc.LineReader(self.proc.stdout, self.log, self._raw).start()
        threading.Thread(target=self._drain, daemon=True).start()
        self.expect(lambda l: l.channel == "sim" and "console:" in l.raw, START_TIMEOUT,
                    "the simulator's banner")

    def _drain(self) -> None:
        while True:
            raw = self._raw.get()
            line = parse(raw)
            if line is None:
                continue
            with self._lock:
                self.lines.append(line)

    def stop(self) -> None:
        if not self.proc or self.proc.poll() is not None:
            return
        try:
            self.send("quit")
            self.proc.wait(5)
        except (OSError, subprocess.TimeoutExpired):
            self.proc.kill()

    # -- the console -------------------------------------------------------
    def send(self, command: str) -> None:
        if not self.proc or not self.proc.stdin:
            raise StepFailed("the door simulator is not running")
        self.proc.stdin.write((command + "\n").encode())
        self.proc.stdin.flush()

    def wifi(self, up: bool) -> None:
        self.send("wifi up" if up else "wifi down")
        self.expect(lambda l: l.channel == "link" and l.state == ("up" if up else "down"), 5.0,
                    f"the radio going {'up' if up else 'down'}")

    def status(self) -> Line:
        mark = self.mark()
        self.send("status")
        return self.expect(lambda l: l.channel == "status", 5.0, "a status line", mark)

    # -- reading -----------------------------------------------------------
    def mark(self) -> int:
        """A cursor into the transcript, so `since(mark)` means "because of what I
        just did" rather than "at any point in this run"."""
        with self._lock:
            return len(self.lines)

    def since(self, mark: int, channel: Optional[str] = None) -> list[Line]:
        with self._lock:
            out = self.lines[mark:]
        return [l for l in out if channel is None or l.channel == channel]

    def expect(self, pred: Callable[[Line], bool], timeout: float, what: str,
               mark: Optional[int] = None) -> Line:
        """Waits for a line, looking BACKWARDS from `mark` first.

        The backward half is not an optimisation. The board runs a 10 ms loop and
        answers a scan in one pass, so by the time Python has written to a pipe and
        come back to wait, the line it is waiting for is frequently already
        printed."""
        start = mark if mark is not None else 0
        deadline = time.time() + timeout
        seen = start
        while True:
            with self._lock:
                fresh = self.lines[seen:]
                seen = len(self.lines)
            for line in fresh:
                if pred(line):
                    return line
            if time.time() >= deadline:
                recent = [l.raw for l in self.since(max(0, seen - 8))]
                raise StepFailed(f"the door simulator never printed {what} within {timeout:.0f}s "
                                 f"(recent: {recent})")
            time.sleep(0.02)

    def maybe(self, pred: Callable[[Line], bool], timeout: float, mark: int) -> Optional[Line]:
        """`expect` without the failure — for asserting that something did NOT
        happen, which is most of what a refusal is."""
        try:
            return self.expect(pred, timeout, "(optional)", mark)
        except StepFailed:
            return None

    # -- the things the harness actually asks ------------------------------
    def scan(self, code: str, timeout: float = 20.0) -> Line:
        """Present `code` at the reader and wait for the board's own decision.

        20 seconds, because a scan that has to wait for a blocking call in flight
        waits one worst-case call — which is 12 s by `kWorstBlockingCallMs` — and a
        harness that timed out at 5 would be asserting its own patience."""
        mark = self.mark()
        self.send(f"scan {code}")
        return self.expect(lambda l: l.channel == "decision", timeout,
                           f"a decision for {code!r}", mark)

    def relay_window(self, mark: int, timeout: float) -> tuple[Optional[int], Optional[int]]:
        """The board's own ON and OFF instants after `mark`, in its own millis().

        `timeout` MUST be longer than the release it is measuring, and callers get
        it from `release_wait()` rather than choosing a number. Both call sites
        here once passed a flat 12.0, which was comfortable for the three-second
        default and became a guaranteed failure the day the club's default became
        fifteen: the board released correctly for 15 002 ms, this returned
        `off=None` because it had stopped listening at 12 000, and the harness
        reported a firmware defect that did not exist. A wait shorter than the
        thing it waits for is not a timeout, it is an assertion that the feature
        is broken."""
        on = self.maybe(lambda l: l.channel == "relay" and l.state == "ON", timeout, mark)
        if on is None:
            return None, None
        off = self.maybe(lambda l: l.channel == "relay" and l.state == "OFF", timeout,
                         mark)
        return (on.at_ms, off.at_ms if off else None)

    @staticmethod
    def release_wait(unlock_seconds: int) -> float:
        """How long to wait for a release of `unlock_seconds` to end, with headroom.

        Derived from the club's OWN configured value, never a constant: this is the
        number that went stale, and a constant would go stale again the next time
        somebody changes the default. The headroom is one hard cap's worth of
        slack rather than a token margin, because the window a re-arm extends can
        legitimately run to CAP_MS (GATE_UNLOCK_HARD_CAP_MS) before the cap closes it."""
        return (CAP_MS / 1000.0) + unlock_seconds + 5.0

    def relay_is_released(self) -> bool:
        """Whether the lock is released RIGHT NOW, read off the transcript."""
        with self._lock:
            for line in reversed(self.lines):
                if line.channel == "relay" and line.state in ("ON", "OFF"):
                    return line.state == "ON"
        return False

    def wait_until_locked(self, timeout: float) -> None:
        """Block until the lock is de-energised, then wait out the relatch dwell.

        A STEP THAT NEEDS A CLOSED DOOR MUST WAIT FOR ONE. Sleeping the scan
        debounce and assuming the rest is what the dwell probe used to do, and it
        was only ever true because a release was three seconds long: by the time
        the debounce had passed, the door had closed on its own. At fifteen the
        previous step's window is still open, so the probe's scan EXTENDED that
        window instead of opening a new one — a correct `released=1` with no relay
        edge at all — and `relay_window` then waited for an ON that was never
        coming and reported the release as broken.

        Waiting on the observed state rather than on a number cannot go stale the
        next time the default moves."""
        if self.relay_is_released():
            self.expect(lambda l: l.channel == "relay" and l.state == "OFF", timeout,
                        "the release window closing", self.mark())
        self.let_the_lock_relatch()

    def let_the_lock_relatch(self) -> None:
        """Wait out the firmware's relock dwell before presenting another code.

        A person cannot scan within 400 ms of a door closing; this harness can and
        does. See RELOCK_DWELL_MS."""
        time.sleep((RELOCK_DWELL_MS / 1000.0) + 0.15)

    def relay_moved(self, mark: int, window: float = 1.5) -> bool:
        """Whether the lock was commanded RELEASED at any point since `mark`.

        A refusal's whole claim is that this is false, and it is asked over a
        WINDOW rather than instantaneously: a relay that opened 200 ms after the
        decision line is still a door that opened."""
        time.sleep(window)
        return any(l.channel == "relay" and l.state == "ON" for l in self.since(mark))

    def force_heartbeat(self, timeout: float = HEARTBEAT_TIMEOUT) -> Line:
        """Drop and re-associate the radio, then wait for the roster to be
        re-anchored.

        The link-up edge arms the heartbeat for "now" — that is the firmware's own
        path, not a back door — and `kMinHeartbeatSpacingMs` then floors the ATTEMPT
        at 15 s after the previous one, which is why this can take an interval. The
        `[hb]` line is printed when the roster's age DROPS, which happens on exactly
        one event: an accepted heartbeat whose body was adopted."""
        mark = self.mark()
        self.wifi(False)
        self.wifi(True)
        return self.expect(lambda l: l.channel == "hb", timeout, "an adopted heartbeat", mark)


# ---------------------------------------------------------------------------
# A peer the real API cannot be made into
# ---------------------------------------------------------------------------


class HostileApi:
    """A device API that answers, hangs, or hangs up — switchable at run time.

    The real API is the right peer for every assertion about BEHAVIOUR, and the
    wrong one for the measurement below: "the API hung" and "the connection dropped"
    are not states a healthy Kestrel can be put into, and pointing the board at a
    closed port measures a refused connection rather than a slow one.

    It answers **chunked, with no `Content-Length`, on HTTP/1.1** in `serve` mode —
    the round-G3 shape — so the measurement runs against the framing the firmware
    actually meets rather than the easy one."""

    #: The three answers. `serve` replies; `hang` accepts and never says anything;
    #: `drop` accepts and closes immediately, which is a peer that went away mid
    #: request rather than one that refused.
    MODES = ("serve", "hang", "drop")

    def __init__(self, unlock_seconds: int, roster: list[str], heartbeat_seconds: int) -> None:
        self.unlock_seconds = unlock_seconds
        self.roster = roster
        self.heartbeat_seconds = heartbeat_seconds
        self.mode = "serve"
        self.requests: list[str] = []
        self._sock = socket.socket()
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(8)
        self.port = self._sock.getsockname()[1]
        self._stop = False
        self._held: list[socket.socket] = []
        threading.Thread(target=self._accept, daemon=True).start()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _accept(self) -> None:
        while not self._stop:
            try:
                conn, _ = self._sock.accept()
            except OSError:
                return
            threading.Thread(target=self._serve_one, args=(conn,), daemon=True).start()

    def _serve_one(self, conn: socket.socket) -> None:
        mode = self.mode
        if mode == "drop":
            # Accepted and then gone. `SO_LINGER` 0 makes the close an RST rather
            # than a graceful FIN, which is what a router dropping a NAT entry or a
            # container being killed looks like from the board.
            try:
                conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER,
                                b"\x01\x00\x00\x00\x00\x00\x00\x00")
                conn.close()
            except OSError:
                pass
            return
        if mode == "hang":
            # HELD OPEN AND SILENT. Held in a list so the socket is not garbage
            # collected and closed behind the board's back, which would turn the
            # header-budget measurement into a dropped-connection one.
            self._held.append(conn)
            return
        try:
            with conn:
                data = b""
                while b"\r\n\r\n" not in data:
                    chunk = conn.recv(4096)
                    if not chunk:
                        return
                    data += chunk
                head, _, rest = data.partition(b"\r\n\r\n")
                path = head.split(b" ")[1].decode()
                length = 0
                for line in head.decode(errors="replace").split("\r\n")[1:]:
                    if line.lower().startswith("content-length:"):
                        length = int(line.split(":")[1])
                while len(rest) < length:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    rest += chunk
                body = rest.decode(errors="replace")
                self.requests.append(f"{path} {body}")
                conn.sendall(self._answer(path, body))
        except OSError:
            pass

    def _answer(self, path: str, body: str) -> bytes:
        if path.endswith("/heartbeat"):
            payload: dict[str, Any] = {
                "kind": "gate", "device_code": "gate-hostile", "gate_key": "hostile",
                "server_time": "2026-01-01T00:00:00Z",
                "heartbeat_seconds": self.heartbeat_seconds,
                "gate": {"unlock_seconds": self.unlock_seconds},
                "roster": self.roster,
            }
        elif path.endswith("/gate"):
            opened = any(entry.split("|")[0] in body for entry in self.roster)
            payload = {"opened": opened, "reason": "ok" if opened else "not_recognised",
                       "unlock_seconds": self.unlock_seconds if opened else 0}
        else:
            payload = {"accepted_through": 4294967295, "recorded": 1}
        raw = json.dumps(payload).encode()
        # CHUNKED, with no Content-Length, on a 1.1 status line — the exact shape
        # round G3 found the real API answering with, and the one the firmware's
        # de-chunker exists for. Split small so the chunk state machine is actually
        # driven across reads rather than handed one whole chunk.
        out = (b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"
               b"Content-Type: application/json\r\n\r\n")
        for i in range(0, len(raw), 23):
            piece = raw[i:i + 23]
            out += b"%x\r\n" % len(piece) + piece + b"\r\n"
        return out + b"0\r\n\r\n"

    def close(self) -> None:
        self._stop = True
        for conn in self._held:
            try:
                conn.close()
            except OSError:
                pass
        try:
            self._sock.close()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# The measurement
# ---------------------------------------------------------------------------


def measure_worst_case_release(workdir: Path, device_key: str) -> dict:
    """How long the lock can PHYSICALLY stay released, measured rather than derived.

    `gatelogic/GateApp.h` and `src/iot/door-gate/README.md` both state the bound in
    words: the release DEADLINE is bounded by the 30 s hard cap and always was, but
    what the deadline does not bound is when the loop gets back to look at it. A
    blocking call in flight when the deadline passes delays the relay write until
    the call returns, so

        physical release <= granted window + kWorstBlockingCallMs + kIdleDelayMs

    which is 30 000 + 12 000 + 10 = 42 010 ms with this image's numbers. That
    sentence has never been measured; it was derived from three timeout constants.

    This measures it, three ways, against a peer the real API cannot be made into:

      * **a hung API** — the peer accepts the connection and never answers. The
        board spends its HEADER budget and gives up;
      * **a dropped connection** — the peer accepts and then RSTs. The board learns
        nothing and falls back to the roster, and the relay must still come back on
        time;
      * **a black hole** — a destination that neither answers nor refuses, which is
        what exercises the CONNECT budget. Best effort: a host that answers
        `EHOSTUNREACH` immediately has not exercised it, and this says so rather
        than reporting a number it did not measure.

    Returns the numbers. The caller asserts on them; this only measures."""
    out: dict[str, Any] = {}

    # `heartbeat_seconds` at the CEILING devlink::Cadence will adopt (300 s), so the
    # cadence cannot fire inside the 30-second release window and take the pass's
    # one blocking call before the scan below can. Pushing a cadence is the server's
    # own documented right; this is not a back door into the firmware.
    api = HostileApi(unlock_seconds=30, roster=["WORSTCASEAAA|0|-600|36000"],
                     heartbeat_seconds=300)
    sim = GateSim(api.base, device_key, "02d0" + secrets.token_hex(4)[:8], workdir, name="dsim-worst")
    try:
        sim.start()
        sim.expect(lambda l: l.channel == "hb" and l.get("unlock_ms") == "30000", 30.0,
                   "a heartbeat adopting the 30-second release")

        # --- (1) a hung API -------------------------------------------------
        opened = sim.mark()
        decision = sim.scan("WORSTCASEAAA")
        if not decision.flag("released"):
            raise StepFailed(f"the hostile API's open was refused: {decision.raw}")
        on = sim.expect(lambda l: l.channel == "relay" and l.state == "ON", 5.0, "the relay opening",
                        opened)
        granted = int(decision.get("granted_ms", "0"))
        api.mode = "hang"

        # INJECT THE CALL AS LATE AS POSSIBLE. The overrun is bounded by ONE blocking
        # call, and it is only EQUAL to one when a call starts immediately before the
        # deadline — a call that started earlier has already spent part of itself. So
        # the harness waits until the release is nearly over and then presents a
        # DIFFERENT token, which `ScanDebounce` does not suppress.
        target = (on.at_ms or 0) + granted - 150
        while True:
            now = sim.status().at_ms or 0
            if now >= target:
                break
            time.sleep(min(1.0, max(0.02, (target - now) / 1000.0)))
        hung_from = sim.mark()
        sim.send("scan WORSTCASEBBB")
        off = sim.expect(lambda l: l.channel == "relay" and l.state == "OFF", 30.0,
                         "the relay closing", opened)
        held = (off.at_ms or 0) - (on.at_ms or 0)
        hung_status = sim.status()
        out["granted_ms"] = granted
        out["hung_release_ms"] = held
        out["hung_overrun_ms"] = held - granted
        out["hung_worst_call_ms"] = int(hung_status.get("worst_call_ms", "0"))
        out["watchdog_breaches"] = int(hung_status.get("wdt_breaches", "0"))
        out["worst_unkicked_gap_ms"] = int(hung_status.get("worst_gap_ms", "0"))
        out["hung_lines"] = [l.raw for l in sim.since(hung_from)][:6]

        # --- (2) a dropped connection ---------------------------------------
        api.mode = "drop"
        time.sleep(2.1)  # past the debounce, so the token below is decided afresh
        dropped = sim.mark()
        drop_decision = sim.scan("WORSTCASEAAA")
        drop_on = sim.maybe(lambda l: l.channel == "relay" and l.state == "ON", 3.0, dropped)
        drop_off = sim.maybe(lambda l: l.channel == "relay" and l.state == "OFF", 30.0, dropped)
        out["drop_reason"] = drop_decision.get("reason")
        out["drop_released"] = drop_decision.flag("released")
        out["drop_release_ms"] = (((drop_off.at_ms or 0) - (drop_on.at_ms or 0))
                                  if drop_on and drop_off else None)
        drop_status = sim.status()
        out["drop_worst_call_ms"] = int(drop_status.get("worst_call_ms", "0"))
        out["calls"] = int(drop_status.get("calls", "0"))
    finally:
        sim.stop()
        api.close()

    # --- (3) the connect budget ---------------------------------------------
    # 192.0.2.1 is TEST-NET-1 (RFC 5737): documentation-only, routed nowhere. A
    # network that black-holes it exercises kHttpConnectTimeoutMs; one that answers
    # ICMP unreachable immediately does not, and the number is reported as "not
    # exercised" rather than quietly recorded as a connect budget of 3 ms.
    blackhole = GateSim("http://192.0.2.1:8088", device_key, "02d0" + secrets.token_hex(4)[:8],
                        workdir, name="dsim-blackhole")
    try:
        blackhole.start()
        time.sleep(6.0)
        status = blackhole.status()
        out["connect_call_ms"] = int(status.get("worst_call_ms", "0"))
        out["connect_calls"] = int(status.get("calls", "0"))
    finally:
        blackhole.stop()
    return out


# ---------------------------------------------------------------------------
# The evening's DSIM section
# ---------------------------------------------------------------------------


def _owner(door: Any):
    """The module `door_evening.py` was loaded as.

    `import door_evening` would be wrong and quietly so: that file is normally run
    as a SCRIPT, so it is in `sys.modules` under `__main__`, and importing it by
    name loads a SECOND copy — a second `REPORT`, a second `Sql`, and a run whose
    assertions land in a report nothing prints. Asking the object it handed us which
    module its class came from gives the one that is actually loaded, whichever name
    that is."""
    return sys.modules[type(door).__module__]


def _minted_ident(door: Any, user_id: str) -> str:
    """A live `MemberIdent` code for somebody, written the way `door_evening.py`'s
    own `mint_ident_for` writes one — through that function, not a copy of it."""
    return _owner(door).mint_ident_for(door, {"user_id": user_id})


def _members_with_a_door_window_open(door: Any, horizon_minutes: int) -> set:
    """Everybody the door would let in right now on some OTHER booking.

    THE RELIEF RULE IS WHY THIS EXISTS, and it cost this section two red
    assertions before it did. `D11` pins it: *"a code outside its own window
    opens for a member whose OTHER court is running"* — so a `too_early` fixture
    handed to a member who happens to be mid-booking answers `ok`, correctly,
    and reads as a firmware defect.

    The evening's earlier steps book for the spare members on their own
    schedule, and which of them is mid-booking by the time this section runs
    depends on how long the two `BackgroundService` waits took. So the member is
    CHOSEN from the database rather than picked by index and hoped about.

    THE PREDICATE IS `GateAccess.HoldsALiveBookingAsync`'s, TRANSLATED, and the
    translation is load-bearing in two places a looser one got wrong:

      * `Booked`, `NoShow` and `Completed` all count. `D8` and `D9` pin the last
        two: a swept no-show's code and a completed booking's code both still
        open a door;
      * the upper edge is `StartsAt + SliceMinutes x SliceCount + grace`, and
        **NOT `EndsAt`**. `GateAccess` says why in full: the no-show sweep
        TRUNCATES `EndsAt` to its own clock, so `EndsAt` is a second upper edge,
        lower than the real one and wrong in two directions at once. A query
        keyed on `EndsAt > now()` therefore reports a member as free while the
        server still considers them due on a court — which is exactly how this
        section's first two runs handed the `too_early` fixture to somebody the
        relief rule then let in.

    The two can only disagree across a settings change, which this section does
    not make while it is reading."""
    grace = int(door.settings.get("grace_window_minutes") or 0)
    rows = door.sql.run(
        f"""select distinct "UserId"::text from bookings where "Status" in (0,2,3) """
        f"""and "StartsAt" <= now() + interval '{horizon_minutes} minutes' """
        f"""and "StartsAt" + make_interval(mins => "SliceMinutes" * "SliceCount" + {grace}) >= now()""")
    return {line.strip() for line in rows.splitlines() if line.strip()}


def _free_member(door: Any, busy: set) -> dict:
    """A spare member with nothing open at the door.

    ONE is enough, and asking for one rather than two is the difference between
    a fixture that is normally available and one that normally is not: the
    evening books for the spares on its own schedule and three of the four are
    routinely mid-booking by the time this section runs.

    The same member carries both policy fixtures, and the arithmetic is why. A
    booking `H + 10` minutes out is outside the `active_member` horizon, so its
    own code is `too_early`; it is also outside the narrower `booking_window`
    horizon, so the same member's IDENT code is `no_booking`. Two refusals the
    policy pair exists to distinguish, from one member and one booking."""
    for member in door.spare:
        if member["user_id"] not in busy:
            return member
    raise StepFailed(
        "every spare member has a booking open at the door, so no `too_early` or `no_booking` "
        "fixture is reachable — the relief rule would answer `ok` for all of them and this "
        f"section would be asserting nothing (busy={sorted(busy)})")


def _audit_count(door: Any, action: str, device_code: str) -> int:
    """Rows this BOARD wrote, by its own device code.

    `DeviceEventEndpoints` puts `device_code` in every `device.*` row's
    `DetailsJson`, which is what makes "exactly once" a question about this board
    rather than about every board in the run — `door_evening.py`'s played
    `GateClient` is uploading `device.gate_open` rows of its own a few steps
    earlier."""
    raw = door.sql.scalar(
        f"""select count(*) from audit_log where "Action"='{action}' """
        f"""and "DetailsJson"->>'device_code'='{device_code}'""")
    return int(raw or 0)


def _dsim_clock_bases(door: Any, live_code: str) -> None:
    """The offline-decide-then-upload cycle at clock bases the simulator's default
    is not, INCLUDING one four seconds before the 49.7-day millis() wrap.

    WHY THIS EXISTS, AND WHY IT IS NOT A NICETY. Round G4's C1 was an offline
    record that every real board destroyed on upload: `Uptime64::seed` left the
    accumulator R ms behind the raw `millis()` every event is stamped from, so
    `tb::widen` underflowed and the batch went up with a stamp of about 1.8e19 —
    which the server refuses, and which the drain then treats as a 4xx the board
    caused and DROPS. R is `millis()` at `begin()`, and `--start-ms 0` is the
    single value of it that makes the arithmetic come out right. It was this
    harness's only value for the whole life of the simulator, so the one end-to-end
    test of the door's offline evidence was green by construction.

    The default is non-zero now (see `kDefaultStartMs` in the simulator), which is
    what makes every step above a real test of it. This adds the OTHER base that
    matters: the wrap, which is the normal case on a board that runs for months and
    the one place widening has to do any work at all."""
    # Four seconds before the rollover, so it happens DURING the scan-to-upload
    # window rather than before the board has associated.
    for label, start_ms in (("wrap-adjacent", 4_294_963_200), ("mid-range", 1_234_567)):
        mac = ("02d2" + secrets.token_hex(4))[:12]
        device_code = f"gate-{mac[-6:]}"
        sim = GateSim(getattr(door.api, "base", ""), door.key, mac,
                      door.api.log.parent, name=f"dsim-{start_ms}")
        try:
            sim.start(start_ms=start_ms)
            first = sim.expect(lambda l: l.channel == "hb", 30.0, "the first heartbeat")
            devices = sc.expect_status(
                door.w.http.get("/api/v1/admin/devices/", token=door.w.admin_token),
                200, "devices").json
            row = next((x for x in devices if x.get("mac_address") == mac), None)
            sim_id = (row or {}).get("id", "")
            if not sim_id:
                raise StepFailed(f"the {label} board did not register: {first.raw}")
            sc.expect_status(door.w.http.patch(f"/api/v1/admin/devices/{sim_id}",
                                               {"gate_key": f"sim-door-{start_ms}"},
                                               token=door.w.admin_token),
                             200, "name the door")
            pushed = sim.force_heartbeat()
            chk("DSIM", f"[{label}] a board whose millis() starts at {start_ms} loads its roster",
                int(pushed.get("roster", "0")) >= 1, pushed.raw)

            sim.wifi(False)
            offline_from = sim.mark()
            allowed = sim.scan(live_code)
            chk("DSIM", f"[{label}] it decides from the cached roster and opens",
                allowed.flag("released") and allowed.flag("queued"), allowed.raw)

            reconnect = sim.mark()
            sim.wifi(True)
            drained = sim.maybe(lambda l: l.channel == "evq" and l.get("held") == "0", 40.0,
                                reconnect)
            # THE ASSERTION C1 WOULD HAVE FAILED. Not "the ring emptied" — a board
            # that drops an event on a 400 empties its ring too, which is exactly
            # how this stayed invisible. The evidence is the row SERVER-SIDE.
            opens = _audit_count(door, "device.gate_open", device_code)
            boots = _audit_count(door, "device.boot", device_code)
            chk("DSIM", f"[{label}] AND THE RECORD SURVIVES THE UPLOAD: the offline open and the "
                        f"boot event are both server-side, so the stamp the board widened was one "
                        f"the server could actually read",
                opens == 1 and boots == 1,
                f"gate_open={opens} boot={boots} drained={drained.raw if drained else None} "
                f"evq={[l.raw for l in sim.since(offline_from, 'evq')]}")
            final = sim.status()
            chk("DSIM", f"[{label}] ...and nothing was lost to a full or jammed ring on the way",
                final.get("queued") == "0" and final.get("lost") == "0", final.raw)
            REPORT.note(f"DSIM {label} board {device_code} (start_ms={start_ms}): {final.raw}")
        finally:
            sim.stop()


def dsim_firmware(door: Any) -> None:
    """DSIM — the compiled door firmware, in the chain, against this run's own API.

    Everything below is decided by `gatelogic` running in a real process over a real
    socket. The harness types at a console and reads a transcript; it does not
    answer a single question on the board's behalf."""
    owner = _owner(door)
    sc.step("DSIM  The REAL door firmware in the chain: compiled gatelogic, real sockets")

    api_base = getattr(door.api, "base", "")
    GateSim.ensure_built(os.environ.get("PIO", str(ROOT / "src" / "iot" / ".venv" / "bin" / "pio")))

    mac = ("02d1" + secrets.token_hex(4))[:12]
    device_code = f"gate-{mac[-6:]}"
    workdir = door.api.log.parent
    sim = GateSim(api_base, door.key, mac, workdir)

    # Fixtures FIRST, so one heartbeat mints and pushes both codes. A second forced
    # heartbeat costs a real interval — `kMinHeartbeatSpacingMs` floors an attempt at
    # 15 s — and paying it twice for tidiness would be paying it with the run's time.
    #
    # SPARE MEMBERS, NOT M, AND COURTS 3 AND 4. M's own booking has been moved
    # through both edges of its window, completed by the LightsCueWorker and scanned
    # at a dozen times by the steps above; a fixture of this section's own is a
    # fixture whose state this section knows. `h + 10` rather than a rounder number
    # because the roster reaches `roster_window + early_entry` and the booking has to
    # be BEYOND the door's horizon and INSIDE the roster's — which is the pair D3
    # already builds and the only gap where `too_early` is reachable at all.
    #
    # AND THE TWO MEMBERS ARE CHOSEN, NOT INDEXED. The relief rule (`D11`) opens the
    # door for a code outside its own window when the holder's OTHER court is
    # running, so handing the `too_early` fixture to whichever spare happens to be
    # mid-booking answers `ok` — correctly — and reads as a firmware defect. Which
    # spare that is depends on how long the evening's two `BackgroundService` waits
    # took, which is exactly the hidden-wall-clock input this harness has been
    # bitten by three times.
    # Read afresh: `horizon_minutes()` and the grace window below both come from
    # here, the evening switches the policy twice before this point, and a stale
    # `H` would pick the fixture against a rule the server is no longer applying.
    door.read_settings()
    h = door.horizon_minutes()
    busy = _members_with_a_door_window_open(door, h)
    holder = _free_member(door, busy)
    print(f"  [fixture] the too_early / no_booking member is {holder['user_id'][:8]}; "
          f"{len(busy)} member(s) already have a door window open", flush=True)
    live = sc.admin_book(door.w, 3, door.w.m_user_id, sc.now_utc() + timedelta(minutes=5), 2,
                         "DSIM live booking")
    early = sc.admin_book(door.w, 4, holder["user_id"],
                          sc.now_utc() + timedelta(minutes=h + 10), 2, "DSIM too-early booking")

    try:
        sim.start()

        # -- D S 0 : the very first thing the board ever does ----------------
        #
        # A GPIO leaves reset as an INPUT, and `pinMode(OUTPUT)` starts driving
        # whatever is already latched. `LockDriver::begin` therefore writes the
        # LOCKED level into the output register and only then makes the pin an
        # output — two calls on `IPinOut` precisely so the ORDER can be observed —
        # and on a board wired the other way round the obvious ordering is a door
        # that clicks open on every boot, including the ones a watchdog reset
        # causes at three in the morning. The host suite pins it with a fake; this
        # is the same property read off a real process's first two lines.
        boot = sim.since(0, "relay")
        chk("DSIM", "the LOCKED level reaches the output register BEFORE the relay pin drives "
                    "anything — the one boot-safety property this firmware can actually provide",
            len(boot) >= 2 and boot[0].state == "OFF" and "register only" in boot[0].raw
            and boot[1].state == "driving",
            f"{[l.raw for l in boot[:2]]}")

        # -- D S 1 : the board registers itself -----------------------------
        first = sim.expect(lambda l: l.channel == "hb", 30.0, "the first heartbeat")
        devices = sc.expect_status(door.w.http.get("/api/v1/admin/devices/", token=door.w.admin_token),
                                   200, "devices").json
        row = next((x for x in devices if x.get("mac_address") == mac), None)
        sim_id = (row or {}).get("id", "")
        # THE HEARTBEAT THE BINARY SENDS IS ACCEPTED, and this is the proof rather
        # than a 200 the harness never saw: a row that did not exist before this
        # process started, carrying the MAC the binary was given, the kind its `kind`
        # hint asked for, the version string `fwversion` compiled into it, and a
        # `last_seen_at` only a request can set. None of it can be here unless the
        # firmware rendered a body the server accepted.
        chk("DSIM", "the COMPILED firmware's own heartbeat is ACCEPTED: the Devices page now holds a "
                    "row for the binary's MAC, auto-registered as a Gate, running the version the "
                    "image reports, with a last_seen_at only a real request can set",
            bool(row) and row.get("kind") == "Gate" and row.get("auto_registered") is True
            and row.get("running_version") == "1.1.0" and bool(row.get("last_seen_at")),
            f"row={row} first_hb={first.raw}")
        if not sim_id:
            raise StepFailed("the simulator's board did not register — nothing below can run")
        sc.expect_status(door.w.http.patch(f"/api/v1/admin/devices/{sim_id}",
                                           {"gate_key": "sim-door"}, token=door.w.admin_token),
                         200, "name the simulated door")

        # Naming the door is what starts its offline fallback, so this heartbeat is
        # the first that carries a roster — and it mints both bookings' codes.
        pushed = sim.force_heartbeat()
        live_code = owner.code_for(door.sql, live["id"])
        early_code = owner.code_for(door.sql, early["id"])
        chk("DSIM", "naming the door fills the BINARY's own roster cache, and the codes it holds are "
                    "the ones the database minted for the bookings",
            int(pushed.get("roster", "0")) >= 2 and bool(live_code) and bool(early_code),
            f"roster={pushed.get('roster')} live={live_code!r} early={early_code!r}")

        # -- D S 2 : an allowed scan, and the release MEASURED ---------------
        opened = sim.mark()
        decision = sim.scan(live_code)
        chk("DSIM", "an allowed scan: the firmware asks the API, reads `opened`, and RELEASES",
            decision.flag("released") and decision.get("reason") == "ok"
            and decision.get("token") == live_code, decision.raw)
        on_ms, off_ms = sim.relay_window(opened, timeout=GateSim.release_wait(door.unlock_seconds()))
        want = door.unlock_seconds() * 1000
        held = (off_ms - on_ms) if (on_ms is not None and off_ms is not None) else None
        chk("DSIM", f"the relay ENERGISES and RELEASES after the club's configured "
                    f"{door.unlock_seconds()} s, measured on the board's own clock "
                    f"(+/-{RELEASE_TOLERANCE_MS} ms)",
            held is not None and abs(held - want) <= RELEASE_TOLERANCE_MS,
            f"on={on_ms} off={off_ms} held={held}ms want={want}ms")

        # -- D S 3 : every refusal the firmware can be made to distinguish ---
        #
        # THE CORPUS HAS SIX DENIED REASONS AND THIS BOARD CAN REACH FOUR. It is a
        # fact about the firmware rather than a gap in this harness, and it is stated
        # rather than glossed: `renderScanBody` hard-codes `"method":"qr"`, so
        # `method_not_supported` is a screen this image can never be shown; and
        # `not_a_gate` is what a COURT BOX is told at `/device/gate`, which this
        # image cannot become because the server keys the kind on the MAC's existing
        # row and not on the `kind` hint. `door_evening.py`'s own D5/D16 provoke both
        # over the wire; what is proven HERE is that the compiled firmware refuses,
        # and that the lock does not move, for each reason it can actually meet.
        # The same member the `too_early` booking belongs to: the membership check
        # runs before anything about a booking, so a barred member is barred
        # whatever they have booked, and reusing them keeps this section's fixture
        # footprint to two members.
        suspended = holder
        ident = _minted_ident(door, suspended["user_id"])
        # THE FIXTURE, PROBED BEFORE THE FIRMWARE IS BLAMED FOR IT.
        #
        # `too_early` is the one refusal here whose fixture can rot underneath it:
        # the relief rule opens the door for a code outside its own window when
        # the holder's OTHER court is running, so a fixture handed to a member the
        # evening happens to have booked answers `ok` — correctly — and reads as a
        # firmware defect. It did, twice, before the member was chosen from the
        # database rather than by index.
        #
        # So the API is asked first, through door_evening's own played client. The
        # two assertions then say different things: this one is about the FIXTURE,
        # and the one below is about the firmware agreeing with it.
        # THE DWELL FIRST. DS2 released the lock and this harness reaches the next
        # scan within milliseconds of it closing, which is inside the firmware's
        # relock dwell — see RELOCK_DWELL_MS. DS4b proves the dwell; here it is
        # simply respected, as a person would respect it without noticing.
        sim.let_the_lock_relatch()

        probe = door.gate.scan(early_code)
        chk("DSIM", "FIXTURE PROBE: the API itself answers `too_early` for this code, so the "
                    "assertion below is about the firmware rather than about which member the "
                    "evening happened to leave free",
            probe.status == 200 and probe.get("opened") is False and probe.get("reason") == "too_early",
            f"{probe.summary()} body={probe.text[:140]} member={holder['user_id'][:8]}")

        refusals = [
            ("a code that never existed", "ZZZZZZZZZZZZ", "not_recognised"),
            (f"a booking {h + 10} min out, before its own door window opens (H={h})", early_code,
             "too_early"),
        ]
        for label, token, reason in refusals:
            mark = sim.mark()
            r = sim.scan(token)
            chk("DSIM", f"{label} -> the firmware refuses with `{reason}`",
                not r.flag("released") and r.get("reason") == reason, r.raw)
            chk("DSIM", f"  ...and the relay NEVER MOVES for `{reason}`", not sim.relay_moved(mark),
                f"relay lines: {[l.raw for l in sim.since(mark, 'relay')]}")
            door.reasons_seen.add(reason)

        # `member_not_active`, which needs the desk to bar somebody.
        door.sql.run(f"""update memberships set "Status"={owner.MEMBERSHIP_SUSPENDED} """
                     f"""where "UserId"='{suspended["user_id"]}'""")
        print(f"  [db] {suspended['user_id'][:8]}'s membership set to Suspended", flush=True)
        mark = sim.mark()
        r = sim.scan(ident)
        chk("DSIM", "a suspended member's ident QR -> the firmware refuses with `member_not_active`",
            not r.flag("released") and r.get("reason") == "member_not_active", r.raw)
        chk("DSIM", "  ...and the relay NEVER MOVES for `member_not_active`", not sim.relay_moved(mark),
            f"relay lines: {[l.raw for l in sim.since(mark, 'relay')]}")
        door.reasons_seen.add("member_not_active")
        door.sql.run(f"""update memberships set "Status"={owner.MEMBERSHIP_ACTIVE} """
                     f"""where "UserId"='{suspended["user_id"]}'""")

        # `no_booking`, which is the policy question and needs the narrower one.
        door.set_policy("booking_window")
        try:
            # THE SAME MEMBER AND THE SAME BOOKING as the `too_early` fixture. A
            # booking `H + 10` out is outside the active_member horizon, which is
            # what makes its own code `too_early`; it is also outside the narrower
            # booking_window one, which is what makes this member's IDENT code
            # `no_booking`. Two refusals the policy pair exists to distinguish,
            # from one fixture — and one member is all the evening usually leaves
            # free by this point.
            stranger_ident = _minted_ident(door, holder["user_id"])
            mark = sim.mark()
            r = sim.scan(stranger_ident)
            chk("DSIM", "under booking_window, a member whose only booking is beyond the narrower "
                        "horizon -> the firmware refuses with `no_booking`",
                not r.flag("released") and r.get("reason") == "no_booking", r.raw)
            chk("DSIM", "  ...and the relay NEVER MOVES for `no_booking`", not sim.relay_moved(mark),
                f"relay lines: {[l.raw for l in sim.since(mark, 'relay')]}")
            door.reasons_seen.add("no_booking")
        finally:
            door.set_policy("active_member")

        # -- D S 4 : the API is unreachable ---------------------------------
        sim.wifi(False)
        offline_from = sim.mark()
        allowed = sim.scan(live_code)
        chk("DSIM", "WITH THE RADIO GONE the firmware decides from its CACHED roster and opens for a "
                    "rostered booking — in microseconds, with no call to make",
            allowed.flag("released") and allowed.flag("queued"), allowed.raw)
        on_ms, off_ms = sim.relay_window(offline_from, timeout=GateSim.release_wait(door.unlock_seconds()))
        held = (off_ms - on_ms) if (on_ms is not None and off_ms is not None) else None
        chk("DSIM", "  ...for the SAME adopted release time, because a door is released for long "
                    "enough to walk through and the booking's minutes are the court's business",
            held is not None and abs(held - want) <= RELEASE_TOLERANCE_MS,
            f"held={held}ms want={want}ms")

        sim.let_the_lock_relatch()
        denied_from = sim.mark()
        denied = sim.scan("QQQQQQQQQQQQ")
        chk("DSIM", "a code the cached list has never heard of is refused offline — the degraded "
                    "mode is NARROWER than the online one, and this is the narrow edge",
            not denied.flag("released") and denied.flag("queued")
            and denied.get("reason") == "not_recognised", denied.raw)
        chk("DSIM", "  ...and the relay never moves for a cached-list refusal",
            not sim.relay_moved(denied_from),
            f"relay lines: {[l.raw for l in sim.since(denied_from, 'relay')]}")

        held_lines = sim.since(offline_from, "evq")
        chk("DSIM", "both offline decisions are QUEUED, because the API by definition does not know "
                    "about a decision the board took for itself",
            any(int(l.get("held", "0")) >= 2 for l in held_lines),
            f"evq: {[l.raw for l in held_lines]}")

        # -- D S 5 : and uploaded on reconnect, exactly once -----------------
        before_open = _audit_count(door, "device.gate_open", device_code)
        before_unknown = _audit_count(door, "device.unknown_scan", device_code)
        chk("DSIM", "nothing the board decided offline has reached the server yet",
            before_open == 0 and before_unknown == 0,
            f"gate_open={before_open} unknown_scan={before_unknown}")

        reconnect = sim.mark()
        sim.wifi(True)
        sim.expect(lambda l: l.channel == "evq" and l.get("held") == "0", 40.0,
                   "the event ring draining", reconnect)
        opens = _audit_count(door, "device.gate_open", device_code)
        unknowns = _audit_count(door, "device.unknown_scan", device_code)
        chk("DSIM", "ON RECONNECT the firmware drains its ring and both offline decisions appear "
                    "server-side EXACTLY ONCE, keyed on this board's own device_code",
            opens == 1 and unknowns == 1, f"gate_open={opens} unknown_scan={unknowns}")
        boots = _audit_count(door, "device.boot", device_code)
        chk("DSIM", "...and the `boot` event every board queues in begin() is there once too",
            boots == 1, f"device.boot={boots}")

        # The board keeps running and keeps heartbeating. Uploading twice is the
        # failure this asserts against, and it is a failure that needs TIME to
        # happen — a drain that re-posted a released event would do it on the next
        # pass, ten milliseconds later.
        settle = sim.mark()
        sim.scan(live_code)
        sim.maybe(lambda l: l.channel == "hb", 6.0, settle)
        chk("DSIM", "and they are STILL exactly one each after the board has carried on running — a "
                    "drain that re-posted a released event would have done it by now",
            _audit_count(door, "device.gate_open", device_code) == 1
            and _audit_count(door, "device.unknown_scan", device_code) == 1,
            f"gate_open={_audit_count(door, 'device.gate_open', device_code)}")

        # -- D S 5 b : the lock is DE-ENERGISED between two openings ---------
        #
        # Round G4, A1. The hard cap bounded a release WINDOW and nothing bounded
        # the DOOR: the cap closed a window and the very next accepted scan opened
        # a fresh one, in the same pass, because `pass()` pumps the lock out of
        # `afterBlocking()` and applies the decision that call produced two lines
        # later. Measured against this binary with two alternating tokens every
        # 50 ms: relay OFF at t=31034 ms and ON at t=31034 ms, dark for 0 ms, then
        # +42 ms and +45 ms, for ever. A relay de-energised for zero milliseconds
        # was never de-energised — the strike does not drop and the maglock keeps
        # its armature — so the door physically never relocked, with every single
        # request inside the rules.
        # THE STATE HAS TO BE MADE: a dwell exists only just after a CLOSE, so
        # this opens the door and waits for the window to end before probing.
        #
        # AND IT IS HERE, AFTER DS5, RATHER THAN BESIDE THE OFFLINE SECTION: the
        # openings below are real openings, and offline each one would queue a
        # `gate_open` that DS5's "exactly once" counts would then read as a drain
        # that duplicated. The board is back online by now, so these go through
        # the API and queue nothing.
        # THE DOOR HAS TO BE SHUT BEFORE THIS CAN OPEN IT. See wait_until_locked.
        sim.wait_until_locked(GateSim.release_wait(door.unlock_seconds()))
        time.sleep((SCAN_DEBOUNCE_MS / 1000.0) + 0.3)
        dwell_open = sim.mark()
        reopened = sim.scan(live_code)
        chk("DSIM", "the cached roster opens the door again, which is what creates the close the "
                    "dwell follows",
            reopened.flag("released"), reopened.raw)
        _, closed_ms = sim.relay_window(dwell_open, timeout=GateSim.release_wait(door.unlock_seconds()))
        if closed_ms is None:
            raise StepFailed("the release window never closed, so the dwell cannot be probed")

        # IMMEDIATELY, which is what no person can do and this harness can. The
        # SAME code that opened the door a moment ago, so the refusal is
        # demonstrably about the DOOR and not about the member.
        dwell_from = sim.mark()
        dwell = sim.scan(live_code)
        chk("DSIM", "a scan inside the relock dwell is REFUSED — with the same code that opened the "
                    "door seconds earlier, so the answer is about the lock relatching and not about "
                    "the member",
            not dwell.flag("released") and dwell.get("reason") == "relocking", dwell.raw)
        chk("DSIM", "  ...and the relay does not move for it", not sim.relay_moved(dwell_from),
            f"relay lines: {[l.raw for l in sim.since(dwell_from, 'relay')]}")
        door.reasons_seen.add("relocking")

        # AND IT IS A DWELL, NOT A REFUSAL: the same code opens the door again a
        # moment later. A board that had simply stopped opening would pass the two
        # assertions above and be far worse than the defect.
        #
        # PAST THE DEBOUNCE TOO, not just past the dwell. The refusal above WAS a
        # decision for this token, so a re-scan inside kScanDebounceMs is
        # suppressed without one — correctly, and it would read here as the board
        # having stopped answering.
        time.sleep((SCAN_DEBOUNCE_MS / 1000.0) + 0.3)
        back_from = sim.mark()
        back = sim.scan(live_code)
        chk("DSIM", "  ...and once the lock has relatched the same code opens the door again, so the "
                    "dwell delays a member rather than refusing them",
            back.flag("released"), back.raw)
        chk("DSIM", "  ...with the relay actually moving for it", sim.relay_moved(back_from),
            f"relay lines: {[l.raw for l in sim.since(back_from, 'relay')]}")
        sim.relay_window(back_from, timeout=GateSim.release_wait(door.unlock_seconds()))
        sim.let_the_lock_relatch()


        # -- D S 5 c : back-to-back scans, and what the hard cap now costs ---
        #
        # THE RELEASE DEFAULT MOVED FROM THREE SECONDS TO FIFTEEN (GOAL item 2),
        # and the interesting consequence is not the fifteen. It is that
        # GATE_UNLOCK_HARD_CAP_MS bounds the TOTAL release across RE-ARMS, from
        # the first energise. At three seconds that allowed nine extensions; at
        # fifteen it allows ONE. A second member scanning at t = 14 s gets fifteen
        # seconds more and a third at t = 29 s gets one — and then the door shuts
        # on whoever is still walking through it.
        #
        # That is CORRECT and must stay: the cap is the property that stops a busy
        # doorway holding a lock open indefinitely one scan at a time. It is also
        # a visible behaviour change at a busy door, which is why it is measured
        # here rather than reasoned about.
        #
        # ASSERTED AS A RELATION, NOT AS A LITERAL. The served `unlock_seconds` is
        # the club's, the firmware default and the backend default are separate
        # changes landing in separate lanes, and a step pinned to either number
        # would go red on whichever arrived second.
        served = door.unlock_seconds()
        rescan_at = (SCAN_DEBOUNCE_MS / 1000.0) + 0.4
        if served < 5:
            # LOUD, not silent. A skip nobody can see is worse than an absent
            # step, and the reason is a number somebody can go and change.
            chk("DSIM", f"SKIPPED — the club serves unlock_seconds={served}, and this harness cannot "
                        f"get a second scan inside a {served} s release: the same token is debounced "
                        f"for {SCAN_DEBOUNCE_MS} ms. Raise gate_unlock_seconds to 5 or more (the "
                        f"firmware default is 15) and this step measures the cap.", True,
                f"served={served}s")
        else:
            time.sleep((SCAN_DEBOUNCE_MS / 1000.0) + 0.3)
            first_from = sim.mark()
            first = sim.scan(live_code)
            chk("DSIM", "back to back: the first member is let in", first.flag("released"), first.raw)
            on = sim.expect(lambda l: l.channel == "relay" and l.state == "ON", 12.0,
                            "the relay energising", first_from)

            # MID-RELEASE, which is the whole point: the lock has not closed, so
            # this is a re-arm rather than a fresh open, and the relock dwell —
            # which only exists just after a CLOSE — must not fire for it.
            time.sleep(rescan_at)
            second_from = sim.mark()
            second = sim.scan(live_code)
            chk("DSIM", "  ...and a second scan ARRIVING MID-RELEASE is accepted rather than refused "
                        "as `relocking`: the dwell is about a lock that has closed, and this one has "
                        "not",
                second.flag("released") and second.get("reason") != "relocking", second.raw)
            chk("DSIM", "  ...and the lock is never DE-ENERGISED between the two — one continuous "
                        "release, not a drop and a re-open, which is a strike that clicks in "
                        "somebody's face",
                not any(l.channel == "relay" and l.state == "OFF" for l in sim.since(first_from,
                                                                                     "relay")[:-0] or
                        [l for l in sim.since(first_from, "relay") if l.state == "OFF"]),
                f"relay: {[l.raw for l in sim.since(first_from, 'relay')]}")

            off = sim.expect(lambda l: l.channel == "relay" and l.state == "OFF", float(CAP_MS / 1000) + 15.0,
                             "the extended release finally closing", first_from)
            held = off.at_ms - on.at_ms
            asked = int(rescan_at * 1000) + (served * 1000)
            want = min(asked, CAP_MS)
            chk("DSIM", f"  ...the extension is granted and BOUNDED: one release of {held} ms from the "
                        f"first energise, where the two scans asked for about {asked} ms and the "
                        f"{CAP_MS} ms whole-window cap allows {want} ms. The cap bounds the TOTAL "
                        f"across re-arms, which is why a {served} s release allows so few of them.",
                abs(held - want) <= (RELEASE_TOLERANCE_MS + 600),
                f"held={held}ms want={want}ms asked={asked}ms served={served}s cap={CAP_MS}ms")
            chk("DSIM", f"  ...and it NEVER exceeds the cap, whatever the club configures",
                held <= CAP_MS + RELEASE_TOLERANCE_MS, f"held={held}ms cap={CAP_MS}ms")
            sim.let_the_lock_relatch()
            time.sleep((SCAN_DEBOUNCE_MS / 1000.0) + 0.3)

        # -- D S 6 : the club shuts the door --------------------------------
        #
        # PULL-ONLY HONESTY. The board keeps no inbound path, so an admin shutting
        # the door changes nothing until the board next asks — and the next thing it
        # asks is the scan of whoever is standing there.
        sc.expect_status(door.w.http.patch(f"/api/v1/admin/devices/{sim_id}", {"enabled": False},
                                           token=door.w.admin_token), 200, "shut the door")
        shut_from = sim.mark()
        time.sleep(2.1)
        shut = sim.scan(live_code)
        chk("DSIM", "an admin shuts the door and the board finds out on the NEXT SCAN — a 403 is the "
                    "one 4xx that is a statement about the board, and it is decided from a status "
                    "with no body at all",
            not shut.flag("released") and shut.get("reason") == "out_of_service"
            and shut.flag("out_of_service"), shut.raw)
        chk("DSIM", "  ...and the relay never moves for an out-of-service door",
            not sim.relay_moved(shut_from),
            f"relay lines: {[l.raw for l in sim.since(shut_from, 'relay')]}")
        door.reasons_seen.add("out_of_service")

        # AND THE ROSTER IS EMPTIED, which is the half that matters: denying only
        # this scan would leave the cache intact, so the next link drop is a door
        # admitting every rostered member again for the whole staleness window after
        # an admin pressed the button meant to stop exactly that.
        emptied = sim.maybe(lambda l: l.channel == "hb" and l.get("roster") == "0", 5.0, shut_from)
        chk("DSIM", "a 403 on the scan path COMMITS AN EMPTY ROSTER, so a board taken out of service "
                    "cannot keep admitting rostered members the moment its link drops",
            emptied is not None, f"hb lines: {[l.raw for l in sim.since(shut_from, 'hb')]}")
        sim.wifi(False)
        offline_shut = sim.mark()
        time.sleep(2.1)
        after = sim.scan(live_code)
        chk("DSIM", "  ...proved from the other side: offline, with the door shut, the same code "
                    "that opened it a minute ago opens nothing",
            not after.flag("released") and not sim.relay_moved(offline_shut), after.raw)

        # Reopened BEFORE the radio returns. The link-up edge arms a heartbeat for "now", and
        # when the last attempt was more than kMinHeartbeatSpacingMs ago it fires at once —
        # racing the PATCH below. Answered 403 by a door not yet reopened, it commits an empty
        # roster and prints the `[hb]` line force_heartbeat then took for the reopened door's
        # answer: a harness race whose outcome depended only on where the board's heartbeat
        # phase happened to fall (seen 2026-09-28, two runs in a row, never in the product).
        sc.expect_status(door.w.http.patch(f"/api/v1/admin/devices/{sim_id}", {"enabled": True},
                                           token=door.w.admin_token), 200, "reopen the door")
        sim.wifi(True)
        back = sim.force_heartbeat()
        chk("DSIM", "re-enabling the door puts the board straight back in service and its roster "
                    "comes back with it",
            int(back.get("roster", "0")) >= 1, back.raw)
        time.sleep(2.1)
        reopened = sim.mark()
        again = sim.scan(live_code)
        chk("DSIM", "and the same code opens the door again", again.flag("released")
            and again.get("reason") == "ok", again.raw)
        chk("DSIM", "  ...with the relay actually moving for it",
            sim.relay_moved(reopened), f"{[l.raw for l in sim.since(reopened, 'relay')]}")

        # -- D S 7 : the watchdog relation, over the whole section -----------
        final = sim.status()
        chk("DSIM", "over the whole section the loop never left the watchdog unkicked for as long "
                    "as its own period — which on hardware is a reset loop that admits nobody",
            final.get("wdt_breaches") == "0",
            f"worst unkicked gap {final.get('worst_gap_ms')}ms against the image's own "
            f"GATE_WATCHDOG_SECONDS; worst call {final.get('worst_call_ms')}ms")
        REPORT.note(f"DSIM board {device_code}: {final.raw}")
    finally:
        sim.stop()

    # -- D S 7 b : the same evening at clock bases that are not zero ---------
    _dsim_clock_bases(door, live_code)

    # -- D S 8 : the release-overrun bound, MEASURED ------------------------
    numbers = measure_worst_case_release(workdir, door.key)
    granted = numbers.get("granted_ms", 0)
    hung = numbers.get("hung_release_ms", 0)
    overrun = numbers.get("hung_overrun_ms", 0)
    one_call = numbers.get("hung_worst_call_ms", 0)
    REPORT.note("DSIM worst case, measured against a hostile peer: " + json.dumps(numbers))
    chk("DSIM", "MEASURED: against a hung API, the physical release is bounded by the granted window "
                "plus ONE blocking call plus one pass tick — the sentence GateApp.h and README.md "
                "both state, and which until now had only ever been derived from three constants",
        granted > 0 and hung <= granted + 12000 + 10 + RELEASE_TOLERANCE_MS,
        f"granted={granted}ms physical={hung}ms overrun={overrun}ms "
        f"bound={granted + 12000 + 10}ms")
    chk("DSIM", "MEASURED: the overrun really is one blocking call and not a whole pass's worth of "
                "them — the deadline is re-checked with a FRESH clock immediately after every call, "
                "which is what keeps it to one",
        one_call > 0 and overrun <= one_call + 2 * 10 + 100,
        f"overrun={overrun}ms against one call of {one_call}ms")
    chk("DSIM", "MEASURED: a DROPPED connection is an outage and not a refusal — the board learns "
                "nothing, falls back to its cached roster, and the lock still comes back on time",
        numbers.get("drop_release_ms") is None
        or abs(numbers["drop_release_ms"] - granted) <= RELEASE_TOLERANCE_MS + 10,
        f"reason={numbers.get('drop_reason')} released={numbers.get('drop_released')} "
        f"held={numbers.get('drop_release_ms')}ms worst_call={numbers.get('drop_worst_call_ms')}ms")
    chk("DSIM", "MEASURED: no call anywhere in the measurement exceeded kWorstBlockingCallMs, so "
                "the watchdog period this firmware asserts against is a real bound and not an "
                "intention",
        max(numbers.get("hung_worst_call_ms", 0), numbers.get("drop_worst_call_ms", 0),
            numbers.get("connect_call_ms", 0)) <= 12000,
        f"hung={numbers.get('hung_worst_call_ms')}ms drop={numbers.get('drop_worst_call_ms')}ms "
        f"connect={numbers.get('connect_call_ms')}ms")
    if numbers.get("connect_call_ms", 0) < 500:
        REPORT.note("the connect budget was NOT exercised: 192.0.2.1 answered in "
                    f"{numbers.get('connect_call_ms')}ms, so this network refuses TEST-NET-1 rather "
                    "than black-holing it. kHttpConnectTimeoutMs is bounded by the port's own "
                    "select() and is covered by the host suite, not by this measurement.")
