#!/usr/bin/env python3
"""One door's whole evening, against the real API and a real Postgres.

```bash
make test-e2e-device            # this runs after scenario.py
test/e2e-device/door_evening.py # or on its own
```

`scenario.py` proves the COURT-BOX chain. This proves the DOOR: a board plugged in
for the first time, named by an admin, handed a roster, scanning members under both
access policies and at both edges of a booking's own door window, refusing for every
reason it has a word for, taken out of service and put back, uploading what it
decided while the link was down — and then the trail an admin reads it all back
from. It reuses this directory's bootstrap (the real API built from source, the
Development seeder, a per-run database) and adds nothing to the stack.

**IT READS RESPONSES THE WAY THE BOARD DOES, AND THAT IS THE POINT.** Everything
else in this repository that talks to the API talks to it through a client that
frames, de-chunks and closes on your behalf — `urllib` here, `HttpClient` in the
backend suite — so the one thing nothing could see was the FRAMING. Round G3 found
what that hid: the real API answers every device route `Transfer-Encoding: chunked`
on a keep-alive connection, and a firmware reader that was correct against every
invented fixture timed out on **every** call against the actual server. No roster,
and a door that refused everyone. Nothing went red; there was nothing that could.

So every device call below goes over a raw socket through `wire.py`, which makes the
same framing decisions `src/iot/door-gate/lib/gatelogic` makes and reports anything
but a whole body as status 0, exactly as `gatelogic::statusForBody` does. Two passes:

* **HTTP/1.0 with `Connection: close`** — what the shipped firmware asks for
  (`Esp32Hal` calls `useHTTP10(true)` + `setReuse(false)`), and what the whole
  evening below runs on; and
* **HTTP/1.1 on a KEPT-OPEN socket, de-chunked by hand** — the belt-and-braces
  half, and the shape that actually broke. Through nginx as well when the machine
  has one, because the gateway is what re-chunks and is not in any test's path.

A framing regression therefore fails here, in CI, instead of at a door.

**Where a booking has to be at an hour the admin API will not create it at, it is
moved with a direct `UPDATE` through `psql`** — the booking and its minted access
code together, which is exactly equivalent to the booking always having been at that
hour. Every such write is announced in the transcript with a `[db]` prefix. That is
not a shortcut around the API: the door's own decisions are all taken over HTTP, and
what the clock is doing is fixture, not behaviour.

Exit status is non-zero on any failed assertion. See README.md for the step table.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import traceback
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import gate_sim  # noqa: E402  - the DSIM section: the COMPILED firmware, in this chain
import scenario as sc  # noqa: E402  - the bootstrap this file is a second scenario on
import wire  # noqa: E402

REPORT = sc.REPORT
StepFailed = sc.StepFailed
now_utc = sc.now_utc
expect_status = sc.expect_status

ROOT = sc.ROOT
GATE_CORPUS = ROOT / "src" / "contracts" / "device-protocol" / "gate" / "cases.json"
REPO_NGINX_CONF = ROOT / "nginx" / "nginx.conf"

#: The five routes a board out of service must be refused on — `door-gate.md` §7.
DEVICE_ROUTES = ("/api/v1/device/heartbeat", "/api/v1/device/gate", "/api/v1/device/events",
                 "/api/v1/device/activate", "/api/v1/device/walkup")

#: `MembershipStatus`, `BookingStatus`, `AccessCodePurpose` and `DeviceKind`, for the
#: `[db]` fixture writes below. Mirrored from `src/backend/.../Domain`; a value that
#: stops matching one there is a defect here, not there.
MEMBERSHIP_ACTIVE, MEMBERSHIP_SUSPENDED = 1, 3
BOOKING_BOOKED, BOOKING_CANCELLED, BOOKING_NOSHOW, BOOKING_COMPLETED = 0, 1, 2, 3
PURPOSE_BOOKING_ACTIVATION, PURPOSE_MEMBER_IDENT = 0, 1
DEVICE_KIND_GATE, DEVICE_HARDWARE_ESP32 = 1, 1

#: Crockford base32 — digits and upper-case letters WITHOUT I, L, O and U, which
#: `AccessCodeService.Normalise` folds onto 1, 1, 0 and V. A hand-minted fixture code
#: drawn from any other alphabet is stored under one spelling and looked up under
#: another, and answers `not_recognised` for a reason that has nothing to do with the
#: door. The first draft of `mint_ident_for` prefixed its codes with "ID".
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

#: How close to a stated instant the door is driven. Wide enough to survive a slow
#: EF query on a cold database and two psql round trips, narrow enough that an edge
#: off by a minute fails — the windows it bounds are half an hour and two hours.
EDGE_MARGIN_SECONDS = 45


def chk(tag: str, what: str, ok: bool, detail: str = "") -> bool:
    return REPORT.check(tag, what, ok, detail)


# ---------------------------------------------------------------------------
# Fixture writes, announced
# ---------------------------------------------------------------------------


class Sql:
    """`psql`, for the two things no admin API does: move a booking in time, and
    suspend a membership.

    Every statement is printed. A failure raises `StepFailed` rather than returning
    an empty string, because a fixture step that silently did nothing is how this
    harness's predecessor spent a whole run reporting failures about the wrong
    booking (`README.md`, "Two ways this harness lied to itself")."""

    def __init__(self, cfg: sc.Config, db: str) -> None:
        self.cfg, self.db = cfg, db
        if not shutil.which("psql"):
            raise StepFailed(
                "psql is not on PATH, and this scenario needs it to place a booking at an "
                "hour the admin API will not create. Install the Postgres client "
                "(`brew install libpq` / `apt-get install postgresql-client`).")

    def run(self, statement: str) -> str:
        env = dict(os.environ, PGPASSWORD=self.cfg.pg_password)
        r = subprocess.run(
            ["psql", "-h", self.cfg.pg_host, "-p", str(self.cfg.pg_port), "-U", self.cfg.pg_user,
             "-d", self.db, "-tAX", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", statement],
            env=env, capture_output=True, text=True)
        if r.returncode != 0:
            raise StepFailed(f"psql failed: {statement[:160]} -> {r.stderr.strip()}")
        return r.stdout.strip()

    def scalar(self, statement: str) -> str:
        out = self.run(statement)
        return out.splitlines()[0].strip() if out else ""


# ---------------------------------------------------------------------------
# One board on one door
# ---------------------------------------------------------------------------


class GateClient:
    """An ESP32 on a door: the club's bearer key in the header, its MAC in every body.

    The MAC is spliced in here rather than at every call site because every device
    request carries it and none of them is about it — the same reason
    `scenario.DeviceClient` does it."""

    def __init__(self, http: wire.BoardHttp, api_key: str, mac: str) -> None:
        self.http, self.api_key, self.mac = http, api_key, mac
        self.seq = 0

    def call(self, path: str, body: dict, api_key: Optional[str] = None,
             mac: Optional[str] = None) -> wire.BoardResponse:
        payload = dict(body)
        payload["mac"] = self.mac if mac is None else mac
        raw = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if api_key != "":
            headers["Authorization"] = "Bearer " + (self.api_key if api_key is None else api_key)
        return self.http.request("POST", path, raw, headers)

    def heartbeat(self, kind: Optional[str] = "gate", **extra: Any) -> wire.BoardResponse:
        body: dict[str, Any] = {"firmware_version": "1.0.0", "uptime_ms": 60_000}
        if kind is not None:
            body["kind"] = kind
        body.update(extra)
        return self.call("/api/v1/device/heartbeat", body)

    def scan(self, token: str, method: str = "qr") -> wire.BoardResponse:
        return self.call("/api/v1/device/gate", {"method": method, "token": token})

    def events(self, events: list[dict], uptime_ms: int = 60_000) -> wire.BoardResponse:
        return self.call("/api/v1/device/events", {"uptime_ms": uptime_ms, "events": events})

    def gate_open(self, token: str, seq: Optional[int] = None) -> wire.BoardResponse:
        """One open the board decided from its own cached roster. `court` is -1, the
        wire's "no relay": a door has one lock and nothing to index."""
        if seq is None:
            self.seq += 1
            seq = self.seq
        return self.events([{"seq": seq, "uptime_ms": 55_000, "kind": "gate_open",
                             "court": -1, "method": "qr", "subject": token, "duration_ms": 0}])


# ---------------------------------------------------------------------------
# The gateway the boards actually talk to
# ---------------------------------------------------------------------------


class Gateway:
    """`nginx` in front of the API, carrying this repository's own `/api/` directives.

    **The boards do not talk to the application; they talk to nginx** — `door-gate.md`
    §7 says so about the 403 pin and the same is true of framing. `proxy_http_version
    1.1` plus `proxy_buffering off` is what re-chunks a response to a 1.1 client, and
    nothing in any suite has ever put a request through it.

    The two framing directives are READ OUT OF `nginx/nginx.conf` rather than
    restated, so flipping `proxy_buffering` in the file that ships fails here instead
    of on a Tuesday. Everything else in that file — the security headers, the SPA and
    upload locations, the forwarding headers — is deliberately not reproduced: this
    is a framing probe, not a second copy of the gateway."""

    def __init__(self, cfg: sc.Config, api_port: int) -> None:
        self.cfg, self.api_port = cfg, api_port
        self.port = sc.free_port()
        self.prefix = cfg.workdir / "gateway"
        self.proc: Optional[subprocess.Popen] = None
        self.directives: list[str] = []

    @staticmethod
    def available() -> Optional[str]:
        return shutil.which("nginx")

    def read_repo_directives(self) -> list[str]:
        """The framing-relevant lines of the shipped `/api/` location block."""
        text = REPO_NGINX_CONF.read_text()
        block = re.search(r"location\s+/api/\s*\{(.*?)\n\s*\}", text, re.S)
        if not block:
            raise StepFailed(f"no `location /api/` block in {REPO_NGINX_CONF}")
        found = []
        for line in block.group(1).splitlines():
            # Runs of whitespace collapsed, because the shipped file aligns its values
            # into a column — `proxy_buffering    off;` — and an assertion that keyed
            # on the spelling would be about the formatter rather than the framing.
            line = " ".join(line.split()).strip()
            if line.startswith(("proxy_http_version", "proxy_buffering", "proxy_request_buffering")):
                found.append(line.rstrip(";") + ";")
        self.directives = found
        return found

    def start(self) -> None:
        self.read_repo_directives()
        for sub in ("logs", "tmp", "client_temp"):
            (self.prefix / sub).mkdir(parents=True, exist_ok=True)

        # EVERY PATH IS QUOTED. This checkout lives on an iCloud volume whose path
        # contains spaces ("FrostAura Global"), and nginx splits an unquoted value on
        # whitespace — so the first attempt died parsing its own `pid` line with a
        # message nothing read. Quoting is not decoration here.
        def q(path: Path) -> str:
            return '"' + str(path) + '"'

        conf = self.prefix / "gateway.conf"
        conf.write_text(
            "daemon off;\n"
            "worker_processes 1;\n"
            f"pid {q(self.prefix / 'logs' / 'nginx.pid')};\n"
            f"error_log {q(self.prefix / 'logs' / 'error.log')} warn;\n"
            "events { worker_connections 64; }\n"
            "http {\n"
            "  default_type application/octet-stream;\n"
            f"  access_log {q(self.prefix / 'logs' / 'access.log')};\n"
            f"  client_body_temp_path {q(self.prefix / 'client_temp')};\n"
            f"  proxy_temp_path {q(self.prefix / 'tmp' / 'proxy')};\n"
            f"  fastcgi_temp_path {q(self.prefix / 'tmp' / 'fastcgi')};\n"
            f"  uwsgi_temp_path {q(self.prefix / 'tmp' / 'uwsgi')};\n"
            f"  scgi_temp_path {q(self.prefix / 'tmp' / 'scgi')};\n"
            "  server {\n"
            f"    listen {self.port};\n"
            "    server_name _;\n"
            "    location /api/ {\n"
            f"      proxy_pass http://127.0.0.1:{self.api_port};\n"
            + "".join(f"      {d}\n" for d in self.directives)
            + "    }\n"
            "  }\n"
            "}\n")
        stdout = self.prefix / "logs" / "stdout.log"
        self.proc = subprocess.Popen(
            # `daemon off;` is in the file, so NOT also on `-g`: nginx refuses a
            # directive that arrives twice ("daemon directive is duplicate").
            [str(self.available()), "-p", str(self.prefix), "-c", str(conf)],
            stdout=open(stdout, "ab"), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        deadline = time.time() + 20
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise StepFailed(f"nginx exited with {self.proc.returncode} during startup: "
                                 + self._why(stdout))
            if sc.tcp_open("127.0.0.1", self.port, timeout=0.5):
                return
            time.sleep(0.2)
        raise StepFailed(f"nginx did not listen on :{self.port} within 20s: " + self._why(stdout))

    def _why(self, stdout: Path) -> str:
        """Whatever nginx managed to say, from either place it might have said it."""
        said = []
        for log in (stdout, self.prefix / "logs" / "error.log"):
            try:
                said.append(f"{log.name}: " + log.read_text(errors="replace")[-500:].strip())
            except OSError:
                pass
        return " | ".join(said) or "it said nothing at all"

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()


# ---------------------------------------------------------------------------
# Small readers over the wire shapes
# ---------------------------------------------------------------------------


def roster_tokens(resp: wire.BoardResponse) -> list[str]:
    return [e.split("|")[0] for e in (resp.get("roster") or [])]


def roster_entry(resp: wire.BoardResponse, token: str) -> Optional[tuple[int, int, int]]:
    """`relay, opens_in, closes_in` for one token, or None."""
    for entry in resp.get("roster") or []:
        parts = entry.split("|")
        if parts[0] == token:
            return int(parts[1]), int(parts[2]), int(parts[3])
    return None


def corpus_reasons() -> set:
    """Every refusal reason with a corpus vector, derived from the vector ids.

    Derived rather than listed, because a hand-kept list beside `GateAccess.Reasons`
    is a third copy of the same set and the one that goes stale. The corpus is
    already the neutral ground both the C++ and the .NET suites are held to."""
    cases = json.loads(GATE_CORPUS.read_text())
    reasons = set()
    for vector in cases.get("responses", []):
        vid = vector.get("id") or ""
        if vid == "gate-scan-response-ok":
            reasons.add("ok")
        elif vid.startswith("gate-scan-response-denied-"):
            reasons.add(vid[len("gate-scan-response-denied-"):].replace("-", "_"))
    return reasons


def code_for(sql: Sql, booking_id: str) -> str:
    return sql.scalar(f"""select "Code" from access_codes where "BookingId"='{booking_id}' """
                      f"""order by "CreatedAt" desc limit 1""")


def expires_epoch(sql: Sql, code: str) -> float:
    raw = sql.scalar(f"""select extract(epoch from "ExpiresAt") from access_codes where "Code"='{code}'""")
    return float(raw) if raw else 0.0


def audit_rows(sql: Sql, action_like: str, limit: int = 10) -> list[tuple[str, str, str]]:
    out = sql.run(f"""select "Action", coalesce("SubjectUserId"::text,'-'), "DetailsJson" """
                  f"""from audit_log where "Action" like '{action_like}' """
                  f"""order by "CreatedAt" desc, "Id" desc limit {limit}""")
    rows = []
    for line in out.splitlines():
        if line.strip():
            action, subject, details = line.split("|", 2)
            rows.append((action, subject, details))
    return rows


def shift(sql: Sql, booking_id: str, minutes: float, with_codes: bool = True) -> None:
    """Move a booking (and, unless told otherwise, its minted code) earlier by `minutes`.

    Negative moves it later. Moving the code WITH the booking is what makes this
    equivalent to the booking always having been at that hour; moving the booking
    alone is how the upper edge — the code's own expiry, which outlives the slot by
    the grace window — is reached without waiting for it."""
    sql.run(f"""update bookings set "StartsAt" = "StartsAt" - interval '{minutes} minutes', """
            f""""EndsAt" = "EndsAt" - interval '{minutes} minutes' where "Id"='{booking_id}'""")
    if with_codes:
        sql.run(f"""update access_codes set "ExpiresAt" = "ExpiresAt" - interval '{minutes} minutes' """
                f"""where "BookingId"='{booking_id}'""")
    moved = "and its code" if with_codes else "alone (its code stays where it is)"
    print(f"  [db] booking {booking_id[:8]} {moved} moved {minutes:+.2f} min earlier", flush=True)


def parse_dt(text: str) -> datetime:
    return sc.parse_dt(text)


# ---------------------------------------------------------------------------
# The evening
# ---------------------------------------------------------------------------


class Door:
    """Everything one run needs to hold on to, in one place rather than in globals."""

    def __init__(self, w: sc.World, sql: Sql, board: wire.BoardHttp, api: sc.ApiProcess) -> None:
        self.w, self.sql, self.board, self.api = w, sql, board, api
        self.gate: Optional[GateClient] = None
        self.gate_id = ""
        self.mac = ""
        self.key = ""
        self.settings: dict = {}
        self.reasons_seen: set = set()
        self.spare: list[dict] = []

    # -- settings ----------------------------------------------------------
    def read_settings(self) -> dict:
        self.settings = expect_status(
            self.w.http.get("/api/v1/admin/settings", token=self.w.admin_token), 200, "settings").json
        return self.settings

    def horizon_minutes(self) -> int:
        """`H` — how far before a booking its own code opens a door.

        `door-gate.md` §5: `gate_early_entry_minutes` under `booking_window`, and
        `max(early, min(roster + cue, 240))` under `active_member`. Recomputed here
        from the settings the API serves, and then checked against the number the
        server itself puts on the member's screen — if the two disagree the server
        is right and this line is the defect."""
        s = self.settings
        early = s["gate_early_entry_minutes"]
        if s["gate_access_policy"] == "booking_window":
            return early
        return max(early, min(s["roster_window_minutes"] + s["activation_cue_window_minutes"], 240))

    def unlock_seconds(self) -> int:
        return max(1, min(30, self.settings["gate_unlock_seconds"]))

    def set_policy(self, policy: str) -> None:
        """Switch `gate_access_policy`, carrying the settings PUT's required half.

        The eight booking keys on `UpdateSettingsRequest` are positional and
        non-nullable — only the economics, court-box and gate keys after them are
        omitted-means-unchanged — so a body carrying the policy alone binds
        `SliceMinutes` to zero and is refused `slice_minutes_out_of_range`. They are
        read back from the GET rather than restated, so this cannot quietly revert
        what `seed_and_tune` tuned."""
        s = self.read_settings()
        body = {
            "sliceMinutes": s["slice_minutes"],
            "slicePriceCredits": s["slice_price_credits"],
            "advanceBookingDays": s["advance_booking_days"],
            "dayStartMinute": s["day_start_minute"],
            "dayEndMinute": s["day_end_minute"],
            "operatingHours": s.get("operating_hours"),
            "penaltyPct": s["penalty_pct"],
            "graceWindowMinutes": s["grace_window_minutes"],
            "penaltyWindowMinutes": s["penalty_window_minutes"],
            "gateAccessPolicy": policy,
        }
        expect_status(self.w.http.put("/api/v1/admin/settings", body,
                                      token=self.w.admin_token), 200, f"policy -> {policy}")
        after = self.read_settings()
        if after["gate_access_policy"] != policy:
            raise StepFailed(f"settings PUT did not take: policy is {after['gate_access_policy']}")
        print(f"  [settings] gate_access_policy = {policy}  (H is now {self.horizon_minutes()} min)", flush=True)

    # -- scanning ----------------------------------------------------------
    def scan(self, tag: str, label: str, token: str, opened: bool, reason: str,
             method: str = "qr") -> wire.BoardResponse:
        """One scan, asserted on all three fields the firmware acts on.

        `unlock_seconds` is checked on every single scan rather than once, because a
        refusal that carried a release would be a door that opens on `opened:false`
        for any firmware that read the seconds first — which is the shape of the
        field, not a hypothetical."""
        r = self.gate.scan(token, method=method)
        if r.get("reason"):
            self.reasons_seen.add(r.get("reason"))
        ok = r.status == 200 and r.get("opened") is opened and r.get("reason") == reason
        chk(tag, f"{label} -> opened={opened} reason={reason}", ok,
            f"{r.summary()} body={r.text[:140]}")
        expected = self.unlock_seconds() if opened else 0
        chk(tag, f"  ...and unlock_seconds is {expected}", r.get("unlock_seconds") == expected,
            f"{r.get('unlock_seconds')}")
        return r

    def qr(self, kind: str = "auto") -> dict:
        path = "/api/v1/me/qr/generate" + ("" if kind == "auto" else f"?kind={kind}")
        return expect_status(self.w.http.call("POST", path, token=self.w.m_token), 200, f"qr {kind}").json

    def fresh_ident(self) -> str:
        """A live ident code for M, now.

        Minted at the point of use rather than reused from D3, because a `MemberIdent`
        code lives `qr_lifetime_seconds` and this run is longer than that. An expired
        code answers `not_recognised`, which is correct and would read as a defect in
        whatever step happened to be holding the stale one."""
        return self.qr("ident")["code"]

    def activity(self, limit: Optional[int] = None) -> list[dict]:
        return self.activity_body(limit).get("items") or []

    def activity_body(self, limit: Optional[int] = None) -> dict:
        """The whole response. `items` is the door's SCANS and `events` is the board's own
        story — a registration, an admin edit, a clock the server had to overrule. They are
        two arrays because a console renders a row it has no chip for through whatever branch
        is last, which is how `device.updated` was painted as a green "Refused" scan."""
        q = f"?limit={limit}" if limit is not None else ""
        return expect_status(self.w.http.get(f"/api/v1/admin/devices/{self.gate_id}/activity{q}",
                                             token=self.w.admin_token), 200, "device activity")


def d1_plug_in(d: Door) -> None:
    sc.step("D1  A door gate is plugged in and heartbeats for the first time")
    s = d.read_settings()
    # `gate_unlock_seconds` is READ rather than pinned. The firmware default moved
    # from three seconds to fifteen (GOAL item 2) and the backend's own default is
    # a separate lane's change, so a literal here would pin whichever of the two
    # landed first and go red on the other. What this step is actually about is
    # that the console's hints and the API's defaults agree — and the RELATION
    # below is what the fifteen seconds is really worth testing for.
    chk("S0", "the door settings are the API defaults the console renders its hints from",
        s["gate_access_policy"] == "active_member" and s["gate_early_entry_minutes"] == 30
        and 1 <= s["gate_unlock_seconds"] <= 30, f"H={d.horizon_minutes()}")
    chk("S0", "...and the release the server serves is inside the bounds both ends clamp to",
        d.unlock_seconds() == max(1, min(30, s["gate_unlock_seconds"])),
        f"served={s['gate_unlock_seconds']} clamped={d.unlock_seconds()}")

    d.key = expect_status(d.w.http.get("/api/v1/admin/devices/api-key", token=d.w.admin_token),
                          200, "api-key")["api_key"]
    d.mac = ("02d0" + secrets.token_hex(4))[:12]
    d.gate = GateClient(d.board, d.key, d.mac)

    anon = d.gate.call("/api/v1/device/heartbeat", {"firmware_version": "1.0.0", "kind": "gate"}, api_key="")
    chk("D1", "a heartbeat with no key at all is 401", anon.http_status == 401, anon.summary())
    stranger = d.gate.call("/api/v1/device/heartbeat", {"firmware_version": "1.0.0", "kind": "gate"},
                           api_key="not-the-club-key-not-the-club-key")
    chk("D1", "an unrecognised key is 401 with an empty body (no reason, no clock)",
        stranger.http_status == 401 and not stranger.text.strip(), stranger.summary())

    hb = d.gate.heartbeat()
    chk("D1", "an unknown MAC with kind=gate auto-registers as gate-<six hex>",
        hb.status == 200 and hb.get("device_code") == f"gate-{d.mac[-6:]}" and hb.get("kind") == "gate",
        f"{hb.summary()} device_code={hb.get('device_code')}")
    chk("D1", "gate_key is present and null on the first heartbeat",
        isinstance(hb.json, dict) and "gate_key" in hb.json and hb.get("gate_key") is None,
        f"keys={sorted(hb.json or {})}")
    chk("D1", "no court_numbers / config / button_map on a gate response",
        not {"court_numbers", "config", "button_map"} & set(hb.json or {}), f"keys={sorted(hb.json or {})}")
    chk("D1", "an UNNAMED gate is pushed an empty roster: no offline fallback until an admin names it",
        hb.get("roster") == [], f"{hb.get('roster')}")
    chk("D1", "gate.unlock_seconds is the club's clamped setting",
        (hb.get("gate") or {}).get("unlock_seconds") == d.unlock_seconds(), f"{hb.get('gate')}")
    chk("D1", "nothing from the retired scheme survives on a gate's wire either: no server_unix, no ota",
        not {"server_unix", "ota"} & set(hb.json or {}), f"keys={sorted(hb.json or {})}")

    devices = expect_status(d.w.http.get("/api/v1/admin/devices/", token=d.w.admin_token), 200, "devices").json
    row = next((x for x in devices if x.get("mac_address") == d.mac), None)
    d.gate_id = (row or {}).get("id", "")
    chk("D1", "the door appears on the Devices page: kind=gate, auto_registered, unnamed",
        bool(row) and row.get("kind") == "Gate" and row.get("auto_registered") is True
        and not row.get("gate_key"), f"row={row}")
    bad_mac = d.gate.call("/api/v1/device/heartbeat", {"firmware_version": "1.0.0", "kind": "gate"},
                          mac="not-a-mac")
    chk("D1", "a mac that is not twelve hex is 400 mac_required, never a 404 reading as 'unknown board'",
        bad_mac.status == 400 and bad_mac.get("error") == "mac_required", bad_mac.text[:120])


def d2_name_the_door(d: Door) -> None:
    sc.step("D2  The admin names the door (real admin JWT, real route)")
    http, token = d.w.http, d.w.admin_token
    bad = http.patch(f"/api/v1/admin/devices/{d.gate_id}", {"court_numbers": [1]}, token=token)
    chk("D2", "court_numbers on a gate -> 400 court_fields_on_a_gate",
        bad.status == 400 and bad.get("error") == "court_fields_on_a_gate", f"{bad.status} {bad.text[:90]}")
    long = http.patch(f"/api/v1/admin/devices/{d.gate_id}", {"gate_key": "x" * 65}, token=token)
    chk("D2", "a 65-character gate_key -> 400 gate_key_too_long",
        long.status == 400 and long.get("error") == "gate_key_too_long", f"{long.status} {long.text[:90]}")

    # THE NEW TRUTH. Round G3 found this PATCH answering 200 and changing nothing for
    # a camelCase `gateKey` — the silent no-op the spec itself argues against for the
    # settings PUT and had not applied to the one field that names the door in every
    # audit row a club ever reads back. Both spellings bind now.
    camel = http.patch(f"/api/v1/admin/devices/{d.gate_id}", {"gateKey": "side-door"}, token=token)
    chk("B7", "SPELLING: a camelCase gateKey BINDS rather than silently doing nothing",
        camel.status == 200 and camel.get("gate_key") == "side-door",
        f"HTTP {camel.status} gate_key={camel.get('gate_key')}")
    both = http.patch(f"/api/v1/admin/devices/{d.gate_id}",
                      {"gate_key": "  front-door  ", "gateKey": "loser"}, token=token)
    chk("B7", "and where both arrive snake_case wins, trimmed", both.get("gate_key") == "front-door",
        f"{both.get('gate_key')}")
    cleared = http.patch(f"/api/v1/admin/devices/{d.gate_id}", {"gate_key": ""}, token=token)
    chk("D2", "an empty string CLEARS the name", cleared.get("gate_key") in (None, ""),
        f"{cleared.get('gate_key')!r}")
    nulled = http.patch(f"/api/v1/admin/devices/{d.gate_id}", {"gate_key": None}, token=token)
    chk("D2", "...and a null leaves it alone rather than clearing it",
        nulled.status == 200 and nulled.get("gate_key") in (None, ""), f"{nulled.get('gate_key')!r}")
    named = expect_status(http.patch(f"/api/v1/admin/devices/{d.gate_id}", {"gate_key": "front-door"},
                                     token=token), 200, "name the door")
    chk("D2", "the door is named, and that is what starts its offline fallback",
        named.get("gate_key") == "front-door", f"{named.get('gate_key')}")


def d3_member_books(d: Door) -> dict:
    sc.step("D3  The member books, and their QR screen is told what it does at a door")
    # A clean evening. The Development seeder plants demo bookings at fixed LOCAL
    # times and whether one collides with this run depends on the hour it starts, so
    # they are cancelled wholesale and every negative below is about the booking it
    # names and nothing else. `ensure_free` exists for the court-box scenario's four
    # windows; this one books across the whole evening.
    #
    # EVERY STATUS BUT CANCELLED, AND `= Booked` WAS NOT ENOUGH. The real
    # `NoShowWorker` and `LightsCueWorker` have been running since the API booted,
    # so by the time this line executes a seeded booking whose hour has just passed
    # is already `NoShow` or `Completed` — and BOTH still open a door and both still
    # hold a slot. `GateAccess.HoldsALiveBookingAsync` counts all three statuses, so
    # a survivor grants M the RELIEF the door gives a member whose other court is
    # running, and M's deliberately-too-early code then answers `ok`. Observed: a run
    # starting at 19:15 local inherited the seeder's 19:00 booking already swept to
    # NoShow, and five assertions went red across D5, EDGE, POL, D10 and D11 —
    # `too_early` answering `ok`, then `slot_taken` and an exclusion-constraint
    # violation from the slot it was still holding. Nothing named the cause. (A second
    # run found the same corpse from the other side: `ck_bookings_no_overlapping_slot`
    # excludes `Cancelled` and nothing else, so D8's back-shift over the slot that had
    # just ended was refused by Postgres, 18:00-18:45 local and green every other hour.)
    #
    # Every booking in this database is the seeder's at this point, so "not already
    # cancelled" is exactly the set meant all along. This is the third form of the
    # lesson this file's README already carries twice: A TEST THAT BOOKS RELATIVE TO
    # `UtcNow` INHERITS THE WALL CLOCK AS A HIDDEN INPUT.
    d.sql.run(f"""update bookings set "Status"={BOOKING_CANCELLED} """
              f"""where "Status"<>{BOOKING_CANCELLED}""")
    print("  [db] cancelled every seeded demo booking — any status, not just Booked — so the "
          "evening starts empty", flush=True)

    members = expect_status(d.w.http.get("/api/v1/admin/members", token=d.w.admin_token), 200, "members").json
    d.spare = [m for m in members if m["user_id"] not in (d.w.m_user_id, d.w.admin_user_id)]
    if len(d.spare) < 4:
        raise StepFailed(f"need four spare seeded members, have {len(d.spare)}")
    for m in d.spare[:4]:
        expect_status(d.w.http.post(f"/api/v1/admin/credit/{m['user_id']}/adjust",
                                    {"amountCredits": 800, "reason": "door walkthrough"},
                                    token=d.w.admin_token), 200, "credit")

    # Far enough out that its own code is NOT yet in its door window (so the first
    # scan below is a real `too_early`), and inside `roster_window + early_entry` so
    # the offline roster carries it anyway — which is the pair §4 and §5 describe.
    h = d.horizon_minutes()
    booking = sc.admin_book(d.w, 1, d.w.m_user_id, now_utc() + timedelta(minutes=h + 10), 2,
                            f"M court 1 +{h + 10}m")
    auto = d.qr("auto")
    # UNDER active_member THE PHONE'S HORIZON AND THE DOOR'S ARE THE SAME NUMBER, by
    # construction: H is max(early, min(roster + cue, 240)) and the screen's is
    # min(roster + cue, …) out of the same function. So a booking the door will
    # refuse as `too_early` is also one the phone is not yet offering, and
    # `?kind=auto` falls through to an ident code. That equality is the claim, and
    # this is where it is observed rather than argued.
    chk("B6", f"a booking {h + 10} min out is beyond the phone's horizon too, so ?kind=auto falls "
              f"through to an ident code — the screen and the door open at ONE instant",
        auto.get("kind") == "ident", f"kind={auto.get('kind')} booking_id={auto.get('booking_id')}")
    chk("B6", "an ident code names no booking, so it is told `doors` but NO window of its own",
        auto.get("doors") is True and auto.get("door_opens_at") is None
        and auto.get("door_closes_at") is None,
        f"doors={auto.get('doors')} opens={auto.get('door_opens_at')} closes={auto.get('door_closes_at')}")

    ident = d.qr("ident")
    chk("D3", "?kind=ident hands the same member a walk-up ident code", ident.get("kind") == "ident",
        f"ident={ident['code']} expires_in={ident.get('expires_in_seconds')}")
    booking["ident"] = ident["code"]
    booking["code"] = ""  # minted by the first heartbeat that carries the roster
    return booking


def d4_roster(d: Door, booking: dict) -> None:
    sc.step("D4  The named door is pushed a roster")
    first = d.gate.heartbeat()
    time.sleep(1.1)
    second = d.gate.heartbeat()
    chk("D4", "server_time moves between heartbeats (the board has no RTC and trusts it)",
        first.get("server_time") != second.get("server_time"),
        f"{first.get('server_time')} -> {second.get('server_time')}")
    chk("D4", "naming the door started the offline fallback: the roster is no longer empty",
        len(roster_tokens(second)) > 0, f"n={len(roster_tokens(second))}")
    # The token is the booking's own BookingActivation code, minted lazily by this
    # push — the same bytes the member's phone will show and a court box will cache.
    booking["code"] = code_for(d.sql, booking["id"])
    chk("D4", "the roster reaches roster_window + early_entry, so it carries a booking the ONLINE "
              "door refuses as too_early: offline is WIDER at the bottom",
        bool(booking["code"]) and booking["code"] in roster_tokens(second),
        f"code={booking['code']!r}")
    entry = roster_entry(second, booking["code"])
    chk("D4", "the member's booking code is on it, on relay 0 (a door has one lock and nothing to index)",
        bool(entry) and entry[0] == 0, f"entry={entry}")
    if entry:
        early = d.settings["gate_early_entry_minutes"]
        want = (booking["starts_at"] - now_utc()).total_seconds() - early * 60
        chk("D4", "opens_in counts to StartsAt - gate_early_entry_minutes and is SIGNED",
            abs(entry[1] - want) <= 120, f"opens_in={entry[1]} expected~{want:.0f}")
        chk("D4", "closes_in counts to EndsAt, and the offline window is NARROWER at the top than "
                  "the online one by the grace window",
            entry[2] <= (booking["ends_at"] - now_utc()).total_seconds() + 120,
            f"closes_in={entry[2]}")
    chk("D4", "the sixty-second ident code is NOT in the roster: a short-lived code cannot be cached",
        booking["ident"] not in roster_tokens(second))
    # `body_result == OK` is half the assertion, not decoration. A body that did not
    # fit comes back EMPTY — never truncated — so "len(body) <= 4096" is trivially
    # true of exactly the failure it is meant to catch. Found by mutating the server
    # to add a 5 KB field to the envelope: every heartbeat assertion in this file went
    # red and this one stayed green.
    chk("E1", f"the heartbeat body ARRIVED WHOLE and stays under the {wire.MAX_RESPONSE_BYTES}-byte "
              f"ceiling the board's {wire.RESPONSE_CAP}-byte buffer is sized against",
        second.body_result == wire.BodyResult.OK
        and 0 < len(second.body) <= wire.MAX_RESPONSE_BYTES,
        f"{len(second.body)} bytes, framing={second.framing}, read={second.body_result}")


def d5_scans(d: Door, booking: dict) -> None:
    sc.step("D5  Scans at the door, under active_member")
    # The booking is H+10 out, so its own code is not yet in its own window. `too_early`
    # rather than `not_recognised`, deliberately and against the reasoning behind every
    # other refusal here: the holder of a code the club itself minted is told they are
    # early, about a booking that is already theirs.
    d.scan("EDGE", f"the booking code {d.horizon_minutes() + 10} min before its start "
                   f"(H={d.horizon_minutes()})", booking["code"], False, "too_early")
    d.scan("D5", "the member's ident QR under active_member", booking["ident"], True, "ok")
    d.scan("D5", "a code that never existed", "ZZZZZZZZZZZZ", False, "not_recognised")
    d.scan("D5", "a token of the wrong length", "SHORT", False, "not_recognised")
    d.scan("D5", "an empty token", "", False, "not_recognised")
    d.scan("D5", "method=pin -> refused BEFORE the code table is touched, so it cannot probe it",
           booking["ident"], False, "method_not_supported", method="pin")
    d.scan("D5", "method=code identifies as well as qr", booking["ident"], True, "ok", method="code")


def move_to(d: Door, booking: dict, opens_in_seconds: float) -> None:
    """Put `StartsAt − H` exactly `opens_in_seconds` from now, code and all.

    Moving the booking rather than waiting for it is what makes an edge two hours
    out testable in a four-minute run, and moving the code WITH it is what makes the
    move equivalent to the booking always having been at that hour."""
    h = d.horizon_minutes()
    current = (booking["starts_at"] - timedelta(minutes=h) - now_utc()).total_seconds()
    delta = current - opens_in_seconds
    shift(d.sql, booking["id"], delta / 60.0)
    booking["starts_at"] -= timedelta(seconds=delta)
    booking["ends_at"] -= timedelta(seconds=delta)


def edges(d: Door, booking: dict, tag: str) -> None:
    """Drive the door at both sides of the instant the member's own screen states.

    This is what turns B6 from a field comparison into behaviour: the page says
    `door_opens_at`, so the door must answer `too_early` a few seconds before it and
    `ok` a few seconds after it — with no code change in between, only the clock.

    The two policies put the phone in different places relative to that instant and
    BOTH are asserted. Under `active_member` H equals the phone's own horizon, so a
    door that is not yet open is a code the phone is not yet offering and `?kind=auto`
    answers `ident`. Under `booking_window` H is narrower, so the phone shows the code
    while the door still refuses it — "the phone is deliberately not narrowed to
    match", which is honest and is exactly the case a member telephones about."""
    policy, h = d.settings["gate_access_policy"], d.horizon_minutes()

    move_to(d, booking, EDGE_MARGIN_SECONDS)
    before = d.qr("auto")
    if before.get("kind") == "booking":
        stated = parse_dt(before["door_opens_at"])
        chk(tag, f"under {policy} the phone SHOWS the code while the door is still shut, and states "
                 f"door_opens_at = StartsAt - {h} min, a moment in the future",
            abs((stated - (booking["starts_at"] - timedelta(minutes=h))).total_seconds()) <= 3
            and stated > now_utc(),
            f"door_opens_at={stated.isoformat()} now={now_utc().isoformat()}")
    else:
        chk(tag, f"under {policy} the phone is not yet offering the code either — H ({h} min) IS the "
                 f"screen's own horizon, so the two open at one instant",
            before.get("kind") == "ident" and policy == "active_member", f"kind={before.get('kind')}")
    d.scan(tag, f"the booking code {EDGE_MARGIN_SECONDS}s BEFORE its door window opens",
           booking["code"], False, "too_early")

    move_to(d, booking, -EDGE_MARGIN_SECONDS)
    after = d.qr("auto")
    chk(tag, "the phone now shows THAT booking's code, with door_opens_at behind us",
        after.get("kind") == "booking" and after.get("booking_id") == booking["id"]
        and parse_dt(after["door_opens_at"]) < now_utc(),
        f"kind={after.get('kind')} door_opens_at={after.get('door_opens_at')}")
    chk("B6", f"and door_opens_at is still StartsAt - H with H = {h} min under {policy}",
        abs((parse_dt(after["door_opens_at"])
             - (booking["starts_at"] - timedelta(minutes=h))).total_seconds()) <= 3,
        f"{after.get('door_opens_at')} vs StartsAt-{h}m")
    closes_at = parse_dt(after["door_closes_at"])
    expiry = datetime.fromtimestamp(expires_epoch(d.sql, booking["code"]), tz=timezone.utc)
    chk("B6", "door_closes_at is the CODE's own expiry — sold end plus the grace window, LATER than "
              "the booking's EndsAt, because understating it would deny the product's own generosity",
        abs((closes_at - expiry).total_seconds()) <= 3 and closes_at > booking["ends_at"],
        f"closes_at={closes_at.isoformat()} code_expiry={expiry.isoformat()} "
        f"ends_at={booking['ends_at'].isoformat()}")
    d.scan(tag, f"the same code {EDGE_MARGIN_SECONDS}s AFTER it, with nothing changed but the clock",
           booking["code"], True, "ok")


def d6_both_policies(d: Door, booking: dict) -> None:
    sc.step("D6  Both sides of the door window, under BOTH access policies")
    edges(d, booking, "EDGE")

    d.set_policy("booking_window")
    try:
        # THE SAME CODE, THE SAME SECOND, A DIFFERENT ANSWER. H drops from the phone's
        # horizon to gate_early_entry_minutes, so a club that narrows its policy shuts
        # the door on a code that opened it a moment ago.
        h_narrow = d.horizon_minutes()
        chk("POL", f"switching to booking_window narrows H to gate_early_entry_minutes ({h_narrow} "
                   f"min) from the phone's horizon",
            h_narrow == d.settings["gate_early_entry_minutes"], f"H={h_narrow}")
        d.scan("POL", "the code that opened the door a second ago is too_early under the narrower "
                      "policy — nothing changed but the club's own rule",
               booking["code"], False, "too_early")

        edges(d, booking, "POL")

        # Under booking_window an ident code needs a qualifying booking, and this
        # member now has one in its window.
        d.scan("POL", "an ident QR under booking_window, by a member whose booking is open",
               booking["ident"], True, "ok")

        # The relief and the policy check are ONE rule asked with two horizons, so a
        # member with nothing booked is the whole reason `no_booking` exists.
        stranger_ident = mint_ident_for(d, d.spare[1])
        d.scan("POL", "an ident QR under booking_window, by an ACTIVE member with nothing booked",
               stranger_ident, False, "no_booking")

        # Club admins always pass step 6: a club that switches policy must not lock its
        # own staff out of the building, and staff do not hold bookings for the hours
        # they are working. Keyed on User.IsAdmin — it used to be keyed on the ABSENCE
        # of a membership row, a state nothing creates, so it fired for nobody.
        admin_ident = mint_ident_for(d, {"user_id": d.w.admin_user_id})
        if admin_ident:
            d.scan("POL", "a CLUB ADMIN with nothing booked, under booking_window", admin_ident, True, "ok")
        else:
            chk("POL", "a club admin has an ident code to present", False, "no ident row for the admin")
    finally:
        d.set_policy("active_member")
    d.scan("POL", "and back under active_member the same booking code opens again",
           booking["code"], True, "ok")


def mint_ident_for(d: Door, member: dict) -> str:
    """A `MemberIdent` code for somebody who is not the logged-in member.

    Written straight into `access_codes` because no admin route mints a code on a
    member's behalf, and logging four seeded members in to collect four sixty-second
    codes is four password resets of pure ceremony. The row is exactly the one
    `AccessCodeService.MintIdentAsync` writes — the member's own user id, purpose
    `MemberIdent`, a lifetime from the club's own setting — and every DECISION about
    it is still the door's, taken over HTTP like all the others."""
    code = "".join(secrets.choice(CROCKFORD) for _ in range(12))
    lifetime = int(d.settings.get("qr_lifetime_seconds") or 900)
    tenant = d.sql.scalar("""select "Id" from tenants where "Slug"='crusaders' limit 1""")
    if not tenant:
        raise StepFailed("the seeded tenant is not there")
    d.sql.run(f"""insert into access_codes ("Id","TenantId","UserId","Purpose","Code","ExpiresAt","CreatedAt") """
              f"""values ('{uuid.uuid4()}','{tenant}','{member["user_id"]}',{PURPOSE_MEMBER_IDENT},"""
              f"""'{code}', now() + interval '{lifetime} seconds', now())""")
    print(f"  [db] minted an ident code for {member['user_id'][:8]}", flush=True)
    return d.sql.scalar(f"""select "Code" from access_codes where "Code"='{code}'""")


def d7_the_door_is_not_a_court(d: Door, booking: dict) -> None:
    sc.step("D7  Straight on to the court box — the door must have changed nothing")
    # The court box has its own, much narrower window: `activation_cue_window_minutes`.
    # Getting into the BUILDING early is ordinary; getting the LIGHTS on early is
    # somebody else's court. So the slot is moved to start now before the box is asked.
    starts_in = (booking["starts_at"] - now_utc()).total_seconds()
    if starts_in > 0:
        shift(d.sql, booking["id"], starts_in / 60.0)
        booking["starts_at"] -= timedelta(seconds=starts_in)
        booking["ends_at"] -= timedelta(seconds=starts_in)
    before = d.sql.scalar(f"""select coalesce("CheckedInAt"::text,'-') from bookings where "Id"='{booking['id']}'""")
    chk("D7", "a door open stamps no CheckedInAt: walking through a door is not attendance",
        before == "-", f"checked_in_at={before}")
    act = d.w.box.call("POST", "/api/v1/device/activate", {"court": 1, "method": "qr", "token": booking["code"]})
    chk("D7", "the court box still activates that booking after the door has scanned it",
        act.status == 200 and act.get("activated") is True, f"HTTP {act.status} {act.text[:160]}")
    after = d.sql.scalar(f"""select coalesce("CheckedInAt"::text,'-') from bookings where "Id"='{booking['id']}'""")
    chk("D7", "and the COURT BOX is what stamps attendance", after != "-", f"checked_in_at={after}")
    rows = d.sql.scalar(f"""select count(*) from ledger_entries where "RelatedBookingId"='{booking['id']}'""")
    chk("D7", "the door wrote no ledger row (the booking charge, and nothing else)", rows == "1", f"rows={rows}")


def d8_completed(d: Door, booking: dict) -> None:
    sc.step("D8  B1 — a member the LIGHTS sweep has just promoted to Completed")
    # The booking is checked in (D7 activated it). Move it so it has ENDED while its
    # code is still live, and let the real LightsCueWorker — every fifteen seconds —
    # promote it. A `Completed` row with no `CheckedInAt` is a fixture the product
    # cannot make, and setting the status by hand is exactly how this defect survived
    # two rounds with a test that said otherwise.
    ends_in = (booking["ends_at"] - now_utc()).total_seconds()
    shift(d.sql, booking["id"], (ends_in + 20) / 60.0, with_codes=False)
    print("  waiting for the real LightsCueWorker (every 15 s) to promote it ...", flush=True)
    deadline = now_utc() + timedelta(seconds=75)
    status = ""
    while now_utc() < deadline:
        status = d.sql.scalar(f"""select "Status" from bookings where "Id"='{booking['id']}'""")
        if status == str(BOOKING_COMPLETED):
            break
        time.sleep(3)
    chk("B1", "the real sweep promoted the attended booking to Completed",
        status == str(BOOKING_COMPLETED), f"status={status}")
    d.scan("B1", "and a Completed booking's own code still opens the door — the record that they "
                 "were ON the court is a better reason to be in the building than anything else",
           booking["code"], True, "ok")
    hb = d.gate.heartbeat()
    chk("B1", "but it has left the OFFLINE roster, which closes at EndsAt",
        booking["code"] not in roster_tokens(hb), f"roster n={len(roster_tokens(hb))}")


def d9_noshow(d: Door) -> dict:
    sc.step("D9  A member the NO-SHOW sweep has just written off")
    grace = d.settings["grace_window_minutes"]
    late = sc.admin_book(d.w, 4, d.spare[0]["user_id"], now_utc() + timedelta(seconds=80), 2, "no-show")
    print(f"  waiting for the real NoShowWorker (grace={grace} min, sweep every 30 s) ...", flush=True)
    deadline = now_utc() + timedelta(seconds=80 + 60 * grace + 120)
    status = ""
    while now_utc() < deadline:
        status = d.sql.scalar(f"""select "Status" from bookings where "Id"='{late['id']}'""")
        if status == str(BOOKING_NOSHOW):
            break
        time.sleep(5)
    chk("D9", "the real sweep marked it NoShow", status == str(BOOKING_NOSHOW), f"status={status}")
    d.gate.heartbeat()
    code = code_for(d.sql, late["id"])
    if not code:
        chk("D9", "the swept booking has a code to present", False, "no access code row")
        return late
    d.scan("D9", "a swept no-show's own booking QR still opens the door — a door that enforced a "
                 "penalty by making it impossible to undo would be the worst place for that rule",
           code, True, "ok")
    hb = d.gate.heartbeat()
    chk("D9", "but the OFFLINE roster has dropped them: this is the one place offline is STRICTER",
        code not in roster_tokens(hb), "a cut-off door refuses the member the online door just admitted")
    late["code"] = code
    return late


def d10_upper_edge(d: Door) -> None:
    sc.step("D10  The upper edge: the code's own liveness, and nothing else")
    grace = d.settings["grace_window_minutes"]
    member = d.spare[3]
    booking = sc.admin_book(d.w, 2, member["user_id"], now_utc() + timedelta(minutes=5), 2, "tail")
    shift(d.sql, booking["id"], 5)           # running now
    d.gate.heartbeat()                        # mints the code from the shifted slot
    code = code_for(d.sql, booking["id"])
    if not code:
        chk("D10", "the running booking has a code to present", False, "no access code row")
        return
    d.scan("D10", "the code while the slot is running", code, True, "ok")

    # Move booking AND code back so the SLOT has ended and the CODE has a few seconds
    # left, whatever instant it was actually minted at. The gap between the two is the
    # grace window, which is the door being deliberately wider at the top than the
    # phone: a member walking back in for a forgotten racquet.
    expiry = expires_epoch(d.sql, code)
    shift(d.sql, booking["id"], (expiry - time.time()) / 60.0 - (EDGE_MARGIN_SECONDS / 60.0))
    ends_at = d.sql.scalar(f"""select "EndsAt"::text from bookings where "Id"='{booking['id']}'""")
    print(f"  the slot now ended at {ends_at}; its code dies in ~{EDGE_MARGIN_SECONDS}s", flush=True)
    d.scan("D10", f"the code {EDGE_MARGIN_SECONDS}s BEFORE its own expiry, with the slot already over "
                  f"(the door is a {grace}-minute grace window wider at the top than the phone)",
           code, True, "ok")
    wait = expires_epoch(d.sql, code) - time.time() + 3
    if 0 < wait < 240:
        print(f"  waiting {wait:.0f}s for the code to expire ...", flush=True)
        time.sleep(wait)
    d.scan("D10", "the same code AFTER its own expiry — indistinguishable from one that never "
                  "existed, deliberately", code, False, "not_recognised")


def d11_relief_and_membership(d: Door, booking: dict) -> None:
    sc.step("D11  A member is not a credential; a cancelled booking is; a suspension is final")
    member = d.spare[3]
    h = d.horizon_minutes()
    # The reachable half of the relief: a code for a booking NOT yet in its own
    # window, held by a member whose other booking is already open.
    running = sc.admin_book(d.w, 2, member["user_id"], now_utc() + timedelta(minutes=5), 2, "running")
    shift(d.sql, running["id"], 5)
    far = sc.admin_book(d.w, 1, member["user_id"], now_utc() + timedelta(minutes=h + 15), 2, "far")
    d.gate.heartbeat()
    far_code = code_for(d.sql, far["id"])
    if far_code:
        d.scan("D11", f"a code for a booking {h + 15} min out, held by a member whose OTHER court is "
                      f"running", far_code, True, "ok")
        expect_status(d.w.http.post(f"/api/v1/admin/bookings/{running['id']}/cancel",
                                    {"waivePenalty": True, "waiveReason": "door walkthrough probe"},
                                    token=d.w.admin_token), 200, "cancel the running booking")
        # THE FIXTURE PROBE. Vary one field of the setup and the same code must be
        # refused, so this cannot be passing because the door opens for everybody.
        d.scan("D11", "...and with that one booking cancelled the same code is too_early again",
               far_code, False, "too_early")
    else:
        chk("D11", "the far booking has a code to present", False, "no access code row")

    cancelled = sc.admin_book(d.w, 3, member["user_id"], now_utc() + timedelta(minutes=10), 2, "cancelled")
    d.gate.heartbeat()
    cancelled_code = code_for(d.sql, cancelled["id"])
    expect_status(d.w.http.post(f"/api/v1/admin/bookings/{cancelled['id']}/cancel",
                                {"waivePenalty": True, "waiveReason": "door walkthrough"},
                                token=d.w.admin_token), 200, "cancel")
    if cancelled_code:
        d.scan("D11", "a CANCELLED booking's own code, while that code is still live — the club's own "
                      "decision about the booking, and final", cancelled_code, False, "not_recognised")

    ident = d.qr("ident")["code"]
    d.sql.run(f"""update memberships set "Status"={MEMBERSHIP_SUSPENDED} where "UserId"='{d.w.m_user_id}'""")
    print("  [db] M's membership set to Suspended", flush=True)
    d.scan("D11", "a suspended member's ident QR", ident, False, "member_not_active")
    d.scan("D11", "a suspended member's booking QR", booking["code"], False, "member_not_active")
    hb = d.gate.heartbeat()
    chk("D11", "a barred member is off the OFFLINE roster too, on real Postgres — otherwise a "
               "suspension holds only while the gate can reach the API",
        booking["code"] not in roster_tokens(hb), f"roster n={len(roster_tokens(hb))}")
    d.sql.run(f"""update memberships set "Status"={MEMBERSHIP_ACTIVE} where "UserId"='{d.w.m_user_id}'""")
    print("  [db] M's membership restored to Active", flush=True)
    d.scan("D11", "and the moment the desk lifts it, the same QR opens the door", ident, True, "ok")

    # -- D11b : NO MEMBERSHIP ROW AT ALL ------------------------------------
    #
    # The hole the member lane found, and the one refusal reason this harness has never
    # reached: a user with NO membership row was not barred, because the check read as
    # "the club has recorded a decision about this person and it was not approval" — and
    # about such a user it has recorded none. A real, live ident code for such a user
    # OPENED THE BUILDING under the default `active_member` policy. "Active member"
    # cannot mean "anybody the club has not said no to".
    #
    # Provoked the way it actually happens rather than by inventing a user: the code is
    # minted while the membership is good and the ROW THEN GOES AWAY — a data repair, a
    # bad migration, a manual delete. No path in this product creates a user without a
    # membership row, which is exactly why the old reading looked safe and was not.
    #
    # The row is stashed as JSON and put back verbatim, columns and all, so the steps
    # after this one run against the fixture they were written for and this cannot
    # become a test that passes by breaking its neighbours.
    stashed = d.sql.scalar(
        f"""select row_to_json(m)::text from memberships m where m."UserId"='{d.w.m_user_id}'""")
    if not stashed:
        raise StepFailed("M has no membership row to remove — the fixture this step needs is gone")
    d.sql.run(f"""delete from memberships where "UserId"='{d.w.m_user_id}'""")
    print("  [db] M's membership ROW DELETED (not suspended — absent)", flush=True)
    try:
        d.scan("D11", "a live ident QR for a user with NO membership row -> `no_membership`, which "
                      "is its own reason because the desk's next action is different: there is "
                      "nothing to un-suspend, the person needs enrolling",
               ident, False, "no_membership")
        d.scan("D11", "  ...and their booking's own code is refused for the same reason, because "
                      "the membership check runs before anything about a booking",
               booking["code"], False, "no_membership")
        hb = d.gate.heartbeat()
        chk("D11", "  ...and they are off the OFFLINE roster too, so the refusal holds through an "
                   "outage rather than only while the gate can reach the API",
            booking["code"] not in roster_tokens(hb), f"roster n={len(roster_tokens(hb))}")
        # THE OTHER HALF OF THE WIDENING. Refusing the scan is not enough if the product
        # will still hand this user a fresh door-capable code the moment they ask.
        minted = d.w.http.call("POST", "/api/v1/me/qr/generate?kind=ident", token=d.w.m_token)
        no_door = minted.status != 200 or not (minted.json or {}).get("doors", False)
        chk("D11", "  ...and no door-capable code is MINTED for them either — a door that refuses "
                   "a code the same product is still issuing is a race, not a rule",
            no_door, f"status={minted.status} body={str(minted.json)[:140]}")
    finally:
        d.sql.run("insert into memberships select * from json_populate_record"
                  f"(null::memberships, $stash${stashed}$stash$)")
        print("  [db] M's membership row restored verbatim", flush=True)
    d.scan("D11", "and with the row back, the same QR opens the door again — so the refusal above "
                  "was about the missing row and not about anything this step broke",
           ident, True, "ok")


def d12_offline_uploads(d: Door, booking: dict) -> None:
    sc.step("D12  The door uploads what it decided while the link was down")
    d.gate.seq += 1
    seq = d.gate.seq
    up = d.gate.gate_open(booking["code"], seq=seq)
    chk("D12", "a gate_open is receipted and acknowledged",
        up.status == 200 and up.get("recorded") == 1 and up.get("accepted_through") == seq,
        f"{up.summary()} body={up.text[:140]}")
    rows = audit_rows(d.sql, "device.gate_open")
    chk("D12", "one device.gate_open audit row, naming the member the code resolved to AT THE SCAN",
        bool(rows) and rows[0][1] != "-", f"subject_user_id={rows[0][1] if rows else None}")
    details = json.loads(rows[0][2]) if rows else {}
    subject = str(details.get("subject") or "")
    chk("D12", "the details carry an 8-hex fingerprint and never the token: a live access code in "
               "a trail an admin can read is a credential in a log",
        subject != booking["code"] and len(subject) == 8
        and all(c in "0123456789abcdef" for c in subject),
        f"subject={subject!r} token={booking['code']}")

    replay = d.gate.gate_open(booking["code"], seq=seq)
    chk("D12", "REPLAYING the same seq is acknowledged and NOT re-recorded",
        replay.status == 200 and replay.get("accepted_through") == seq and replay.get("recorded") == 0,
        f"body={replay.text[:140]}")
    after = audit_rows(d.sql, "device.gate_open", 20)
    chk("D12", "...and the replay left no second audit row", len(after) == len(rows),
        f"{len(rows)} -> {len(after)}")

    d.gate.seq += 1
    again = d.gate.gate_open(booking["code"])
    chk("D12", "two scans of one code fingerprint the SAME, so 'the same badge eleven times' is "
               "still a question the trail answers",
        again.status == 200
        and json.loads(audit_rows(d.sql, "device.gate_open")[0][2]).get("subject") == subject)

    d.gate.seq += 1
    unknown = d.gate.events([{"seq": d.gate.seq, "uptime_ms": 55_000, "kind": "unknown_scan",
                              "court": -1, "method": "qr", "subject": "ABCDEFGHJKMN", "duration_ms": 0}])
    urows = audit_rows(d.sql, "device.unknown_scan", 2)
    usub = str(json.loads(urows[0][2]).get("subject") or "") if urows else ""
    chk("D12", "an offline unknown_scan is receipted, names NOBODY (structurally — an unresolvable "
               "token could not have been in the roster) and is fingerprinted too",
        unknown.status == 200 and usub != "ABCDEFGHJKMN" and len(usub) == 8
        and (not urows or urows[0][1] == "-"),
        f"subject={usub!r} subject_user_id={urows[0][1] if urows else None}")
    ledger = d.sql.scalar(f"""select count(*) from ledger_entries where "RelatedBookingId"='{booking['id']}'""")
    chk("D12", "an offline open settles nothing: still one ledger row on that booking", ledger == "1",
        f"rows={ledger}")

    # A3 — AN UPLOAD IS CONTACT, and the two clocks have to agree about it.
    #
    # Reviewer A read a door page saying "Last heard from 28m ago · Nothing can reach it"
    # over nine offline rows each saying "the door told us at 09:38", and could not tell
    # whether the product was contradicting itself or the fixture was. It is not a
    # contradiction: `POST /device/events` runs DeviceSilenceLog.NoteHeartbeat exactly as the
    # heartbeat does, so a board that uploads has just been heard from. Which means
    # `last_seen_at` can never be OLDER than the delivery instant of a row that board
    # uploaded — and that is a sentence about the product rather than about a screen, so it
    # is asserted here rather than argued about.
    row = d.activity()[0]
    delivered = row.get("delivered_at")
    devices = expect_status(d.w.http.get("/api/v1/admin/devices/", token=d.w.admin_token),
                            200, "devices").json
    mine = next((x for x in devices if x.get("id") == d.gate_id), None)
    last_seen = (mine or {}).get("last_seen_at")
    chk("D12", "an upload IS contact: last_seen_at is at or after the row it just delivered",
        bool(delivered) and bool(last_seen) and parse_dt(last_seen) >= parse_dt(delivered),
        f"last_seen_at={last_seen} delivered_at={delivered}")
    chk("D12", "...and the row it delivered is stamped with the SCAN, which is older",
        bool(row.get("at")) and parse_dt(row["at"]) <= parse_dt(delivered),
        f"at={row.get('at')} delivered_at={delivered}")


def d13_malformed_and_counters(d: Door, booking: dict) -> None:
    sc.step("D13  Malformed kinds, the normalisation guard, and the two diagnostic counters")
    for label, kind in (("null", None), ("empty", ""), ("200-character", "k" * 200)):
        d.gate.seq += 1
        r = d.gate.events([{"seq": d.gate.seq, "uptime_ms": 55_000, "kind": kind, "court": -1,
                            "method": "qr", "subject": "X", "duration_ms": 0}])
        chk("D13", f"a {label} kind is receipted as malformed rather than 500, and the queue DRAINS "
                   f"past it (a board only drains up to accepted_through)",
            r.status == 200 and r.get("accepted_through") == d.gate.seq, f"{r.summary()} {r.text[:120]}")

    # B7. `no_push` bound as a 32-bit integer, so the very first value past the
    # board's own saturation point answered 400 for the WHOLE heartbeat — no gate
    # block, no roster — and a door up long enough to saturate a counter then lost
    # its cache at the next stale deadline. They bind as LONG now, and an
    # out-of-range or negative value is IGNORED rather than refused.
    for field, values in (("no_push", (7, 0, -3, 2 ** 31, 2 ** 31 - 1, 2 ** 63 - 1)),
                          ("events_lost", (5, 0, -1, 2 ** 31))):
        for value in values:
            r = d.gate.heartbeat(**{field: value})
            chk("B7", f"{field}={value} is accepted, changes nothing, and never takes the door out "
                      f"of service", r.status == 200 and r.get("kind") == "gate" and "roster" in (r.json or {}),
                f"{r.summary()} {r.text[:120]}")
    both = d.gate.heartbeat(no_push=3, events_lost=11)
    chk("B7", "both counters together are accepted and leave the response untouched",
        both.status == 200 and both.get("gate", {}).get("unlock_seconds") == d.unlock_seconds())
    log = d.api.tail(400)
    chk("B7", "the server LOGS them against the device code and stores nothing (no column, no migration)",
        "no_push" in log or "events_lost" in log or "11" in log,
        "searched the API log tail for the counter line")

    # B2. The guard read the `kind` RAW while the receipt, the audit action and the
    # malformed test all read it trimmed — so " gate_open " was stored, receipted and
    # audited as an honest open while the guard did not recognise it and wrote THE
    # LIVE ACCESS CODE IN FULL. Anything holding the club key could do it by adding a
    # character. The kind is normalised ONCE now, at the top of /events.
    for label, kind in ((" gate_open  (padded)", " gate_open "), ("GATE_OPEN (upper)", "GATE_OPEN"),
                        ("  GaTe_OpEn  (both)", "  GaTe_OpEn  ")):
        d.gate.seq += 1
        r = d.gate.events([{"seq": d.gate.seq, "uptime_ms": 55_000, "kind": kind, "court": -1,
                            "method": "qr", "subject": booking["code"], "duration_ms": 0}])
        rows = audit_rows(d.sql, "device.%", 6)
        hit = [x for x in rows if json.loads(x[2]).get("seq") == d.gate.seq]
        sub = str(json.loads(hit[0][2]).get("subject") or "") if hit else "?"
        action = hit[0][0] if hit else "?"
        chk("B2", f"a kind of {label} is normalised ONCE: the row is device.gate_open and its "
                  f"subject is a fingerprint, never the live token",
            r.status == 200 and action == "device.gate_open" and sub != booking["code"] and len(sub) == 8,
            f"{r.summary()} action={action} subject={sub!r} token={booking['code']}")

    d.gate.seq += 1
    odd = d.gate.events([{"seq": d.gate.seq, "uptime_ms": 55_000, "kind": "Door_Was_Pushed",
                          "court": -1, "method": "qr", "subject": booking["code"], "duration_ms": 0}])
    rows = [x for x in audit_rows(d.sql, "device.%", 6)
            if json.loads(x[2]).get("seq") == d.gate.seq]
    sub = str(json.loads(rows[0][2]).get("subject") or "") if rows else "?"
    chk("B2", "a kind this server has never heard of is recorded AS NORMALISED (it is evidence, and "
              "a board cannot edit what it has queued) and fingerprinted like every other",
        odd.status == 200 and bool(rows) and rows[0][0] == "device.door_was_pushed" and len(sub) == 8,
        f"action={rows[0][0] if rows else '?'} subject={sub!r}")


def d14_another_club(d: Door) -> None:
    sc.step("D14  Another club's code at this club's door")
    other = str(uuid.uuid4())
    d.sql.run(f"""insert into tenants ("Id","Slug","DisplayName","Status","CreatedAt") values """
              f"""('{other}','g3other{other[:8]}','Other club','active',now())""")
    purpose = d.sql.scalar("""select "Purpose" from access_codes where "BookingId" is null limit 1""") or "2"
    stolen = "".join(secrets.choice(CROCKFORD) for _ in range(12))
    d.sql.run(f"""insert into access_codes ("Id","TenantId","UserId","Purpose","Code","ExpiresAt","CreatedAt") """
              f"""values ('{uuid.uuid4()}','{other}','{d.w.m_user_id}',{purpose},'{stolen}', """
              f"""now()+interval '1 hour', now())""")
    d.scan("D14", "a LIVE code belonging to another tenant — one reason for four cases, because a "
                  "door that distinguished them would be an oracle", stolen, False, "not_recognised")


def d15_out_of_service(d: Door, booking: dict) -> None:
    sc.step("D15  Out of service, and back")
    ident = d.fresh_ident()
    # A live booking so "in service" and "shut" are compared on a roster that has
    # something in it. Everything earlier in the evening has since been completed,
    # swept, cancelled or run out of code.
    sc.admin_book(d.w, 4, d.spare[2]["user_id"], now_utc() + timedelta(minutes=20), 2, "roster control")
    hb_open = d.gate.heartbeat()
    chk("D15", "while the door is in service its heartbeat carries a roster to fall back on",
        hb_open.status == 200 and len(roster_tokens(hb_open)) > 0,
        f"roster n={len(roster_tokens(hb_open))}")
    expect_status(d.w.http.patch(f"/api/v1/admin/devices/{d.gate_id}", {"enabled": False},
                                 token=d.w.admin_token), 200, "disable")
    bodies = {
        "/api/v1/device/heartbeat": {"firmware_version": "1.0.0", "uptime_ms": 1, "kind": "gate"},
        "/api/v1/device/gate": {"method": "qr", "token": ident},
        "/api/v1/device/events": {"uptime_ms": 1, "events": []},
        "/api/v1/device/activate": {"court": 1, "method": "qr", "token": ident},
        "/api/v1/device/walkup": {"minutes": 30, "method": "qr", "token": ident,
                                  "court": 1, "nonce": "n1"},
    }
    shut = {}
    for path in DEVICE_ROUTES:
        r = d.gate.call(path, bodies[path])
        shut[path] = r
        chk("D15", f"{path} is 403 while out of service — and on this surface a 403 can mean "
                   f"NOTHING ELSE, which is what the firmware acts on",
            r.http_status == 403, r.summary())
    # THE EMPTY ROSTER. A 403 on the heartbeat carries no roster at all, which is what
    # the board commits an EMPTY one on: every other failure is evidence about the
    # link, a 403 is evidence about the club's decision, and a board that fell back to
    # a roster fetched before that decision would keep admitting people the club has
    # just stopped admitting. The board's half of that is pinned in src/iot/door-gate.
    hb_shut = shut["/api/v1/device/heartbeat"]
    chk("D15", "a shut door's heartbeat hands back NO roster — there is nothing in the answer for a "
               "board to keep, which is why 403 means commit an empty one",
        not (hb_shut.json or {}).get("roster"), f"{hb_shut.summary()} body={hb_shut.text[:100]}")

    unknown_kind = d.gate.call("/api/v1/device/heartbeat",
                               {"firmware_version": "1.0.0", "uptime_ms": 1, "kind": "letterbox"})
    chk("D15", "the one documented exception: an unknown kind is 400 kind_unknown, checked BEFORE "
               "the MAC, so a shut board is told its firmware is wrong rather than that it is shut",
        unknown_kind.status == 400 and unknown_kind.get("error") == "kind_unknown",
        unknown_kind.text[:90])

    expect_status(d.w.http.patch(f"/api/v1/admin/devices/{d.gate_id}", {"enabled": True},
                                 token=d.w.admin_token), 200, "re-enable")
    d.scan("D15", "re-enabling puts the door straight back in service", ident, True, "ok")
    hb = d.gate.heartbeat()
    chk("D15", "and its roster comes back with it", hb.status == 200 and len(roster_tokens(hb)) > 0,
        f"roster n={len(roster_tokens(hb))}")


def d16_cross_kind(d: Door, booking: dict) -> None:
    sc.step("D16  Cross-kind: a gate on the court paths, a court box on the door's")
    ident = d.fresh_ident()
    act = d.gate.call("/api/v1/device/activate", {"court": 1, "method": "qr", "token": booking["code"]})
    chk("D16", "a gate cannot activate a court, and is refused BY NAME rather than by the emptiness "
               "of its court list", act.status == 200 and act.get("reason") == "not_a_court_box",
        f"{act.summary()} {act.text[:120]}")
    walk = d.gate.call("/api/v1/device/walkup", {"minutes": 30, "method": "qr",
                                                 "token": ident, "court": 1, "nonce": "g3"})
    chk("D16", "a gate cannot sell a walk-up", walk.status == 400 and walk.get("error") == "not_a_court_box",
        f"{walk.summary()} {walk.text[:120]}")

    box = d.w.box.call("POST", "/api/v1/device/gate", {"method": "qr", "token": ident})
    chk("D16", "a COURT BOX at /device/gate -> 200 not_a_gate, so a board flashed with the wrong "
               "image shows a refusal and stops instead of retrying for ever",
        box.status == 200 and box.get("reason") == "not_a_gate" and box.get("opened") is False,
        f"HTTP {box.status} {box.text[:120]}")
    if box.get("reason"):
        d.reasons_seen.add(box.get("reason"))

    cross = d.w.box.call("POST", "/api/v1/device/events", {
        "uptime_ms": 90_000,
        "events": [{"seq": 90_001, "uptime_ms": 85_000, "kind": "gate_open", "court": -1,
                    "method": "qr", "subject": booking["code"], "duration_ms": 0}]})
    chk("D16", "a gate_open uploaded by a court box is receipted rather than 4xx'd", cross.status == 200,
        cross.text[:120])
    rows = [r for r in audit_rows(d.sql, "device.gate_open%", 8)
            if json.loads(r[2]).get("outcome") == "not_a_gate"]
    chk("D16", "...as not_a_gate, and that row NAMES NOBODY — a false record of who was in the "
               "building is a worse artefact than a refusal",
        bool(rows) and all(r[1] == "-" for r in rows), f"rows={[(r[0], r[1]) for r in rows]}")

    # The respelt version, which stepped around this guard until the kind was
    # normalised once.
    respelt = d.w.box.call("POST", "/api/v1/device/events", {
        "uptime_ms": 91_000,
        "events": [{"seq": 90_002, "uptime_ms": 86_000, "kind": " GATE_OPEN ", "court": -1,
                    "method": "qr", "subject": booking["code"], "duration_ms": 0}]})
    hit = [r for r in audit_rows(d.sql, "device.%", 6) if json.loads(r[2]).get("seq") == 90_002]
    chk("B2", "a court box cannot post a door open by RESPELLING the kind",
        respelt.status == 200 and bool(hit) and json.loads(hit[0][2]).get("outcome") == "not_a_gate"
        and hit[0][1] == "-", f"row={hit[0][:2] if hit else None}")


_CONSOLE_KINDS: Optional[frozenset[str]] = None


def console_event_kinds() -> frozenset[str]:
    """Every `kind` the admin console has a word for, read from its own source.

    Parsed rather than restated so the two cannot drift: this harness once carried a
    hand-copied set that went stale the day WIRE-R3 §6 made `kind` the fine vocabulary,
    and it then failed a correct product on every run. Both maps count — a row may be
    rendered through either — and `describeDoorEventKind` falls back to a neutral
    sentence, which is exactly the outcome the assertion exists to prevent, so the
    fallback is NOT treated as coverage.

    A parse that finds nothing raises rather than returning an empty set: an allow-list
    that accidentally allows everything is worse than one that is stale, because it
    never fails and nobody looks at it again."""
    global _CONSOLE_KINDS
    if _CONSOLE_KINDS is not None:
        return _CONSOLE_KINDS
    src = (ROOT / "src" / "frontend" / "src" / "lib" / "deviceActivity.ts").read_text(encoding="utf-8")
    kinds: set[str] = set()
    for map_name in ("DOOR_EVENT_KIND_WORDS", "DOOR_EVENT_CHANGE_WORDS"):
        m = re.search(map_name + r"\s*:\s*Record<string,\s*string>\s*=\s*\{(.*?)^\};",
                      src, re.S | re.M)
        if not m:
            raise StepFailed(f"could not find {map_name} in deviceActivity.ts — this harness "
                             f"reads the console's own vocabulary and cannot assert without it")
        body = m.group(1)
        # Keys only, and only at the map's own indentation: a key inside a doc comment or a
        # nested object would widen the allow-list silently.
        for line in body.splitlines():
            km = re.match(r"\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:", line)
            if km:
                kinds.add(km.group(1))
    if not kinds:
        raise StepFailed("parsed the console's event-kind maps and found no kinds at all")
    _CONSOLE_KINDS = frozenset(kinds)
    return _CONSOLE_KINDS


def da_activity(d: Door) -> None:
    sc.step("DA  B5 — the trail finally has a reader")
    body = d.activity_body()
    items = body.get("items") or []
    events = body.get("events") or []
    chk("B5", "GET /admin/devices/{id}/activity answers this board's rows",
        len(items) > 0, f"n={len(items)}")
    actions = [i.get("action") for i in items]
    chk("B5", "it carries BOTH halves of the board's day: what the API decided online, and what the "
              "board decided for itself while the link was down",
        any(a == "gate.opened" for a in actions)
        and any(str(a).startswith("gate.denied_") for a in actions)
        and any(a == "device.gate_open" for a in actions), f"actions={sorted(set(map(str, actions)))}")
    chk("B5", "it is the BOARD's trail and not a door-opens feed: the registration row and the "
              "admin's edits are here too — in `events`, under a neutral word, NEVER among the "
              "scans, because a console paints a row it has no chip for as a green refusal",
        any(str(e.get("action")).startswith("device.auto_registered")
            or str(e.get("action")).startswith("device.updated") for e in events)
        and not any(str(a).startswith("device.auto_registered") or str(a).startswith("device.updated")
                    for a in actions)
        # THE ALLOW-LIST IS READ FROM THE CONSOLE, NOT RESTATED HERE.
        #
        # This clause used to carry a hand-copied set — {registered, edited, removed,
        # clock_corrected, unrecognised} — and WIRE-R3 §6 then made `kind` the FINE
        # vocabulary, so the server began answering `renamed`, `shut` and `reopened`.
        # The console had words for all three on the day it changed; this list did not,
        # and it failed a correct product for two rounds.
        #
        # What the assertion is actually about is the SEAM: a kind the console has no
        # chip for renders as a neutral "Unrecognised event" at best, and the sentence
        # above warns it can render as a green refusal at worst. So it is asked of the
        # console's own map, parsed out of the frontend source. A kind genuinely new to
        # both still fails here, which is the whole point; a kind both already agree on
        # cannot fail here again.
        and all(e.get("kind") in console_event_kinds() for e in events),
        f"events={sorted({(str(e.get('action')), str(e.get('kind'))) for e in events})}")
    chk("B5", "one scan is ONE row on every surface: the clock-correction row the upload writes "
              "beside a clamped event carries identical details and is not a second scan",
        len({(i.get("action"), i.get("at"), i.get("fingerprint")) for i in items}) == len(items),
        f"n={len(items)} distinct={len({(i.get('action'), i.get('at'), i.get('fingerprint')) for i in items})}")

    def delivered(row: dict) -> str:
        """The axis the trail is ordered on: when the CLUB heard about the row. An offline
        row's `at` is the SCAN, which is older than its delivery by the length of the
        outage, so the two are not the same list (A4)."""
        return row.get("delivered_at") or row["at"]

    chk("B5", "newest first, by when the club heard about it",
        all(parse_dt(delivered(items[i])) >= parse_dt(delivered(items[i + 1]))
            for i in range(len(items) - 1)),
        f"first={delivered(items[0])} last={delivered(items[-1])}")
    chk("B5", "an online decision has nothing to deliver, and an offline one says when it "
              "arrived — a page that had only `at` could not tell a two-hour-old scan from a "
              "two-hour-old outage",
        all(i.get("delivered_at") is None for i in items if not i.get("offline"))
        and all(i.get("delivered_at") for i in items if i.get("offline")),
        f"offline={[(i['at'], i.get('delivered_at')) for i in items if i.get('offline')][:3]}")

    offline = [i for i in items if i.get("offline")]
    online = [i for i in items if not i.get("offline")]
    chk("B5", "`offline` is keyed on the event's own seq, so an admin's device.updated is not "
              "reported as an open the board decided",
        all(str(i["action"]).startswith("device.") for i in offline)
        and any(str(i["action"]).startswith("gate.") for i in online),
        f"offline actions={sorted({str(i['action']) for i in offline})}")
    opened = next((i for i in items if i["action"] == "gate.opened"), None)
    chk("B5", "an online open names the member and carries its reason",
        bool(opened) and (opened.get("member") or {}).get("id") and opened.get("reason") == "ok",
        f"row={opened}")
    denied = next((i for i in items if str(i["action"]).startswith("gate.denied_")), None)
    chk("B5", "a refusal carries the reason the door answered — the refusals are the only place "
              "'nobody could get in through the side door all Tuesday' is answerable",
        bool(denied) and denied.get("reason") and str(denied["action"]).endswith(str(denied["reason"])),
        f"row={denied}")
    gate_open = next((i for i in items if i["action"] == "device.gate_open"), None)
    chk("B5", "an offline open carries a validated 8-hex fingerprint, not a token",
        bool(gate_open) and isinstance(gate_open.get("fingerprint"), str)
        and len(gate_open["fingerprint"]) == 8
        and all(c in "0123456789abcdef" for c in gate_open["fingerprint"]),
        f"fingerprint={(gate_open or {}).get('fingerprint')}")

    # `body` is the harness's Resp wrapper, not a dict — serialise what the API actually sent.
    serialised = body.text
    chk("B5", "DetailsJson is NEVER returned, in whole or in part: it carries the club's internal "
              "device id, the gate key and a court box's relay and booking ids",
        d.gate_id not in serialised and "front-door" not in serialised
        and "details" not in serialised and "gate_key" not in serialised,
        "searched the whole payload for the device id and the gate key")
    leaked = re.search(r'"[' + CROCKFORD + r']{12}"', serialised)
    chk("B5", "and no live access code reaches the console through it — rows written before the "
              "fingerprint existed hold one in `subject` IN FULL, so the field is validated to BE a "
              "fingerprint rather than forwarded",
        leaked is None, f"found {leaked.group(0) if leaked else '-'}")

    one, million = len(d.activity(limit=1)), len(d.activity(limit=1_000_000))
    chk("B5", "limit defaults to 50", len(items) <= 50, f"n={len(items)}")
    chk("B5", "limit is CLAMPED rather than refused: a console asking for a million rows is a "
              "mistake to bound, not a request to answer with an error screen",
        one == 1 and million <= 200, f"1 -> {one}, 1e6 -> {million}")

    # Rows are attributed to a board by a `device_id` inside a jsonb document with no
    # foreign key behind it, so BOTH filters — the device lookup and the row query —
    # are worth an injection rather than one.
    other_tenant = str(uuid.uuid4())
    d.sql.run(f"""insert into tenants ("Id","Slug","DisplayName","Status","CreatedAt") values """
              f"""('{other_tenant}','otherclub{other_tenant[:6]}','Other club','active',now())""")
    foreign = str(uuid.uuid4())
    # Only the columns EF declares non-nullable without a default. Naming more than
    # that is how this step first failed — against a column a sibling branch has and
    # this one does not.
    d.sql.run(f"""insert into devices ("Id","TenantId","DeviceCode","Name","MacAddress","Kind","Hardware","""
              f""""Enabled","AutoRegistered","CourtNumbers","CreatedAt") values """
              f"""('{foreign}','{other_tenant}','gate-ffffff','Other club door','02ff00000001',"""
              f"""{DEVICE_KIND_GATE},{DEVICE_HARDWARE_ESP32},true,true,'{{}}',now())""")
    r = d.w.http.get(f"/api/v1/admin/devices/{foreign}/activity", token=d.w.admin_token)
    chk("B5", "another club's board is 404 here — whether a device id exists at all is itself a "
              "fact about that tenant", r.status == 404, f"HTTP {r.status} {r.text[:120]}")


def dw_wire(d: Door, booking: dict, gateway: Optional[Gateway]) -> None:
    sc.step("DW  E1 — the framing, read the way the board reads it")
    host, port = d.board.host, d.board.port
    ident = d.fresh_ident()

    # --- the shipped firmware's ask: HTTP/1.0 + Connection: close ------------
    hb10 = d.gate.heartbeat()
    chk("E1", "over HTTP/1.0 with Connection: close the API does NOT chunk: the body is "
              "close-delimited or carries a Content-Length, which is what useHTTP10(true) buys",
        hb10.status == 200 and hb10.framing in (wire.Framing.UNTIL_CLOSE, wire.Framing.KNOWN_LENGTH),
        hb10.summary())
    chk("E1", "and the whole evening above was read that way — every assertion in this file came "
              "off a raw socket, not out of urllib", d.board.version == "1.0", f"{d.board.version}")

    # --- the half that actually broke: HTTP/1.1 on a KEPT-OPEN socket --------
    board11 = wire.BoardHttp(host, port, version="1.1", label="board/1.1")
    gate11 = GateClient(board11, d.key, d.mac)
    try:
        hb11 = gate11.heartbeat()
        chk("E1", "over HTTP/1.1 the API answers Transfer-Encoding: chunked with NO Content-Length "
                  "and HOLDS THE SOCKET OPEN — which is exactly what made every G2 call time out",
            hb11.chunked and hb11.header("content-length") is None, hb11.summary())
        chk("E1", "and hand de-chunking recovers a WHOLE document inside the body's own budget",
            hb11.status == 200 and hb11.body_result == wire.BodyResult.OK
            and isinstance(hb11.json, dict) and hb11.get("kind") == "gate",
            f"{hb11.summary()} keys={sorted(hb11.json or {})}")
        chk("E1", "the de-chunked bytes are the document and never the framing: no chunk-size line "
                  "reached the parser",
            not re.match(rb"^[0-9a-fA-F]+\r\n", hb11.body) and hb11.body.startswith(b"{")
            and hb11.body.rstrip().endswith(b"}"), f"first 24 bytes: {hb11.body[:24]!r}")
        chk("E1", "the framing overhead really was on the wire, so this was a chunked read rather "
                  "than a plain one that happened to parse",
            hb11.wire_bytes > len(hb11.body), f"{hb11.wire_bytes} read, {len(hb11.body)} handed up")

        scan11 = gate11.scan(ident)
        chk("E1", "a SECOND call on the same kept-open socket is framed and read correctly too — a "
                  "reader that guessed 'until close' would still be waiting on it",
            scan11.status == 200 and scan11.get("opened") is True and scan11.get("reason") == "ok",
            f"{scan11.summary()} {scan11.text[:120]}")
        if scan11.get("reason"):
            d.reasons_seen.add(scan11.get("reason"))

        roster_hb = gate11.heartbeat()
        chk("E1", f"and the chunked body ARRIVED WHOLE, under the {wire.MAX_RESPONSE_BYTES}-byte "
                  f"ceiling the board's {wire.RESPONSE_CAP}-byte buffer is sized against — a body "
                  f"that did not fit comes back EMPTY, so the size alone is not the assertion",
            roster_hb.body_result == wire.BodyResult.OK
            and 0 < len(roster_hb.body) <= wire.MAX_RESPONSE_BYTES,
            f"{len(roster_hb.body)} bytes, read={roster_hb.body_result}")
    finally:
        board11.close()

    # --- and through the gateway the boards actually talk to -----------------
    if gateway is None:
        if os.environ.get("E2E_REQUIRE_GATEWAY") == "1":
            chk("E1", "the gateway pass ran (E2E_REQUIRE_GATEWAY=1)", False,
                "nginx is not on PATH and this run was told to require it")
        else:
            REPORT.note("DW: no nginx on PATH, so the gateway pass did not run. The boards do NOT "
                        "talk to the application — they talk to nginx, and `proxy_http_version 1.1` "
                        "with `proxy_buffering off` is what re-chunks to a 1.1 client. CI sets "
                        "E2E_REQUIRE_GATEWAY=1 so this cannot go quiet there.")
        return

    chk("E1", "nginx.conf's /api/ block still asks for the framing this pass is about",
        any(dv.startswith("proxy_http_version 1.1") for dv in gateway.directives)
        and any(dv.startswith("proxy_buffering off") for dv in gateway.directives),
        f"directives={gateway.directives}")

    for version in ("1.0", "1.1"):
        proxied = wire.BoardHttp("127.0.0.1", gateway.port, version=version, label=f"gateway/{version}")
        proxy_gate = GateClient(proxied, d.key, d.mac)
        try:
            hb = proxy_gate.heartbeat()
            if version == "1.0":
                chk("E1", "through the REAL gateway, an HTTP/1.0 board gets a close-delimited body: "
                          "nginx must not chunk to a 1.0 client",
                    hb.status == 200 and not hb.chunked, hb.summary())
            else:
                chk("E1", "through the REAL gateway, an HTTP/1.1 board gets a re-chunked body and "
                          "hand de-chunking still recovers the whole document",
                    hb.status == 200 and hb.chunked and isinstance(hb.json, dict)
                    and hb.get("kind") == "gate", hb.summary())
            scan = proxy_gate.scan(ident)
            chk("E1", f"and a scan through the gateway over HTTP/{version} is decided and read "
                      f"exactly as it is direct",
                scan.status == 200 and isinstance(scan.json, dict) and "opened" in scan.json,
                f"{scan.summary()} {scan.text[:100]}")
            if scan.get("reason"):
                d.reasons_seen.add(scan.get("reason"))
        finally:
            proxied.close()


def d17_the_trail(d: Door, booking: dict) -> None:
    sc.step("D17  What the trail says afterwards, and what it does not")
    opened = d.sql.scalar("""select count(*) from audit_log where "Action"='gate.opened'""")
    denied = d.sql.scalar("""select count(*) from audit_log where "Action" like 'gate.denied_%'""")
    chk("D17", "every decision left one row, refusals included — that row is the ENTIRE record that "
               "anything happened, because a door writes no ledger entry and no booking",
        int(opened or 0) > 0 and int(denied or 0) > 0, f"opened={opened} denied={denied}")
    leaked = d.sql.scalar("""select count(*) from audit_log where "Action" like 'gate.%' """
                          f"""and "DetailsJson"::text like '%{booking["code"]}%'""")
    chk("D17", "no gate.* audit row carries a live token", leaked == "0", f"rows={leaked}")
    named = d.sql.scalar("""select count(*) from audit_log where "Action" like 'gate.%' """
                         """and "DetailsJson"->>'gate_key' = 'front-door'""")
    chk("D17", "the rows name the door by its gate_key, which is the whole reason gate_key exists",
        int(named or 0) > 0, f"rows={named}")

    seen = d.reasons_seen
    want = corpus_reasons()
    chk("D17", "EVERY refusal reason with a corpus vector was provoked at the live door in this run "
               "— a reason nothing here reaches is a screen the firmware has for a refusal this "
               "harness has never seen",
        want.issubset(seen), f"missing={sorted(want - seen)} seen={sorted(seen)}")
    actions = {row.split("|")[0] for row in
               d.sql.run("""select distinct "Action" from audit_log where "Action" like 'gate.denied_%'""").splitlines()
               if row.strip()}
    print(f"  refusal actions in the trail: {sorted(actions)}", flush=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def run_step(fn, label: str) -> None:
    try:
        fn()
    except StepFailed as e:
        REPORT.check(label, f"step could not complete: {e}", False)
    except Exception:  # noqa: BLE001 - the report must survive a scripting fault
        REPORT.check(label, "step raised: " + traceback.format_exc().strip().splitlines()[-1], False)
        traceback.print_exc()


def evening(d: Door, gateway: Optional[Gateway]) -> None:
    run_step(lambda: d1_plug_in(d), "D1")
    run_step(lambda: d2_name_the_door(d), "D2")
    booking = d3_member_books(d)
    run_step(lambda: d4_roster(d, booking), "D4")
    run_step(lambda: d5_scans(d, booking), "D5")
    run_step(lambda: d6_both_policies(d, booking), "POL")
    run_step(lambda: d7_the_door_is_not_a_court(d, booking), "D7")
    run_step(lambda: d8_completed(d, booking), "B1")
    run_step(lambda: d9_noshow(d), "D9")
    run_step(lambda: d10_upper_edge(d), "D10")
    run_step(lambda: d11_relief_and_membership(d, booking), "D11")
    run_step(lambda: d12_offline_uploads(d, booking), "D12")
    run_step(lambda: d13_malformed_and_counters(d, booking), "D13")
    run_step(lambda: d14_another_club(d), "D14")
    run_step(lambda: d15_out_of_service(d, booking), "D15")
    run_step(lambda: d16_cross_kind(d, booking), "D16")
    run_step(lambda: da_activity(d), "B5")
    run_step(lambda: gate_sim.dsim_firmware(d), "DSIM")
    run_step(lambda: dw_wire(d, booking, gateway), "E1")
    run_step(lambda: d17_the_trail(d, booking), "D17")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--no-gateway", action="store_true",
                        help="skip the nginx pass even when nginx is on PATH")
    args = parser.parse_args()

    cfg = sc.Config()
    cfg.workdir = cfg.workdir.parent / (cfg.workdir.name + "-door")
    cfg.workdir.mkdir(parents=True, exist_ok=True)
    print(f"door evening: worktree {ROOT}\n  scratch {cfg.workdir}", flush=True)

    pg = sc.Postgres(cfg)
    db_name = "e2e_door_" + datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + secrets.token_hex(2)
    api: Optional[sc.ApiProcess] = None
    gateway: Optional[Gateway] = None
    try:
        sql = Sql(cfg, db_name)  # fails fast and by name if psql is missing
        pg.ensure()
        api = sc.ApiProcess(cfg, pg.connection_string(db_name))
        if not cfg.skip_build:
            api.build()
        api.start()
        print(f"  fresh database {db_name} (migrated + seeded by the API on boot)", flush=True)

        parsed = urlsplit(api.base)
        board = wire.BoardHttp(parsed.hostname or "127.0.0.1", parsed.port or 80,
                               version="1.0", label="board/1.0")
        print(f"  the board reads over a raw socket: HTTP/1.0 + Connection: close, "
              f"{wire.RESPONSE_CAP}-byte buffer, {wire.CONNECT_BUDGET:.0f}/"
              f"{wire.HEADER_BUDGET:.0f}/{wire.BODY_BUDGET:.0f}s budgets", flush=True)

        if not args.no_gateway and Gateway.available():
            # A gateway that will not start is ONE step's problem, not the evening's:
            # it is recorded where DW can report it and the other hundred and sixty
            # assertions still run.
            try:
                gateway = Gateway(cfg, parsed.port or 80)
                gateway.start()
                print(f"  nginx gateway on :{gateway.port} carrying nginx.conf's own /api/ directives",
                      flush=True)
            except StepFailed as e:
                gateway = None
                REPORT.check("E1", f"the nginx gateway started: {e}", False)

        w = sc.World(sc.Http(api.base))
        sc.admin_login(w)
        run_step(lambda: sc.seed_and_tune(w), "setup")
        run_step(lambda: sc.provision_box(w), "C1")
        evening(Door(w, sql, board, api), gateway)
        board.close()
    except StepFailed as e:
        REPORT.check("infra", f"environment: {e}", False)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        REPORT.check("infra", "driver raised: " + traceback.format_exc().strip().splitlines()[-1], False)
    finally:
        if gateway:
            gateway.stop()
        if api:
            api.stop()

    print(REPORT.summary(), flush=True)
    failed = bool(REPORT.failed)
    if failed:
        print("\nlast HTTP exchanges (JWT client):")
        for ex in REPORT.exchanges[-8:]:
            print("  " + ex.compact().replace("\n", "\n  "))
        if api:
            print(f"\nAPI log tail ({api.log}):\n" + api.tail())
        print(f"\nscratch kept at {cfg.workdir}")
    else:
        # A passing run leaves nothing behind, per the tree's scratch rule.
        shutil.rmtree(cfg.workdir, ignore_errors=True)
        for parent in (cfg.workdir.parent, cfg.workdir.parent.parent):
            if parent.exists() and parent.is_relative_to(ROOT) and not any(parent.iterdir()):
                parent.rmdir()
    if not cfg.keep_db and not failed:
        pg.drop(db_name)
    else:
        print(f"database kept for forensics: {db_name}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
