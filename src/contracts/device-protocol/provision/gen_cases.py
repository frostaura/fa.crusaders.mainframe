#!/usr/bin/env python3
"""Generates this directory's cases.json and manifest.json: what a board accepts when
the server, or the setup portal, changes how it reaches the club.

Run it as `python3 src/contracts/device-protocol/provision/gen_cases.py`. Standard
library only; this file is the reference implementation of four rules both ESP
images share (through `src/iot/shared/lib/devnet`) and the server enforces when an
admin saves the same values:

  * base_urls  — the grammar of a server base URL a board will dial;
  * nets       — when a heartbeat's `net` object is adopted, and what it becomes;
  * keys       — when a heartbeat's `key_next` object is adopted;
  * supervisor — what the WiFi link supervisor does after the link has been down.

Contract: docs/specs/device-api.md sections 5, 6 and 8.
"""
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent

BASE_URL_MAX = 96
HOST_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
BASE_RE = re.compile(r"^http://(?P<host>[^:/?#@\s]+)(?::(?P<port>[0-9]{1,5}))?$")
IPV4_RE = re.compile(r"^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$")
NAME_RE = re.compile(rf"^{HOST_LABEL}(?:\.{HOST_LABEL})*$")
KEY_ID_RE = re.compile(r"^k[1-9][0-9]{0,5}$")
KEY_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")

# The link supervisor's constants. They are recovery mechanics, not club
# preferences, so they are contract constants and not tenant settings: a club
# cannot usefully choose how fast a board retries an access point.
SUP_GRACE_S = 30          # leave the core's own reconnect alone this long
SUP_BACKOFF_S = [30, 60, 120, 240, 300]  # between supervised attempts, capped at the last
SUP_RESTART_S = 900       # down this long in total: restart the chip


def base_url(url: str):
    """(accept, reason). http only — the boards have no heap for TLS; no path, no
    query, no userinfo, no trailing slash; an IPv4 literal or a lowercase DNS name;
    port 1-65535 (absent means 80)."""
    if not isinstance(url, str) or len(url) == 0:
        return False, "empty"
    if len(url) > BASE_URL_MAX:
        return False, "too_long"
    if url.startswith("https://"):
        return False, "https"
    m = BASE_RE.match(url)
    if not m:
        return False, "grammar"
    host, port = m.group("host"), m.group("port")
    if not (IPV4_RE.match(host) or (NAME_RE.match(host) and not host.replace(".", "").isdigit())):
        return False, "host"
    if port is not None and (port.startswith("0") or not 1 <= int(port) <= 65535):
        return False, "port"
    return True, "ok"


def printable(s: str) -> bool:
    return all(0x20 <= ord(c) <= 0x7E for c in s)


def adopt_net(net: dict, applied_ver: int):
    """(adopt, reason, result). `ver` must be newer than what the board has applied;
    every present field must be valid or NOTHING is adopted — a half-applied network
    change is a board on the wrong network with the wrong server."""
    ver = net.get("ver")
    if not isinstance(ver, int) or isinstance(ver, bool) or not 1 <= ver <= 2147483647:
        return False, "ver", None
    if ver <= applied_ver:
        return False, "not_newer", None
    result = {"ver": ver, "base": None, "wifi": []}
    if "base" in net:
        ok, why = base_url(net["base"])
        if not ok:
            return False, "base_" + why, None
        result["base"] = net["base"]
    for slot in (0, 1):
        ssid = net.get(f"wifi{slot}_ssid")
        psk = net.get(f"wifi{slot}_psk")
        if ssid is None and psk is None:
            continue
        if not isinstance(ssid, str) or not 1 <= len(ssid.encode("utf-8")) <= 32 or any(ord(c) < 0x20 or ord(c) == 0x7F for c in ssid):
            return False, f"wifi{slot}_ssid", None
        if psk is None:
            psk = ""
        if not isinstance(psk, str) or not printable(psk) or not (len(psk) == 0 or 8 <= len(psk) <= 63):
            return False, f"wifi{slot}_psk", None
        result["wifi"].append([ssid, psk])
    if result["base"] is None and not result["wifi"]:
        return False, "empty", None
    return True, "ok", result


def adopt_key(key_next: dict, current_id: str, held_ids: list):
    if not isinstance(key_next.get("id"), str) or not KEY_ID_RE.match(key_next["id"]):
        return False, "id"
    if not isinstance(key_next.get("key"), str) or not KEY_RE.match(key_next["key"]):
        return False, "key"
    if key_next["id"] == current_id:
        return False, "current"
    if key_next["id"] in held_ids:
        return False, "held"
    return True, "ok"


def supervise(down_s: int, since_attempt_s: int, attempts: int):
    """The action for one supervisor tick. `attempts` counts supervised reconnects in
    this outage; `since_attempt_s` is time since the last one (or since the outage
    began, before the first)."""
    if down_s >= SUP_RESTART_S:
        return "restart"
    if down_s < SUP_GRACE_S:
        return "none"
    wait = SUP_BACKOFF_S[min(attempts - 1, len(SUP_BACKOFF_S) - 1)] if attempts else 0
    if attempts and since_attempt_s < wait:
        return "none"
    return "reconnect_next_profile"


def main() -> int:
    cases = {
        "description": ("How a board reaches the club, and what it accepts when that changes: base URL grammar, the "
                        "heartbeat's `net` and `key_next` objects, and the WiFi link supervisor. Generated by "
                        "gen_cases.py beside this file. Contract: docs/specs/device-api.md sections 5, 6 and 8."),
        "constants": {"base_url_max": BASE_URL_MAX, "supervisor_grace_seconds": SUP_GRACE_S,
                      "supervisor_backoff_seconds": SUP_BACKOFF_S, "supervisor_restart_seconds": SUP_RESTART_S},
        "base_urls": [], "nets": [], "keys": [], "supervisor": [],
    }

    def bu(cid, url, accept, reason, note=""):
        assert base_url(url) == (accept, reason), (cid, base_url(url))
        cases["base_urls"].append({"id": cid, "note": note, "url": url, "accept": accept, "reason": reason})

    bu("base-ipv4-port", "http://192.168.1.20:8088", True, "ok", "today's compiled shape")
    bu("base-ipv4-default-port", "http://10.0.0.5", True, "ok")
    bu("base-hostname", "http://crusaders-server.lan:8088", True, "ok",
       "a name the club router resolves survives the server's DHCP lease changing")
    bu("base-single-label", "http://mainframe:8088", True, "ok")
    bu("base-https", "https://crusaders.frostaura.net", False, "https",
       "no TLS: the boards have no heap for it, and an https base is a URL they can never open")
    bu("base-trailing-slash", "http://192.168.1.20:8088/", False, "grammar", "the board appends /api/v1/...; one spelling only")
    bu("base-path", "http://192.168.1.20:8088/club", False, "grammar")
    bu("base-userinfo", "http://admin:pw@192.168.1.20", False, "grammar")
    bu("base-uppercase-scheme", "HTTP://192.168.1.20", False, "grammar")
    bu("base-uppercase-host", "http://Mainframe.LAN", False, "host", "lowercase only, so two spellings are never two configurations")
    bu("base-underscore", "http://main_frame:8088", False, "host")
    bu("base-bad-octet", "http://192.168.1.256:8088", False, "host")
    bu("base-port-zero", "http://192.168.1.20:0", False, "port")
    bu("base-port-high", "http://192.168.1.20:65536", False, "port")
    bu("base-port-leading-zero", "http://192.168.1.20:08088", False, "port")
    bu("base-ipv6", "http://[fe80::1]:8088", False, "grammar")
    bu("base-empty", "", False, "empty")
    bu("base-too-long", "http://" + "a" * 90 + ".lan", False, "too_long")

    def nc(cid, net, applied, adopt, reason, result=None, note=""):
        got = adopt_net(net, applied)
        assert got == (adopt, reason, result), (cid, got)
        cases["nets"].append({"id": cid, "note": note, "net": net, "applied_ver": applied,
                              "adopt": adopt, "reason": reason, "result": result})

    full = {"ver": 4, "base": "http://192.168.1.20:8088", "wifi0_ssid": "CRUSADERS", "wifi0_psk": "squash-court-4",
            "wifi1_ssid": "CRUSADERS-NEW", "wifi1_psk": "new-router-pass"}
    nc("net-full", full, 3, True, "ok", {"ver": 4, "base": full["base"],
       "wifi": [["CRUSADERS", "squash-court-4"], ["CRUSADERS-NEW", "new-router-pass"]]},
       "a new router added as the second profile BEFORE the old one is switched off: the migration that needs no visit")
    nc("net-base-only", {"ver": 5, "base": "http://mainframe.lan:8088"}, 4, True, "ok",
       {"ver": 5, "base": "http://mainframe.lan:8088", "wifi": []}, "profiles not named are kept as they are")
    nc("net-wifi-only", {"ver": 2, "wifi0_ssid": "CRUSADERS", "wifi0_psk": "squash-court-4"}, 0, True, "ok",
       {"ver": 2, "base": None, "wifi": [["CRUSADERS", "squash-court-4"]]})
    nc("net-open-network", {"ver": 2, "wifi0_ssid": "CLUB-GUEST", "wifi0_psk": ""}, 1, True, "ok",
       {"ver": 2, "base": None, "wifi": [["CLUB-GUEST", ""]]}, "an empty psk is an open network")
    nc("net-not-newer", full, 4, False, "not_newer", note="already applied: nothing is rewritten, no flash wear")
    nc("net-older", full, 9, False, "not_newer")
    nc("net-bad-base-adopts-nothing", dict(full, ver=5, base="https://x.example"), 4, False, "base_https",
       note="one bad field and NOTHING is adopted, not even the valid profiles")
    nc("net-short-psk", dict(full, ver=5, wifi1_psk="short"), 4, False, "wifi1_psk", note="WPA2 needs 8 to 63 characters")
    nc("net-long-ssid", {"ver": 5, "wifi0_ssid": "S" * 33, "wifi0_psk": "squash-court-4"}, 4, False, "wifi0_ssid")
    nc("net-psk-without-ssid", {"ver": 5, "wifi0_psk": "squash-court-4"}, 4, False, "wifi0_ssid")
    nc("net-empty", {"ver": 5}, 4, False, "empty")
    nc("net-ver-zero", dict(full, ver=0), 0, False, "ver", note="0 is the board's own (compiled or portal) configuration")
    nc("net-ver-string", dict(full, ver="5"), 4, False, "ver")

    def kc(cid, key_next, current, held, adopt, reason, note=""):
        assert adopt_key(key_next, current, held) == (adopt, reason), cid
        cases["keys"].append({"id": cid, "note": note, "key_next": key_next, "current_id": current,
                              "held_ids": held, "adopt": adopt, "reason": reason})

    good = "Zq7Hn2Vb5Rt8Wy1Lp4Mk6Xc9Ds3Fg0Jh_a-QeUoIiEr"
    assert len(good) == 43
    kc("key-adopt", {"id": "k2", "key": good}, "k1", ["k1"], True, "ok")
    kc("key-adopt-from-compiled", {"id": "k1", "key": good}, "k0", [], True, "ok",
       "k0 is the compiled key: the first rotation a box ever sees")
    kc("key-current", {"id": "k2", "key": good}, "k2", ["k1", "k2"], False, "current", "already in use: nothing to do")
    kc("key-held", {"id": "k1", "key": good}, "k2", ["k1", "k2"], False, "held", "the previous key is never re-adopted as next")
    kc("key-short", {"id": "k3", "key": good[:-1]}, "k2", ["k2"], False, "key")
    kc("key-padded", {"id": "k3", "key": good[:-1] + "="}, "k2", ["k2"], False, "key")
    kc("key-id-zero", {"id": "k0", "key": good}, "k1", ["k1"], False, "id", "k0 names the compiled key and is never sent")
    kc("key-id-grammar", {"id": "K3", "key": good}, "k2", ["k2"], False, "id")

    def sc(cid, down, since, attempts, action, note=""):
        assert supervise(down, since, attempts) == action, (cid, supervise(down, since, attempts))
        cases["supervisor"].append({"id": cid, "note": note, "down_seconds": down, "since_attempt_seconds": since,
                                    "attempts": attempts, "action": action})

    sc("sup-blip", 10, 10, 0, "none", "the core reconnects on its own after most drops")
    sc("sup-grace-ends", 30, 30, 0, "reconnect_next_profile",
       "some disconnect reasons (AUTH_FAIL while an AP boots) make the core stop trying for good")
    sc("sup-backoff-wait", 50, 20, 1, "none")
    sc("sup-backoff-due", 61, 30, 1, "reconnect_next_profile")
    sc("sup-backoff-capped", 800, 299, 9, "none")
    sc("sup-backoff-capped-due", 850, 300, 9, "reconnect_next_profile")
    sc("sup-restart", 900, 10, 7, "restart",
       "fifteen minutes down: restart the chip. Safe on both boards — the Mega holds its relays, and the gate writes LOCKED before it drives")

    (HERE / "cases.json").write_text(json.dumps(cases, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    manifest = {
        "description": "Base URL grammar, network and key adoption from the heartbeat, and the WiFi link supervisor.",
        "authority": "docs/specs/device-api.md sections 5, 6 and 8; gen_cases.py beside this file is the reference implementation.",
        "generator": "src/contracts/device-protocol/provision/gen_cases.py",
        "read_by": ["fw-shared", "csharp"],
        "case_count": {k: len(v) for k, v in cases.items() if isinstance(v, list)},
    }
    (HERE / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
