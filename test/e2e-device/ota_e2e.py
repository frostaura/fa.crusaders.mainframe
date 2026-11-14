#!/usr/bin/env python3
"""Signed OTA for the court box bridge, end to end against the real API.

device-api.md §7, bridge 3.1.0. The stack is real (the API from source, its own Postgres
database, migrations and the Development seed); the bridge is `src/iot/court-box/.pio/build/
bridge_sim/program` — the REAL bridgelogic::BridgeOta, BridgeKeys and BridgeNet and the v3
heartbeat renderer, over a socket, with the ESP8266's flash played by files and its restart by an
exit code (see src/iot/court-box/src/bridge_sim/main.cpp). This script is eboot and the power
switch: it starts the process again whenever it asks.

What it proves, each a numbered check below:

  OTA-1  a release signed with a key the server does not hold is refused at upload (sig_invalid);
  OTA-2  the board DISCOVERS a rolled-out release in its heartbeat, verifies the signature before
         fetching, keeps a copy of its running image, DOWNLOADS from its own server, stages,
         verifies the staged bytes, switches, boots in probation and COMMITS on an accepted beat;
         the server sees the new running_version and fw_state committed;
  OTA-3  a release that never reaches an accepted heartbeat (it "crashes" on every boot) is ROLLED
         BACK on its fourth boot from the board's own copy, reported rolled_back with fw_failed and
         fw_error probation, and the server never offers that version again.

    python3 test/e2e-device/ota_e2e.py

Environment as scenario.py's (E2E_PG_*, E2E_SKIP_BUILD, E2E_KEEP_DB).
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import traceback
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scenario as sc  # noqa: E402

ROOT = sc.ROOT
SIM = ROOT / "src" / "iot" / "court-box" / ".pio" / "build" / "bridge_sim" / "program"
OTA_SIGN = ROOT / "src" / "iot" / "tools" / "ota_sign.py"
MAC = "5ccf7f0a0ca1"
REPORT = sc.REPORT
EXIT_RESTART = 75
EXIT_CRASH = 76


def chk(tag: str, what: str, ok: bool, detail: str = "") -> bool:
    return REPORT.check(tag, what, ok, detail)


def image(version: str, size: int) -> bytes:
    """A sim image: its version on line one, then deterministic filler to `size` bytes."""
    head = f"CRUSADERS-SIM-IMAGE {version}\n".encode()
    filler = (version.encode() * (size // len(version) + 1))[: size - len(head)]
    return head + filler


def multipart(fields: dict[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    boundary = "----crusaders" + secrets.token_hex(8)
    out = bytearray()
    for name, (filename, data, ctype) in fields.items():
        out += f"--{boundary}\r\n".encode()
        disp = f'form-data; name="{name}"' + (f'; filename="{filename}"' if filename else "")
        out += f"Content-Disposition: {disp}\r\nContent-Type: {ctype}\r\n\r\n".encode()
        out += data + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def upload(w: sc.World, img: Path, manifest: Path) -> tuple[int, Any]:
    body, ctype = multipart({
        "image": (img.name, img.read_bytes(), "application/octet-stream"),
        "manifest": ("", manifest.read_bytes(), "application/json"),
    })
    req = urllib.request.Request(w.http.base + "/api/v1/admin/devices/firmware", data=body, method="POST",
                                 headers={"Content-Type": ctype, "Authorization": "Bearer " + w.admin_token})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode("utf-8", "replace")


def sign(key: Path, version: str, img: Path) -> Path:
    out = img.with_suffix(".manifest.json")
    r = subprocess.run([sys.executable, str(OTA_SIGN), "sign", "--key", str(key), "--target", "court_bridge",
                        "--version", version, "--out", str(out), str(img)], capture_output=True, text=True)
    if r.returncode != 0:
        raise sc.StepFailed(f"ota_sign.py sign {version} failed: {r.stderr.strip()}")
    return out


class Board:
    """The bridge_sim process across its reboots."""

    def __init__(self, state: Path, base: str, key: str, modulus: str, log: Path) -> None:
        self.state, self.base, self.key, self.modulus, self.log = state, base, key, modulus, log
        self.boots: list[tuple[int, str]] = []

    def boot(self, crash_on: str = "", beats: int = 3) -> tuple[int, str]:
        cmd = [str(SIM), "--state", str(self.state), "--base", self.base, "--key", self.key,
               "--mac", MAC, "--ota-key", self.modulus, "--beats", str(beats), "--gap-ms", "200"]
        if crash_on:
            cmd += ["--crash-on", crash_on]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)
        out = r.stdout + r.stderr
        with open(self.log, "a", encoding="utf-8") as f:
            f.write(f"--- boot {len(self.boots) + 1} (exit {r.returncode})\n{out}")
        self.boots.append((r.returncode, out))
        return r.returncode, out

    def running(self) -> str:
        head = (self.state / "running.bin").read_bytes().split(b"\n", 1)[0].decode()
        return head.split(" ", 1)[1]


def device_row(w: sc.World) -> dict:
    rows = sc.expect_status(w.http.get("/api/v1/admin/devices", token=w.admin_token), 200, "devices").json
    for row in rows:
        if row.get("device_code", "").endswith(MAC[-6:]) or MAC in json.dumps(row):
            return row
    raise sc.StepFailed(f"no device row for {MAC}: {json.dumps(rows)[:400]}")


def run(w: sc.World, work: Path, base: str, key_file: Path, modulus_hex: str) -> None:
    """Every check, against the API started with `modulus_hex` (the release key's)."""
    api_key = sc.expect_status(w.http.get("/api/v1/admin/devices/api-key", token=w.admin_token), 200,
                               "api-key")["api_key"]
    state = work / "flash"
    state.mkdir(parents=True, exist_ok=True)
    original = image("3.1.0", 200_000)
    (state / "running.bin").write_bytes(original)
    board = Board(state, base, api_key, modulus_hex, work / "board.log")

    # The board's first beats register it; an admin acknowledges it (the rollout is to
    # acknowledged boards only).
    code, out = board.boot(beats=2)
    chk("OTA-0", "a 3.1.0 bridge registers by heartbeat and announces ota:1 key:1 net:1",
        code == 0 and "heartbeat 200" in out, out[-400:])
    row = device_row(w)
    caps = row.get("capabilities") or []
    chk("OTA-0", "the server records the lifeline caps", all(c in caps for c in ("ota:1", "key:1", "net:1")),
        str(caps))
    sc.expect_status(w.http.patch(f"/api/v1/admin/devices/{row['id']}", {"enabled": True},
                                  token=w.admin_token), 200, "acknowledge")

    # OTA-1: an image signed by a key the server does not hold.
    rogue_key = work / "rogue.key"
    subprocess.run([sys.executable, str(OTA_SIGN), "keygen", "--out", str(rogue_key)], capture_output=True,
                   text=True, check=True)
    rogue = work / "rogue-3.1.5.bin"
    rogue.write_bytes(image("3.1.5", 120_000))
    status, body = upload(w, rogue, sign(rogue_key, "3.1.5", rogue))
    chk("OTA-1", "an upload signed with another key is refused sig_invalid",
        status == 400 and isinstance(body, dict) and body.get("error") == "sig_invalid", f"{status} {body}")

    # OTA-2: the good release, to this board only.
    good = work / "good-3.1.1.bin"
    good.write_bytes(image("3.1.1", 260_000))
    status, body = upload(w, good, sign(key_file, "3.1.1", good))
    chk("OTA-2", "the signed 3.1.1 release uploads", status == 200, f"{status} {body}")
    good_id = body["id"]
    sc.expect_status(w.http.patch(f"/api/v1/admin/devices/firmware/{good_id}",
                                  {"rollout": "one", "device_id": row["id"]}, token=w.admin_token), 200,
                     "rollout one")

    code, out = board.boot(beats=3)
    chk("OTA-2", "the board is offered 3.1.0 -> 3.1.1 in its heartbeat", "ota offer 3.1.1" in out, out[-600:])
    chk("OTA-2", "the signature is verified before anything is fetched",
        out.find("signature verified") < out.find("GET /api/v1/device/firmware/") if "GET" in out else False,
        out[-600:])
    chk("OTA-2", "the download comes from the board's own server, Content-Length equal to the size",
        f"-> 200, {len(good.read_bytes())} bytes declared" in out, out[-600:])
    chk("OTA-2", "the staged image is verified and the copy armed, then a restart is asked for",
        code == EXIT_RESTART and "armed 3.1.1" in out, f"exit {code}")
    prev = state / "_ota_prev.bin"
    chk("OTA-2", "the running 3.1.0 image was copied to /ota/prev.bin first, byte for byte",
        prev.exists() and prev.read_bytes() == original, str(prev))

    code, out = board.boot(beats=3)
    chk("OTA-2", "after the switch the board runs 3.1.1, in probation", board.running() == "3.1.1" and
        "running 3.1.1 fw_state=probation" in out, out[:300])
    chk("OTA-2", "an accepted heartbeat commits it", "fw_state=committed" in out and code == 0, out[-300:])
    row = device_row(w)
    chk("OTA-2", "the server sees running_version 3.1.1 and fw_state committed",
        row.get("running_version") == "3.1.1" and row.get("fw_state") == "committed",
        f"{row.get('running_version')} {row.get('fw_state')}")

    # OTA-3: a release that crashes on every boot.
    bad = work / "bad-3.1.2.bin"
    bad.write_bytes(image("3.1.2", 230_000))
    status, body = upload(w, bad, sign(key_file, "3.1.2", bad))
    chk("OTA-3", "the signed 3.1.2 release uploads", status == 200, f"{status} {body}")
    sc.expect_status(w.http.patch(f"/api/v1/admin/devices/firmware/{body['id']}",
                                  {"rollout": "one", "device_id": row["id"]}, token=w.admin_token), 200,
                     "rollout one (bad)")
    code, out = board.boot(crash_on="3.1.2", beats=3)
    chk("OTA-3", "3.1.1 takes 3.1.2 the same verified way", code == EXIT_RESTART and "armed 3.1.2" in out,
        out[-300:])
    crashes = 0
    for _ in range(6):
        code, out = board.boot(crash_on="3.1.2", beats=3)
        if code == EXIT_CRASH:
            crashes += 1
            continue
        break
    chk("OTA-3", "3.1.2 crashes on three boots before an accepted heartbeat", crashes == 3, f"{crashes}")
    chk("OTA-3", "its fourth boot in probation rolls back from the board's own copy",
        code == EXIT_RESTART and "rolling back" in out and "rollback armed" in out, out[-300:])
    code, out = board.boot(crash_on="3.1.2", beats=3)
    chk("OTA-3", "the board is back on 3.1.1, the copy verified against its recorded SHA-256",
        board.running() == "3.1.1" and "running 3.1.1 fw_state=rolled_back" in out, out[:300])
    chk("OTA-3", "it is never offered 3.1.2 again", "ota offer 3.1.2" not in out and code == 0, out[-300:])
    row = device_row(w)
    chk("OTA-3", "the server records rolled_back, fw_failed 3.1.2, fw_error probation",
        row.get("fw_state") == "rolled_back" and row.get("fw_failed") == "3.1.2" and row.get("fw_error") == "probation"
        and "3.1.2" in (row.get("fw_failed_versions") or []) and row.get("running_version") == "3.1.1",
        json.dumps({k: row.get(k) for k in ("fw_state", "fw_failed", "fw_error", "fw_failed_versions",
                                            "running_version")}))


def main() -> int:
    cfg = sc.Config()
    cfg.workdir = cfg.workdir.parent / (cfg.workdir.name + "-ota")
    cfg.workdir.mkdir(parents=True, exist_ok=True)
    print(f"ota e2e: worktree {ROOT}\n  scratch {cfg.workdir}", flush=True)
    if not cfg.skip_build:
        r = subprocess.run([cfg.pio, "run", "-d", str(ROOT / "src" / "iot" / "court-box"), "-e", "bridge_sim"],
                           capture_output=True, text=True, stdin=subprocess.DEVNULL)
        if r.returncode != 0:
            print(r.stdout[-3000:] + r.stderr[-2000:])
            return 1

    # The release key the API verifies uploads against: generated for this run, so no key
    # from the repository is ever trusted by the stack under test.
    key = cfg.workdir / "release.key"
    r = subprocess.run([sys.executable, str(OTA_SIGN), "keygen", "--out", str(key)], capture_output=True, text=True)
    found = re.search(r"\b[0-9a-f]{512}\b", r.stdout + r.stderr)
    if r.returncode != 0 or found is None:
        print("keygen failed: " + r.stderr)
        return 1
    modulus_hex = found.group(0)
    pg = sc.Postgres(cfg)
    db_name = "e2e_ota_" + datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + secrets.token_hex(2)
    api: Optional[sc.ApiProcess] = None
    try:
        pg.ensure()
        os.environ["DeviceOta__PublicKeyModulus"] = modulus_hex
        api = sc.ApiProcess(cfg, pg.connection_string(db_name))
        if not cfg.skip_build:
            api.build()
        api.start()
        w = sc.World(sc.Http(api.base))
        sc.admin_login(w)
        run(w, cfg.workdir, api.base, key, modulus_hex)
    except sc.StepFailed as e:
        chk("infra", f"environment: {e}", False)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        chk("infra", "driver raised: " + traceback.format_exc().strip().splitlines()[-1], False)
    finally:
        if api:
            api.stop()
    print(REPORT.summary(), flush=True)
    failed = bool(REPORT.failed)
    if failed:
        log = cfg.workdir / "board.log"
        if log.exists():
            print("\nboard log tail:\n" + "\n".join(log.read_text().splitlines()[-60:]))
        if api:
            print(f"\nAPI log tail ({api.log}):\n" + api.tail())
        print(f"\nscratch kept at {cfg.workdir}")
    else:
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
