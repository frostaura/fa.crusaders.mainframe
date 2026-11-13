#!/usr/bin/env python3
"""End-to-end proof of the court-light system with no hardware.

Real API from source + real Postgres + the firmware's native simulator (the Mega
half, over TCP) + the PayFast mountebank imposter. The script plays every part the
missing hardware would: the ESP8266 bridge (the club API key, its MAC, plain HTTP),
the member's phone (login, QR code), the admin (settings, bookings), PayFast (a
signed ITN) and, on the serial side, the bridge again against the simulated Mega.

Stdlib only, by design: urllib / hashlib / socket / subprocess. See README.md
beside this file for what each step proves and which review finding it pins.

Exit status is non-zero on any failed assertion. Every HTTP exchange is recorded and
the failing ones are printed compactly.
"""

from __future__ import annotations

import argparse
import hashlib
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
import traceback
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from decimal import Decimal
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Optional

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9
    ZoneInfo = None  # type: ignore

ROOT = Path(__file__).resolve().parents[2]
API_PROJECT = ROOT / "src" / "backend" / "Crusaders.Mainframe.Api"
API_CSPROJ = API_PROJECT / "Crusaders.Mainframe.Api.csproj"
API_DLL = API_PROJECT / "bin" / "Debug" / "net10.0" / "Crusaders.Mainframe.Api.dll"
IMPOSTER = ROOT / "test" / "virtualization" / "payfast" / "imposter.json"
SIMULATOR = ROOT / "src" / "iot" / "court-box" / ".pio" / "build" / "simulator" / "program"

# The pilot tenant the Development seeder writes. Its PayFast passphrase is drawn fresh per
# database (money lane BM-12), so the money leg sets the club's credentials itself through
# PUT /api/v1/admin/payments/payfast and signs the ITN with what it set. The merchant is
# PayFast's published sandbox merchant, which the seeder also writes.
SEEDED_TENANT = "crusaders"
SCENARIO_PAYFAST_PASSPHRASE = "scenario-passphrase-not-a-real-one"
SEEDED_PAYFAST_MERCHANT_ID = "10000100"
SEEDED_PAYFAST_MERCHANT_KEY = "46f0cd694581a"
SEEDED_MEMBER_M = "MEM-1001"  # Naledi Khoza, Regular — the scanning member
SEEDED_MEMBER_N = "MEM-1003"  # Aisha Patel, Regular — the no-show member
# What M chooses when the temporary password forces a change. Long enough for the
# eight-character minimum, and fixed so a failing run can be re-driven by hand.
M_PASSWORD = "e2e-device-member-pw"

RELAY_HARD_CAP_SECONDS = 5400

# ---------------------------------------------------------------------------
# The panel, as the firmware now drives it.
#
# TWENTY COLUMNS BY FOUR ROWS. The 2004A was always the panel on the wiring
# sheet; what changed is that the firmware stopped driving it as a 16x2 and
# started using all of it (src/iot/court-box/platformio.ini's [lcd] block sets
# LCD_COLS/LCD_ROWS for every environment that composes text, the simulator
# included). Anything here that still assumed two rows of sixteen was asserting
# against a panel this repository no longer builds for.
#
# The numbers are DUPLICATED from the build flags rather than read from them,
# and that is deliberate: a harness that derived the geometry from the same
# place the firmware does could not notice the two disagreeing. `lcd_geometry`
# asserts the transcript's own shape against these before anything reads a row.
# ---------------------------------------------------------------------------
LCD_COLS = 20
LCD_ROWS = 4

#: courtlogic::kIdleLine1 / kIdleLine2 — the landing screen's top two rows (Mega
#: 2.1.0). The call to action LEADS, because the club's fitted panel is a 16x2
#: and rows 2-3 are off-glass there; row 1 is TO PLAY while every court is dark
#: and the lit courts' minutes left (LANDING_SUMMARY) while any is lit.
IDLE_ROW0 = "SCAN YOUR CODE"
IDLE_ROW1 = "TO PLAY"
#: Row 1 of the landing screen with courts lit: `COURT B 45 MIN` for one,
#: four-column cells (`A45 C 5`) for several.
LANDING_SUMMARY = re.compile(r"^(COURT [A-D] \d+ MIN|([A-D][ \d]\d ?)+)$")
#: The one sentence the Mega itself can say about a press it had to drop — on
#: the action row of the 20x4, and on row 1 (HINT_ROW1) for the 16x2.
HINT_ROW = "SCAN YOUR CODE FIRST"
HINT_ROW1 = "SCAN CODE FIRST"
#: courtlogic::kScanFeedbackLine1/2 — painted the instant a scan completes.
SCAN_FEEDBACK_ROW0 = "CHECKING CODE"
SCAN_FEEDBACK_ROW1 = "PLEASE WAIT"
#: courtlogic::kHintFallbackMs — how long a court press forwarded with the window
#: shut waits for the bridge's answer before the Mega paints HINT_ROW1 itself.
HINT_FALLBACK_SECONDS = 1.5
#: courtlogic::kDefaultHoldMs — what `!LCD` and a scan's own feedback hold for.
DEFAULT_HOLD_SECONDS = 10
#: courtlogic::kHintMs and kHintRateLimitMs.
HINT_SECONDS = 3
HINT_RATE_LIMIT_SECONDS = 2
#: proto::kShowHoldMaxSeconds — the ceiling the DECODER clamps every hold into.
SHOW_HOLD_MAX_SECONDS = 120
#: courtlogic::kStateIntervalMs — the periodic `!STATE`, and the ONLY traffic a
#: quiet box is allowed to put on the link.
STATE_INTERVAL_SECONDS = 10
#: The `--start-ms` that puts the 49.7-day millis() rollover four seconds after
#: launch. A box that has been up for forty-nine days and reboots is the NORMAL
#: case for a club box, not an edge case, so every deadline-shaped screen step
#: is run at this base as well as at an ordinary one.
MILLIS_WRAP_START_MS = 4294963200
#: A mid-range base that is not zero, for the ordinary pass. Zero is the one
#: value that makes every widening arithmetic come out right by accident.
ORDINARY_START_MS = 1234567

#: Two LCD frames closer together than this are one BURST — one pass of the
#: firmware's loop, rendered a row at a time by posix_hal::ConsoleDisplay, which
#: repaints the whole panel on every `print()`. Only the LAST frame of a burst is
#: a screen a member could read; the ones before it are the rows of a single
#: repaint arriving one at a time, which is a property of the console transcript
#: and not of the glass. Every real gap in this firmware is a second or longer.
LCD_BURST_GAP_SECONDS = 0.15

# The weekday keys tenant_settings.operating_hours uses, and the close this run sets for
# every one of them. See seed_and_tune for why the club is opened all day.
DAY_KEYS = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")
OPEN_ALL_DAY_END_MINUTE = 23 * 60 + 59


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


@dataclass
class Exchange:
    method: str
    url: str
    request_body: Optional[str]
    status: int
    response_body: str
    headers: dict

    def compact(self) -> str:
        req = (self.request_body or "")[:600]
        resp = (self.response_body or "")[:600]
        return f"{self.method} {self.url} -> {self.status}\n    req:  {req}\n    resp: {resp}"


@dataclass
class Check:
    finding: str
    description: str
    ok: bool
    detail: str = ""
    #: A check that could not run because the thing it asserts about is not built
    #: yet. It is neither a pass nor a failure and is counted as neither — but it
    #: is PRINTED, loudly and by name, because a step that silently passes when
    #: its feature is missing is worse than no step at all.
    skipped: bool = False


class Report:
    """The finding-id -> assertion mapping, plus the evidence behind a failure."""

    def __init__(self) -> None:
        self.checks: list[Check] = []
        self.exchanges: list[Exchange] = []
        self.notes: list[str] = []

    def record(self, ex: Exchange) -> None:
        self.exchanges.append(ex)

    def check(self, finding: str, description: str, ok: bool, detail: str = "") -> bool:
        self.checks.append(Check(finding, description, bool(ok), detail))
        mark = "PASS" if ok else "FAIL"
        line = f"  [{mark}] {finding:<8} {description}"
        if detail:
            line += f"  -- {detail}"
        print(line, flush=True)
        if not ok and self.exchanges:
            print("        last exchange: " + self.exchanges[-1].compact().replace("\n", "\n        "), flush=True)
        return bool(ok)

    def skip(self, finding: str, description: str, missing: str, where: str) -> bool:
        """This step's subject does not exist yet — say so by NAME, and run nothing.

        `missing` is the wire field and `where` the endpoint that would carry it,
        both spelled exactly as the firmware reads them, because the whole value of
        a skip is that somebody reading the run can tell a feature that has not
        landed from an assertion that has quietly stopped asserting. Returns False
        so a caller can `if REPORT.skip(...): return` read naturally either way."""
        text = f"{description}  [SKIPPED: `{missing}` is absent from {where}]"
        self.checks.append(Check(finding, text, True, "", skipped=True))
        print(f"  [SKIP] {finding:<8} {description}", flush=True)
        print(f"         nothing was asserted: `{missing}` is absent from {where}.", flush=True)
        return False

    def note(self, text: str) -> None:
        self.notes.append(text)
        print(f"  [note] {text}", flush=True)

    @property
    def failed(self) -> list[Check]:
        return [c for c in self.checks if not c.ok and not c.skipped]

    @property
    def skipped(self) -> list[Check]:
        return [c for c in self.checks if c.skipped]

    def summary(self) -> str:
        lines = ["", "finding-id -> assertion", "-" * 72]
        for c in self.checks:
            mark = "SKIP" if c.skipped else ("PASS" if c.ok else "FAIL")
            lines.append(f"  {mark}  {c.finding:<8} {c.description}")
        lines.append("-" * 72)
        total = len(self.checks) - len(self.skipped)
        lines.append(f"  {total - len(self.failed)}/{total} assertions passed")
        if self.skipped:
            lines.append(f"  {len(self.skipped)} step(s) SKIPPED for a field the API does not serve yet:")
            lines.extend(f"      {c.finding:<12} {c.description}" for c in self.skipped)
        if self.notes:
            lines.append("")
            lines.append("notes:")
            lines.extend(f"  - {n}" for n in self.notes)
        lines.append("")
        lines.append("RESULT: " + ("PASS" if not self.failed else "FAIL"))
        return "\n".join(lines)


REPORT = Report()


class StepFailed(Exception):
    """A precondition a later assertion depends on did not hold."""


def step(title: str) -> None:
    print(f"\n== {title}", flush=True)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


_FRACTION = re.compile(r"\.(\d+)")


def parse_dt(text: str) -> datetime:
    """A .NET timestamp, as a datetime, on every Python this repo runs on.

    `fromisoformat` before 3.11 accepts a fractional second of EXACTLY three or six
    digits and nothing else. .NET writes up to seven and its serialiser trims
    trailing zeros, so the same endpoint answers `.2717739` on one call and `.69739`
    on the next — and the second one raised `ValueError: Invalid isoformat string`
    on the founder's system Python (3.9). The previous rule here only TRUNCATED a
    long fraction, which is the seven-digit case; it could not lengthen a short one,
    so roughly one timestamp in ten crashed whichever step happened to read it. CI
    runs 3.12, where the parser is permissive, so nothing went red there.

    Normalised to exactly six digits instead: pad or trim, whichever it needs.
    """
    text = text.replace("Z", "+00:00")
    return datetime.fromisoformat(
        _FRACTION.sub(lambda m: "." + (m.group(1) + "000000")[:6], text, count=1))


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def tcp_open(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def dec(value: Any) -> Decimal:
    """
    Rand, as a decimal — never a float.

    Every money assertion in this file is an equality. Rand carries cents, and float
    equality on cents is not equality (`451.33 + 160 == 611.33` is False in binary
    floating point), so a rand figure is compared as a Decimal.
    """
    return Decimal(str(value))


def mins(value: Any) -> int:
    """
    Minutes, the ledger's unit (docs/specs/minutes-and-packages.md §1.1): a JSON integer,
    never `50.0`. A fractional or non-integral value is a wire defect, so it is refused
    here rather than rounded into agreement — an assertion that compares it fails loudly.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise StepFailed(f"a minutes figure on the wire is not a JSON integer: {value!r}")
    return value


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802
        return None


_OPENER = urllib.request.build_opener(NoRedirect())


@dataclass
class Resp:
    status: int
    headers: dict
    json: Any
    text: str

    def __getitem__(self, key: str) -> Any:
        if not isinstance(self.json, dict):
            raise KeyError(f"response is not a JSON object: {self.text[:200]}")
        return self.json[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.json.get(key, default) if isinstance(self.json, dict) else default


class Http:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")

    def call(
        self,
        method: str,
        path: str,
        body: Any = None,
        token: Optional[str] = None,
        headers: Optional[dict] = None,
        raw: Optional[bytes] = None,
        content_type: Optional[str] = None,
        timeout: float = 60,
        absolute: bool = False,
    ) -> Resp:
        url = path if absolute else self.base + path
        data: Optional[bytes] = None
        hdrs = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        if raw is not None:
            data = raw
            hdrs["Content-Type"] = content_type or "application/octet-stream"
        if token:
            hdrs["Authorization"] = "Bearer " + token
        if headers:
            hdrs.update(headers)
        req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            with _OPENER.open(req, timeout=timeout) as r:
                status, raw_resp, rh = r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            status, raw_resp, rh = e.code, e.read(), dict(e.headers)
        text = raw_resp.decode("utf-8", "replace")
        try:
            parsed = json.loads(text) if text else None
        except json.JSONDecodeError:
            parsed = None
        REPORT.record(Exchange(method, url, data.decode("utf-8", "replace") if data else None, status, text, rh))
        return Resp(status, rh, parsed, text)

    def get(self, path: str, **kw: Any) -> Resp:
        return self.call("GET", path, **kw)

    def post(self, path: str, body: Any = None, **kw: Any) -> Resp:
        return self.call("POST", path, body=body, **kw)

    def put(self, path: str, body: Any = None, **kw: Any) -> Resp:
        return self.call("PUT", path, body=body, **kw)

    def patch(self, path: str, body: Any = None, **kw: Any) -> Resp:
        return self.call("PATCH", path, body=body, **kw)


def expect_status(resp: Resp, status: int, what: str) -> Resp:
    if resp.status != status:
        raise StepFailed(f"{what}: expected HTTP {status}, got {resp.status}: {resp.text[:400]}")
    return resp


# ---------------------------------------------------------------------------
# The device credential: one static club key, and the box's MAC in the body
# ---------------------------------------------------------------------------


class DeviceClient:
    """A box on the club LAN: bearer key in the header, MAC in every body."""

    def __init__(self, http: Http, api_key: str, mac: str) -> None:
        self.http = http
        self.api_key = api_key
        self.mac = mac

    def call(self, method: str, path: str, body: Any, api_key: Optional[str] = None, mac: Optional[str] = None) -> Resp:
        """A device request. `mac` is spliced in here rather than at every call site,
        because every device request carries it and none of them is about it."""
        payload = dict(body or {})
        payload["mac"] = self.mac if mac is None else mac
        headers = {"Authorization": "Bearer " + (self.api_key if api_key is None else api_key)}
        return self.http.call(
            method, path,
            raw=json.dumps(payload).encode("utf-8"),
            content_type="application/json",
            headers=headers,
        )

    def heartbeat(self, **extra: Any) -> Resp:
        body = {"firmware_version": "2.0.0", "mega_version": "2.0.0", "uptime_ms": 5000}
        body.update(extra)
        return self.call("POST", "/api/v1/device/heartbeat", body)


def corpus_request_vectors() -> list[dict]:
    """The shared corpus's device requests, as the firmware writes them."""
    cases = json.loads((ROOT / "src" / "contracts" / "device-protocol" / "http" / "cases.json").read_text())
    return cases.get("requests", [])


def selftest_device_contract() -> None:
    """Pin this script's idea of a device request to the shared corpus before trusting
    it against the API. There is no signing left to self-test — the whole of the
    credential is a bearer header and a `mac` — so what is checked is that both are
    where this script puts them."""
    saw_bearer = False
    saw_mac = False
    for case in corpus_request_vectors():
        for value in case.values():
            if isinstance(value, str) and value.startswith("Bearer ") and len(value) > len("Bearer "):
                saw_bearer = True
        body_hex = case.get("body_hex") or ""
        if not body_hex:
            continue
        body = json.loads(bytes.fromhex(body_hex))
        mac = body.get("mac")
        if mac is None:
            continue
        if mac != mac.lower() or len(mac) != 12:
            raise StepFailed(f"corpus vector {case.get('id')} carries a mac the API would not normalise: {mac!r}")
        saw_mac = True
    if not saw_bearer:
        raise StepFailed("no corpus request vector carries an Authorization: Bearer header")
    if not saw_mac:
        raise StepFailed("no corpus request vector carries a `mac` in its body")


def selftest_serial_codec() -> None:
    """Pin this script's serial codec to the shared corpus, byte for byte.

    The corpus's `encode` vectors carry the exact bytes the firmware puts on the
    wire, checksums included, produced independently of `Codec.cpp`. Framing a
    corpus case here and comparing bytes therefore checks BOTH halves of the
    codec — the escaping and `xor_checksum` — against the same authority the C++
    tests read, rather than against this script's own opinion of itself.

    This exists because `xor_checksum` went missing (finding F12) and nothing
    said so: it is called only from `serial_frame` / `serial_parse`, so every
    serial step raised `NameError` several minutes into a run, after the API and
    Postgres had been built and started. A preflight that frames one corpus case
    fails in the first second instead.
    """
    cases = json.loads((ROOT / "src" / "contracts" / "device-protocol" / "serial" / "cases.json").read_text())
    encodes = [c for c in cases.get("encode", []) if c.get("kind") == "encode_v2" and c.get("bytes")]
    if not encodes:
        raise StepFailed("the serial corpus carries no encode_v2 vectors to pin the codec against")
    checked = 0
    for case in encodes:
        frame = case["frame"]
        expected = case["bytes"]
        args = list(frame.get("args", []))
        # Some vectors encode an argument the FIRMWARE rewrites before framing
        # (ON,D,60000 -> the 90-minute relay cap). That is the court box's rule,
        # not the wire format's, so pin only the vectors whose arguments reach
        # the wire verbatim. The checksum compared is still the corpus's own.
        # Compared as the whole framed body, not as a substring of the bytes:
        # `"0" in "!LIVE,1*0B"` is true (the checksum holds a 0), which is how the
        # v3 clamp vectors slipped past this filter as "verbatim".
        verbatim = "!" + ",".join([frame["verb"], *args]) + "*"
        if not expected.startswith(verbatim):
            continue
        got = serial_frame(frame["verb"], *args).decode()
        if got != expected:
            raise StepFailed(
                f"serial codec disagrees with corpus vector {case.get('id')}: "
                f"framed {got!r}, corpus says {expected!r}")
        parsed = serial_parse(expected)
        if parsed is None or parsed.verb != frame["verb"] or parsed.args != args:
            raise StepFailed(f"serial_parse could not read back corpus vector {case.get('id')}: {parsed}")
        checked += 1
    if checked == 0:
        raise StepFailed("no serial corpus vector was usable to pin the codec")
    # And a corrupted frame must be refused rather than quietly accepted, which
    # is the only property the checksum field exists for.
    good = encodes[0]["bytes"].rstrip("\n")
    star = good.rfind("*")
    corrupted = good[:star] + "*" + ("00" if good[star + 1:] != "00" else "01")
    refused = serial_parse(corrupted)
    if refused is None or refused.verb != "BADCRC?":
        raise StepFailed(f"serial_parse accepted a frame whose checksum does not match: {corrupted!r}")


# ---------------------------------------------------------------------------
# Serial protocol: !VERB,arg,arg*CC
# ---------------------------------------------------------------------------


def serial_escape(arg: str) -> str:
    return arg.replace("%", "%25").replace(",", "%2C")


def serial_unescape(arg: str) -> str:
    return arg.replace("%2C", ",").replace("%25", "%")


def xor_checksum(body: bytes) -> str:
    """The frame checksum, exactly as `proto::Codec` computes it.

    XOR of every byte of the frame BODY — what sits between the leading `!` and
    the `*`, escaping already applied, because the checksum covers what is on
    the wire — rendered as two UPPERCASE hex digits. Uppercase is not cosmetic:
    `Codec.cpp`'s `hexValue` rejects lowercase deliberately, so a lowercase
    digit here would make every frame this harness sends a BADCRC.

    This function was lost in d67f98e and nothing noticed, because it is called
    only from `serial_frame` / `serial_parse` and every serial step therefore
    died on `NameError` before it could assert anything — the harness that gates
    all six image builds could not run at all. See `test_serial_codec`, which
    pins it against the corpus.
    """
    cs = 0
    for b in body:
        cs ^= b
    return f"{cs:02X}"


def serial_frame(verb: str, *args: str) -> bytes:
    body = verb + "".join("," + serial_escape(a) for a in args)
    return ("!" + body + "*" + xor_checksum(body.encode()) + "\n").encode()


@dataclass
class Frame:
    verb: str
    args: list[str]
    raw: str

    def __str__(self) -> str:
        return self.raw


def serial_parse(line: str) -> Optional[Frame]:
    line = line.rstrip("\r\n")
    if not line.startswith("!"):
        return None
    star = line.rfind("*")
    if star < 0 or len(line) - star != 3:
        return None
    body = line[1:star]
    if xor_checksum(body.encode()) != line[star + 1:]:
        return Frame("BADCRC?", [], line)
    parts = body.split(",")
    return Frame(parts[0], [serial_unescape(p) for p in parts[1:]], line)


# ---------------------------------------------------------------------------
# PayFast: PHP urlencode + MD5, the corpus-pinned algorithm
# ---------------------------------------------------------------------------


def php_urlencode(value: str) -> str:
    out = []
    for b in value.encode("utf-8"):
        c = chr(b)
        if c.isascii() and (c.isalnum() or c in "_.-"):
            out.append(c)
        elif c == " ":
            out.append("+")
        else:
            out.append(f"%{b:02X}")
    return "".join(out)


def payfast_signature(fields: list[tuple[str, str]], passphrase: Optional[str]) -> str:
    parts = [f"{k}={php_urlencode(v)}" for k, v in fields if v]
    if passphrase:
        parts.append(f"passphrase={php_urlencode(passphrase)}")
    return hashlib.md5("&".join(parts).encode("utf-8")).hexdigest()


def form_encode(fields: list[tuple[str, str]]) -> bytes:
    return "&".join(f"{urllib.parse.quote(k, safe='')}={urllib.parse.quote(v, safe='')}" for k, v in fields).encode()


# ---------------------------------------------------------------------------
# Infrastructure: Postgres, API, mountebank, simulator
# ---------------------------------------------------------------------------


@dataclass
class Config:
    pg_host: str = os.environ.get("E2E_PG_HOST", "localhost")
    pg_port: int = int(os.environ.get("E2E_PG_PORT", "5439"))
    pg_user: str = os.environ.get("E2E_PG_USER", "crusaders")
    pg_password: str = os.environ.get("E2E_PG_PASSWORD", "crusaders_test_pw")
    pg_container: str = os.environ.get("E2E_PG_CONTAINER", "crusaders-fixprog-pg")
    pg_image: str = os.environ.get("E2E_PG_IMAGE", "postgres:16-alpine")
    dotnet: str = os.environ.get("DOTNET", "dotnet")
    pio: str = os.environ.get("PIO", str(ROOT / "src" / "iot" / ".venv" / "bin" / "pio"))
    npx: str = os.environ.get("NPX", "npx")
    mb_port: int = int(os.environ.get("E2E_MB_PORT", "4545"))
    mb_admin_port: int = int(os.environ.get("E2E_MB_ADMIN_PORT", "2525"))
    smtp_port: Optional[int] = int(os.environ["E2E_SMTP_PORT"]) if os.environ.get("E2E_SMTP_PORT") else None
    keep_db: bool = os.environ.get("E2E_KEEP_DB", "") == "1"
    skip_build: bool = os.environ.get("E2E_SKIP_BUILD", "") == "1"
    workdir: Path = field(default_factory=lambda: ROOT / ".tmp" / "e2e-device" / datetime.now().strftime("run-%Y%m%d-%H%M%S"))


class Postgres:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.started_container = False

    def ensure(self) -> None:
        if tcp_open(self.cfg.pg_host, self.cfg.pg_port):
            print(f"  postgres already answering on {self.cfg.pg_host}:{self.cfg.pg_port}")
            return
        if not shutil.which("docker"):
            raise StepFailed(f"nothing on {self.cfg.pg_host}:{self.cfg.pg_port} and docker is not available to start it")
        print(f"  starting throwaway postgres container {self.cfg.pg_container} on :{self.cfg.pg_port}")
        start = subprocess.run(["docker", "start", self.cfg.pg_container], capture_output=True, text=True)
        if start.returncode != 0:
            run = subprocess.run(
                [
                    "docker", "run", "-d", "--name", self.cfg.pg_container,
                    "-p", f"{self.cfg.pg_port}:5432",
                    "-e", f"POSTGRES_USER={self.cfg.pg_user}",
                    "-e", f"POSTGRES_PASSWORD={self.cfg.pg_password}",
                    "-e", "POSTGRES_DB=crusaders_mainframe_test",
                    self.cfg.pg_image,
                ],
                capture_output=True, text=True,
            )
            if run.returncode != 0:
                raise StepFailed(f"docker run failed: {run.stderr.strip()}")
        self.started_container = True
        deadline = time.time() + 60
        while time.time() < deadline:
            if tcp_open(self.cfg.pg_host, self.cfg.pg_port):
                time.sleep(2)  # the port opens before the server accepts logins
                return
            time.sleep(1)
        raise StepFailed("postgres did not start listening within 60s")

    def connection_string(self, database: str) -> str:
        return (
            f"Host={self.cfg.pg_host};Port={self.cfg.pg_port};Database={database};"
            f"Username={self.cfg.pg_user};Password={self.cfg.pg_password}"
        )

    def drop(self, database: str) -> None:
        sql = f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)'
        env = dict(os.environ, PGPASSWORD=self.cfg.pg_password)
        if shutil.which("psql"):
            cmd = ["psql", "-h", self.cfg.pg_host, "-p", str(self.cfg.pg_port), "-U", self.cfg.pg_user, "-d", "postgres", "-c", sql]
            r = subprocess.run(cmd, env=env, capture_output=True, text=True)
        elif shutil.which("docker"):
            cmd = ["docker", "exec", self.cfg.pg_container, "psql", "-U", self.cfg.pg_user, "-d", "postgres", "-c", sql]
            r = subprocess.run(cmd, capture_output=True, text=True)
        else:
            print(f"  (no psql or docker on PATH — database {database} left in place)")
            return
        print(f"  dropped {database}" if r.returncode == 0 else f"  could not drop {database}: {r.stderr.strip()}")


class LineReader(threading.Thread):
    """Pumps a pipe into a queue so a subprocess never blocks on a full stdout."""

    def __init__(self, stream, sink: Path, q: "queue.Queue[str]") -> None:
        super().__init__(daemon=True)
        self.stream = stream
        self.sink = sink
        self.q = q

    def run(self) -> None:
        with open(self.sink, "a", encoding="utf-8", errors="replace") as f:
            for raw in iter(self.stream.readline, b""):
                line = raw.decode("utf-8", "replace")
                f.write(line)
                f.flush()
                self.q.put(line.rstrip("\r\n"))


class ApiProcess:
    def __init__(self, cfg: Config, connection_string: str) -> None:
        self.cfg = cfg
        self.connection_string = connection_string
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.proc: Optional[subprocess.Popen] = None
        self.log = cfg.workdir / "api.log"
        self.lines: "queue.Queue[str]" = queue.Queue()

    def build(self) -> None:
        env = dict(os.environ, MSBuildEnableWorkloadResolver="false", DOTNET_CLI_TELEMETRY_OPTOUT="1", DOTNET_NOLOGO="1")
        # MSB3021 on this iCloud volume: MSBuild's copy of appsettings*.json into bin/ is
        # denied on create and allowed on overwrite. Pre-seeding the files is harmless
        # everywhere else. See memory/gotchas.md.
        bin_dir = API_DLL.parent
        bin_dir.mkdir(parents=True, exist_ok=True)
        for name in ("appsettings.json", "appsettings.Development.json"):
            target = bin_dir / name
            if not target.exists():
                shutil.copyfile(API_PROJECT / name, target)
        print(f"  dotnet build {API_CSPROJ.name} ...")
        r = subprocess.run(
            [self.cfg.dotnet, "build", str(API_CSPROJ), "--nologo", "-v", "q", "-c", "Debug"],
            cwd=str(API_PROJECT), env=env, capture_output=True, text=True,
        )
        if r.returncode != 0:
            raise StepFailed("dotnet build failed:\n" + (r.stdout + r.stderr)[-4000:])
        if not API_DLL.exists():
            raise StepFailed(f"build succeeded but {API_DLL} is missing")

    def start(self) -> None:
        media = self.cfg.workdir / "media"
        media.mkdir(parents=True, exist_ok=True)
        # The content root is a scratch directory holding fresh copies of appsettings*.json,
        # not the project directory. A checkout under a dot-directory on macOS (a
        # `.claude/worktrees/...` worktree, say) carries the BSD `hidden` flag on every
        # file, and .NET's PhysicalFileProvider excludes Hidden files by default — so the
        # app boots with no appsettings at all and dies on "Jwt:Secret is required" while
        # the file sits right there. A byte-for-byte copy has no flag.
        content_root = self.cfg.workdir / "api-root"
        content_root.mkdir(parents=True, exist_ok=True)
        for name in ("appsettings.json", "appsettings.Development.json"):
            (content_root / name).write_bytes((API_PROJECT / name).read_bytes())
        env = dict(os.environ)
        env.update({
            "MSBuildEnableWorkloadResolver": "false",
            "ASPNETCORE_ENVIRONMENT": "Development",  # runs the Seeder: tenant, admin, 4 courts, sample members
            "ASPNETCORE_URLS": self.base,
            "ConnectionStrings__DefaultConnection": self.connection_string,
            "Database__AutoMigrateOnStartup": "true",
            "Media__StoragePath": str(media),
            "Biometric__TemplateStorePath": str(self.cfg.workdir / "biometric"),
            "RateLimits__AuthPerMinute": "1000",  # the scenario makes more auth calls per minute than a club does
            "RateLimits__DevicePerMinute": "100000",
            "RateLimits__GlobalPerMinute": "100000",
            # The ITN's server-side confirmation (payments-payfast.md) goes to the imposter, which
            # answers VALID, instead of PayFast's sandbox, which knows nothing of these payments.
            "PayFast__ValidateUrl": f"http://127.0.0.1:{self.cfg.mb_port}/eng/query/validate",
            "Smtp__Host": "127.0.0.1",
            "Smtp__Port": str(self.cfg.smtp_port or 1),  # port 1 refuses instantly; MailHog on E2E_SMTP_PORT if wanted
            "Logging__LogLevel__Default": "Information",
            "Logging__LogLevel__Microsoft.AspNetCore": "Warning",
            "Logging__LogLevel__Microsoft.EntityFrameworkCore": "Warning",
            "Logging__LogLevel__Microsoft.Hosting.Lifetime": "Information",
        })
        self.proc = subprocess.Popen(
            [self.cfg.dotnet, str(API_DLL)], cwd=str(content_root), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        )
        LineReader(self.proc.stdout, self.log, self.lines).start()
        deadline = time.time() + 180
        http = Http(self.base)
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise StepFailed(f"API exited with {self.proc.returncode} during startup; see {self.log}")
            try:
                if http.get("/healthz", timeout=3).status == 200:
                    print(f"  API up at {self.base}, log {self.log}")
                    return
            except OSError:
                pass
            time.sleep(1)
        raise StepFailed(f"API did not answer /healthz within 180s; see {self.log}")

    def tail(self, n: int = 40) -> str:
        try:
            return "\n".join(self.log.read_text(errors="replace").splitlines()[-n:])
        except OSError:
            return ""

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(15)
            except subprocess.TimeoutExpired:
                self.proc.kill()


class Mountebank:
    """The PayFast imposter from test/virtualization/payfast/imposter.json."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.proc: Optional[subprocess.Popen] = None
        self.reused = False
        self.base = f"http://127.0.0.1:{cfg.mb_port}"

    def start(self) -> None:
        admin = Http(f"http://127.0.0.1:{self.cfg.mb_admin_port}")
        try:
            if admin.get(f"/imposters/{self.cfg.mb_port}", timeout=2).status == 200:
                self.reused = True
                print(f"  PayFast imposter already up on :{self.cfg.mb_port} (reusing it)")
                return
        except OSError:
            pass
        if not shutil.which(self.cfg.npx):
            raise StepFailed("npx is required for the PayFast imposter (same as make virt-up)")
        log = self.cfg.workdir / "mountebank.log"
        # cwd is the scratch dir and the logfile is named explicitly: mountebank writes
        # `mb.log` into whatever directory it starts in, which must not be the repo.
        self.proc = subprocess.Popen(
            [self.cfg.npx, "--yes", "mountebank@2.9.1", "start", "--configfile", str(IMPOSTER),
             "--port", str(self.cfg.mb_admin_port), "--logfile", str(self.cfg.workdir / "mb.log")],
            cwd=str(self.cfg.workdir), stdout=open(log, "ab"), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        )
        deadline = time.time() + 120
        while time.time() < deadline:
            try:
                if admin.get(f"/imposters/{self.cfg.mb_port}", timeout=2).status == 200:
                    print(f"  PayFast imposter on :{self.cfg.mb_port} (admin :{self.cfg.mb_admin_port}), log {log}")
                    return
            except OSError:
                pass
            if self.proc.poll() is not None:
                raise StepFailed(f"mountebank exited with {self.proc.returncode}; see {log}")
            time.sleep(1)
        raise StepFailed(f"mountebank did not load the imposter within 120s; see {log}")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()


@dataclass
class LcdFrame:
    """One whole panel, as posix_hal::ConsoleDisplay printed it.

    `rows` is always LCD_ROWS strings of exactly LCD_COLS characters, spaces
    included, because the padding IS the assertion in several places: the port
    does not pad, so a row that is short on the glass is a row with the previous
    message's tail still on it."""

    at: float
    rows: list[str]

    def row(self, index: int) -> str:
        return self.rows[index] if index < len(self.rows) else ""

    def text(self) -> str:
        return " / ".join(r.rstrip() for r in self.rows)


def lcd_pad(text: str) -> str:
    """A row as the firmware writes it: padded to the full width, then clipped."""
    return text.ljust(LCD_COLS)[:LCD_COLS]


def is_landing(frame: "LcdFrame") -> bool:
    """The Mega's own landing screen: SCAN YOUR CODE over TO PLAY, or over the lit
    courts' minutes left (Mega 2.1.0). A hint on row 1 is NOT the landing screen."""
    row1 = frame.row(1).rstrip()
    return frame.row(0) == lcd_pad(IDLE_ROW0) and (row1 == IDLE_ROW1 or bool(LANDING_SUMMARY.match(row1)))


class Simulator:
    """The firmware's Mega half: courtlogic::CourtBox over posix_hal, one TCP peer."""

    def __init__(self, cfg: Config, name: str = "simulator", start_ms: Optional[int] = None) -> None:
        self.cfg = cfg
        self.name = name
        #: What the board's millis() reads at launch. See MILLIS_WRAP_START_MS.
        self.start_ms = start_ms
        self.proc: Optional[subprocess.Popen] = None
        self.port = 0
        self.stdout: "queue.Queue[str]" = queue.Queue()
        self.stdout_seen: list[str] = []
        self.frames: "queue.Queue[Frame]" = queue.Queue()
        self.frames_seen: list[Frame] = []
        self.sock: Optional[socket.socket] = None
        self.log = cfg.workdir / f"{name}.log"
        #: Every whole panel the board has ever painted, in order. Kept rather
        #: than consumed so an assertion can look BACKWARDS as well as wait
        #: forwards: the screen a step is about is frequently already painted by
        #: the time Python has come back round to look for it.
        self.lcd_frames: list[LcdFrame] = []
        self._lcd_rows: list[str] = []
        self._lcd_lock = threading.Lock()

    def ensure_built(self) -> None:
        if SIMULATOR.exists():
            return
        if not Path(self.cfg.pio).exists() and not shutil.which(self.cfg.pio):
            raise StepFailed(f"{SIMULATOR} is missing and no pio to build it (set PIO=)")
        print("  building the native simulator (pio run -e simulator) ...")
        r = subprocess.run([self.cfg.pio, "run", "-d", str(ROOT / "src" / "iot" / "court-box"), "-e", "simulator"], capture_output=True, text=True)
        if r.returncode != 0 or not SIMULATOR.exists():
            raise StepFailed("simulator build failed:\n" + (r.stdout + r.stderr)[-3000:])

    def start(self) -> None:
        store = self.cfg.workdir / f"{self.name}-store"
        store.mkdir(parents=True, exist_ok=True)
        argv = [str(SIMULATOR), "--port", "0", "--store", str(store)]
        if self.start_ms is not None:
            argv += ["--start-ms", str(self.start_ms)]
        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=str(self.cfg.workdir),
        )
        LineReader(self.proc.stdout, self.log, self.stdout).start()
        # ONE consumer of the stdout queue, started before anything waits on it.
        # `expect_stdout` used to drain the queue itself, which meant a line
        # nobody happened to be waiting for was thrown away — and the LCD
        # transcript is almost entirely lines nobody is waiting for at the
        # instant they are printed.
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        first = self.expect_stdout(lambda l: l.startswith("[sim] listening on 127.0.0.1:"), 10)
        self.port = int(first.rsplit(":", 1)[1])
        clock = f", millis() starts at {self.start_ms}" if self.start_ms is not None else ""
        print(f"  {self.name} (Mega half) listening on 127.0.0.1:{self.port}{clock}, log {self.log}")

    # -- the glass -----------------------------------------------------------

    def _pump_stdout(self) -> None:
        """Drain the process's stdout for ever, assembling whole panels.

        `ConsoleDisplay::render` prints every row of the panel on every change,
        so LCD_ROWS consecutive `[lcd]` lines are one frame. Anything else ends
        a partial frame rather than being folded into it."""
        while True:
            line = self.stdout.get()
            self.stdout_seen.append(line)
            if line.startswith("[lcd] |") and line.endswith("|"):
                self._lcd_rows.append(line[len("[lcd] |"):-1])
                if len(self._lcd_rows) >= LCD_ROWS:
                    with self._lcd_lock:
                        self.lcd_frames.append(LcdFrame(time.monotonic(), self._lcd_rows))
                    self._lcd_rows = []
            elif self._lcd_rows:
                # A torn render: rows printed and then something else. Kept as a
                # short frame rather than dropped, so a panel that stopped
                # painting a row shows up as a malformed frame rather than as
                # silence.
                with self._lcd_lock:
                    self.lcd_frames.append(LcdFrame(time.monotonic(), self._lcd_rows))
                self._lcd_rows = []

    def lcd_mark(self) -> int:
        """A cursor into the LCD transcript: "because of what I just did"."""
        with self._lcd_lock:
            return len(self.lcd_frames)

    def lcd_since(self, mark: int = 0) -> list[LcdFrame]:
        with self._lcd_lock:
            return list(self.lcd_frames[mark:])

    def settled_since(self, mark: int = 0) -> list[LcdFrame]:
        """Only the frames a member could actually have read.

        One repaint of the panel reaches this transcript as up to LCD_ROWS
        frames, because the console port redraws on every `print()` and the
        firmware paints a row at a time. The intermediate ones are microseconds
        apart and are an artefact of the transcript; the LAST frame of each
        burst is the screen. Every deadline in this firmware is a second or
        more, so the two can be told apart by the gap alone.

        The newest frame is settled only once the gap has passed with nothing
        after it: read sooner, it can be row 0 of a repaint whose row 1 has not
        arrived yet (seen on CI: `CHECKING CODE / TO PLAY`)."""
        frames = self.lcd_since(mark)
        now = time.monotonic()
        out: list[LcdFrame] = []
        for i, frame in enumerate(frames):
            last = i + 1 == len(frames)
            if (now - frame.at > LCD_BURST_GAP_SECONDS) if last else (frames[i + 1].at - frame.at > LCD_BURST_GAP_SECONDS):
                out.append(frame)
        return out

    def screen(self) -> LcdFrame:
        """What is on the glass right now, blank if it has never been painted."""
        with self._lcd_lock:
            if self.lcd_frames:
                return self.lcd_frames[-1]
        return LcdFrame(time.monotonic(), [" " * LCD_COLS] * LCD_ROWS)

    def expect_screen(self, pred: Callable[[LcdFrame], bool], timeout: float, what: str,
                      mark: int = 0) -> LcdFrame:
        """Wait for a SETTLED screen matching `pred`, looking backwards first."""
        deadline = time.time() + timeout
        while True:
            for frame in self.settled_since(mark):
                if pred(frame):
                    return frame
            if time.time() >= deadline:
                recent = " | ".join(f.text() for f in self.settled_since(mark)[-4:])
                raise StepFailed(f"the panel never showed {what} within {timeout:.0f}s (recent: {recent})")
            time.sleep(0.05)

    def expect_landing(self, timeout: float, mark: int = 0) -> LcdFrame:
        """The landing screen, which is the only screen with no deadline on it.

        IT ASKS WHAT THE GLASS SAYS, NOT WHETHER IT REPAINTED. The simulator's
        console display writes stdout only when the grid actually CHANGES — a
        court box repaints its rows on a schedule and echoing every identical
        repaint would bury the relay and protocol lines in the same transcript —
        so `!RST` while the landing screen is already up produces no `[lcd]`
        line at all. Waiting for a frame there is waiting for a repaint that
        correctly never comes, and it is the wrong question: this predicate is
        about a steady state, and the steady state may already be true."""
        already = self.screen()
        if is_landing(already):
            return already
        return self.expect_screen(is_landing, timeout, "the landing screen", mark)

    def no_screen(self, pred: Callable[[LcdFrame], bool], window: float, mark: int) -> bool:
        """True when no settled screen in the window matches — a refusal's claim."""
        time.sleep(window)
        return not any(pred(f) for f in self.settled_since(mark))

    # -- the link ------------------------------------------------------------

    def frame_mark(self) -> int:
        return len(self.frames_seen)

    def frames_after(self, mark: int) -> list[Frame]:
        return list(self.frames_seen[mark:])

    def connect(self) -> None:
        self.sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        buf = b""
        assert self.sock is not None
        self.sock.settimeout(None)
        while True:
            try:
                chunk = self.sock.recv(4096)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                frame = serial_parse(line.decode("utf-8", "replace"))
                if frame is not None:
                    self.frames_seen.append(frame)
                    self.frames.put(frame)

    def send(self, verb: str, *args: str) -> None:
        assert self.sock is not None
        self.sock.sendall(serial_frame(verb, *args))

    def send_raw(self, line: bytes) -> None:
        assert self.sock is not None
        self.sock.sendall(line)

    def console(self, command: str) -> None:
        assert self.proc is not None and self.proc.stdin is not None
        self.proc.stdin.write((command + "\n").encode())
        self.proc.stdin.flush()

    def expect_frame(self, pred: Callable[[Frame], bool], timeout: float, what: str) -> Frame:
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                recent = ", ".join(str(f) for f in self.frames_seen[-6:])
                raise StepFailed(f"no {what} from the simulator within {timeout}s (recent: {recent})")
            try:
                frame = self.frames.get(timeout=remaining)
            except queue.Empty:
                continue
            if pred(frame):
                return frame

    def no_frame(self, pred: Callable[[Frame], bool], window: float) -> bool:
        """True when nothing matching arrives inside the window (frames are kept for later)."""
        deadline = time.time() + window
        held: list[Frame] = []
        found = False
        while time.time() < deadline:
            try:
                frame = self.frames.get(timeout=max(0.01, deadline - time.time()))
            except queue.Empty:
                break
            held.append(frame)
            if pred(frame):
                found = True
        for f in held:
            self.frames.put(f)
        return not found

    def stdout_mark(self) -> int:
        return len(self.stdout_seen)

    def expect_stdout(self, pred: Callable[[str], bool], timeout: float, mark: int = 0) -> str:
        """Wait for a stdout line, looking BACKWARDS from `mark` first.

        It used to consume the queue, which made it the only reader and threw
        away everything it was not waiting for at that instant. `_pump_stdout`
        is the single consumer now, so this scans what has already arrived and
        then waits — which is also what makes it safe to ask for a line the
        board printed while Python was busy elsewhere."""
        deadline = time.time() + timeout
        seen = mark
        while True:
            lines = self.stdout_seen[seen:]
            seen += len(lines)
            for line in lines:
                if pred(line):
                    return line
            if time.time() >= deadline:
                raise StepFailed(f"simulator stdout never matched within {timeout}s (recent: {self.stdout_seen[-5:]})")
            time.sleep(0.02)

    def stop(self) -> None:
        try:
            if self.sock:
                self.sock.close()
        except OSError:
            pass
        if self.proc and self.proc.poll() is None:
            try:
                self.console("quit")
                self.proc.wait(5)
            except (OSError, subprocess.TimeoutExpired):
                self.proc.terminate()


# ---------------------------------------------------------------------------
# The scenario
# ---------------------------------------------------------------------------


@dataclass
class World:
    http: Http
    admin_token: str = ""
    admin_user_id: str = ""
    tenant_tz: str = "Africa/Johannesburg"
    courts: dict[int, str] = field(default_factory=dict)  # court number -> id
    slice_minutes: int = 15
    m_user_id: str = ""
    m_membership_id: str = ""
    m_token: str = ""
    n_user_id: str = ""
    n_membership_id: str = ""
    box: Optional[DeviceClient] = None
    box_device_id: str = ""
    box_mac: str = ""
    ident_code: str = ""
    t0: datetime = field(default_factory=now_utc)
    b1: dict = field(default_factory=dict)  # court 1, offline activation event
    b3: dict = field(default_factory=dict)  # court 3, online /activate
    b6: dict = field(default_factory=dict)  # court 2 in 3h, too_early
    b7: dict = field(default_factory=dict)  # court 4, member N, no-show
    tokens: dict[int, str] = field(default_factory=dict)  # relay -> roster token
    walkup: dict = field(default_factory=dict)  # the walk-up grant on court 2, and when it was made


def admin_login(w: World) -> None:
    r = expect_status(w.http.post("/api/v1/auth/dev/admin-login"), 200, "dev admin login")
    w.admin_token = r["access_token"]
    w.admin_user_id = r["user_id"]
    if not r.get("is_admin"):
        raise StepFailed("dev admin login did not return an admin session")


def club_zone_for_the_run() -> str:
    """A club timezone in which this whole fixture fits inside ONE local day.

    THE HIDDEN INPUT IS THE WALL CLOCK. Every booking here is placed relative to "now",
    and the furthest — B6, three hours out and forty-five minutes long — has to END
    before the club's local midnight, because no window in this product spans two club
    days. Run before about 20:15 in Johannesburg it fits; run after, the admin booking
    is refused and three assertions fail on a product that is behaving correctly. That
    is exactly what happened, and the refusal it produced was so misleading it earned its
    own fix in BookingRules (`crosses_midnight`).

    The zone is a genuine club setting rather than a stub, so choosing one is not cheating
    — a real deployment has clubs in several. Johannesburg is kept whenever it works, so
    the ordinary run is the realistic one; otherwise the first candidate whose local time
    leaves the fixture room wins. The candidates span offsets from -7 to +13 with no gap
    wider than four hours, so one of them always lands in the daytime window.

    It varies the fixture for free, which this repository asks for anyway: a suite that
    only ever runs in one zone is a suite in which a whole class of club-day defect is
    invisible."""
    if ZoneInfo is None:
        return "UTC"
    now = now_utc()
    for name in ("Africa/Johannesburg", "Europe/London", "UTC", "America/Sao_Paulo",
                 "America/Los_Angeles", "Asia/Kolkata", "Asia/Tokyo", "Pacific/Auckland"):
        try:
            local = now.astimezone(ZoneInfo(name))
        except Exception:  # noqa: BLE001 - a platform without that zone simply tries the next
            continue
        # 06:00-18:00: at least six hours of local day left for a fixture that reaches
        # three hours and forty-five minutes out, and a club hour that reads as plausible
        # in any transcript somebody reads later.
        if 6 <= local.hour < 18:
            return name
    raise StepFailed("no candidate club timezone leaves room for the fixture — "
                     "this should be unreachable; the candidates span 20 hours of offset")


def seed_and_tune(w: World) -> None:
    step("Seed tenant/admin/courts/members and tune settings through the API")
    # The Development seeder created the pilot tenant, the admin, four courts and five
    # sample members with an opening balance. Everything below is done over HTTP.
    settings = expect_status(w.http.get("/api/v1/admin/settings", token=w.admin_token), 200, "settings GET")
    w.tenant_tz = settings.get("timezone") or w.tenant_tz
    zone = club_zone_for_the_run()
    print(f"  [settings] club timezone for this run: {zone} "
          f"(local {now_utc().astimezone(ZoneInfo(zone)).strftime('%H:%M') if ZoneInfo else '??:??'}) "
          f"— see club_zone_for_the_run", flush=True)
    body = {
        "timezone": zone,
        "sliceMinutes": 15,
        "advanceBookingDays": settings["advance_booking_days"],
        # The club is open for the whole local day, for the run.
        #
        # The seeded hours are a CLUB's hours — 06:00-22:00 on a weekday, 07:00-20:00 at
        # the weekend — and this scenario plays a day of court life in four minutes, so
        # outside them it cannot buy court time at all: the walk-up leg is refused
        # `walk_up_refused` and the whole C5/H3 block goes red for no reason but the hour
        # somebody pressed the button. Both ends are set, because HoursFor falls back to
        # the flat pair for any weekday operating_hours does not name.
        #
        # This does NOT bypass the closing-time rule — walk_up_expectation still derives
        # what to expect from whatever the schedule says the club's hours are, and the
        # walk-up still truncates at close. It moves the close somewhere the run is not
        # standing on. 23:59 rather than 24:00 because ParseRange goes through
        # TimeOnly.TryParse, which has no 24:00.
        "dayStartMinute": 0,
        "dayEndMinute": OPEN_ALL_DAY_END_MINUTE,
        "operatingHours": {day: f"00:00-{OPEN_ALL_DAY_END_MINUTE // 60:02d}:{OPEN_ALL_DAY_END_MINUTE % 60:02d}" for day in DAY_KEYS},
        "penaltyPct": 30,
        "graceWindowMinutes": 1,
        "penaltyWindowMinutes": settings["penalty_window_minutes"],
        "activationCueWindowMinutes": 10,
        # 240 rather than the 120 default: the too_early case needs a booking three hours
        # out to be INSIDE the forward window (found) and OUTSIDE the cue window (not lit).
        "activationForwardWindowMinutes": 240,
        "rosterWindowMinutes": 120,
        "walkUpMaxMinutes": 90,
        "heartbeatSeconds": 30,
        # The member-ident code has to outlive the minutes between minting it and the
        # walk-up step; 60s would expire it mid-run.
        "qrLifetimeSeconds": 900,
    }
    expect_status(w.http.put("/api/v1/admin/settings", body, token=w.admin_token), 200, "settings PUT")
    after = expect_status(w.http.get("/api/v1/admin/settings", token=w.admin_token), 200, "settings GET")
    # Every later leg reckons "today" in the club's zone. It was left at the zone read BEFORE this
    # PUT moved the club, so late in a Johannesburg evening the club traded in daytime Los Angeles
    # while the walk-up leg counted Johannesburg's last minute and refused itself (CI 36636067614).
    w.tenant_tz = after.get("timezone") or zone
    REPORT.check(
        "setup", "tenant settings tuned via admin API (slice 15, grace 1, cue 10, roster 120, forward 240)",
        after["slice_minutes"] == 15 and after["grace_window_minutes"] == 1 and after["activation_cue_window_minutes"] == 10
        and after["roster_window_minutes"] == 120 and after["activation_forward_window_minutes"] == 240,
    )
    # Asserted, not assumed: a settings PUT that silently dropped the map would put the
    # walk-up leg back at the mercy of the club's trading hours, and the symptom would be
    # an evening-only red run in CI with no mention of hours anywhere in it.
    REPORT.check(
        "setup", "the club is open all day for every weekday of the run, so no leg is refused for the hour it ran at",
        after.get("operating_hours") == {day: "00:00-23:59" for day in DAY_KEYS}
        and after["day_start_minute"] == 0 and after["day_end_minute"] == OPEN_ALL_DAY_END_MINUTE,
        f"operating_hours={after.get('operating_hours')} flat={after.get('day_start_minute')}-{after.get('day_end_minute')}")

    courts = expect_status(w.http.get("/api/v1/admin/courts", token=w.admin_token), 200, "courts GET").json
    for c in courts:
        w.courts[c["court_number"]] = c["id"]
    # A court has no price: a booking costs its length in minutes (P13 §1.1), so the
    # 15-minute slices set above are the whole of the arithmetic below.
    REPORT.check("setup", "four courts present (numbers 1-4)", all(n in w.courts for n in (1, 2, 3, 4)))

    members = expect_status(w.http.get("/api/v1/admin/members", token=w.admin_token), 200, "members GET").json
    by_number = {m["membership_number"]: m for m in members}
    if SEEDED_MEMBER_M not in by_number or SEEDED_MEMBER_N not in by_number:
        raise StepFailed(f"seeded members {SEEDED_MEMBER_M}/{SEEDED_MEMBER_N} not found: {sorted(by_number)}")
    m, n = by_number[SEEDED_MEMBER_M], by_number[SEEDED_MEMBER_N]
    w.m_user_id, w.m_membership_id = m["user_id"], m["membership_id"]
    w.n_user_id, w.n_membership_id = n["user_id"], n["membership_id"]

    # A seeded member has no password. The admin reset returns a one-shot temporary
    # password, which is the API's own out-of-band path — and what gives us M's JWT.
    #
    # The temporary password is TEMPORARY, and the API enforces that rather than advising
    # it: `PasswordChangeGate` answers 403 `password_change_required` to every authenticated
    # call from a must-change session except the change itself. So this walks the member's
    # real journey — reset, sign in, choose a password — instead of holding a session that a
    # real member could not use. Skipping the change is how this harness spent a whole run
    # reporting failures on the wallet, the QR screen and the roster that were all one 403.
    reset = expect_status(w.http.post(f"/api/v1/admin/members/{w.m_membership_id}/reset-password", token=w.admin_token), 200, "reset-password")
    login = expect_status(w.http.post("/api/v1/auth/login", {"email": m["email"], "password": reset["temp_password"]}), 200, "member login")
    w.m_token = login["access_token"]
    REPORT.check("setup", f"member M ({SEEDED_MEMBER_M}) logged in via admin password reset", bool(w.m_token) and not login.get("is_admin"))

    REPORT.check("setup", "the temporary password forces a change: an authenticated call is refused until it is done",
                 w.http.get("/api/v1/wallet", token=w.m_token).status == 403 and login.get("must_change_password") is True)

    expect_status(
        w.http.post("/api/v1/me/password", {"currentPassword": reset["temp_password"], "newPassword": M_PASSWORD}, token=w.m_token),
        200, "member chooses a password")
    login = expect_status(w.http.post("/api/v1/auth/login", {"email": m["email"], "password": M_PASSWORD}), 200, "member re-login")
    w.m_token = login["access_token"]
    REPORT.check("setup", "and once it is changed the member holds an ordinary session",
                 not login.get("must_change_password") and w.http.get("/api/v1/wallet", token=w.m_token).status == 200)

    # Minutes through the desk's goodwill adjustment, on top of the seeded opening balance.
    seed = {"amountMinutes": 500, "reasonCode": "goodwill", "reason": "e2e-device seed"}
    adj = expect_status(w.http.post(f"/api/v1/admin/minutes/{w.m_user_id}/adjust", seed, token=w.admin_token), 200, "adjust M")
    expect_status(w.http.post(f"/api/v1/admin/minutes/{w.n_user_id}/adjust", seed, token=w.admin_token), 200, "adjust N")
    wallet = expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")
    REPORT.check("setup", "minutes seeded via admin adjustment and visible on M's wallet, as whole minutes",
                 mins(wallet["balance_minutes"]) == mins(adj["balance_after_minutes"]) and wallet["balance_minutes"] >= 500)



def schedule_slots(w: World, around: datetime) -> list[dict]:
    """Every non-cancelled slot on the tenant-local days around `around`."""
    tz = ZoneInfo(w.tenant_tz) if ZoneInfo else timezone.utc
    local = around.astimezone(tz).date()
    seen: dict[str, dict] = {}
    for delta in (-1, 0, 1):
        date = (local + timedelta(days=delta)).isoformat()
        r = expect_status(w.http.get(f"/api/v1/schedule?date={date}", token=w.admin_token), 200, "schedule GET")
        for slot in r["slots"]:
            if slot.get("bookingId"):
                seen[slot["bookingId"]] = slot
    return list(seen.values())


def find_slot(w: World, booking_id: str, around: datetime) -> Optional[dict]:
    for slot in schedule_slots(w, around):
        if slot["bookingId"] == booking_id:
            return slot
    return None


def booked_over(w: World, court_number: int, start: datetime, end: datetime) -> list[dict]:
    """Live bookings on this court that collide with the window this run needs."""
    out = []
    for slot in schedule_slots(w, start):
        if slot["courtNumber"] != court_number or slot["status"] != "booked":
            continue
        s, e = parse_dt(slot["startsAtUtc"]), parse_dt(slot["endsAtUtc"])
        if s < end and e > start:
            out.append(slot)
    return out


def ensure_free(w: World, court_number: int, start: datetime, end: datetime) -> None:
    """Admin-cancel any seeded booking overlapping the window this run needs.

    The waiver REASON is not optional, and this step used to send none. §8's admin
    cancel is "penalty waiveable WITH REASON" and the endpoint enforces it — a waive
    with no reason is 400 `waive_reason_required`, because an audit field that may be
    left blank is one that always is. This function sent `{"waivePenalty": true}` and
    then PRINTED the status rather than checking it, so every clear it attempted had
    been silently refused for as long as the reason has been mandatory.

    That is invisible for most of the day and then wrecks a run, which is why it took a
    CI failure to find: the seeder plants demo bookings at fixed LOCAL times, so whether
    one collides with this run depends on the hour it starts. At 19:57 SAST the seeded
    19:00 slot on court 2 is in the past and nothing collides; at 18:09 SAST it is fifty
    minutes out, survives the refused cancel, and then poses as the scenario's own
    fixtures — the member-ident QR comes back as THAT booking's activation code, the box
    roster carries it on relay 1 where B6 should be, the walk-up refuses it as a wallet
    (correctly — a roster code is not a wallet), and the too-early scan reports the time
    to the wrong slot. Five checks fail and none of them names the cause.

    So the cancel now carries its reason, every refusal is fatal, and the window is
    re-read afterwards: "I asked" is not the same as "it is clear".
    """
    for slot in booked_over(w, court_number, start, end):
        s, e = parse_dt(slot["startsAtUtc"]), parse_dt(slot["endsAtUtc"])
        r = w.http.post(
            f"/api/v1/admin/bookings/{slot['bookingId']}/cancel",
            {"waivePenalty": True, "waiveReason": "e2e-device: clearing the seeded slot this run books over"},
            token=w.admin_token)
        expect_status(r, 200, f"clear seeded booking on court {court_number} ({s:%H:%M}-{e:%H:%M} UTC)")
        print(f"  cleared seeded booking {slot['bookingId']} on court {court_number} ({s:%H:%M}-{e:%H:%M} UTC)")

    left = booked_over(w, court_number, start, end)
    if left:
        raise StepFailed(
            f"court {court_number} is still booked over {start:%H:%M}-{end:%H:%M} UTC after cancelling: "
            + ", ".join(f"{b['bookingId']} {b['startsAtUtc']}" for b in left))


def admin_book(w: World, court_number: int, user_id: str, starts_at: datetime, slices: int, what: str) -> dict:
    r = w.http.post("/api/v1/admin/bookings", {
        "courtId": w.courts[court_number], "userId": user_id, "startsAt": iso(starts_at), "sliceCount": slices,
    }, token=w.admin_token)
    expect_status(r, 200, f"admin booking {what}")
    return {"id": r["booking_id"], "court": court_number, "starts_at": starts_at,
            "ends_at": starts_at + timedelta(minutes=w.slice_minutes * slices), "user_id": user_id,
            "amount": w.slice_minutes * slices}


def create_bookings(w: World) -> None:
    step("Create the bookings the scenario turns on")
    w.t0 = now_utc()
    for court, horizon in ((1, 3), (3, 3), (4, 3), (2, 4)):
        ensure_free(w, court, w.t0 - timedelta(hours=2), w.t0 + timedelta(hours=horizon))

    # The member-ident code, minted while M has no booking in reach — with one, the QR
    # screen shows the booking's code instead (asserted later, H2).
    qr = expect_status(w.http.post("/api/v1/me/qr/generate", token=w.m_token), 200, "qr generate")
    w.ident_code = qr["code"]
    REPORT.check("H2", "QR screen with no booking in reach shows a 12-char member-ident code",
                 qr.get("kind") == "ident" and len(w.ident_code) == 12, f"code={w.ident_code} expires_in={qr.get('expires_in_seconds')}")

    # Starts are deliberately staggered so "earliest booking" is unambiguous.
    w.b3 = admin_book(w, 3, w.m_user_id, w.t0 + timedelta(seconds=60), 3, "B3 (M, court 3, online activate)")
    w.b1 = admin_book(w, 1, w.m_user_id, w.t0 + timedelta(seconds=75), 3, "B1 (M, court 1, offline event)")
    w.b7 = admin_book(w, 4, w.n_user_id, w.t0 + timedelta(seconds=60), 3, "B7 (N, court 4, no-show)")
    w.b6 = admin_book(w, 2, w.m_user_id, w.t0 + timedelta(hours=3), 3, "B6 (M, court 2, +3h, too early)")
    REPORT.check("setup", "four bookings created over the admin booking API (charged at booking)", all(b.get("id") for b in (w.b1, w.b3, w.b6, w.b7)))


def provision_box(w: World) -> None:
    step("C1  Read the club key, and let a box register itself on its first heartbeat")

    # The key: readable, not shown-once, minted on the first read so the page is never
    # empty. This is the whole of what an admin does before flashing a box.
    key = expect_status(w.http.get("/api/v1/admin/devices/api-key", token=w.admin_token), 200, "device api-key GET")
    api_key = key.get("api_key")
    REPORT.check("C1", "GET /admin/devices/api-key mints and returns the club's device key with a regenerated_at",
                 isinstance(api_key, str) and len(api_key) >= 32 and bool(key.get("regenerated_at")),
                 f"len={len(api_key or '')}")
    again = expect_status(w.http.get("/api/v1/admin/devices/api-key", token=w.admin_token), 200, "device api-key GET again")
    REPORT.check("C1", "the key is readable rather than shown-once: a second read is the same key",
                 again.get("api_key") == api_key)

    # No key, and a key that is merely wrong, are both a plain 401 with nothing in the body.
    w.box_mac = ("02e2e" + secrets.token_hex(4))[:12]  # 12 lowercase hex, locally administered
    anonymous = w.http.call("POST", "/api/v1/device/heartbeat",
                            raw=json.dumps({"mac": w.box_mac}).encode("utf-8"), content_type="application/json")
    REPORT.check("C1", "a heartbeat with no key at all is 401", anonymous.status == 401, f"status={anonymous.status}")

    stranger = DeviceClient(w.http, "not-the-club-key-not-the-club-key", w.box_mac)
    refused = stranger.heartbeat()
    REPORT.check("C1", "a heartbeat with an unrecognised key is 401 with an empty body (no reason, no clock)",
                 refused.status == 401 and not refused.text.strip(), f"status={refused.status} body={refused.text[:80]!r}")

    # The box. It has never been registered, and registering it IS the first heartbeat.
    w.box = DeviceClient(w.http, api_key, w.box_mac)
    first = expect_status(w.box.heartbeat(), 200, "first heartbeat")
    REPORT.check("C1", "an unknown MAC on a heartbeat registers itself: the response names the box",
                 first.get("device_code") == f"box-{w.box_mac[-6:]}", f"device_code={first.get('device_code')}")
    REPORT.check("C4", "the box it created drives the club's four courts in ascending relay order [1,2,3,4]",
                 first.get("court_numbers") == [1, 2, 3, 4], f"court_numbers={first.get('court_numbers')}")
    REPORT.check("C1", "nothing from the retired scheme survives on the wire: no server_unix, no ota",
                 "server_unix" not in first.json and "ota" not in first.json, f"keys={sorted(first.json)}")

    devices = expect_status(w.http.get("/api/v1/admin/devices/", token=w.admin_token), 200, "admin devices GET").json
    mine = next((d for d in devices if d.get("mac_address") == w.box_mac), None)
    w.box_device_id = (mine or {}).get("id", "")
    REPORT.check("C1", "the box appears on the admin Devices list by itself, flagged as unchecked",
                 bool(mine) and mine.get("auto_registered") is True, f"device={mine}")

    # A second heartbeat is the same board, not a second row.
    expect_status(w.box.heartbeat(), 200, "second heartbeat")
    devices = expect_status(w.http.get("/api/v1/admin/devices/", token=w.admin_token), 200, "admin devices GET 2").json
    REPORT.check("C1", "a second heartbeat from the same MAC does not register a second row",
                 len([d for d in devices if d.get("mac_address") == w.box_mac]) == 1)

    # A body with no usable MAC cannot be answered, and must say so rather than 404 —
    # which would read as "unknown board" to a box that simply wrote the field wrong.
    no_mac = w.box.call("POST", "/api/v1/device/heartbeat", {}, mac="not-a-mac")
    # BD-13: a MAC that is present but malformed is `mac_invalid`; `mac_required` is for an
    # absent or blank one (door-gate.md's error table).
    REPORT.check("C1", "a heartbeat whose mac is not twelve hex characters is 400 mac_invalid",
                 no_mac.status == 400 and no_mac.get("error") == "mac_invalid", f"resp={no_mac.text[:120]}")


def roster_entries(resp: Resp) -> dict[int, tuple[str, int, int]]:
    """relay -> (token, opens_in, closes_in) for a heartbeat response."""
    out: dict[int, tuple[str, int, int]] = {}
    for entry in resp.get("roster", []):
        token, relay, opens, closes = entry.split("|")
        out.setdefault(int(relay), (token, int(opens), int(closes)))
    return out


def heartbeat_roster(w: World) -> None:
    step("C2/C4/H2  Heartbeat carries the four-court mapping and the roster")
    assert w.box is not None
    hb = expect_status(w.box.heartbeat(), 200, "heartbeat")
    REPORT.check("C4", "heartbeat court_numbers == [1,2,3,4] (relay order)", hb.get("court_numbers") == [1, 2, 3, 4])
    REPORT.check("C2", "heartbeat carries heartbeat_seconds from settings and a config block, and no server_unix",
                 "server_unix" not in hb.json and hb.get("heartbeat_seconds") == 30 and hb.get("config", {}).get("grace_window_minutes") == 1)
    entries = roster_entries(hb)
    pattern = re.compile(r"^[0-9A-Z]{1,20}\|[0-3]\|-?\d+\|-?\d+$")
    REPORT.check("C2", "every roster entry matches TOKEN|relay|opens_in|closes_in", all(pattern.match(e) for e in hb.get("roster", [])), f"roster={hb.get('roster')}")
    REPORT.check("C2", "roster has entries on relay 0 (court 1, B1) and relay 2 (court 3, B3) and relay 3 (court 4, N)",
                 {0, 2, 3} <= set(entries), f"relays={sorted(entries)}")
    REPORT.check("C2", "B6 (three hours out) is outside the 120-minute roster window: no entry on relay 1", 1 not in entries)
    if 0 in entries and 2 in entries:
        w.tokens[0] = entries[0][0]
        w.tokens[2] = entries[2][0]
        w.tokens[3] = entries[3][0] if 3 in entries else ""
        elapsed = (now_utc() - w.t0).total_seconds()
        # B3 starts t0+60s with a 10-minute cue: opens_in ~= 60-600-elapsed, closes_in ~= 60+2700-elapsed.
        t3, o3, c3 = entries[2]
        t1, o1, c1 = entries[0]
        REPORT.check("C2", "opens_in/closes_in are signed seconds from the response instant (B3: cue already open, slot 45 min + cue apart)",
                     -640 - elapsed <= o3 <= -520 and c3 - o3 == 45 * 60 + 600 and 2700 - elapsed - 5 <= c3 <= 2760,
                     f"B3 opens_in={o3} closes_in={c3} elapsed={elapsed:.0f}s")
        REPORT.check("C2", "B1 (starts 15s after B3) has opens_in 15s later than B3's", o1 - o3 == 15 and c1 - c3 == 15,
                     f"B1 opens_in={o1} closes_in={c1}")
        REPORT.check("H2", "roster tokens are 12-char access codes (scannable), not JWTs", len(t3) == 12 and len(t1) == 12 and t1 != t3)

    # H2: the QR the phone shows for M is the same code the box was pushed for M's
    # earliest booking in reach.
    qr = expect_status(w.http.post("/api/v1/me/qr/generate", token=w.m_token), 200, "qr generate (booking)")
    REPORT.check("H2", "QR screen now shows B3's booking-activation code — the bytes in the box's roster on relay 2",
                 qr.get("kind") == "booking" and qr.get("booking_id") == w.b3["id"] and qr.get("code") == w.tokens.get(2) and qr.get("court_number") == 3,
                 f"qr={qr.json}")

    # B6's token is needed for the too_early case and is outside the 120-minute window.
    # Widen the window through the settings API, read it, narrow it again.
    def set_roster_window(minutes: int) -> None:
        cur = expect_status(w.http.get("/api/v1/admin/settings", token=w.admin_token), 200, "settings GET")
        body = {
            "sliceMinutes": cur["slice_minutes"],
            "advanceBookingDays": cur["advance_booking_days"], "dayStartMinute": cur["day_start_minute"],
            "dayEndMinute": cur["day_end_minute"], "penaltyPct": cur["penalty_pct"],
            "graceWindowMinutes": cur["grace_window_minutes"], "penaltyWindowMinutes": cur["penalty_window_minutes"],
            "rosterWindowMinutes": minutes,
        }
        expect_status(w.http.put("/api/v1/admin/settings", body, token=w.admin_token), 200, "settings PUT roster window")

    set_roster_window(240)
    wide = expect_status(w.box.heartbeat(), 200, "heartbeat (wide window)")
    wide_entries = roster_entries(wide)
    REPORT.check("C2", "widening roster_window_minutes to 240 brings B6 (relay 1, court 2) into the roster with a positive opens_in",
                 1 in wide_entries and wide_entries[1][1] > 3 * 3600 - 600 - 120, f"relay1={wide_entries.get(1)}")
    if 1 in wide_entries:
        w.tokens[1] = wide_entries[1][0]
    set_roster_window(120)
    narrow = expect_status(w.box.heartbeat(), 200, "heartbeat (narrow again)")
    REPORT.check("C2", "narrowing it back to 120 drops B6 again — the window is the tenant setting, not a constant", 1 not in roster_entries(narrow))

    devices = expect_status(w.http.get("/api/v1/admin/devices", token=w.admin_token), 200, "devices GET").json
    mine = next((d for d in devices if d["id"] == w.box_device_id), None)
    REPORT.check("C4", "admin device list shows the box with court_numbers [1,2,3,4], last_seen_at and running_version from the heartbeat",
                 bool(mine) and mine["court_numbers"] == [1, 2, 3, 4] and mine.get("last_seen_at") and mine.get("running_version") == "2.0.0")
    REPORT.check("R17", "the box carries no button-map override (button_map null) and the heartbeat sent the club's eight-entry map",
                 bool(mine) and "button_map" in mine and mine["button_map"] is None and len(hb.get("config", {}).get("button_map", [])) == 8)


def online_activation(w: World, sim: Optional[Simulator]) -> None:
    step("C3/C4  Online activation of a pre-booked member from the box")
    assert w.box is not None
    token = w.tokens.get(2)
    if not token:
        raise StepFailed("no roster token for relay 2 (B3)")
    if sim is not None:
        # The scan itself, through the Mega half: feed the code to the simulated scanner
        # and take the !SCAN frame off the wire, exactly as the bridge would.
        sim.console(f"scan {token}")
        scan = sim.expect_frame(lambda f: f.verb == "SCAN", 5, "!SCAN")
        REPORT.check("M-serial", "simulated scanner line arrives on the bridge link as !SCAN,<code> with a valid checksum",
                     scan.args == [token], str(scan))
        token = scan.args[0] if scan.args else token
    before = now_utc()
    act = expect_status(w.box.call("POST", "/api/v1/device/activate", {"method": "qr", "token": token, "court": 3}), 200, "activate B3")
    granted = act.get("granted_seconds", -1)
    expected = int((w.b3["ends_at"] - before).total_seconds())
    REPORT.check("C3", "POST /device/activate with B3's code -> activated, court_number 3, booking_id B3",
                 act.get("activated") is True and act.get("reason") == "ok" and act.get("court_number") == 3 and act.get("booking_id") == w.b3["id"], f"resp={act.json}")
    REPORT.check("C3", "granted_seconds is the remainder of the slot, <= the 5400s relay cap",
                 0 < granted <= RELAY_HARD_CAP_SECONDS and abs(granted - expected) <= 3, f"granted={granted} expected~{expected}")
    REPORT.check("C3", "the activate response no longer carries server_unix: the box has no clock to seed",
                 "server_unix" not in act.json, f"keys={sorted(act.json)}")
    # Bridge 2.3.0's greeting: HI <NAME> / BALANCE <n> MIN before the outcome.
    # The box reads both fields tolerantly, but the server owes them for every
    # answer about a recognised member — the box cannot greet with what it was
    # not sent.
    wallet = mins(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_minutes"])
    name = act.get("greeting_name")
    REPORT.check("GREET", "the activate response greets the member: greeting_name is their first name, upper-case "
                          "ASCII, at most 16 characters (the box shows HI plus thirteen)",
                 isinstance(name, str) and 0 < len(name) <= 16 and name == name.upper() and name.isascii()
                 and name.split()[0] == name, f"greeting_name={name!r}")
    REPORT.check("GREET", "...and balance_minutes is M's spendable balance in whole minutes, read after the decision",
                 isinstance(act.get("balance_minutes"), int) and act.get("balance_minutes") == wallet,
                 f"balance_minutes={act.get('balance_minutes')!r} wallet={wallet}")

    if sim is not None:
        # And the lights: the bridge's decision goes to the Mega as !ON on relay C.
        sim.send("ON", "C", str(granted))
        state = sim.expect_frame(lambda f: f.verb == "STATE" and (int(f.args[0]) & 0b0100), 5, "!STATE with relay C")
        rem_c = int(state.args[3])
        REPORT.check("M-serial", "!ON,C,<granted> closes relay C: !STATE mask has bit 2 and remaining C ~= granted (<= 5400)",
                     granted - 3 <= rem_c <= min(granted, RELAY_HARD_CAP_SECONDS), str(state))
        on_line = sim.expect_stdout(lambda l: "[relay] court C ON" in l, 5)
        REPORT.check("M-serial", "the simulated relay driver reports court C ON", True)
        # Mega 2.1.0: the club's normally-open solid-state relays close on HIGH.
        # The simulator is built with the Mega's own RELAY_ACTIVE_LOW=0, so its
        # transcript names the level the fitted relays actually see.
        REPORT.check("RELAY-POL", "relays are ACTIVE HIGH: court C ON is driven at pin level HIGH",
                     "(pin level HIGH)" in on_line, on_line)

    time.sleep(1.2)
    again = expect_status(w.box.call("POST", "/api/v1/device/activate", {"method": "qr", "token": token}), 200, "re-activate B3")
    REPORT.check("C3", "a repeat scan of the live session is idempotent: activated again with the remaining seconds, no second charge",
                 again.get("activated") is True and again.get("booking_id") == w.b3["id"] and 0 < again.get("granted_seconds", 0) < granted, f"resp={again.json}")
    hb = expect_status(w.box.heartbeat(), 200, "heartbeat after activation")
    # A checked-in booking STAYS on the roster while it is live: a slot longer than the
    # 90-minute relay cap needs its second half re-lit from the roster during an outage.
    REPORT.check("C3", "B3 (now checked in, still live) is still pushed in the roster — re-lightable offline", 2 in roster_entries(hb))
    ledger = expect_status(w.http.get(f"/api/v1/admin/ledger?userId={w.m_user_id}&limit=200", token=w.admin_token), 200, "ledger M").json
    b3_rows = [r for r in ledger if r.get("relatedBookingId") == w.b3["id"]]
    REPORT.check("C3", f"M's ledger holds exactly one movement for B3: the -{w.b3['amount']} minute charge posted at booking, nothing at activation",
                 len(b3_rows) == 1 and mins(b3_rows[0]["signedAmountMinutes"]) == -w.b3["amount"] and b3_rows[0]["type"] == "BookingCharge", f"rows={[(r['type'], r['signedAmountMinutes']) for r in b3_rows]}")
    if sim is not None:
        sim.send("OFF", "C")
        evt = sim.expect_frame(lambda f: f.verb == "EVT" and f.args[:2] == ["OFF", "C"], 5, "!EVT,OFF,C")
        state = sim.expect_frame(lambda f: f.verb == "STATE" and int(f.args[0]) & 0b0100 == 0, 12, "!STATE with C clear")
        REPORT.check("M-serial", "!OFF,C opens the relay: !EVT,OFF,C is reported and the next !STATE mask has C clear", bool(evt) and bool(state), f"{evt} / {state}")
        off_line = sim.expect_stdout(lambda l: "[relay] court C OFF" in l, 5)
        # Mega 3.0.0 (HW-1): a released relay is an INPUT, never a driven level, so a
        # wrong drive level fails dark for either module type.
        REPORT.check("RELAY-POL", "...and released is an input (high-Z) — off for either relay module, so a "
                                  "wrong drive level fails dark, never lit", "(pin input)" in off_line, off_line)


def offline_attendance(w: World) -> None:
    step("C6  An uploaded activation event is attendance")
    assert w.box is not None
    token = w.tokens.get(0)
    if not token:
        raise StepFailed("no roster token for relay 0 (B1)")
    batch = {"uptime_ms": 600_000, "events": [
        {"seq": 1, "uptime_ms": 590_000, "kind": "activation", "court": 0, "method": "qr", "subject": token, "duration_ms": 2_700_000},
    ]}
    up = expect_status(w.box.call("POST", "/api/v1/device/events", batch), 200, "events upload")
    REPORT.check("C6", "events upload acknowledges accepted_through=1, recorded=1, with no server_unix",
                 up.get("accepted_through") == 1 and up.get("recorded") == 1 and "server_unix" not in up.json, f"resp={up.json}")
    hb = expect_status(w.box.heartbeat(), 200, "heartbeat after event")
    # Attendance is stamped server-side, but the entry STAYS: a checked-in booking still
    # inside its window is re-lightable offline (a slot longer than the 90-minute relay
    # cap needs its second half re-lit from the roster). It leaves when it ends.
    REPORT.check("C6", "B1 stays on the roster after the activation event (checked-in and still live: re-lightable offline)", 0 in roster_entries(hb))
    live = expect_status(w.box.call("POST", "/api/v1/device/activate", {"method": "qr", "token": token}), 200, "activate B1 after event")
    REPORT.check("C6", "a scan of B1 now answers as a live session (activated, remaining seconds) rather than a fresh cue-window check",
                 live.get("activated") is True and live.get("booking_id") == w.b1["id"] and 0 < live.get("granted_seconds", 0) <= 2775)
    replay = expect_status(w.box.call("POST", "/api/v1/device/events", batch), 200, "events replay")
    REPORT.check("C6", "replaying the same seq is acknowledged (accepted_through=1) and not re-recorded (recorded=0)",
                 replay.get("accepted_through") == 1 and replay.get("recorded") == 0, f"resp={replay.json}")
    # A relay/court mismatch is receipted, never refused — the box cannot change it. B1's
    # own token on relay D (court 4): wrong_court, and B1 is already checked in anyway.
    wrong = {"uptime_ms": 601_000, "events": [
        {"seq": 2, "uptime_ms": 600_500, "kind": "activation", "court": 3, "method": "qr", "subject": token, "duration_ms": 1000},
    ]}
    wr = expect_status(w.box.call("POST", "/api/v1/device/events", wrong), 200, "events wrong relay")
    REPORT.check("C6", "an activation naming a relay not wired to the booking's court is still receipted (accepted_through=2), not 4xx",
                 wr.get("accepted_through") == 2 and wr.get("recorded") == 1)


def walk_up_expectation(w: World, requested: int) -> tuple[int, int]:
    """How many minutes the club can sell right now, and what the server will charge."""
    tz = ZoneInfo(w.tenant_tz) if ZoneInfo else timezone.utc
    local = now_utc().astimezone(tz)
    day = expect_status(
        w.http.get(f"/api/v1/schedule?date={local.date().isoformat()}", token=w.m_token), 200, "schedule today").json
    closes = local.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(minutes=int(day["dayEndMinute"]))
    to_close = int((closes - local).total_seconds() // 60)
    minutes = min(requested, max(to_close, 0))
    # A walk-up costs exactly the whole minutes it grants (P13 §1.2) — no slice price, no
    # pro rata, no rounding to argue about.
    return minutes, minutes


def walk_up(w: World) -> None:
    step("C5/H3  Walk-up on an unbooked court, replay-safe by nonce")
    assert w.box is not None
    wallet_before = mins(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_minutes"])

    # What the club will actually sell right now, rather than a hard-coded hour.
    #
    # A walk-up truncates at closing time — an hour bought at 19:50 on a Saturday ends at
    # 20:00 — so a fixed "60 minutes for 60 minutes" is a test that passes all afternoon
    # and fails after 19:00, which is the same wall-clock trap `BookableSlot` and the
    # peak-window fixtures already exist to close, arriving from a third direction. It
    # cost a whole red run at 19:09 SAST. The expectation is derived from the club's own
    # hours for today.
    minutes, cost = walk_up_expectation(w, requested=60)
    # A club with nothing left to sell refuses the purchase outright, and the wire says
    # `walk_up_refused` — which reads as a broken walk-up and is a closed club. seed_and_tune
    # opens the club 00:00-23:59 for every weekday precisely so this cannot happen; the only
    # way here is a run that crossed the last minute of the local day on its way to this step.
    if minutes < 1:
        raise StepFailed(
            f"the club has {minutes} sellable minutes left in the local day ({w.tenant_tz}), so no "
            "walk-up can be bought and this leg cannot prove anything. Re-run: seed_and_tune opens "
            "the club all day, so this is the last minute before local midnight, not a defect.")

    nonce = secrets.token_hex(8)
    req = {"minutes": 60, "method": "qr", "token": w.ident_code, "court": 2, "nonce": nonce}
    first = expect_status(w.box.call("POST", "/api/v1/device/walkup", req), 200, "walkup")
    w.walkup = dict(first.json, granted_at=now_utc())
    REPORT.check("C5", f"walk-up on court 2 (named in the request, on the box) is granted {minutes} minutes (<= 90) for {cost} minutes",
                 first.get("granted_minutes") == minutes and first.get("amount_minutes") == cost and first.get("replayed") is False, f"resp={first.json}")
    REPORT.check("C5", f"balance_after_minutes == wallet before - {cost}", first.get("balance_after_minutes") == wallet_before - cost)
    replay = expect_status(w.box.call("POST", "/api/v1/device/walkup", req), 200, "walkup replay")
    REPORT.check("H3", f"resending the identical nonce answers replayed:true with the SAME booking_id and the remainder of the grant ({minutes}, seconds later)",
                 replay.get("replayed") is True and replay.get("booking_id") == first.get("booking_id") and minutes - 1 <= replay.get("granted_minutes", 0) <= minutes, f"resp={replay.json}")
    wallet_after = mins(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_minutes"])
    REPORT.check("H3", f"the replay charged nothing: wallet moved by exactly -{cost} across both calls", wallet_after == wallet_before - cost, f"{wallet_before} -> {wallet_after}")
    ledger = expect_status(w.http.get(f"/api/v1/admin/ledger?userId={w.m_user_id}&limit=200", token=w.admin_token), 200, "ledger M").json
    wu_rows = [r for r in ledger if r.get("relatedBookingId") == first.get("booking_id")]
    REPORT.check("H3", f"one LightsPurchase row of -{cost} for the walk-up booking, not two", len(wu_rows) == 1 and wu_rows[0]["type"] == "LightsPurchase" and mins(wu_rows[0]["signedAmountMinutes"]) == -cost,
                 f"rows={[(r['type'], r['signedAmountMinutes']) for r in wu_rows]}")
    slot = find_slot(w, first.get("booking_id", ""), now_utc())
    REPORT.check("C5", "the walk-up is a real booking on court 2 in M's name, visible on the schedule",
                 bool(slot) and slot["courtNumber"] == 2 and slot["ownerUserId"] == w.m_user_id and slot["status"] == "booked")
    off_box = w.box.call("POST", "/api/v1/device/walkup", {"minutes": 30, "method": "qr", "token": w.ident_code, "court": 5, "nonce": secrets.token_hex(8)})
    REPORT.check("C5", "court 5 (not on this box) -> 400 court_not_on_device", off_box.status == 400 and off_box.get("error") == "court_not_on_device", f"resp={off_box.text[:120]}")
    no_nonce = w.box.call("POST", "/api/v1/device/walkup", {"minutes": 30, "method": "qr", "token": w.ident_code, "court": 2})
    REPORT.check("H3", "a walk-up without a nonce -> 400 nonce_required", no_nonce.status == 400 and no_nonce.get("error") == "nonce_required")
    booking_code = w.tokens.get(2)
    if booking_code:
        wallet_now = mins(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_minutes"])
        as_wallet = w.box.call("POST", "/api/v1/device/walkup", {"minutes": 30, "method": "qr", "token": booking_code, "court": 2, "nonce": secrets.token_hex(8)})
        wallet_after_attempt = mins(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_minutes"])
        REPORT.check("R19", "B3's BOOKING code presented as a walk-up buyer -> 400 not_recognised and the wallet is untouched (a roster code is not a wallet)",
                     as_wallet.status == 400 and as_wallet.get("error") == "not_recognised" and wallet_after_attempt == wallet_now, f"resp={as_wallet.text[:120]}")
    too_long = w.box.call("POST", "/api/v1/device/walkup", {"minutes": 240, "method": "qr", "token": w.ident_code, "court": 2, "nonce": secrets.token_hex(8)})
    REPORT.check("M1", "240 minutes is refused with the effective cap (min(walk_up_max, relay cap 90))",
                 too_long.status == 400 and too_long.get("error") == "minutes_out_of_range" and too_long.get("max_minutes") == 90)


def wallet_of(w: World) -> int:
    return mins(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_minutes"])


def extend_call(w: World, court: int, minutes: int, nonce: Optional[str], token: Optional[str] = None) -> Resp:
    """POST /device/extend exactly as bridgelogic::renderExtendBody shapes it."""
    assert w.box is not None
    body: dict[str, Any] = {"method": "qr", "token": token or w.ident_code, "court": court, "minutes": minutes}
    if nonce is not None:
        body["nonce"] = nonce
    return w.box.call("POST", "/api/v1/device/extend", body)


def extend_dark_court(w: World) -> None:
    """EXT-0 — there is nothing to extend on a court nobody is playing on.

    Runs BEFORE the walk-up, while court 2 holds only B6, three hours out: a box
    that pressed a court it believed lit, on a court the server knows is dark,
    is answered `court_not_lit` (COURT NOT ON / PICK ANOTHER) and charged nothing."""
    step("EXT-0  Extending a court nothing is in play on is refused, and costs nothing")
    before = wallet_of(w)
    r = extend_call(w, 2, 15, secrets.token_hex(8))
    REPORT.check("EXT", "POST /device/extend on court 2 with nothing in play -> 409 court_not_lit",
                 r.status == 409 and r.get("error") == "court_not_lit", f"{r.status} {r.text[:160]}")
    REPORT.check("EXT", "...and the wallet is untouched", wallet_of(w) == before)


def extend_lit_court(w: World, sim: Optional[Simulator]) -> None:
    """EXT-1 — bridge 2.3.0's extension at the panel, end to end.

    M scans, presses court 2 (lit by the walk-up), then a black button. The box
    POSTs /device/extend; the server sells a NEW booking that starts exactly at
    the session's end, truncated before the next booking, charged like a walk-up
    of that length; the box re-arms the relay with `!EXT,B,min(5400, left +
    extended)` and the Mega answers with `!STATE` AT ONCE carrying the new
    deadline (Mega 2.1.0), so the glass can show the minutes just bought."""
    step("EXT-1  Extend a lit court at the box: the money, the replay, the truncation and the relay")
    assert w.box is not None
    if not w.walkup.get("booking_id"):
        raise StepFailed("no walk-up on court 2 to extend (C5 did not complete)")
    granted_at: datetime = w.walkup["granted_at"]
    walkup_minutes = int(w.walkup.get("granted_minutes", 0))
    walkup_ends = granted_at + timedelta(minutes=walkup_minutes)

    # The Mega half first, as the bridge left it after the walk-up: relay B lit for
    # what the walk-up has left.
    relay_left = 0
    if sim is not None:
        relay_left = max(1, int((walkup_ends - now_utc()).total_seconds()))
        sim.send("ON", "B", str(relay_left))
        lit = sim.expect_frame(lambda f: f.verb == "STATE" and int(f.args[0]) & 0b0010, 5, "!STATE with B lit")
        relay_left = int(lit.args[2])

    wallet_before = wallet_of(w)
    nonce = secrets.token_hex(8)
    first = expect_status(extend_call(w, 2, 15, nonce), 200, "extend court 2 by 15")
    ext_minutes = first.get("extended_minutes")
    REPORT.check("EXT", "POST /device/extend on lit court 2 for 15 minutes -> 200 extended_minutes 15, "
                        "replayed:false, amount_minutes == extended_minutes",
                 ext_minutes == 15 and first.get("replayed") is False and first.get("amount_minutes") == 15,
                 f"resp={first.json}")
    REPORT.check("EXT", "balance_after_minutes is the wallet after the charge, which the box shows as BALANCE <n> MIN",
                 first.get("balance_after_minutes") == wallet_before - 15 and wallet_of(w) == wallet_before - 15,
                 f"{wallet_before} -> {first.get('balance_after_minutes')}")
    ends = parse_dt(first["ends_at"]) if first.get("ends_at") else None
    REPORT.check("EXT", "the extension starts exactly where the walk-up ends: ends_at == walk-up end + 15 min",
                 ends is not None and abs((ends - (walkup_ends + timedelta(minutes=15))).total_seconds()) <= 61,
                 f"ends_at={first.get('ends_at')} walk-up ends ~{iso(walkup_ends)}")
    REPORT.check("GREET", "the extend answer carries the scanner's greeting_name too",
                 isinstance(first.get("greeting_name"), str) and first.get("greeting_name") != "", f"{first.get('greeting_name')!r}")

    replay = expect_status(extend_call(w, 2, 15, nonce), 200, "extend replay")
    REPORT.check("EXT", "the same nonce again -> replayed:true, the SAME booking_id, and no second charge",
                 replay.get("replayed") is True and replay.get("booking_id") == first.get("booking_id")
                 and wallet_of(w) == wallet_before - 15, f"resp={replay.json}")
    ledger = expect_status(w.http.get(f"/api/v1/admin/ledger?userId={w.m_user_id}&limit=200", token=w.admin_token), 200, "ledger M").json
    rows = [r for r in ledger if r.get("relatedBookingId") == first.get("booking_id")]
    REPORT.check("EXT", "exactly ONE ledger row of -15 for the extension, across the call and its replay",
                 len(rows) == 1 and mins(rows[0]["signedAmountMinutes"]) == -15,
                 f"rows={[(r['type'], r['signedAmountMinutes']) for r in rows]}")
    slot = find_slot(w, first.get("booking_id", ""), now_utc())
    REPORT.check("EXT", "the extension is a real booking on court 2 in M's name, on the schedule",
                 bool(slot) and slot["courtNumber"] == 2 and slot["ownerUserId"] == w.m_user_id, f"slot={slot}")

    if sim is not None:
        # The bridge's arithmetic (bridgelogic::planExtension): the new relay
        # deadline from now is what the court had left plus what was bought,
        # capped at ninety minutes.
        state_mark = sim.frame_mark()
        left_now = max(0, relay_left - 2)
        relay_seconds = min(RELAY_HARD_CAP_SECONDS, left_now + 15 * 60)
        landing = sim.lcd_mark()
        sent = time.monotonic()
        sim.send("EXT", "B", str(relay_seconds))
        st = sim.expect_frame(lambda f: f.verb == "STATE" and int(f.args[0]) & 0b0010 and int(f.args[2]) >= relay_seconds - 3,
                              4, "!STATE carrying the extended deadline")
        took = time.monotonic() - sent
        REPORT.check("EXT", f"!EXT,B,{relay_seconds} is answered by a !STATE with B's NEW deadline at once "
                            f"(Mega 2.1.0) — not at the next {STATE_INTERVAL_SECONDS}s publish",
                     took < 1.5 and relay_seconds - 3 <= int(st.args[2]) <= relay_seconds, f"{st} after {took:.2f}s")
        errs = [f for f in sim.frames_after(state_mark) if f.verb == "ERR"]
        REPORT.check("EXT", "...and the Mega accepted it (no !ERR): the relay was closed, so this is a deadline "
                            "moved, never an implicit !ON", not errs, f"{[str(f) for f in errs]}")
        minutes_left = (int(st.args[2]) + 59) // 60
        shown = sim.expect_screen(
            lambda f: f.row(0) == lcd_pad(IDLE_ROW0) and f.row(1).rstrip() in
            (f"COURT B {minutes_left} MIN", f"COURT B {minutes_left - 1} MIN"),
            # An earlier step's scan can still hold the glass ("CHECKING CODE ... READY IN
            # <n> s", up to kRevertSeconds); the landing screen is what follows it.
            15, "the landing screen's minutes for court B after the extension", landing)
        REPORT.check("EXT", "the Mega's landing row 1 reads the extended minutes for court B (what an unscanned "
                            "press then shows as SCAN TO EXTEND)", True, shown.text())

    # Truncation, and the refusal behind it: B6 starts three hours out on court 2,
    # and every extension chains onto the end of the one before. Each 90 is
    # expected to be exactly what fits before B6 (whole minutes, rounded down);
    # the last one that fits is cut short, and the one after it has nothing to sell.
    chain_end = ends or walkup_ends
    b6_start: datetime = w.b6["starts_at"]
    truncated = False
    grants: list[str] = []
    r = extend_call(w, 2, 90, secrets.token_hex(8))
    for _ in range(4):
        if r.status != 200:
            break
        got_end = parse_dt(r["ends_at"]) if r.get("ends_at") else None
        expected = min(90, int((b6_start - chain_end).total_seconds() // 60))
        got = r.get("extended_minutes", 0)
        grants.append(f"{got}/{expected}")
        REPORT.check("EXT", f"a chained 90-minute extension sells what fits before B6: {got} of an expected {expected}, "
                            f"ending at or before B6's start",
                     abs(got - expected) <= 1 and got_end is not None and got_end <= b6_start + timedelta(seconds=1),
                     f"resp={r.json} chain end {iso(chain_end)} b6 {iso(b6_start)}")
        truncated = truncated or 0 < got < 90
        chain_end = got_end or chain_end
        r = extend_call(w, 2, 90, secrets.token_hex(8))
    REPORT.check("EXT", "an extension that would run into the next booking (B6) is TRUNCATED before it",
                 truncated, f"grants={grants}")
    REPORT.check("EXT", "with B6 next and no minute left before it -> 409 no_time_available "
                        "(NO TIME BEFORE / NEXT BOOKING)",
                 r.status == 409 and r.get("error") == "no_time_available", f"{r.status} {r.text[:160]}")

    before = wallet_of(w)
    too_long = extend_call(w, 2, 91, secrets.token_hex(8))
    REPORT.check("EXT", "91 minutes -> 400 minutes_out_of_range with max_minutes 90 (the relay cap)",
                 too_long.status == 400 and too_long.get("error") == "minutes_out_of_range" and too_long.get("max_minutes") == 90,
                 f"{too_long.status} {too_long.text[:160]}")
    no_nonce = extend_call(w, 2, 15, None)
    REPORT.check("EXT", "no nonce -> 400 nonce_required (an extension moves money; a retry must replay, never re-buy)",
                 no_nonce.status == 400 and no_nonce.get("error") == "nonce_required", f"{no_nonce.status} {no_nonce.text[:160]}")
    booking_code = w.tokens.get(2)
    if booking_code:
        as_wallet = extend_call(w, 2, 15, secrets.token_hex(8), token=booking_code)
        REPORT.check("EXT", "B3's BOOKING code as the buyer -> 400 not_recognised (a roster code is not a wallet)",
                     as_wallet.status == 400 and as_wallet.get("error") == "not_recognised", f"{as_wallet.status} {as_wallet.text[:160]}")
    off_box = extend_call(w, 5, 15, secrets.token_hex(8))
    REPORT.check("EXT", "court 5 (not on this box) -> 400 court_not_on_device",
                 off_box.status == 400 and off_box.get("error") == "court_not_on_device", f"{off_box.status} {off_box.text[:160]}")
    REPORT.check("EXT", "none of the refusals moved the wallet", wallet_of(w) == before)
    if sim is not None:
        sim.send("OFF", "B")
        sim.expect_frame(lambda f: f.verb == "EVT" and f.args[:2] == ["OFF", "B"], 5, "!EVT,OFF,B")


def early_scan(w: World) -> None:
    step("A2-15  A scan three hours early is identified but not lit")
    assert w.box is not None
    token = w.tokens.get(1)
    if not token:
        raise StepFailed("no token for B6 (relay 1)")
    r = expect_status(w.box.call("POST", "/api/v1/device/activate", {"method": "qr", "token": token}), 200, "activate B6")
    starts_in = r.get("starts_in_seconds", 0)
    expected = int((w.b6["starts_at"] - now_utc()).total_seconds())
    REPORT.check("A2-15", "activate B6 -> activated:false, reason too_early, granted_seconds 0, court_number 2",
                 r.get("activated") is False and r.get("reason") == "too_early" and r.get("granted_seconds") == 0 and r.get("court_number") == 2, f"resp={r.json}")
    REPORT.check("A2-15", "starts_in_seconds counts to the slot start (~3h)", abs(starts_in - expected) <= 3, f"starts_in={starts_in} expected~{expected}")
    again = expect_status(w.box.call("POST", "/api/v1/device/activate", {"method": "qr", "token": token}), 200, "activate B6 again")
    REPORT.check("A2-15", "a second early scan is still too_early: nothing was stamped (a live session is never too early)",
                 again.get("reason") == "too_early")
    ledger = expect_status(w.http.get(f"/api/v1/admin/ledger?userId={w.m_user_id}&limit=200", token=w.admin_token), 200, "ledger M").json
    b6_rows = [r for r in ledger if r.get("relatedBookingId") == w.b6["id"]]
    REPORT.check("A2-15", "B6's only ledger movement is its booking charge — no activation-time movement", len(b6_rows) == 1 and b6_rows[0]["type"] == "BookingCharge")


def money_leg(w: World, mb: Mountebank) -> None:
    step("Money  A PayFast package purchase through the mountebank imposter, ITN verified and replay refused")
    creds = expect_status(w.http.put("/api/v1/admin/payments/payfast", {
        "merchant_id": SEEDED_PAYFAST_MERCHANT_ID, "merchant_key": SEEDED_PAYFAST_MERCHANT_KEY,
        "passphrase": SCENARIO_PAYFAST_PASSPHRASE, "environment": "test"}, token=w.admin_token), 200, "payfast credentials")
    REPORT.check("money", "the admin sets the club's PayFast credentials and the club reads as configured",
                 creds.get("configured") is True and creds.get("passphrase_set") is True and "passphrase" not in creds.json,
                 f"resp={creds.json}")
    wallet_before = mins(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_minutes"])
    # The member's own shelf (P13 §3.4, §4.2). The seeded club packages are 1 hour / 5 hours /
    # 10 hours; whatever discount M's groups set applies to the RAND, never the minutes.
    shelf = expect_status(w.http.get("/api/v1/minutes/packages", token=w.m_token), 200, "shelf").json
    hour = next((p for p in shelf.get("packages", []) if p.get("source") == "club" and p.get("minutes") == 60), None)
    if hour is None:
        raise StepFailed(f"no one-hour club package on M's shelf: {shelf}")
    price = dec(hour["price_zar"])
    amount = f"{price:.2f}"
    REPORT.check("money", "M's shelf offers the one-hour club package as 60 whole minutes, priced in rand",
                 mins(hour["minutes"]) == 60 and price > 0, f"package={hour}")
    buy = expect_status(w.http.post("/api/v1/minutes/purchase", {"packageId": hour["id"], "quotedPriceZar": float(price)},
                                    token=w.m_token), 200, "purchase register")
    m_payment_id = buy["checkout_id"]
    REPORT.check("money", "POST /minutes/purchase registers a pending purchase locked at the shelf price and points the browser at PayFast",
                 bool(m_payment_id) and "/eng/process" in buy.get("redirect_url", "") and dec(buy.get("amount_zar", -1)) == price
                 and mins(buy["package"]["minutes"]) == 60, f"resp={buy.json}")
    # The browser leg, against the imposter instead of PayFast.
    form = form_encode([("merchant_id", SEEDED_PAYFAST_MERCHANT_ID), ("m_payment_id", m_payment_id), ("amount", amount), ("item_name", "Minutes")])
    checkout = w.http.call("POST", f"{mb.base}/eng/process", raw=form, content_type="application/x-www-form-urlencoded", absolute=True)
    REPORT.check("money", "the imposter answers the checkout POST with a 302 back to the return URL",
                 checkout.status == 302 and "/wallet/" in checkout.headers.get("Location", ""), f"Location={checkout.headers.get('Location')}")
    # The server-to-server leg: an ITN as PayFast would sign it, in posted order.
    pf_payment_id = str(1_000_000 + secrets.randbelow(9_000_000))
    fields = [("m_payment_id", m_payment_id), ("pf_payment_id", pf_payment_id), ("payment_status", "COMPLETE"),
              ("item_name", "Minutes"), ("amount_gross", amount), ("amount_fee", "-2.30"), ("amount_net", f"{price - Decimal('2.30'):.2f}"),
              ("merchant_id", SEEDED_PAYFAST_MERCHANT_ID)]
    signed = fields + [("signature", payfast_signature(fields, SCENARIO_PAYFAST_PASSPHRASE))]
    itn = w.http.call("POST", f"/api/v1/credit/topup/callback?tenant={SEEDED_TENANT}", raw=form_encode(signed), content_type="application/x-www-form-urlencoded")
    REPORT.check("money", "a correctly signed COMPLETE ITN is accepted and adds the package's locked 60 minutes",
                 itn.status == 200 and itn.get("ok") is True and itn.get("minutes") == 60 and itn.get("package_id") == hour["id"], f"resp={itn.text[:160]}")
    wallet_mid = mins(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_minutes"])
    REPORT.check("money", "M's wallet rose by exactly 60 minutes", wallet_mid == wallet_before + 60, f"{wallet_before} -> {wallet_mid}")
    status = expect_status(w.http.get(f"/api/v1/minutes/purchase/{buy['purchase_id']}", token=w.m_token), 200, "purchase status")
    REPORT.check("money", "the pending purchase is now Completed", status.get("status") == "Completed")
    replay = w.http.call("POST", f"/api/v1/credit/topup/callback?tenant={SEEDED_TENANT}", raw=form_encode(signed), content_type="application/x-www-form-urlencoded")
    wallet_after = mins(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_minutes"])
    REPORT.check("money", "replaying the same ITN is acknowledged as idempotent and adds nothing a second time",
                 replay.status == 200 and replay.get("idempotent") is True and wallet_after == wallet_mid, f"resp={replay.text[:120]}")
    tampered = [(k, ("999.00" if k == "amount_gross" else v)) for k, v in signed]
    bad = w.http.call("POST", f"/api/v1/credit/topup/callback?tenant={SEEDED_TENANT}", raw=form_encode(tampered), content_type="application/x-www-form-urlencoded")
    REPORT.check("money", "an ITN altered after signing is refused (401)", bad.status == 401)
    ledger = expect_status(w.http.get(f"/api/v1/admin/ledger?userId={w.m_user_id}&type=TopUp&limit=50", token=w.admin_token), 200, "ledger topups").json
    REPORT.check("money", "exactly one TopUp ledger row of +60 minutes exists for this payment",
                 sum(1 for r in ledger if mins(r["signedAmountMinutes"]) == 60) == 1,
                 f"rows={[(r.get('signedAmountMinutes'), r.get('comment')) for r in ledger]}")


def no_show_sweep(w: World) -> None:
    step("H5/C6  The no-show sweep releases the slot and leaves attended bookings alone")
    n_before = next(m for m in expect_status(w.http.get("/api/v1/admin/members", token=w.admin_token), 200, "members").json if m["user_id"] == w.n_user_id)
    grace_due = w.b7["starts_at"] + timedelta(minutes=1)
    wait = (grace_due - now_utc()).total_seconds()
    if wait > 0:
        print(f"  waiting {wait:.0f}s for B7's grace window to lapse, then up to 60s for the 30s sweep ...", flush=True)
    deadline = grace_due + timedelta(seconds=75)
    slot7 = None
    while now_utc() < deadline:
        slot7 = find_slot(w, w.b7["id"], w.b7["starts_at"])
        if slot7 and slot7["status"] == "noshow":
            break
        time.sleep(5)
    swept_at = now_utc()
    REPORT.check("H5", "an unscanned booking (B7) is swept to noshow within ~30s of its grace window lapsing", bool(slot7) and slot7["status"] == "noshow", f"slot={slot7}")
    if slot7 and slot7["status"] == "noshow":
        ends = parse_dt(slot7["endsAtUtc"])
        REPORT.check("H5", "B7's EndsAt is truncated to the sweep time (<= now, < the booked end)", ends <= swept_at and ends < w.b7["ends_at"], f"ends_at={ends.isoformat()}")
    ledger_n = expect_status(w.http.get(f"/api/v1/admin/ledger?userId={w.n_user_id}&limit=200", token=w.admin_token), 200, "ledger N").json
    rows7 = {r["type"]: mins(r["signedAmountMinutes"]) for r in ledger_n if r.get("relatedBookingId") == w.b7["id"]}
    charged7 = w.b7["amount"]
    # ⌊30% of the charge⌋: the member keeps the part-minute (P13 §1.2) — 45 → 13, never 13.5 or 14.
    penalty7 = charged7 * 30 // 100
    REPORT.check("H5", f"N's ledger for B7: BookingCharge -{charged7}, CancellationRefund +{charged7}, NoShowPenalty -{penalty7} (⌊30%⌋) as separate rows",
                 rows7.get("BookingCharge") == -charged7 and rows7.get("CancellationRefund") == charged7
                 and rows7.get("NoShowPenalty") == -penalty7, f"rows={rows7}")
    n_after = next(m for m in expect_status(w.http.get("/api/v1/admin/members", token=w.admin_token), 200, "members").json if m["user_id"] == w.n_user_id)
    # Money is ledger-only: the balance the admin screen shows must be the sum of N's rows,
    # including the two the sweep just posted. (A plain before/after delta would also
    # pick up any seeded booking of N's the same sweep happened to settle.)
    ledger_sum = sum(mins(r["signedAmountMinutes"]) for r in ledger_n)
    REPORT.check("H5", "N's balance equals the sum of N's ledger rows after the sweep (no stored balance drift)",
                 mins(n_after["balance_minutes"]) == ledger_sum and n_after["balance_minutes"] >= n_before["balance_minutes"] + charged7 - penalty7,
                 f"{n_before['balance_minutes']} -> {n_after['balance_minutes']} (ledger sum {ledger_sum})")
    rebook = w.http.post("/api/v1/admin/bookings", {
        "courtId": w.courts[4], "userId": w.n_user_id, "startsAt": iso(now_utc() + timedelta(seconds=45)), "sliceCount": 1,
    }, token=w.admin_token)
    REPORT.check("H5", "the freed remainder of B7's slot on court 4 is immediately bookable again (2xx, not slot_taken)", 200 <= rebook.status < 300, f"HTTP {rebook.status} {rebook.text[:100]}")

    slot1 = find_slot(w, w.b1["id"], w.b1["starts_at"])
    slot3 = find_slot(w, w.b3["id"], w.b3["starts_at"])
    REPORT.check("C6", "B1 (attended via the uploaded event) is still booked after the sweep, not noshow", bool(slot1) and slot1["status"] == "booked", f"status={slot1 and slot1['status']}")
    REPORT.check("C3", "B3 (attended via /activate) is still booked after the sweep", bool(slot3) and slot3["status"] == "booked")
    ledger_m = expect_status(w.http.get(f"/api/v1/admin/ledger?userId={w.m_user_id}&limit=300", token=w.admin_token), 200, "ledger M").json
    for label, b in (("C6", w.b1), ("C3", w.b3)):
        rows = [(r["type"], mins(r["signedAmountMinutes"])) for r in ledger_m if r.get("relatedBookingId") == b["id"]]
        REPORT.check(label, f"no refund and no penalty were posted for the attended booking on court {b['court']}",
                     rows == [("BookingCharge", -b["amount"])], f"rows={rows}")


def mega_half(sim: Simulator) -> None:
    step("Mega  The serial protocol against the firmware's own CourtBox (simulator)")
    sim.send("PING")
    pong = sim.expect_frame(lambda f: f.verb == "PONG", 5, "!PONG")
    # FIVE ARGUMENTS NOW, and the two-argument form still decodes — kVerbSpecs
    # gives PONG minArgs 2 and maxArgs 5 precisely so a bridge flashed ahead of
    # the Mega it is wired to can still read the answer, and the Mega is the half
    # that cannot be reflashed over the air. This assertion used to demand
    # exactly two and would now be red for the counters being there at all.
    REPORT.check("M-serial", "!PING is answered with !PONG,<version>,<uptime_s>,<txDropped>,<rxErrors>,<unauthorised>",
                 len(pong.args) == 5 and pong.args[0].count(".") == 2 and all(a.isdigit() for a in pong.args[1:]),
                 str(pong))
    # The counters are the whole reason the three extra arguments exist: a
    # climbing "presses thrown away because the window was shut" is a stuck
    # contact or a bridge that stopped sending !AUTH, and until now it was
    # invisible from the office. E-BTN-1 below asserts that it climbs.
    REPORT.check("M-serial", "the three since-boot counters are readable off the wire (tx dropped, rx errors, unauthorised presses)",
                 int(pong.args[2]) >= 0 and int(pong.args[3]) >= 0 and int(pong.args[4]) >= 0,
                 f"txDropped={pong.args[2]} rxErrors={pong.args[3]} unauthorised={pong.args[4]}")

    # A DURATION key without authorisation: dropped, never queued — it is the
    # only press that can buy anything, and held over it would buy on the next
    # member's scan.
    sim.console("btn 1")
    REPORT.check("M-serial", "a DURATION press while !AUTH is not armed produces no !BTN frame (dropped, not queued)", sim.no_frame(lambda f: f.verb == "BTN", 1.5))
    # A COURT key is forwarded with the window shut (Mega 2.1.0): on its own it
    # buys nothing and lights nothing, and only the bridge can answer it with the
    # court's minutes left or SCAN YOUR CODE.
    sim.console("btn A")
    court_key = sim.expect_frame(lambda f: f.verb == "BTN", 3, "!BTN,A with the window shut")
    REPORT.check("M-serial", "a COURT press with the window shut is forwarded as !BTN,A for the bridge to answer",
                 court_key.args == ["A"], str(court_key))
    sim.send("AUTH", "30")
    time.sleep(0.2)
    sim.console("btn 1")
    btn = sim.expect_frame(lambda f: f.verb == "BTN", 3, "!BTN,1")
    REPORT.check("M-serial", "after !AUTH,30 the duration press arrives as !BTN,1 (debounced once)", btn.args == ["1"], str(btn))
    sim.send("AUTH", "1")
    expired = sim.expect_frame(lambda f: f.verb == "EVT" and f.args[:1] == ["AUTHEXPIRED"], 4, "!EVT,AUTHEXPIRED")
    REPORT.check("M-serial", "!AUTH,1 lapses into exactly one !EVT,AUTHEXPIRED", bool(expired), str(expired))
    sim.console("btn 2")
    REPORT.check("M-serial", "a duration press after the window lapsed is dropped again", sim.no_frame(lambda f: f.verb == "BTN", 1.5))

    # The relay timer is the Mega's own: AUTOOFF fires with no bridge involvement.
    # Court B may still be lit from the EXT step, and an !ON on a lit court only
    # moves its deadline (no mask change, so no immediate !STATE): release it first.
    sim.send("OFF", "B")
    sim.expect_frame(lambda f: f.verb == "STATE" and int(f.args[0]) & 0b0010 == 0, 12, "!STATE with B released")
    sim.send("ON", "B", "1")
    on = sim.expect_frame(lambda f: f.verb == "STATE" and int(f.args[0]) & 0b0010, 5, "!STATE with B")
    REPORT.check("M-serial", "!ON,B,1 closes relay B: !STATE mask bit 1 set, remaining B <= 1", int(on.args[2]) <= 1, str(on))
    autooff = sim.expect_frame(lambda f: f.verb == "EVT" and f.args[:2] == ["AUTOOFF", "B"], 5, "!EVT,AUTOOFF,B")
    off_state = sim.expect_frame(lambda f: f.verb == "STATE" and int(f.args[0]) & 0b0010 == 0, 5, "!STATE with B clear")
    REPORT.check("M-serial", "the deadline releases the relay by itself: !EVT,AUTOOFF,B then !STATE with B clear", bool(autooff) and bool(off_state), f"{autooff} / {off_state}")

    # Clamp: a duration past the hard cap is clamped, never refused.
    sim.send("ON", "D", "99999")
    capped = sim.expect_frame(lambda f: f.verb == "STATE" and int(f.args[0]) & 0b1000, 5, "!STATE with D")
    REPORT.check("M-serial", "!ON,D,99999 is clamped to the 5400s hard cap (remaining D <= 5400, > 5390)", 5390 < int(capped.args[4]) <= 5400, str(capped))
    sim.send("OFF", "D")
    sim.expect_frame(lambda f: f.verb == "EVT" and f.args[:2] == ["OFF", "D"], 5, "!EVT,OFF,D")

    # Integrity: a corrupted frame is dropped with !ERR,BADCRC; a bad court with NOCOURT.
    sim.send_raw(b"!ON,A,60*00\n")
    badcrc = sim.expect_frame(lambda f: f.verb == "ERR", 5, "!ERR")
    REPORT.check("M-serial", "a frame with a wrong checksum is refused with !ERR,BADCRC and relay A stays open", badcrc.args == ["BADCRC"], str(badcrc))
    REPORT.check("M-serial", "no !STATE with relay A set follows the corrupt !ON", sim.no_frame(lambda f: f.verb == "STATE" and int(f.args[0]) & 1, 1.0))
    sim.send("ON", "E", "60")
    nocourt = sim.expect_frame(lambda f: f.verb == "ERR", 5, "!ERR")
    REPORT.check("M-serial", "!ON on court E is refused with !ERR,NOCOURT", nocourt.args == ["NOCOURT"], str(nocourt))
    sim.send("EXT", "A", "60")
    badarg = sim.expect_frame(lambda f: f.verb == "ERR", 5, "!ERR")
    REPORT.check("M-serial", "!EXT on an open relay is refused with !ERR,BADARG (never an implicit !ON)", badarg.args == ["BADARG"], str(badarg))
    sim.send("RST")
    rst_state = sim.expect_frame(lambda f: f.verb == "STATE", 12, "!STATE after RST")
    REPORT.check("M-serial", "!RST leaves every relay open (mask 0)", rst_state.args[0] == "0", str(rst_state))


# ---------------------------------------------------------------------------
# The glass: what can paint it, what takes it away, and what it costs the link
#
# WHY THESE STEPS EXIST AT ALL. A refusal screen the bridge painted for an
# unrecognised scan never left the panel: `AuthWindow::arm(now, 0)` calls
# `disarm()`, `disarm()` does not set the lapse edge, and any `!LCD` disarmed the
# Mega's only other timer — so for the one sequence a member is most likely to
# produce (`scan`, refusal, `!AUTH,0`) BOTH paths back to the idle screen were
# shut. Fifty seconds into the reproduction the glass still read the refusal and
# every button was dead behind it. It was intermittent BY MEMBERSHIP STATUS,
# because a RECOGNISED refusal recovered when its window lapsed naturally, which
# is why it survived review.
#
# The fix is structural — every screen the bridge paints is an overlay the
# decoder clamps into [1, 120] seconds — so the test has to be structural too:
# these steps drive EVERY verb that can paint, not the one that broke, and they
# run at an ordinary clock base and again four seconds before the 49.7-day
# millis() rollover, because a box that has been up for forty-nine days and
# reboots is the normal case for a club box.
#
# None of this needs the backend. It is the Mega's own firmware, over a socket.
# ---------------------------------------------------------------------------


def lcd_geometry(sim: Simulator, label: str) -> None:
    """The panel's own shape, asserted before any step reads a row off it.

    The firmware drives 20x4 now, and it used to drive 16x2 on the same physical
    2004A. Every row assertion below is written against twenty columns; a build
    that went back to sixteen would make all of them fail with a diff nobody
    could read, so the geometry is checked ONCE, by itself, and says which
    number moved."""
    frame = sim.expect_screen(lambda f: True, 10, "any painted panel")
    REPORT.check("E-LCD", f"[{label}] the panel is driven as {LCD_COLS} columns by {LCD_ROWS} rows",
                 len(frame.rows) == LCD_ROWS and all(len(r) == LCD_COLS for r in frame.rows),
                 f"rows={len(frame.rows)} cols={sorted({len(r) for r in frame.rows})}")


def screen_deadlines(sim: Simulator, label: str) -> None:
    """E-LCD-1 — no screen outlives its hold, FOR EVERY VERB THAT CAN PAINT ONE."""
    step(f"E-LCD-1  [{label}] every verb that paints is a verb whose screen leaves again")
    # THE MARK IS TAKEN BEFORE THE SEND, EVERY TIME. `expect_screen` looks
    # backwards from its mark first — the board paints in one 1 ms pass and
    # Python is frequently still on its way back to look — so a mark taken after
    # the send is a mark that has already missed the frame it is waiting for.
    reset = sim.lcd_mark()
    sim.send("RST")
    sim.expect_landing(6, reset)

    # (a) `!LCD` — the legacy two-row form, which is the one an UN-UPGRADED
    # bridge sends and therefore the one the fix has to hold for.
    mark = sim.lcd_mark()
    sim.send("LCD", "GRANTED", "45 MIN")
    sim.expect_screen(lambda f: f.row(0) == lcd_pad("GRANTED"), 4, "the !LCD overlay", mark)
    landed = sim.expect_landing(DEFAULT_HOLD_SECONDS + 1.0, mark)
    REPORT.check("E-LCD-1", f"[{label}] !LCD paints an overlay and the landing screen is back inside its "
                            f"{DEFAULT_HOLD_SECONDS}s default hold + 1s",
                 True, landed.text())

    # (b) `!ROW` x4 + `!SHOW` — the v2 form, with a hold of its own.
    mark = sim.lcd_mark()
    for row, text in enumerate(("HI NALEDI", "45 MIN", "COURT 3", "PRESS A")):
        sim.send("ROW", str(row), text)
    sim.send("SHOW", "5", "0")
    sim.expect_screen(lambda f: f.row(0) == lcd_pad("HI NALEDI"), 4, "the committed overlay", mark)
    sim.expect_landing(6.0 + 1.0, mark)
    REPORT.check("E-LCD-1", f"[{label}] !ROW+!SHOW,5 paints a four-row overlay and the landing screen is "
                            f"back inside 5s + 1s", True)

    # (c) THE EXACT LIVE SEQUENCE THAT STOOD FOR FIFTY SECONDS. A code the API
    # does not recognise, the bridge's refusal, and then the `!AUTH,0` that used
    # to shut the second of the two paths home.
    mark = sim.lcd_mark()
    sim.console("scan RANDOMRECEIPT42")
    scan = sim.expect_frame(lambda f: f.verb == "SCAN", 5, "!SCAN,RANDOMRECEIPT42")
    REPORT.check("E-LCD-1", f"[{label}] the unrecognised receipt reaches the bridge link as !SCAN",
                 scan.args == ["RANDOMRECEIPT42"], str(scan))
    feedback = sim.expect_screen(lambda f: f.row(0) == lcd_pad(SCAN_FEEDBACK_ROW0), 4,
                                 "the scan's own local feedback", mark)
    REPORT.check("E-LCD-1", f"[{label}] the scan's own feedback fits the club's 16x2: "
                            f"`{SCAN_FEEDBACK_ROW0}` / `{SCAN_FEEDBACK_ROW1}`",
                 feedback.row(1) == lcd_pad(SCAN_FEEDBACK_ROW1), feedback.text())
    sim.send("LCD", "CODE NOT RECOGNISED", "THEN SCAN AGAIN")
    refusal = sim.expect_screen(lambda f: f.row(0) == lcd_pad("CODE NOT RECOGNISED"), 4,
                                "the refusal screen", mark)
    sim.send("AUTH", "0")
    home = sim.expect_landing(DEFAULT_HOLD_SECONDS + 1.0, mark)
    REPORT.check("E-LCD-1", f"[{label}] scan -> !LCD,<refusal> -> !AUTH,0 and the landing screen is back "
                            f"inside {DEFAULT_HOLD_SECONDS}s + 1s — this screen used to stand for fifty "
                            f"seconds with every button dead behind it",
                 True, f"{refusal.at:.0f} -> {home.at:.0f} ({home.at - refusal.at:.1f}s)")
    # And the buttons behind it are not silent: the Mega answers a press it had
    # to drop, which is the other half of the same incident.
    press = sim.lcd_mark()
    sim.console("btn 1")
    sim.expect_screen(lambda f: f.row(3) == lcd_pad(HINT_ROW) and f.row(1) == lcd_pad(HINT_ROW1), 3,
                      "the dropped-press hint", press)
    REPORT.check("E-LCD-1", f"[{label}] ...and a press behind it is ANSWERED rather than swallowed",
                 True)

    # (d) A VERB THIS FIRMWARE HAS NEVER HEARD OF. The point of the structural
    # fix is that a screen added next year inherits the deadline without anybody
    # remembering to — so the case that matters is the verb nobody has written.
    time.sleep(HINT_SECONDS + 0.4)
    mark = sim.lcd_mark()
    sim.send("ZZTOP", "1")
    err = sim.expect_frame(lambda f: f.verb == "ERR", 4, "!ERR for an unknown verb")
    REPORT.check("E-LCD-1", f"[{label}] a verb from a future firmware is !ERR,BADVERB and paints NOTHING "
                            f"— an unknown verb cannot leave a screen behind because it cannot leave one",
                 err.args == ["BADVERB"] and not sim.lcd_since(mark), f"{err} frames={len(sim.lcd_since(mark))}")
    mark = sim.lcd_mark()
    sim.send("ROW", "4", "OFF THE END")
    err = sim.expect_frame(lambda f: f.verb == "ERR", 4, "!ERR for !ROW,4")
    REPORT.check("E-LCD-1", f"[{label}] !ROW,4 is REFUSED with !ERR,BADARG rather than folded onto row 3 "
                            f"— a peer addressing a row this panel does not have disagrees about the "
                            f"hardware, and hiding that behind a screen that merely looks odd is worse",
                 err.args == ["BADARG"] and not sim.lcd_since(mark), f"{err}")

    # (e) `!IDLE` paints the action row, so it is a verb that can paint and is in
    # this sweep on exactly those terms. It has no hold because it does not take
    # the glass away from anybody: it changes the landing screen itself.
    for flags, hhmm, expect in ((0b1000, "----", "STARTING UP"), (0b0000, "----", "READY NO WIFI"),
                                (0b0001, "----", "READY NO SERVER"), (0b0111, "1345", "READY")):
        mark = sim.lcd_mark()
        sim.send("IDLE", str(flags), hhmm)
        got = sim.expect_screen(lambda f, e=expect: f.row(3).startswith(e), 4,
                                f"an action row reading {expect!r}", mark)
        REPORT.check("E-LCD-1", f"[{label}] !IDLE,{flags},{hhmm} -> the action row reads {expect!r}",
                     True, repr(got.row(3)))
    clocked = sim.expect_screen(lambda f: f.row(3).endswith("13:45"), 4, "the club's wall clock", 0)
    REPORT.check("E-LCD-1", f"[{label}] ...and a trusted clock renders in the action row's last five cells, "
                            f"where a countdown would otherwise be",
                 clocked.row(3) == lcd_pad("READY")[:LCD_COLS - 5] + "13:45", repr(clocked.row(3)))


def show_ceiling(sim: Simulator, label: str) -> None:
    """E-LCD-2 — the two-minute ceiling, measured rather than derived.

    SLOW BY CONSTRUCTION: the assertion is that a screen asking for forever is
    still there at 115 s and gone by 123 s, and there is no way to learn that in
    less than two minutes. `--quick` skips it; nothing else does, because a
    ceiling nobody ever waits out is a ceiling nobody has ever seen hold."""
    step(f"E-LCD-2  [{label}] the two-minute ceiling: !SHOW,4294967295 is clamped by the DECODER")
    sim.send("RST")
    sim.expect_landing(6, sim.lcd_mark())
    mark = sim.lcd_mark()
    for row, text in enumerate(("FOREVER PLEASE", "ASKED FOR 2^32-1", "", "")):
        sim.send("ROW", str(row), text)
    armed = time.monotonic()
    sim.send("SHOW", "4294967295", "0")
    sim.expect_screen(lambda f: f.row(0) == lcd_pad("FOREVER PLEASE"), 4, "the unbounded overlay", mark)
    print(f"  waiting out the {SHOW_HOLD_MAX_SECONDS}s ceiling (this is the slow step) ...", flush=True)

    # JUST BEFORE. A screen clamped to something SHORTER than the ceiling would
    # pass the "it went away" half on its own, so the ceiling is only proved by
    # asserting it is still there five seconds before it.
    time.sleep(max(0.0, (SHOW_HOLD_MAX_SECONDS - 5) - (time.monotonic() - armed)))
    still = sim.screen()
    REPORT.check("E-LCD-2", f"[{label}] a hold of 2^32-1 seconds is still on the glass at "
                            f"{SHOW_HOLD_MAX_SECONDS - 5}s — clamped UP to the ceiling, not down to a default",
                 still.row(0) == lcd_pad("FOREVER PLEASE"),
                 f"t+{time.monotonic() - armed:.0f}s screen={still.text()}")
    home = sim.expect_landing(SHOW_HOLD_MAX_SECONDS + 4 - (time.monotonic() - armed), mark)
    held = home.at - armed
    REPORT.check("E-LCD-2", f"[{label}] ...and gone just after it: no screen a bridge paints can outlive "
                            f"{SHOW_HOLD_MAX_SECONDS}s, whatever it asks for",
                 SHOW_HOLD_MAX_SECONDS - 1 <= held <= SHOW_HOLD_MAX_SECONDS + 4, f"held={held:.1f}s")


def atomic_commit(sim: Simulator, label: str) -> None:
    """E-LCD-3 — `!ROW` paints nothing and `!SHOW` commits all four rows at once.

    THE OBSERVED TEAR was `CRUSADERS COURTS` on row 0 beside `45 MIN` on row 1 —
    the old screen's second line under the new screen's first — and it came from
    `noteAuthLapse` painting the landing screen straight over a live grant
    screen thirty seconds after a court was lit.

    A settled screen is what a member could read; see `Simulator.settled_since`.
    The console port repaints the whole panel on every `print()`, so one commit
    reaches this transcript as four frames microseconds apart, and asserting on
    the raw frames would be asserting about the transcript rather than the
    glass."""
    step(f"E-LCD-3  [{label}] the commit is atomic, and a lapsing auth window repaints nothing")
    sim.send("RST")
    sim.send("MAP", "1", "2", "3", "4")
    sim.send("ON", "A", "2700")
    sim.send("IDLE", "7", "1345")
    before = sim.expect_screen(lambda f: f.row(0) == lcd_pad(IDLE_ROW0) and f.row(2).startswith("A 45"),
                               8, "the landing screen with court A lit", sim.lcd_mark())

    staged = ("HI NALEDI", "45 MIN", "COURT 3", "PRESS A")
    mark = sim.lcd_mark()
    for row, text in enumerate(staged):
        sim.send("ROW", str(row), text)
    time.sleep(0.6)
    REPORT.check("E-LCD-3", f"[{label}] four !ROW frames stage a whole new screen and paint NOTHING — "
                            f"which is what makes the commit atomic rather than a repaint the member "
                            f"watches happen",
                 not sim.lcd_since(mark), f"frames={[f.text() for f in sim.lcd_since(mark)]}")

    commit = sim.lcd_mark()
    sim.send("SHOW", "8", "0")
    got = sim.expect_screen(lambda f: f.row(0) == lcd_pad(staged[0]), 4, "the committed screen", commit)
    REPORT.check("E-LCD-3", f"[{label}] !SHOW commits all four staged rows at once",
                 [r.rstrip() for r in got.rows] == list(staged), got.text())
    torn = [f for f in sim.settled_since(commit)
            if f.row(0) == lcd_pad(staged[0]) and f.row(1) == before.row(1)]
    REPORT.check("E-LCD-3", f"[{label}] no settled screen mixes the new screen's row 0 with the old "
                            f"screen's row 1 — the observed tear, exactly",
                 not torn, f"torn={[f.text() for f in torn]}")

    # AND THE OTHER DIRECTION, which is where the tear was actually produced: the
    # authorisation window closing is about the BUTTONS, and the screen has its
    # own deadline that is nobody else's to take away.
    lapse = sim.lcd_mark()
    sim.send("AUTH", "1")
    sim.expect_frame(lambda f: f.verb == "EVT" and f.args[:1] == ["AUTHEXPIRED"], 5, "!EVT,AUTHEXPIRED")
    time.sleep(0.5)
    mixed = [f for f in sim.settled_since(lapse)
             if f.row(0) == lcd_pad(IDLE_ROW0) and f.row(1) == lcd_pad("45 MIN")]
    REPORT.check("E-LCD-3", f"[{label}] the auth window lapsing repaints NOTHING: `{IDLE_ROW0}` "
                            f"never appears above the grant screen's `45 MIN`",
                 not mixed and sim.screen().row(0) == lcd_pad(staged[0]),
                 f"mixed={[f.text() for f in mixed]} now={sim.screen().text()}")
    sim.send("OFF", "A")


def lit_court_row(sim: Simulator, label: str) -> None:
    """E-LCD-4 — a lit court is visible, and it costs the link nothing.

    The whole argument for rendering the countdown on the MEGA is that RelayGuard
    already holds the truth and the ESP is the half that goes away. Pushing a
    per-second countdown over 9600 baud would cost about 117 ms of every second;
    rendering it here costs a row of I2C and no serial traffic at all. That is an
    assertion, so it is asserted: between the two samples the ONLY frames on the
    link are the periodic `!STATE`."""
    step(f"E-LCD-4  [{label}] the court row counts down on the Mega, for free")
    sim.send("RST")
    sim.send("MAP", "1", "2", "3", "4")
    sim.send("IDLE", "7", "1345")
    sim.send("ON", "A", "2700")
    lit = sim.expect_screen(lambda f: f.row(2).startswith("A 45"), 8, "court A lit for 45 minutes",
                            sim.lcd_mark())
    REPORT.check("E-LCD-4", f"[{label}] !MAP,1,2,3,4 then !ON,A,2700 -> row 2 reads "
                            f"`A 45 B -- C -- D --`, with `--` for a mapped court that is dark",
                 lit.row(2) == lcd_pad("A 45 B -- C -- D --"), repr(lit.row(2)))
    REPORT.check("E-LCD-4", f"[{label}] ...and row 1 — the only row besides the scan prompt a 16x2 shows — "
                            f"reads `COURT A 45 MIN` under `{IDLE_ROW0}` (Mega 2.1.0)",
                 lit.row(0) == lcd_pad(IDLE_ROW0) and lit.row(1) == lcd_pad("COURT A 45 MIN"), lit.text())

    quiet_from = sim.frame_mark()
    print("  waiting ~60s for the court row to tick down a minute, with the link silent ...", flush=True)
    ticked = sim.expect_screen(lambda f: f.row(2).startswith("A 44"), 80, "the court row at 44 minutes",
                               sim.lcd_mark())
    REPORT.check("E-LCD-4", f"[{label}] ...and a minute later, with nobody asked, `A 44` — on row 2 and "
                            f"on the 16x2's row 1",
                 ticked.row(2) == lcd_pad("A 44 B -- C -- D --") and ticked.row(1) == lcd_pad("COURT A 44 MIN"),
                 ticked.text())
    between = sim.frames_after(quiet_from)
    REPORT.check("E-LCD-4", f"[{label}] and NOTHING crossed the link between the two but the periodic "
                            f"!STATE — the countdown is rendered from RelayGuard and costs the bridge "
                            f"no bandwidth at all",
                 bool(between) and all(f.verb == "STATE" for f in between),
                 f"{len(between)} frame(s): {sorted({f.verb for f in between})}")

    # A relay the heartbeat never mapped renders BLANK, not `--`: a dash claims
    # the box drives a dark court, and it does not drive this one at all.
    mark = sim.lcd_mark()
    sim.send("MAP", "0", "2", "3", "4")
    blanked = sim.expect_screen(lambda f: f.row(2).startswith("     "), 5, "relay 0 unmapped", mark)
    REPORT.check("E-LCD-4", f"[{label}] a relay !MAP never mapped renders BLANK rather than `--`, because "
                            f"a dash claims a dark court and the box does not drive this one",
                 blanked.row(2) == lcd_pad("     B -- C -- D --"), repr(blanked.row(2)))
    sim.send("OFF", "A")
    sim.send("MAP", "1", "2", "3", "4")


def dropped_press(sim: Simulator, label: str) -> None:
    """E-BTN-1 — a press the box cannot act on says so, ONCE.

    The DROP was always right: a press queued until the next window opens fires a
    relay on the NEXT member's scan, which is the unexpiring-flag defect the
    window exists to close. The SILENCE was the bug — six presses across all
    eight channels produced no frame, no pixel and no sound, and the box was
    indistinguishable from broken."""
    step(f"E-BTN-1  [{label}] a dropped DURATION press is answered once, rate-limited, and never queued")
    sim.send("RST")
    sim.send("AUTH", "0")
    sim.send("IDLE", "7", "1345")
    sim.expect_landing(6, sim.lcd_mark())
    time.sleep(HINT_RATE_LIMIT_SECONDS + 0.4)  # past any hint this step did not make

    ping = sim.frame_mark()
    sim.send("PING")
    before = sim.expect_frame(lambda f: f.verb == "PONG", 5, "!PONG before the presses")

    first = sim.lcd_mark()
    btn_from = sim.frame_mark()
    sim.console("btn 1")
    hinted = sim.expect_screen(lambda f: f.row(3) == lcd_pad(HINT_ROW), 3, "the hint", first)
    REPORT.check("E-BTN-1", f"[{label}] with the window shut, `btn 1` paints `{HINT_ROW}` in the action row "
                            f"and `{HINT_ROW1}` on row 1, under `{IDLE_ROW0}` — the 16x2 shows rows 0-1 only",
                 hinted.row(1) == lcd_pad(HINT_ROW1) and hinted.row(0) == lcd_pad(IDLE_ROW0), hinted.text())

    # A SECOND PRESS INSIDE THE RATE LIMIT PAINTS NOTHING MORE — and the way to
    # see that is that it does not extend the first hint either. A press that
    # re-armed the hint would keep the sentence on the glass past its 3 s, and a
    # stuck contact would strobe the panel at loop rate.
    time.sleep(0.4)
    second = sim.lcd_mark()
    sim.console("btn 2")
    reverted = sim.expect_screen(lambda f: f.row(3) != lcd_pad(HINT_ROW), HINT_SECONDS + 1.5,
                                 "the action row coming back", second)
    REPORT.check("E-BTN-1", f"[{label}] a second press {HINT_RATE_LIMIT_SECONDS}s inside the limit paints "
                            f"nothing more AND does not extend the first hint: the row is back "
                            f"{HINT_SECONDS}s after the FIRST press, not after the second",
                 reverted.at - hinted.at <= HINT_SECONDS + 1.0, f"{reverted.at - hinted.at:.1f}s")

    # And after the limit one fires again — a rate limit, not a mute.
    third = sim.lcd_mark()
    sim.console("btn 3")
    again = sim.expect_screen(lambda f: f.row(3) == lcd_pad(HINT_ROW), 3, "the hint firing again", third)
    REPORT.check("E-BTN-1", f"[{label}] once the limit has passed the next press is answered again — a "
                            f"rate limit, not a mute", True, repr(again.row(3)))

    REPORT.check("E-BTN-1", f"[{label}] and the DROP is still a drop: no !BTN frame reached the bridge "
                            f"for any of the three presses",
                 not any(f.verb == "BTN" for f in sim.frames_after(btn_from)),
                 f"{[str(f) for f in sim.frames_after(btn_from) if f.verb == 'BTN']}")
    sim.send("PING")
    after = sim.expect_frame(lambda f: f.verb == "PONG" and f is not before, 5, "!PONG after the presses")
    REPORT.check("E-BTN-1", f"[{label}] ...and the office can see it: !PONG's `unauthorised` counter has "
                            f"climbed by the three presses that were thrown away",
                 len(after.args) == 5 and int(after.args[4]) - int(before.args[4]) == 3,
                 f"{before.args[4] if len(before.args) == 5 else '?'} -> "
                 f"{after.args[4] if len(after.args) == 5 else '?'} (ping mark {ping})")


def unscanned_court_press(sim: Simulator, label: str) -> None:
    """E-BTN-2 — a COURT press with the window shut is the BRIDGE's to answer.

    Mega 2.1.0 forwards court keys whatever the window says: an unscanned court
    press asks a question ("how long is left on court B?") that only the bridge
    can answer, and a court key on its own buys nothing. If the bridge does not
    answer — dead, rebooting, mid-flash — the Mega paints its own hint after
    kHintFallbackMs, so the press is never met with silence. Neither is an
    unauthorised press: `!PONG`'s counter means "a press thrown away"."""
    step(f"E-BTN-2  [{label}] an unscanned court press reaches the bridge, and the Mega covers for a silent one")
    sim.send("RST")
    sim.send("AUTH", "0")
    sim.send("IDLE", "7", "1345")
    sim.expect_landing(6, sim.lcd_mark())
    time.sleep(HINT_RATE_LIMIT_SECONDS + HINT_SECONDS + 0.4)  # past any hint this step did not make
    sim.send("PING")
    before = sim.expect_frame(lambda f: f.verb == "PONG", 5, "!PONG before the presses")

    # (a) Nobody answers: the Mega's own hint, after the grace and not before.
    first = sim.lcd_mark()
    pressed = time.monotonic()
    sim.console("btn B")
    fwd = sim.expect_frame(lambda f: f.verb == "BTN", 3, "!BTN,B with the window shut")
    REPORT.check("E-BTN-2", f"[{label}] with the window shut a court key is FORWARDED as !BTN,B",
                 fwd.args == ["B"], str(fwd))
    hinted = sim.expect_screen(lambda f: f.row(1) == lcd_pad(HINT_ROW1), HINT_FALLBACK_SECONDS + 2.0,
                               "the Mega's own hint for an unanswered court press", first)
    waited = hinted.at - pressed
    REPORT.check("E-BTN-2", f"[{label}] the bridge stays silent: the Mega paints `{HINT_ROW1}` on row 1 "
                            f"(and `{HINT_ROW}` on row 3) after its {HINT_FALLBACK_SECONDS}s grace — not at once",
                 HINT_FALLBACK_SECONDS - 0.3 <= waited <= HINT_FALLBACK_SECONDS + 1.5
                 and hinted.row(3) == lcd_pad(HINT_ROW), f"after {waited:.2f}s: {hinted.text()}")

    # (b) The bridge answers inside the grace, as bridge 2.3.0 does for a lit
    # court with no scan behind it: MinutesLeft. Its words stay; no hint.
    time.sleep(HINT_SECONDS + HINT_RATE_LIMIT_SECONDS + 0.4)
    second = sim.lcd_mark()
    sim.console("btn C")
    sim.expect_frame(lambda f: f.verb == "BTN" and f.args == ["C"], 3, "!BTN,C with the window shut")
    for row, text in enumerate(("COURT C 45 MIN", "SCAN TO EXTEND", "Then press the court", "SCAN WHEN READY")):
        sim.send("ROW", str(row), text)
    sim.send("SHOW", "10", "1")
    answered = sim.expect_screen(lambda f: f.row(1) == lcd_pad("SCAN TO EXTEND"), 3, "the bridge's answer", second)
    time.sleep(HINT_FALLBACK_SECONDS + 1.0)
    REPORT.check("E-BTN-2", f"[{label}] the bridge answers inside the grace (`COURT C 45 MIN` / `SCAN TO "
                            f"EXTEND`) and the Mega's fallback never paints over it",
                 not any(f.row(1) == lcd_pad(HINT_ROW1) for f in sim.settled_since(second))
                 and answered.row(0) == lcd_pad("COURT C 45 MIN"),
                 f"{[f.text() for f in sim.settled_since(second)]}")

    sim.send("PING")
    after = sim.expect_frame(lambda f: f.verb == "PONG" and f is not before, 5, "!PONG after the presses")
    REPORT.check("E-BTN-2", f"[{label}] neither court press is an unauthorised press: !PONG's counter did not move",
                 len(after.args) == 5 and len(before.args) == 5 and after.args[4] == before.args[4],
                 f"{before.args[4] if len(before.args) == 5 else '?'} -> {after.args[4] if len(after.args) == 5 else '?'}")


def retry_wrong_court(sim: Simulator, label: str) -> None:
    """E-RETRY-1 — time is never added to the wrong court.

    `it added time to the wrong court` is the live bug this pins. A frame for a
    DIFFERENT court, and then a decode failure on the way back, must leave court
    A's own deadline exactly where it was: the only legal direction for a lit
    court's remaining seconds is DOWN, and a court gaining seconds nobody sold is
    a court the club is giving away."""
    step(f"E-RETRY-1  [{label}] a retry for another court, and a bad frame, never extend court A")
    sim.send("RST")
    sim.send("ON", "A", "600")
    opened = sim.expect_frame(lambda f: f.verb == "STATE" and int(f.args[0]) & 0b0001, 5, "!STATE with A")
    start_remaining = int(opened.args[1])
    watch = sim.frame_mark()

    # A frame for a court that is NOT A.
    sim.send("ON", "B", "120")
    sim.expect_frame(lambda f: f.verb == "STATE" and int(f.args[0]) & 0b0010, 5, "!STATE with B")
    # A corrupted frame that, decoded, would have been a much longer ON for A.
    sim.send_raw(b"!ON,A,3600*00\n")
    badcrc = sim.expect_frame(lambda f: f.verb == "ERR", 5, "!ERR,BADCRC")
    REPORT.check("E-RETRY-1", f"[{label}] a corrupted `!ON,A,3600` is refused with !ERR,BADCRC rather than "
                              f"guessed at", badcrc.args == ["BADCRC"], str(badcrc))
    # And an `!ERR,BADCRC` arriving the WRONG WAY — a bridge reporting its own
    # decode failure down the downlink. A confused peer, answered and ignored.
    sim.send("ERR", "BADCRC")
    sim.expect_frame(lambda f: f.verb == "ERR" and f.args == ["BADVERB"], 5, "!ERR,BADVERB")
    # Long enough that the next periodic !STATE has to carry a smaller number.
    time.sleep(STATE_INTERVAL_SECONDS + 1.5)

    states = [f for f in sim.frames_after(watch) if f.verb == "STATE"]
    remaining_a = [int(f.args[1]) for f in states]
    monotonic = all(b <= a for a, b in zip(remaining_a, remaining_a[1:]))
    REPORT.check("E-RETRY-1", f"[{label}] court A's remaining seconds DECREASE monotonically across a "
                              f"frame for another court, a BADCRC and a misdirected !ERR — nothing "
                              f"re-armed the court that was already lit",
                 len(remaining_a) >= 2 and monotonic and remaining_a[-1] < start_remaining,
                 f"{start_remaining} -> {remaining_a}")
    REPORT.check("E-RETRY-1", f"[{label}] ...and court A never gains a second it was not sold: no "
                              f"!STATE reports more than the {start_remaining}s it was granted",
                 all(r <= start_remaining for r in remaining_a), f"max={max(remaining_a or [0])}")
    last = states[-1] if states else opened
    REPORT.check("E-RETRY-1", f"[{label}] and court B kept the 120s IT was sold, so the two deadlines "
                              f"are genuinely separate rather than one shared number",
                 0 < int(last.args[2]) <= 120, str(last))
    sim.send("OFF", "A")
    sim.send("OFF", "B")


def refused_extension(sim: Simulator, label: str) -> None:
    """E-EXT-1 — a refused extension is answered once and does not flood the link.

    9600 baud is the whole budget. A refusal the bridge retries, or one the Mega
    answers more than once, is a link spending itself on a court that is already
    dark — and the periodic `!STATE` is what the bridge reconciles against, so
    losing it to a storm of `!ERR` is losing the box's only heartbeat."""
    step(f"E-EXT-1  [{label}] !EXT on a dark court is one !ERR,BADARG and then silence")
    sim.send("RST")
    sim.expect_frame(lambda f: f.verb == "STATE", 12, "!STATE after RST")
    mark = sim.frame_mark()
    sim.send("EXT", "C", "60")
    err = sim.expect_frame(lambda f: f.verb == "ERR", 5, "!ERR,BADARG")
    REPORT.check("E-EXT-1", f"[{label}] !EXT on a dark court is !ERR,BADARG — never an implicit !ON",
                 err.args == ["BADARG"], str(err))
    time.sleep(2.0)
    after = sim.frames_after(mark)
    errs = [f for f in after if f.verb == "ERR"]
    REPORT.check("E-EXT-1", f"[{label}] EXACTLY ONE !ERR in the two seconds that follow, and no second "
                            f"!EXT: a refusal that repeats is a refusal that eats the link",
                 len(errs) == 1, f"errs={[str(f) for f in errs]} all={[f.verb for f in after]}")
    REPORT.check("E-EXT-1", f"[{label}] ...and relay C never closed for it",
                 not any(f.verb == "STATE" and int(f.args[0]) & 0b0100 for f in after),
                 f"{[str(f) for f in after if f.verb == 'STATE']}")


def glass_steps(sim: Simulator, label: str, quick: bool) -> None:
    """Every screen-and-deadline step, against one simulator at one clock base."""
    lcd_geometry(sim, label)
    screen_deadlines(sim, label)
    atomic_commit(sim, label)
    lit_court_row(sim, label)
    dropped_press(sim, label)
    unscanned_court_press(sim, label)
    retry_wrong_court(sim, label)
    refused_extension(sim, label)
    if quick:
        REPORT.note(f"E-LCD-2 [{label}] was SKIPPED by --quick. It is the only step in this file that "
                    f"costs two minutes, and it is the only one that proves the ceiling.")
    else:
        show_ceiling(sim, label)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def run_step(fn: Callable[[], None], label: str) -> None:
    try:
        fn()
    except StepFailed as e:
        REPORT.check(label, f"step could not complete: {e}", False)
    except Exception:  # noqa: BLE001 - the report must survive a scripting fault
        REPORT.check(label, "step raised: " + traceback.format_exc().strip().splitlines()[-1], False)
        traceback.print_exc()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--no-simulator", action="store_true", help="skip the Mega-half checks")
    parser.add_argument("--quick", action="store_true",
                        help="skip E-LCD-2, the two-minute screen ceiling — the only step here that "
                             "costs two minutes, and the only one that proves no screen a bridge "
                             "paints can become permanent")
    parser.add_argument("--no-money", action="store_true", help="skip the PayFast leg")
    args = parser.parse_args()

    cfg = Config()
    cfg.workdir.mkdir(parents=True, exist_ok=True)
    print(f"e2e-device: worktree {ROOT}\n  scratch {cfg.workdir}")

    step("Preflight")
    selftest_device_contract()
    REPORT.check("C1", "this script's device request shape matches the shared corpus (bearer header + normalised mac)", True)
    selftest_serial_codec()
    REPORT.check("F12", "this script's serial framing and checksum match the shared corpus byte for byte, and a bad checksum is refused", True)

    pg = Postgres(cfg)
    db_name = "e2e_device_" + datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + secrets.token_hex(2)
    api: Optional[ApiProcess] = None
    mb: Optional[Mountebank] = None
    sim: Optional[Simulator] = None
    try:
        pg.ensure()
        api = ApiProcess(cfg, pg.connection_string(db_name))
        if not cfg.skip_build:
            api.build()
        sim = None if args.no_simulator else Simulator(cfg)
        if sim:
            sim.ensure_built()
            sim.start()
            sim.connect()
        mb = None if args.no_money else Mountebank(cfg)
        if mb:
            mb.start()
        api.start()
        print(f"  fresh database {db_name} (migrated + seeded by the API on boot)")

        w = World(Http(api.base))
        admin_login(w)
        run_step(lambda: seed_and_tune(w), "setup")
        run_step(lambda: provision_box(w), "C1")
        run_step(lambda: create_bookings(w), "setup")
        run_step(lambda: heartbeat_roster(w), "C2")
        run_step(lambda: online_activation(w, sim), "C3")
        run_step(lambda: offline_attendance(w), "C6")
        run_step(lambda: extend_dark_court(w), "EXT")
        run_step(lambda: walk_up(w), "C5")
        run_step(lambda: extend_lit_court(w, sim), "EXT")
        run_step(lambda: early_scan(w), "A2-15")
        if mb:
            run_step(lambda: money_leg(w, mb), "money")
        if sim:
            run_step(lambda: mega_half(sim), "M-serial")
        run_step(lambda: no_show_sweep(w), "H5")
        if sim:
            # THE GLASS GOES LAST, and the ordering is load-bearing rather than
            # tidy. These steps spend real seconds waiting for real deadlines —
            # a ten-second hold, a five-second one, a three-second hint, and
            # without --quick the two-minute ceiling — and every booking this
            # run created is anchored to the wall clock. Run between the
            # bookings and the sweep, they push B7's grace window past the
            # point the sweep's arithmetic is written for, and the failure
            # reads as a no-show defect rather than as a slow test. It is the
            # tree's oldest test trap and this is the shape it takes here.
            #
            # At an ordinary clock base AND four seconds before the 49.7-day
            # millis() rollover: every deadline in these steps is a
            # tb::Deadline, and a box that has been up for forty-nine days and
            # reboots is the NORMAL case for a machine in a cupboard.
            run_step(lambda: glass_steps(sim, "ordinary clock", args.quick), "E-LCD")
            wrap = Simulator(cfg, name="simulator-wrap", start_ms=MILLIS_WRAP_START_MS)
            try:
                wrap.start()
                wrap.connect()
                run_step(lambda: glass_steps(wrap, "4 s before the millis() wrap", args.quick),
                         "E-LCD")
            finally:
                wrap.stop()
    except StepFailed as e:
        REPORT.check("infra", f"environment: {e}", False)
    finally:
        if sim:
            sim.stop()
        if mb:
            mb.stop()
        if api:
            api.stop()

    print(REPORT.summary(), flush=True)
    failed = bool(REPORT.failed)
    if failed:
        print("\nlast HTTP exchanges:")
        for ex in REPORT.exchanges[-12:]:
            print("  " + ex.compact().replace("\n", "\n  "))
        if api:
            print(f"\nAPI log tail ({api.log}):\n" + api.tail())
        print(f"\nscratch kept at {cfg.workdir}")
    else:
        # A passing run leaves nothing behind: .tmp/ is emptied, per the tree's scratch rule.
        shutil.rmtree(cfg.workdir, ignore_errors=True)
        for parent in (cfg.workdir.parent, cfg.workdir.parent.parent):
            if parent.exists() and parent.is_relative_to(ROOT) and not any(parent.iterdir()):
                parent.rmdir()
    if not cfg.keep_db and not failed:
        pg.drop(db_name)
    elif cfg.keep_db or failed:
        print(f"database kept for forensics: {db_name}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
