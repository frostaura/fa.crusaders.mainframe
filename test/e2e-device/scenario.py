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
SIMULATOR = ROOT / "src" / "iot" / ".pio" / "build" / "simulator" / "program"

# What the Development seeder writes for the pilot tenant. The tenant's PayFast
# credentials have no admin API yet (they live inside tenant_settings.payfast, and
# the settings PUT does not write that key), so the ITN is signed with the seeded
# passphrase. If Seeder.cs changes these, this is the one place to follow it.
SEEDED_TENANT = "crusaders"
SEEDED_PAYFAST_PASSPHRASE = "REPLACE_WITH_PAYFAST_PASSPHRASE"
SEEDED_PAYFAST_MERCHANT_ID = "REPLACE_WITH_PAYFAST_MERCHANT_ID"
SEEDED_MEMBER_M = "MEM-1001"  # Naledi Khoza, Regular — the scanning member
SEEDED_MEMBER_N = "MEM-1003"  # Aisha Patel, Regular — the no-show member

RELAY_HARD_CAP_SECONDS = 5400


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

    def note(self, text: str) -> None:
        self.notes.append(text)
        print(f"  [note] {text}", flush=True)

    @property
    def failed(self) -> list[Check]:
        return [c for c in self.checks if not c.ok]

    def summary(self) -> str:
        lines = ["", "finding-id -> assertion", "-" * 72]
        for c in self.checks:
            lines.append(f"  {'PASS' if c.ok else 'FAIL'}  {c.finding:<8} {c.description}")
        lines.append("-" * 72)
        total = len(self.checks)
        lines.append(f"  {total - len(self.failed)}/{total} assertions passed")
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


_FRACTION = re.compile(r"(\.\d{1,6})\d*")


def parse_dt(text: str) -> datetime:
    # .NET writes seven fractional digits; fromisoformat on older Pythons wants six.
    text = _FRACTION.sub(r"\1", text.replace("Z", "+00:00"))
    return datetime.fromisoformat(text)


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


def dec(value: Any) -> float:
    return float(value)


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


# ---------------------------------------------------------------------------
# Serial protocol: !VERB,arg,arg*CC
# ---------------------------------------------------------------------------


def serial_escape(arg: str) -> str:
    return arg.replace("%", "%25").replace(",", "%2C")


def serial_unescape(arg: str) -> str:
    return arg.replace("%2C", ",").replace("%25", "%")


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


class Simulator:
    """The firmware's Mega half: courtlogic::CourtBox over posix_hal, one TCP peer."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.proc: Optional[subprocess.Popen] = None
        self.port = 0
        self.stdout: "queue.Queue[str]" = queue.Queue()
        self.stdout_seen: list[str] = []
        self.frames: "queue.Queue[Frame]" = queue.Queue()
        self.frames_seen: list[Frame] = []
        self.sock: Optional[socket.socket] = None
        self.log = cfg.workdir / "simulator.log"

    def ensure_built(self) -> None:
        if SIMULATOR.exists():
            return
        if not Path(self.cfg.pio).exists() and not shutil.which(self.cfg.pio):
            raise StepFailed(f"{SIMULATOR} is missing and no pio to build it (set PIO=)")
        print("  building the native simulator (pio run -e simulator) ...")
        r = subprocess.run([self.cfg.pio, "run", "-d", str(ROOT / "src" / "iot"), "-e", "simulator"], capture_output=True, text=True)
        if r.returncode != 0 or not SIMULATOR.exists():
            raise StepFailed("simulator build failed:\n" + (r.stdout + r.stderr)[-3000:])

    def start(self) -> None:
        store = self.cfg.workdir / "simstore"
        store.mkdir(parents=True, exist_ok=True)
        self.proc = subprocess.Popen(
            [str(SIMULATOR), "--port", "0", "--store", str(store)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=str(self.cfg.workdir),
        )
        LineReader(self.proc.stdout, self.log, self.stdout).start()
        first = self.expect_stdout(lambda l: l.startswith("[sim] listening on 127.0.0.1:"), 10)
        self.port = int(first.rsplit(":", 1)[1])
        print(f"  simulator (Mega half) listening on 127.0.0.1:{self.port}, log {self.log}")

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

    def expect_stdout(self, pred: Callable[[str], bool], timeout: float) -> str:
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise StepFailed(f"simulator stdout never matched within {timeout}s (recent: {self.stdout_seen[-5:]})")
            try:
                line = self.stdout.get(timeout=remaining)
            except queue.Empty:
                continue
            self.stdout_seen.append(line)
            if pred(line):
                return line

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
    court_price: float = 8.0
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


def admin_login(w: World) -> None:
    r = expect_status(w.http.post("/api/v1/auth/dev/admin-login"), 200, "dev admin login")
    w.admin_token = r["access_token"]
    w.admin_user_id = r["user_id"]
    if not r.get("is_admin"):
        raise StepFailed("dev admin login did not return an admin session")


def seed_and_tune(w: World) -> None:
    step("Seed tenant/admin/courts/members and tune settings through the API")
    # The Development seeder created the pilot tenant, the admin, four courts and five
    # sample members with an opening balance. Everything below is done over HTTP.
    settings = expect_status(w.http.get("/api/v1/admin/settings", token=w.admin_token), 200, "settings GET")
    w.tenant_tz = settings.get("timezone") or w.tenant_tz
    body = {
        "sliceMinutes": 15,
        "slicePriceCredits": settings["slice_price_credits"],
        "advanceBookingDays": settings["advance_booking_days"],
        "dayStartMinute": settings["day_start_minute"],
        "dayEndMinute": settings["day_end_minute"],
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
    REPORT.check(
        "setup", "tenant settings tuned via admin API (slice 15, grace 1, cue 10, roster 120, forward 240)",
        after["slice_minutes"] == 15 and after["grace_window_minutes"] == 1 and after["activation_cue_window_minutes"] == 10
        and after["roster_window_minutes"] == 120 and after["activation_forward_window_minutes"] == 240,
    )

    courts = expect_status(w.http.get("/api/v1/admin/courts", token=w.admin_token), 200, "courts GET").json
    for c in courts:
        w.courts[c["court_number"]] = c["id"]
        # 8 credits a slice, the number the whole test corpus is written against; the
        # seeder ships 50. Patched through the API rather than assumed.
        expect_status(w.http.patch(f"/api/v1/admin/courts/{c['id']}", {"slicePriceCredits": 8}, token=w.admin_token), 200, "court PATCH")
    REPORT.check("setup", "four courts present (numbers 1-4) and priced at 8 credits/slice", all(n in w.courts for n in (1, 2, 3, 4)))

    members = expect_status(w.http.get("/api/v1/admin/members", token=w.admin_token), 200, "members GET").json
    by_number = {m["membership_number"]: m for m in members}
    if SEEDED_MEMBER_M not in by_number or SEEDED_MEMBER_N not in by_number:
        raise StepFailed(f"seeded members {SEEDED_MEMBER_M}/{SEEDED_MEMBER_N} not found: {sorted(by_number)}")
    m, n = by_number[SEEDED_MEMBER_M], by_number[SEEDED_MEMBER_N]
    w.m_user_id, w.m_membership_id = m["user_id"], m["membership_id"]
    w.n_user_id, w.n_membership_id = n["user_id"], n["membership_id"]

    # A seeded member has no password. The admin reset returns a one-shot temporary
    # password, which is the API's own out-of-band path — and what gives us M's JWT.
    reset = expect_status(w.http.post(f"/api/v1/admin/members/{w.m_membership_id}/reset-password", token=w.admin_token), 200, "reset-password")
    login = expect_status(w.http.post("/api/v1/auth/login", {"email": m["email"], "password": reset["temp_password"]}), 200, "member login")
    w.m_token = login["access_token"]
    REPORT.check("setup", f"member M ({SEEDED_MEMBER_M}) logged in via admin password reset", bool(w.m_token) and not login.get("is_admin"))

    # Credits through the admin API, on top of the seeded opening balance.
    adj = expect_status(w.http.post(f"/api/v1/admin/credit/{w.m_user_id}/adjust", {"amountCredits": 500, "reason": "e2e-device seed"}, token=w.admin_token), 200, "adjust M")
    expect_status(w.http.post(f"/api/v1/admin/credit/{w.n_user_id}/adjust", {"amountCredits": 500, "reason": "e2e-device seed"}, token=w.admin_token), 200, "adjust N")
    wallet = expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")
    REPORT.check("setup", "credits seeded via admin adjustment and visible on M's wallet",
                 dec(wallet["balance_credits"]) == dec(adj["balance_after_credits"]) and dec(wallet["balance_credits"]) >= 500)



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


def ensure_free(w: World, court_number: int, start: datetime, end: datetime) -> None:
    """Admin-cancel any seeded booking overlapping the window this run needs."""
    for slot in schedule_slots(w, start):
        if slot["courtNumber"] != court_number or slot["status"] != "booked":
            continue
        s, e = parse_dt(slot["startsAtUtc"]), parse_dt(slot["endsAtUtc"])
        if s < end and e > start:
            r = w.http.post(f"/api/v1/admin/bookings/{slot['bookingId']}/cancel", {"waivePenalty": True}, token=w.admin_token)
            print(f"  cleared seeded booking {slot['bookingId']} on court {court_number} ({s:%H:%M}-{e:%H:%M} UTC): HTTP {r.status}")


def admin_book(w: World, court_number: int, user_id: str, starts_at: datetime, slices: int, what: str) -> dict:
    r = w.http.post("/api/v1/admin/bookings", {
        "courtId": w.courts[court_number], "userId": user_id, "startsAt": iso(starts_at), "sliceCount": slices,
    }, token=w.admin_token)
    expect_status(r, 200, f"admin booking {what}")
    return {"id": r["booking_id"], "court": court_number, "starts_at": starts_at,
            "ends_at": starts_at + timedelta(minutes=15 * slices), "user_id": user_id, "amount": w.court_price * slices}


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
    REPORT.check("C1", "a heartbeat whose mac is not twelve hex characters is 400 mac_required",
                 no_mac.status == 400 and no_mac.get("error") == "mac_required", f"resp={no_mac.text[:120]}")


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
            "sliceMinutes": cur["slice_minutes"], "slicePriceCredits": cur["slice_price_credits"],
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

    if sim is not None:
        # And the lights: the bridge's decision goes to the Mega as !ON on relay C.
        sim.send("ON", "C", str(granted))
        state = sim.expect_frame(lambda f: f.verb == "STATE" and (int(f.args[0]) & 0b0100), 5, "!STATE with relay C")
        rem_c = int(state.args[3])
        REPORT.check("M-serial", "!ON,C,<granted> closes relay C: !STATE mask has bit 2 and remaining C ~= granted (<= 5400)",
                     granted - 3 <= rem_c <= min(granted, RELAY_HARD_CAP_SECONDS), str(state))
        sim.expect_stdout(lambda l: "[relay] court C ON" in l, 5)
        REPORT.check("M-serial", "the simulated relay driver reports court C ON", True)

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
    REPORT.check("C3", "M's ledger holds exactly one movement for B3: the -24 charge posted at booking, nothing at activation",
                 len(b3_rows) == 1 and dec(b3_rows[0]["signedAmountCredits"]) == -24 and b3_rows[0]["type"] == "BookingCharge", f"rows={[(r['type'], r['signedAmountCredits']) for r in b3_rows]}")
    if sim is not None:
        sim.send("OFF", "C")
        evt = sim.expect_frame(lambda f: f.verb == "EVT" and f.args[:2] == ["OFF", "C"], 5, "!EVT,OFF,C")
        state = sim.expect_frame(lambda f: f.verb == "STATE" and int(f.args[0]) & 0b0100 == 0, 12, "!STATE with C clear")
        REPORT.check("M-serial", "!OFF,C opens the relay: !EVT,OFF,C is reported and the next !STATE mask has C clear", bool(evt) and bool(state), f"{evt} / {state}")


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


def walk_up(w: World) -> None:
    step("C5/H3  Walk-up on an unbooked court, replay-safe by nonce")
    assert w.box is not None
    wallet_before = dec(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_credits"])
    nonce = secrets.token_hex(8)
    req = {"minutes": 60, "method": "qr", "token": w.ident_code, "court": 2, "nonce": nonce}
    first = expect_status(w.box.call("POST", "/api/v1/device/walkup", req), 200, "walkup")
    REPORT.check("C5", "walk-up on court 2 (named in the request, on the box) is granted 60 minutes (<= 90) for 32 credits",
                 first.get("granted_minutes") == 60 and dec(first.get("amount_credits", 0)) == 32 and first.get("replayed") is False, f"resp={first.json}")
    REPORT.check("C5", "balance_after_credits == wallet before - 32", dec(first.get("balance_after_credits", -1)) == wallet_before - 32)
    replay = expect_status(w.box.call("POST", "/api/v1/device/walkup", req), 200, "walkup replay")
    REPORT.check("H3", "resending the identical nonce answers replayed:true with the SAME booking_id and the remainder of the grant (60, seconds later)",
                 replay.get("replayed") is True and replay.get("booking_id") == first.get("booking_id") and 59 <= replay.get("granted_minutes", 0) <= 60, f"resp={replay.json}")
    wallet_after = dec(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_credits"])
    REPORT.check("H3", "the replay charged nothing: wallet moved by exactly -32 across both calls", wallet_after == wallet_before - 32, f"{wallet_before} -> {wallet_after}")
    ledger = expect_status(w.http.get(f"/api/v1/admin/ledger?userId={w.m_user_id}&limit=200", token=w.admin_token), 200, "ledger M").json
    wu_rows = [r for r in ledger if r.get("relatedBookingId") == first.get("booking_id")]
    REPORT.check("H3", "one LightsPurchase row of -32 for the walk-up booking, not two", len(wu_rows) == 1 and wu_rows[0]["type"] == "LightsPurchase" and dec(wu_rows[0]["signedAmountCredits"]) == -32,
                 f"rows={[(r['type'], r['signedAmountCredits']) for r in wu_rows]}")
    slot = find_slot(w, first.get("booking_id", ""), now_utc())
    REPORT.check("C5", "the walk-up is a real booking on court 2 in M's name, visible on the schedule",
                 bool(slot) and slot["courtNumber"] == 2 and slot["ownerUserId"] == w.m_user_id and slot["status"] == "booked")
    off_box = w.box.call("POST", "/api/v1/device/walkup", {"minutes": 30, "method": "qr", "token": w.ident_code, "court": 5, "nonce": secrets.token_hex(8)})
    REPORT.check("C5", "court 5 (not on this box) -> 400 court_not_on_device", off_box.status == 400 and off_box.get("error") == "court_not_on_device", f"resp={off_box.text[:120]}")
    no_nonce = w.box.call("POST", "/api/v1/device/walkup", {"minutes": 30, "method": "qr", "token": w.ident_code, "court": 2})
    REPORT.check("H3", "a walk-up without a nonce -> 400 nonce_required", no_nonce.status == 400 and no_nonce.get("error") == "nonce_required")
    booking_code = w.tokens.get(2)
    if booking_code:
        wallet_now = dec(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_credits"])
        as_wallet = w.box.call("POST", "/api/v1/device/walkup", {"minutes": 30, "method": "qr", "token": booking_code, "court": 2, "nonce": secrets.token_hex(8)})
        wallet_after_attempt = dec(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_credits"])
        REPORT.check("R19", "B3's BOOKING code presented as a walk-up buyer -> 400 not_recognised and the wallet is untouched (a roster code is not a wallet)",
                     as_wallet.status == 400 and as_wallet.get("error") == "not_recognised" and wallet_after_attempt == wallet_now, f"resp={as_wallet.text[:120]}")
    too_long = w.box.call("POST", "/api/v1/device/walkup", {"minutes": 240, "method": "qr", "token": w.ident_code, "court": 2, "nonce": secrets.token_hex(8)})
    REPORT.check("M1", "240 minutes is refused with the effective cap (min(walk_up_max, relay cap 90))",
                 too_long.status == 400 and too_long.get("error") == "minutes_out_of_range" and too_long.get("max_minutes") == 90)


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
    step("Money  PayFast top-up through the mountebank imposter, ITN verified and replay refused")
    wallet_before = dec(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_credits"])
    topup = expect_status(w.http.post("/api/v1/credit/topup", {"amountZar": 100}, token=w.m_token), 200, "topup register")
    m_payment_id = topup["checkout_id"]
    REPORT.check("money", "POST /credit/topup registers a pending R100 top-up and points the browser at PayFast's process URL",
                 bool(m_payment_id) and "/eng/process" in topup.get("redirect_url", ""), f"resp={topup.json}")
    # The browser leg, against the imposter instead of PayFast.
    form = form_encode([("merchant_id", SEEDED_PAYFAST_MERCHANT_ID), ("m_payment_id", m_payment_id), ("amount", "100.00"), ("item_name", "Credits")])
    checkout = w.http.call("POST", f"{mb.base}/eng/process", raw=form, content_type="application/x-www-form-urlencoded", absolute=True)
    REPORT.check("money", "the imposter answers the checkout POST with a 302 back to the return URL",
                 checkout.status == 302 and "/wallet/topup/" in checkout.headers.get("Location", ""), f"Location={checkout.headers.get('Location')}")
    # The server-to-server leg: an ITN as PayFast would sign it, in posted order.
    pf_payment_id = str(1_000_000 + secrets.randbelow(9_000_000))
    fields = [("m_payment_id", m_payment_id), ("pf_payment_id", pf_payment_id), ("payment_status", "COMPLETE"),
              ("item_name", "Credits"), ("amount_gross", "100.00"), ("amount_fee", "-2.30"), ("amount_net", "97.70"),
              ("merchant_id", SEEDED_PAYFAST_MERCHANT_ID)]
    signed = fields + [("signature", payfast_signature(fields, SEEDED_PAYFAST_PASSPHRASE))]
    itn = w.http.call("POST", f"/api/v1/credit/topup/callback?tenant={SEEDED_TENANT}", raw=form_encode(signed), content_type="application/x-www-form-urlencoded")
    REPORT.check("money", "a correctly signed COMPLETE ITN is accepted and converts R100 -> 160 credits (Regular rate 1.6)",
                 itn.status == 200 and itn.get("ok") is True and dec(itn.get("credits", 0)) == 160, f"resp={itn.text[:160]}")
    wallet_mid = dec(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_credits"])
    REPORT.check("money", "M's wallet rose by exactly 160", wallet_mid == wallet_before + 160, f"{wallet_before} -> {wallet_mid}")
    status = expect_status(w.http.get(f"/api/v1/credit/topup/{topup['topup_id']}", token=w.m_token), 200, "topup status")
    REPORT.check("money", "the pending top-up is now Completed", status.get("status") == "Completed")
    replay = w.http.call("POST", f"/api/v1/credit/topup/callback?tenant={SEEDED_TENANT}", raw=form_encode(signed), content_type="application/x-www-form-urlencoded")
    wallet_after = dec(expect_status(w.http.get("/api/v1/wallet", token=w.m_token), 200, "wallet")["balance_credits"])
    REPORT.check("money", "replaying the same ITN is acknowledged as idempotent and credits nothing a second time",
                 replay.status == 200 and replay.get("idempotent") is True and wallet_after == wallet_mid, f"resp={replay.text[:120]}")
    tampered = [(k, ("999.00" if k == "amount_gross" else v)) for k, v in signed]
    bad = w.http.call("POST", f"/api/v1/credit/topup/callback?tenant={SEEDED_TENANT}", raw=form_encode(tampered), content_type="application/x-www-form-urlencoded")
    REPORT.check("money", "an ITN altered after signing is refused (401)", bad.status == 401)
    ledger = expect_status(w.http.get(f"/api/v1/admin/ledger?userId={w.m_user_id}&type=TopUp&limit=50", token=w.admin_token), 200, "ledger topups").json
    REPORT.check("money", "exactly one TopUp ledger row of +160 exists for this payment", sum(1 for r in ledger if dec(r["signedAmountCredits"]) == 160) == 1)


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
    rows7 = {r["type"]: dec(r["signedAmountCredits"]) for r in ledger_n if r.get("relatedBookingId") == w.b7["id"]}
    REPORT.check("H5", "N's ledger for B7: BookingCharge -24, CancellationRefund +24, NoShowPenalty -7.20 (30%) as separate rows",
                 rows7.get("BookingCharge") == -24 and rows7.get("CancellationRefund") == 24 and rows7.get("NoShowPenalty") == -7.2, f"rows={rows7}")
    n_after = next(m for m in expect_status(w.http.get("/api/v1/admin/members", token=w.admin_token), 200, "members").json if m["user_id"] == w.n_user_id)
    # Money is ledger-only: the balance the admin screen shows must be the sum of N's rows,
    # including the two the sweep just posted. (A plain before/after delta would also
    # pick up any seeded booking of N's the same sweep happened to settle.)
    ledger_sum = round(sum(dec(r["signedAmountCredits"]) for r in ledger_n), 2)
    REPORT.check("H5", "N's balance equals the sum of N's ledger rows after the sweep (no stored balance drift)",
                 round(dec(n_after["balance_credits"]), 2) == ledger_sum and dec(n_after["balance_credits"]) >= dec(n_before["balance_credits"]) + 16.8,
                 f"{n_before['balance_credits']} -> {n_after['balance_credits']} (ledger sum {ledger_sum})")
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
        rows = [(r["type"], dec(r["signedAmountCredits"])) for r in ledger_m if r.get("relatedBookingId") == b["id"]]
        REPORT.check(label, f"no refund and no penalty were posted for the attended booking on court {b['court']}",
                     rows == [("BookingCharge", -24.0)], f"rows={rows}")


def mega_half(sim: Simulator) -> None:
    step("Mega  The serial protocol against the firmware's own CourtBox (simulator)")
    sim.send("PING")
    pong = sim.expect_frame(lambda f: f.verb == "PONG", 5, "!PONG")
    REPORT.check("M-serial", "!PING is answered with !PONG,<version>,<uptime_s>", len(pong.args) == 2 and pong.args[0].count(".") == 2 and pong.args[1].isdigit(), str(pong))

    # Button without authorisation: dropped, never queued.
    sim.console("btn A")
    REPORT.check("M-serial", "a button press while !AUTH is not armed produces no !BTN frame (dropped, not queued)", sim.no_frame(lambda f: f.verb == "BTN", 1.5))
    sim.send("AUTH", "30")
    time.sleep(0.2)
    sim.console("btn A")
    btn = sim.expect_frame(lambda f: f.verb == "BTN", 3, "!BTN,A")
    REPORT.check("M-serial", "after !AUTH,30 the same press arrives as !BTN,A (debounced once)", btn.args == ["A"], str(btn))
    sim.send("AUTH", "1")
    expired = sim.expect_frame(lambda f: f.verb == "EVT" and f.args[:1] == ["AUTHEXPIRED"], 4, "!EVT,AUTHEXPIRED")
    REPORT.check("M-serial", "!AUTH,1 lapses into exactly one !EVT,AUTHEXPIRED", bool(expired), str(expired))
    sim.console("btn B")
    REPORT.check("M-serial", "a press after the window lapsed is dropped again", sim.no_frame(lambda f: f.verb == "BTN", 1.5))

    # The relay timer is the Mega's own: AUTOOFF fires with no bridge involvement.
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
    parser.add_argument("--no-money", action="store_true", help="skip the PayFast leg")
    args = parser.parse_args()

    cfg = Config()
    cfg.workdir.mkdir(parents=True, exist_ok=True)
    print(f"e2e-device: worktree {ROOT}\n  scratch {cfg.workdir}")

    step("Preflight")
    selftest_device_contract()
    REPORT.check("C1", "this script's device request shape matches the shared corpus (bearer header + normalised mac)", True)

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
        run_step(lambda: walk_up(w), "C5")
        run_step(lambda: early_scan(w), "A2-15")
        if mb:
            run_step(lambda: money_leg(w, mb), "money")
        if sim:
            run_step(lambda: mega_half(sim), "M-serial")
        run_step(lambda: no_show_sweep(w), "H5")
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
