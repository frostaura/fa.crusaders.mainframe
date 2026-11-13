#!/usr/bin/env python3
"""Generates this directory's cases.json and manifest.json: what the frozen firmware does with a
server it has never met.

Run it as `python3 src/contracts/device-protocol/compat/gen_cases.py`. Standard library only.

The Mega 3.0.0 image is the last one that chip will ever get, and each ESP image is only as
updatable as its own heartbeat parser, its key ring and its OTA path keep working against every
server that comes after it (docs/specs/device-api.md section 11, "the lifeline"). This file is the
reference implementation of the tolerance rules both ESP images apply to a server body, and of
the budgets both sides hold a body to:

  * budgets          — per device, firmware and endpoint: the buffer the firmware reads into, and
                       the most the server may ever send (or must accept). Read by C# and C++.
  * court_box        — heartbeat bodies a court box (bridge 3.0.0, `hb:3`) receives after it has
                       adopted `base`, and what it must have adopted afterwards.
  * door_gate        — the same for a door gate 2.0.0.
  * scan             — /activate, /walkup, /extend, /events and /gate replies with their HTTP
                       status, and how the board classifies each (decided / undecided).

A consumer is checked against this file's output, never against itself. Every rule below is a
sentence in docs/specs/device-api.md section 11; change both or neither.
"""
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

# ---------------------------------------------------------------------------------------------
# Budgets. firmware_buffer is the static buffer the body is read into: a body is readable only
# when it is strictly shorter (the reader keeps a terminator). server_max is the most the server
# may ever serialise for that endpoint and generation, and every server_max is at most 80% of its
# buffer (the 2.x/1.x rows are history and keep their measured figures). For a request,
# firmware_buffer is what the board renders into and server_min_accept is the least the server
# must accept.
# ---------------------------------------------------------------------------------------------
BUDGETS = [
    # court box, bridge 3.0.0
    ("court_box", "bridge-3.0.0", "heartbeat", "response", 5120, 4096,
     "hb:3 body; widest http/ vector v3-heartbeat-response-widest"),
    ("court_box", "bridge-3.0.0", "activate", "response", 512, 300,
     "widest realistic reply ~240 B (court, booking_id, granted, play_remaining, member_display 16, greeting 16, balance)"),
    ("court_box", "bridge-3.0.0", "walkup", "response", 512, 300, "same buffer as activate"),
    ("court_box", "bridge-3.0.0", "extend", "response", 512, 300, "same buffer as activate"),
    ("court_box", "bridge-3.0.0", "events", "response", 192, 96,
     "the reply is {accepted_through, recorded} forever; new information goes in the heartbeat"),
    ("court_box", "bridge-3.0.0", "heartbeat", "request", 1536, 4096,
     "with telemetry; widest http/ vector v3-heartbeat-request-widest"),
    ("court_box", "bridge-3.0.0", "events", "request", 512, 4096, "one drain post"),
    # court box, bridge 2.3.0 (the flash window only)
    ("court_box", "bridge-2.3.0", "heartbeat", "response", 2560, 2048, "the 2.x contract; FC-3 is recorded, not reopened"),
    ("court_box", "bridge-2.3.0", "activate", "response", 384, 300, "FC-6"),
    ("court_box", "bridge-2.3.0", "walkup", "response", 384, 300, "FC-6"),
    ("court_box", "bridge-2.3.0", "extend", "response", 384, 300, "FC-6"),
    ("court_box", "bridge-2.3.0", "events", "response", 192, 96, "FC-5"),
    # door gate 2.0.0
    ("door_gate", "gate-2.0.0", "heartbeat", "response", 8192, 6144,
     "v3 gate body; widest is membercode/gate.json codes-full plus every v3 object at its bound"),
    ("door_gate", "gate-2.0.0", "gate", "response", 256, 110, "the scan decision"),
    ("door_gate", "gate-2.0.0", "events", "response", 192, 96, "same reply as the court box"),
    ("door_gate", "gate-2.0.0", "heartbeat", "request", 1536, 4096, "with telemetry; gate/ gate-heartbeat-request-v3-telemetry"),
    # door gate 1.x (the flash window only)
    ("door_gate", "gate-1.1.2", "heartbeat", "response", 4608, 4096, "the 1.x contract"),
    ("door_gate", "gate-1.1.2", "gate", "response", 128, 110, "FC-6: over 127 B reads as status 0 and teaches the breaker"),
    ("door_gate", "gate-1.1.2", "events", "response", 192, 96, "FC-5"),
]

# The deepest nesting a server body may use (body -> object -> array -> nothing deeper), and the
# firmware scanner's own refusal depth.
SERVER_MAX_DEPTH = 3
FIRMWARE_MAX_DEPTH = 32

# ---------------------------------------------------------------------------------------------
# JSON reading as the firmware reads it: a UTF-8 BOM and leading whitespace are skipped; the body
# must be ONE complete object; duplicate keys resolve first-wins; nesting past 32 is refused.
# ---------------------------------------------------------------------------------------------


def first_wins(pairs):
    out = {}
    for k, v in pairs:
        if k not in out:
            out[k] = v
    return out


def depth(v, d=1):
    if isinstance(v, dict):
        return max([d] + [depth(x, d + 1) for x in v.values()])
    if isinstance(v, list):
        return max([d] + [depth(x, d + 1) for x in v])
    return d - 1


def read_object(raw: bytes, buffer: int):
    """The object the firmware would read, or None."""
    if len(raw) >= buffer:
        return None                      # an over-cap payload arrives empty, never half
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    text = raw.decode("utf-8", errors="strict").lstrip(" \t\r\n")
    try:
        obj, end = json.JSONDecoder(object_pairs_hook=first_wins).raw_decode(text)
    except ValueError:
        return None
    if not isinstance(obj, dict) or text[end:].strip(" \t\r\n"):
        return None
    if depth(obj) > FIRMWARE_MAX_DEPTH:
        return None
    return obj


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def is_uint(v):
    return is_int(v) and v >= 0


def fields(s, n):
    """The first n '|'-separated fields of an element; any further fields are ignored (the
    element grammars only ever grow at the end). None when fewer than n."""
    if not isinstance(s, str):
        return None
    parts = s.split("|")
    return parts[:n] if len(parts) >= n else None


def as_int(s, lo=None, hi=None):
    if not isinstance(s, str) or not re.fullmatch(r"-?[0-9]{1,10}", s):
        return None
    v = int(s)
    if lo is not None and v < lo:
        return None
    if hi is not None and v > hi:
        return None
    return v


def read_array(value, element, cap):
    """(adopted list | None for 'kept', drift?). Element-wise: an unreadable element is skipped;
    a present, non-empty array of which NOTHING was readable keeps the previous value (a grammar
    the board does not know must never be committed as 'nothing'); [] commits empty."""
    if not isinstance(value, list):
        return None, True
    out, bad = [], 0
    for e in value:
        r = element(e)
        if r is None:
            bad += 1
        elif len(out) < cap:
            out.append(r)
    if value and not out:
        return None, True
    return out, bad > 0


# --- element grammars (canonical forms are the first N fields, rejoined) ---------------------
def roster_el(e):
    f = fields(e, 4)
    if f is None or not re.fullmatch(r"[0-9A-Za-z]{1,20}", f[0]):
        return None
    relay, opens, closes = as_int(f[1], 0, 3), as_int(f[2]), as_int(f[3])
    if relay is None or opens is None or closes is None or closes <= opens:
        return None
    return f"{f[0]}|{relay}|{opens}|{closes}"


def gate_roster_el(e):
    r = roster_el(e)
    return r if r is not None and r.split("|")[1] == "0" else None


def courts_el(e):
    f = fields(e, 5)
    if f is None:
        return None
    relay, lit, secs = as_int(f[0], 0, 3), as_int(f[1], 0, 1), as_int(f[2], 0, 86400)
    if relay is None or lit is None or secs is None:
        return None
    kind = f[3] if f[3] in ("b", "w", "e", "-") else ("b" if lit else "-")   # display-only
    ref = f[4] if re.fullmatch(r"[0-9a-f]{8}|-", f[4]) else "-"
    return f"{relay}|{lit}|{secs}|{kind}|{ref}"


def relays_el(e):
    f = fields(e, 3)
    if f is None:
        return None
    relay, secs = as_int(f[0], 0, 3), as_int(f[1], 1, 5400)
    if relay is None or secs is None or not re.fullmatch(r"[0-9a-f]{8}", f[2]):
        return None
    return f"{relay}|{secs}|{f[2]}"


def ref_ok(r):
    return len(r) == 4 and all(c in REF_ALPHABET for c in r) and r != "0000"


def key_el(e):
    """REF(4) + slot + 16 base64url = 21 characters; a later grammar may append '|...' fields."""
    if not isinstance(e, str) or len(e) < 21 or (len(e) > 21 and e[21] != "|"):
        return None
    k = e[:21]
    if not ref_ok(k[:4]) or k[4] not in "01" or not re.fullmatch(r"[A-Za-z0-9_-]{16}", k[5:]):
        return None
    return k


def day_el(e):
    f = fields(e, 2)
    if f is None:
        return None
    a, b = as_int(f[0], 0), as_int(f[1], 0)
    if a is None or b is None or not 1 <= b - a <= 3120:
        return None
    return f"{a}|{b}"


BUTTON_RE = re.compile(r"(?i)^(|none|off|court:[a-d]|minutes:([1-9]|[1-8][0-9]|90))$")


def button_map(value):
    if (not isinstance(value, list) or len(value) != 8
            or not all(isinstance(t, str) and BUTTON_RE.match(t) for t in value)):
        return None
    return value


# --- lifeline objects: adopted from any complete body, whatever else in it drifted -----------
OTA_PATH = re.compile(r"^/api/v1/device/firmware/[A-Za-z0-9_-]{1,64}$")


def ota_offer(o):
    if not isinstance(o, dict):
        return None
    ok = (isinstance(o.get("target"), str) and isinstance(o.get("version"), str)
          and re.fullmatch(r"[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}", o.get("version", ""))
          and is_uint(o.get("size")) and isinstance(o.get("sha256"), str)
          and re.fullmatch(r"[0-9a-f]{64}", o["sha256"]) and isinstance(o.get("sig"), str)
          and re.fullmatch(r"[A-Za-z0-9_-]{342}", o["sig"]) and isinstance(o.get("path"), str)
          and OTA_PATH.match(o["path"]))
    return o["version"] if ok else None


def key_next(o):
    if (isinstance(o, dict) and isinstance(o.get("id"), str) and re.fullmatch(r"k[1-9][0-9]{0,5}", o["id"])
            and isinstance(o.get("key"), str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", o["key"])):
        return o["id"]
    return None


def net_ver(o):
    if not isinstance(o, dict) or not is_int(o.get("ver")) or not 1 <= o["ver"] <= 2147483647:
        return None
    base = o.get("base")
    if not isinstance(base, str) or not re.fullmatch(r"http://[a-z0-9.-]{1,80}(:[1-9][0-9]{0,4})?", base):
        return None
    if not isinstance(o.get("wifi0_ssid"), str) or not 1 <= len(o["wifi0_ssid"]) <= 32:
        return None
    return o["ver"]


# --- settings ---------------------------------------------------------------------------------
def clamp(lo, hi):
    return lambda v, prev: (min(max(v, lo), hi), False) if is_uint(v) else (prev, True)


def enum(values, unknown_is=None):
    def f(v, prev):
        if v in values and type(v) is type(values[0]):
            return v, False
        return (unknown_is if unknown_is is not None else prev), True
    return f


def boolean(v, prev):
    return (v, False) if isinstance(v, bool) else (prev, True)


COURT_BOX_SETTINGS = {
    "relay_restore_enabled": boolean,
    "lcd_layout": enum(["compact", "expanded"], unknown_is="compact"),
    "lcd_marquee_step_ms": clamp(250, 1000),
    "lcd_screen_ceiling_seconds": clamp(15, 120),
    "relay_reconcile_min_seconds": clamp(30, 600),
    "hw_relay_active_level": enum(["high", "low"]),
    "hw_lcd_i2c_address": enum([0] + list(range(32, 40)) + list(range(56, 64))),
    "hw_scanner_baud": enum([0, 9600, 19200, 38400, 57600, 115200]),
    "hw_scanner_line_end": enum(["auto", "crlf"]),
    "hw_scanner_gap_ms": clamp(50, 500),
}
COURT_BOX_DEFAULTS = {
    "relay_restore_enabled": True, "lcd_layout": "compact", "lcd_marquee_step_ms": 400,
    "lcd_screen_ceiling_seconds": 60, "relay_reconcile_min_seconds": 60,
    "hw_relay_active_level": "high", "hw_lcd_i2c_address": 0, "hw_scanner_baud": 0,
    "hw_scanner_line_end": "auto", "hw_scanner_gap_ms": 150,
}
GATE_SETTINGS = {
    "unlock_seconds": clamp(1, 30),
    "power_restore_trust_minutes": clamp(0, 120),
    "net_fallback_minutes": clamp(3, 60),
    "ota_probation_minutes": clamp(3, 60),
    "device_fault_reporting": boolean,
    "device_fault_max_per_hour": clamp(1, 120),
}
GATE_DEFAULTS = {"unlock_seconds": 15, "power_restore_trust_minutes": 20, "net_fallback_minutes": 10,
                 "ota_probation_minutes": 10, "device_fault_reporting": True, "device_fault_max_per_hour": 60}


def read_settings(obj, table, prev, drift, name):
    """Scalars at the top level of ONE object (`config` / `gate`); a nested object or array is
    never searched, so a key inside it can never be mistaken for the setting (FC-7, FC-12)."""
    out = dict(prev)
    if not isinstance(obj, dict):
        return out
    for key, rule in table.items():
        if key in obj:
            out[key], bad = rule(obj[key], prev[key])
            if bad:
                drift.add(f"{name}.{key}")
    return out


# --- the two adopters -----------------------------------------------------------------------
def http_class(status):
    if 200 <= status <= 299:
        return "2xx"
    if status == 401:
        return "auth"
    return "failed"


def adopt_court_box(prev, raw, status=200):
    st = json.loads(json.dumps(prev))
    out = {"accepted": False, "auth_retry": http_class(status) == "auth", "drift": []}
    if http_class(status) != "2xx":
        return st, out
    body = read_object(raw, 5120)
    if body is None:
        return st, out
    out["accepted"] = True
    drift = set()
    if "court_numbers" in body:
        cn = body["court_numbers"]
        if isinstance(cn, list) and 1 <= len(cn) <= 4 and all(is_int(c) and 1 <= c <= 65535 for c in cn):
            st["court_numbers"] = cn
        else:
            drift.add("court_numbers")
    if "config" in body:
        cfg = body["config"]
        if isinstance(cfg, dict):
            st["config"] = read_settings(cfg, COURT_BOX_SETTINGS, st["config"], drift, "config")
            if "button_map" in cfg:
                bm = button_map(cfg["button_map"])
                if bm is None:
                    drift.add("config.button_map")
                else:
                    st["button_map"] = bm
        else:
            drift.add("config")
    for key, element, cap in (("courts", courts_el, 4), ("roster", roster_el, 16),
                              ("code_days", day_el, 2), ("code_keys", key_el, 64), ("relays", relays_el, 4)):
        if key in body:
            got, bad = read_array(body[key], element, cap)
            if key == "courts" and got == []:
                got = None               # an empty snapshot changes nothing (ON-only)
            if got is not None:
                st[key] = got
            if bad:
                drift.add(key)
    if "code_keys" in body and isinstance(body.get("code_keys"), list):
        filled = len(st.get("code_days", []))
        st["code_keys"] = [k for k in st["code_keys"] if int(k[4]) < filled]
    for key, reader, name in (("ota", ota_offer, "ota_version"), ("key_next", key_next, "key_next_id"),
                              ("net", net_ver, "net_ver")):
        st[name] = reader(body[key]) if key in body else None
    out["drift"] = sorted(drift)
    return st, out


def adopt_gate(prev, raw, status=200):
    st = json.loads(json.dumps(prev))
    out = {"accepted": False, "auth_retry": http_class(status) == "auth", "drift": [], "kind_mismatch": False}
    if http_class(status) != "2xx":
        return st, out
    body = read_object(raw, 8192)
    if body is None:
        return st, out
    out["accepted"] = True
    drift = set()
    if body.get("kind") != "gate":
        out["kind_mismatch"] = True     # no roster, no keys, no settings from a non-gate answer
    else:
        if "gate" in body:
            if isinstance(body["gate"], dict):
                st["gate"] = read_settings(body["gate"], GATE_SETTINGS, st["gate"], drift, "gate")
            else:
                drift.add("gate")
        for key, element, cap in (("roster", gate_roster_el, 48), ("code_days", day_el, 2),
                                  ("code_keys", key_el, 72)):
            if key in body:
                got, bad = read_array(body[key], element, cap)
                if got is not None:
                    st[key] = got
                if bad:
                    drift.add(key)
    for key, reader, name in (("ota", ota_offer, "ota_version"), ("key_next", key_next, "key_next_id"),
                              ("net", net_ver, "net_ver")):
        st[name] = reader(body[key]) if key in body else None
    out["drift"] = sorted(drift)
    return st, out


# ---------------------------------------------------------------------------------------------
# Bodies.
# ---------------------------------------------------------------------------------------------
def dump(o):
    return json.dumps(o, separators=(",", ":"), ensure_ascii=True).encode()


_ota = json.loads((ROOT / "ota" / "cases.json").read_text())
BRIDGE_OFFER = next(i["offer"] for i in _ota["images"] if i["id"] == "image-bridge")
GATE_OFFER = next(i["offer"] for i in _ota["images"] if i["id"] == "image-gate")
KEY_NEXT = {"id": "k2", "key": "Zq7Hn2Vb5Rt8Wy1Lp4Mk6Xc9Ds3Fg0Jh_a-QeUoIiEr"}
NET = {"ver": 4, "base": "http://192.168.1.20:8088", "wifi0_ssid": "CRUSADERS", "wifi0_psk": "squash-court-4",
       "wifi1_ssid": "CRUSADERS-NEW", "wifi1_psk": "new-router-pass"}
BUTTONS = ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "minutes:60"]

CONFIG = {
    "slice_minutes": 15, "grace_window_minutes": 5, "walk_up_max_minutes": 60, "lcd_revert_seconds": 10,
    "lcd_choice_seconds": 20, "lcd_card_seconds": 2, "lcd_hint_seconds": 3, "scan_memory_seconds": 30,
    "clock_trust_minutes": 90, "relay_restore_enabled": True, "device_fault_reporting": True,
    "device_fault_max_per_hour": 60, "lcd_layout": "compact", "lcd_marquee_enabled": True,
    "lcd_marquee_step_ms": 400, "lcd_landing_page_seconds": 4, "lcd_screen_ceiling_seconds": 60,
    "lcd_landing_dwell_seconds": 3, "lcd_after_lights_on_seconds": 15, "lcd_reinit_seconds": 60,
    "relay_authorisation_cap_minutes": 240, "relay_reconcile_min_seconds": 60,
    "device_power_restore_trust_minutes": 20, "device_net_fallback_minutes": 10,
    "device_ota_probation_minutes": 10, "hw_relay_active_level": "high", "hw_lcd_i2c_address": 0,
    "hw_scanner_baud": 0, "hw_scanner_line_end": "auto", "hw_scanner_gap_ms": 150, "button_map": BUTTONS,
}


def court_box_base():
    """expanded, so that the unknown-layout case visibly falls back to compact."""
    config = json.loads(json.dumps(CONFIG))
    config["lcd_layout"] = "expanded"
    return {
        "server_time": "2026-11-13T18:00:00", "tenant_slug": "crusaders", "device_code": "box-5ccf7f0a1b2c",
        "court_numbers": [1, 2, 3, 4], "heartbeat_seconds": 60, "config": config,
        "courts": ["0|1|2700|b|3fa85f64", "1|0|0|-|-", "2|1|7140|e|9c1d0e22", "3|0|0|-|-"],
        "roster": ["m18Y9BWDJ|1|-300|2400", "m18Y9|3|600|4200"],
        "code_step": 59672640, "code_step_ms": 17000, "code_days": ["59670480|59673360"],
        "code_keys": ["18Y90HkE5WHvWQ0Oe9Rdl", "BWDJ0IksrpX8Aq55NF6dh"],
    }


def gate_base():
    return {
        "server_time": "2026-11-13T18:00:00", "tenant_slug": "crusaders", "device_code": "gate-0a1b2c",
        "kind": "gate", "gate_key": "front-door", "heartbeat_seconds": 60, "gate": dict(GATE_DEFAULTS),
        "roster": ["m18Y9BWDJ|0|-300|2400", "7Q3F9KM2XZ8B|0|1800|5400"],
        "code_step": 59672640, "code_step_ms": 17000, "code_days": ["59670480|59673360"],
        "code_keys": ["18Y90HkE5WHvWQ0Oe9Rdl", "BWDJ0IksrpX8Aq55NF6dh"],
    }


def court_box_fresh():
    return {"court_numbers": [], "config": dict(COURT_BOX_DEFAULTS), "button_map": BUTTONS[:],
            "courts": [], "roster": [], "code_days": [], "code_keys": [], "relays": [],
            "ota_version": None, "key_next_id": None, "net_ver": None}


def gate_fresh():
    return {"gate": dict(GATE_DEFAULTS), "roster": [], "code_days": [], "code_keys": [],
            "ota_version": None, "key_next_id": None, "net_ver": None}


def with_key(obj, key, value, before=None, inside=None):
    """A copy of obj with key inserted before `before` (or appended) in obj or obj[inside]."""
    o = json.loads(json.dumps(obj))
    target = o if inside is None else o[inside]
    items = [(k, v) for k, v in target.items() if k != key]
    idx = len(items) if before is None else [k for k, _ in items].index(before)
    items.insert(idx, (key, value))
    new = dict(items)
    if inside is None:
        return new
    o[inside] = new
    return o


def replaced(obj, path, value):
    o = json.loads(json.dumps(obj))
    t = o
    for p in path[:-1]:
        t = t[p]
    t[path[-1]] = value
    return o


def padded(obj, total):
    """obj with an unknown top-level string sized so the whole body is exactly `total` bytes."""
    o = with_key(obj, "zz_pad", "")
    o["zz_pad"] = "x" * (total - len(dump(o)))
    assert len(dump(o)) == total
    return o


def nested(levels):
    v = 1
    for _ in range(levels):
        v = {"n": v}
    return v


CB = court_box_base()
GB = gate_base()

# (id, note, raw-or-object, status)
court_box_bodies = [
    ("cb-base", "the base body itself: everything adopted, nothing drifted", CB, 200),
    ("cb-unknown-top-level-scalar-first", "an unknown key before everything is ignored",
     with_key(CB, "schema", 4, before="server_time"), 200),
    ("cb-unknown-top-level-object-carrying-known-names",
     "FC-7: a future object BEFORE config that carries button_map, roster and courts of its own; the "
     "board reads known keys only where they live, so none of them is adopted from it",
     with_key(CB, "layout", {"button_map": ["off"] * 8, "roster": [], "courts": ["0|1|60|b|00000000"],
                             "lcd_layout": "expanded"}, before="config"), 200),
    ("cb-unknown-config-object-carrying-button-map",
     "a nested object inside config that carries button_map and lcd_layout: config is read one level "
     "deep only",
     with_key(CB, "panel", {"button_map": ["off"] * 8, "lcd_layout": "expanded"}, before="lcd_layout",
              inside="config"), 200),
    ("cb-unknown-config-keys", "unknown config keys of every JSON kind are ignored",
     with_key(with_key(with_key(CB, "lcd_contrast", 7, inside="config"), "lcd_theme", "night", inside="config"),
              "future", [1, {"a": None}], inside="config"), 200),
    ("cb-roster-element-extra-field", "FC-1: a fifth field on every roster element is ignored, never a refusal",
     replaced(CB, ["roster"], ["m18Y9BWDJ|1|-300|2400|p", "m18Y9|3|600|4200|future|x"]), 200),
    ("cb-courts-element-extra-field", "FC-1: a sixth field on every courts element is ignored",
     replaced(CB, ["courts"], ["0|1|2700|b|3fa85f64|x", "1|0|0|-|-|x", "2|1|7140|e|9c1d0e22|x", "3|0|0|-|-|x"]), 200),
    ("cb-courts-unknown-kind", "an unknown kind letter is display-only: lit reads as a booking, dark as dark",
     replaced(CB, ["courts"], ["0|1|2700|z|3fa85f64", "1|0|0|q|-", "2|1|7140|e|9c1d0e22", "3|0|0|-|-"]), 200),
    ("cb-code-keys-element-extra-field", "FC-1: a key element may grow a '|' suffix; the first 21 characters are the key",
     replaced(CB, ["code_keys"], ["18Y90HkE5WHvWQ0Oe9Rdl|v2", "BWDJ0IksrpX8Aq55NF6dh|v2"]), 200),
    ("cb-code-days-element-extra-field", "a third field on a day slot is ignored",
     replaced(CB, ["code_days"], ["59670480|59673360|x"]), 200),
    ("cb-roster-all-unreadable", "a roster in a grammar this board does not know is never committed as empty: "
     "the previous roster stays and the drift is reported",
     replaced(CB, ["roster"], [{"token": "m18Y9BWDJ", "relay": 1}, {"token": "m18Y9", "relay": 3}]), 200),
    ("cb-roster-partly-unreadable", "unreadable elements are skipped, the rest committed, the drift reported",
     replaced(CB, ["roster"], ["m18Y9BWDJ|1|-300|2400", 17, "bad element"]), 200),
    ("cb-roster-empty", "an explicit [] is 'no bookings' and is committed", replaced(CB, ["roster"], []), 200),
    ("cb-code-keys-all-unreadable", "a key ring in an unknown grammar keeps the previous ring",
     replaced(CB, ["code_keys"], ["18Y9:0:HkE5WHvWQ0Oe9Rdl", "BWDJ:0:IksrpX8Aq55NF6dh"]), 200),
    ("cb-courts-empty", "an empty snapshot changes nothing (the reconcile is ON-only)", replaced(CB, ["courts"], []), 200),
    ("cb-court-numbers-drift", "an unreadable court list keeps the previous map whole (positions are relays)",
     replaced(CB, ["court_numbers"], [1, 2, "3", 4]), 200),
    ("cb-number-kinds", "FC-11: a fraction, an exponent, a quoted number and a negative read as absent "
     "(previous value kept, drift reported); never truncated",
     dump(replaced(replaced(replaced(replaced(CB, ["config", "lcd_marquee_step_ms"], 450.5),
                                     ["config", "lcd_screen_ceiling_seconds"], 90.0),
                             ["config", "relay_reconcile_min_seconds"], "90"), ["config", "hw_scanner_gap_ms"], -5)
          ).replace(b'"lcd_screen_ceiling_seconds":90.0', b'"lcd_screen_ceiling_seconds":9e1'), 200),
    ("cb-bool-kind", "a quoted bool reads as absent", replaced(CB, ["config", "relay_restore_enabled"], "false"), 200),
    ("cb-hardware-values", "hardware facts other than the defaults, adopted",
     replaced(replaced(replaced(replaced(replaced(CB, ["config", "hw_relay_active_level"], "low"),
                                         ["config", "hw_lcd_i2c_address"], 63), ["config", "hw_scanner_baud"], 115200),
                       ["config", "hw_scanner_line_end"], "crlf"), ["config", "hw_scanner_gap_ms"], 90), 200),
    ("cb-hardware-unknown-values", "an unknown relay level, LCD address or baud keeps the current value: a "
     "remote guess never flips the relay drive",
     replaced(replaced(replaced(CB, ["config", "hw_relay_active_level"], "inverted"), ["config", "hw_lcd_i2c_address"], 40),
              ["config", "hw_scanner_baud"], 4800), 200),
    ("cb-layout-unknown", "an unknown layout is compact", replaced(CB, ["config", "lcd_layout"], "jumbo"), 200),
    ("cb-button-map-drift", "a button map with a token this board does not know keeps the previous map whole",
     replaced(CB, ["config", "button_map"], ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30",
                                             "minutes:45", "hold:5"]), 200),
    ("cb-button-map-new", "a valid remap is adopted",
     replaced(CB, ["config", "button_map"], ["court:B", "court:A", "court:D", "court:C", "minutes:30", "minutes:60",
                                             "minutes:90", "off"]), 200),
    ("cb-duplicate-key-first-wins", "duplicate keys resolve first-wins on the board; the server never emits one",
     b'{"court_numbers":[4,3,2,1],' + dump(CB)[1:], 200),
    ("cb-bom-and-whitespace", "a UTF-8 BOM and leading whitespace are skipped; the server never sends either",
     b"\xef\xbb\xbf \r\n" + dump(CB), 200),
    ("cb-pretty-printed", "whitespace between tokens is tolerated; the server sends compact",
     json.dumps(CB, indent=2).encode(), 200),
    ("cb-nesting-eight-in-unknown", "an unknown value nested eight deep is skipped",
     with_key(CB, "future", nested(8)), 200),
    ("cb-nesting-past-32", "past 32 levels the scanner refuses the body whole: nothing adopted",
     with_key(CB, "future", nested(33)), 200),
    ("cb-top-level-array", "not one object: nothing adopted", b"[" + dump(CB) + b"]", 200),
    ("cb-html-200", "an HTML 200 (a captive portal, a proxy page): nothing adopted",
     b"<html><body>Login</body></html>", 200),
    ("cb-cut-body", "a body cut mid-way: nothing adopted", dump(CB)[:700], 200),
    ("cb-at-budget-adopted", "a body of exactly 4096 bytes, the server's maximum: adopted", padded(CB, 4096), 200),
    ("cb-at-buffer-not-adopted", "a body of 5120 bytes cannot be held whole: nothing adopted", padded(CB, 5120), 200),
    ("cb-status-201", "FC-4: every 2xx is a success", CB, 201),
    ("cb-status-204-empty", "a 2xx with no body adopts nothing and is not a failure of the link", b"", 204),
    ("cb-status-500", "a 500 adopts nothing", CB, 500),
    ("cb-status-401", "a 401 adopts nothing and retries once with the previous key", CB, 401),
    ("cb-lifeline-with-drifted-rest",
     "the lifeline: ota, key_next and net are adopted from a complete body even when its roster, courts and "
     "config are in a grammar this board does not know",
     with_key(with_key(with_key(replaced(replaced(replaced(CB, ["roster"], [{"t": 1}]), ["courts"], [{"r": 0}]),
                                         ["config"], "v4"), "ota", BRIDGE_OFFER), "key_next", KEY_NEXT), "net", NET), 200),
    ("cb-lifeline-only", "a lifeline-only body (the server's answer when everything would not fit): the lifeline is "
     "adopted and everything absent keeps its value",
     {"server_time": "2026-11-13T18:00:00", "tenant_slug": "crusaders", "device_code": "box-5ccf7f0a1b2c",
      "heartbeat_seconds": 60, "ota": BRIDGE_OFFER, "key_next": KEY_NEXT, "net": NET}, 200),
    ("cb-lifeline-extra-fields", "a future field inside ota, key_next or net is ignored",
     with_key(with_key(with_key(CB, "ota", with_key(BRIDGE_OFFER, "channel", "stable")), "key_next",
                       with_key(KEY_NEXT, "not_after", 1800000000)), "net", with_key(NET, "wifi2_ssid", "SPARE")), 200),
    ("cb-relays-extra-field", "a v3 box on a pre-v3 server: relays elements with a fourth field are read",
     replaced(with_key(CB, "relays", ["0|1834|3fa85f64|x", "2|600|9c1d0e22|x"], before="roster"), ["courts"], []), 200),
]

gate_bodies = [
    ("gt-base", "the base body itself", GB, 200),
    ("gt-gate-object-nested-decoy", "FC-12: a nested object inside `gate` that carries unlock_seconds first: only "
     "the gate object's own scalars are settings",
     with_key(GB, "lamp", {"unlock_seconds": 30}, before="unlock_seconds", inside="gate"), 200),
    ("gt-gate-unknown-scalars", "unknown gate settings are ignored",
     with_key(with_key(GB, "chime", True, inside="gate"), "hold_open_minutes", 0, inside="gate"), 200),
    ("gt-gate-fault-settings", "FC-8: device_fault_* inside the gate object are read",
     replaced(replaced(GB, ["gate", "device_fault_reporting"], False), ["gate", "device_fault_max_per_hour"], 500), 200),
    ("gt-roster-extra-field", "a fifth roster field is ignored",
     replaced(GB, ["roster"], ["m18Y9BWDJ|0|-300|2400|x", "7Q3F9KM2XZ8B|0|1800|5400|x"]), 200),
    ("gt-roster-all-unreadable", "an unknown roster grammar keeps the previous roster",
     replaced(GB, ["roster"], [["m18Y9BWDJ", 0, -300, 2400]]), 200),
    ("gt-kind-not-gate", "DG-9: an answer whose kind is not gate adopts no roster, keys or settings",
     replaced(GB, ["kind"], "court_box"), 200),
    ("gt-number-kinds", "a fraction and a quoted number read as absent",
     replaced(replaced(GB, ["gate", "unlock_seconds"], 12.5), ["gate", "ota_probation_minutes"], "30"), 200),
    ("gt-lifeline-with-drifted-rest", "the lifeline survives a roster and gate object it cannot read",
     with_key(with_key(replaced(replaced(GB, ["roster"], [{"t": 1}]), ["gate"], [15]), "ota", GATE_OFFER),
              "key_next", KEY_NEXT), 200),
    ("gt-status-202", "every 2xx is a success", GB, 202),
    ("gt-html-200", "nothing adopted", b"<!doctype html><p>gateway</p>", 200),
    ("gt-at-budget-adopted", "a body of exactly 6144 bytes, the server's maximum: adopted", padded(GB, 6144), 200),
    ("gt-at-buffer-not-adopted", "8192 bytes cannot be held whole", padded(GB, 8192), 200),
]


def raw_of(b):
    return b if isinstance(b, (bytes, bytearray)) else dump(b)


def build(bodies, base, fresh, adopt):
    prior, out0 = adopt(fresh(), dump(base))
    assert out0["accepted"] and not out0["drift"], out0
    cases = []
    for cid, note, body, status in bodies:
        raw = raw_of(body)
        st, out = adopt(prior, raw, status)
        expect = dict(out)
        # Only what this body changed; every observable not named here equals `prior`.
        expect["changes"] = {k: v for k, v in st.items() if prior.get(k) != v}
        cases.append({"id": cid, "note": note, "status": status, "body_hex": raw.hex(), "expect": expect})
    return prior, cases


cb_prior, court_box_cases = build(court_box_bodies, CB, court_box_fresh, adopt_court_box)
gt_prior, gate_cases = build(gate_bodies, GB, gate_fresh, adopt_gate)

# ---------------------------------------------------------------------------------------------
# Scan-path replies. decided = the server decided and the board acts on the body; undecided = the
# server did not decide: /activate falls back to the roster, /walkup and /extend show BUSY / PRESS
# AGAIN with the scan AND the purchase nonce kept (so the retry is the same purchase), /gate
# decides offline. A readable 4xx is a decided refusal except 401 (key fallback), 408 and 429.
# ---------------------------------------------------------------------------------------------
UNDECIDED_4XX = {401, 408, 429}


def classify(endpoint, status, raw, buffer):
    body = read_object(raw, buffer) if raw else None
    if 200 <= status <= 299:
        if body is None:
            return {"class": "undecided"}
        if endpoint == "activate":
            if not isinstance(body.get("activated"), bool):
                return {"class": "undecided"}
            r = {"class": "decided", "activated": body["activated"]}
            if body["activated"]:
                g = body.get("granted_seconds")
                if not is_uint(g) or g == 0:
                    return {"class": "undecided"}
                r["granted_seconds"] = min(g, 5400)
                p = body.get("play_remaining_seconds")
                r["play_remaining_seconds"] = p if is_uint(p) and p >= r["granted_seconds"] else r["granted_seconds"]
            return r
        if endpoint in ("walkup", "extend"):
            field = "granted_minutes" if endpoint == "walkup" else "extended_minutes"
            v = body.get(field)
            if not is_uint(v) or v == 0:
                return {"class": "undecided"}
            return {"class": "decided", field: min(v, 90)}
        if endpoint == "events":
            a = body.get("accepted_through")
            return {"class": "decided", "accepted_through": a} if is_uint(a) else {"class": "undecided"}
        if endpoint == "gate":
            if not isinstance(body.get("opened"), bool):
                return {"class": "undecided"}
            r = {"class": "decided", "opened": body["opened"]}
            if body["opened"]:
                u = body.get("unlock_seconds")
                if not is_uint(u):
                    return {"class": "undecided"}
                r["unlock_seconds"] = min(max(u, 1), 30)
            return r
    if 400 <= status <= 499 and status not in UNDECIDED_4XX and endpoint in ("walkup", "extend"):
        err = body.get("error") if body else None
        return {"class": "decided", "refused": err if isinstance(err, str) else "unknown"}
    return {"class": "undecided"}


ACT_OK = {"activated": True, "reason": "ok", "court_number": 3, "booking_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          "granted_seconds": 5400, "play_remaining_seconds": 6300, "greeting_name": "DEAN", "balance_minutes": 120}
SCAN = [
    ("court_box", "activate", "act-extra-fields", "unknown fields of every kind are ignored", 200,
     with_key(with_key(ACT_OK, "future", {"a": [1]}), "court_name", "Court 3")),
    ("court_box", "activate", "act-201", "FC-4: a 201 is a success", 201, ACT_OK),
    ("court_box", "activate", "act-no-play-remaining", "a pre-v3 server: play_remaining falls back to granted",
     200, {k: v for k, v in ACT_OK.items() if k != "play_remaining_seconds"}),
    ("court_box", "activate", "act-html-200", "an unreadable 200 is undecided: the roster decides", 200,
     b"<html></html>"),
    ("court_box", "activate", "act-activated-quoted", "FC-11: activated as a string is unreadable: undecided", 200,
     replaced(ACT_OK, ["activated"], "true")),
    ("court_box", "activate", "act-at-buffer", "512 bytes cannot be held: undecided", 200, padded(ACT_OK, 512)),
    ("court_box", "walkup", "walk-201", "FC-4: a 201 grant lights the court (2.3.0 read it as SEE THE DESK and charged)",
     201, {"granted_minutes": 30, "replayed": False}),
    ("court_box", "walkup", "walk-202-extra", "a 202 with future fields", 202,
     {"granted_minutes": 30, "replayed": False, "receipt": "r-1"}),
    ("court_box", "walkup", "walk-204-empty", "a 2xx with no body is undecided: BUSY, nonce kept", 204, b""),
    ("court_box", "walkup", "walk-200-quoted-minutes", "FC-11: granted_minutes as a string is undecided, never the "
     "requested minutes", 200, {"granted_minutes": "10", "replayed": False}),
    ("court_box", "walkup", "walk-409", "a readable 409 is a decided refusal", 409, {"error": "code_used"}),
    ("court_box", "walkup", "walk-409-html", "an unreadable 409 is still a decided refusal", 409, b"<html></html>"),
    ("court_box", "walkup", "walk-429", "429 is undecided", 429, {"error": "rate_limited"}),
    ("court_box", "walkup", "walk-503", "5xx is undecided", 503, b""),
    ("court_box", "extend", "ext-201", "FC-4", 201, {"extended_minutes": 30, "balance_after_minutes": 150, "replayed": False}),
    ("court_box", "extend", "ext-200-missing-field", "a field-less 200 is undecided (unchanged)", 200, {"replayed": True}),
    ("court_box", "events", "events-extra-fields", "accepted_through is read whatever else the reply grows",
     200, {"accepted_through": 42, "recorded": 3, "future": [1, 2]}),
    ("court_box", "events", "events-201", "every 2xx", 201, {"accepted_through": 42, "recorded": 3}),
    ("court_box", "events", "events-at-buffer", "FC-5: 192 bytes cannot be held: nothing released, retried with "
     "backoff", 200, padded({"accepted_through": 42, "recorded": 3}, 192)),
    ("door_gate", "gate", "gate-extra-fields", "unknown fields ignored", 200,
     {"opened": True, "reason": "ok", "unlock_seconds": 15, "future": {"x": 1}}),
    ("door_gate", "gate", "gate-201", "every 2xx", 201, {"opened": False, "reason": "no_booking", "unlock_seconds": 0}),
    ("door_gate", "gate", "gate-html-200", "unreadable: decided offline", 200, b"<html></html>"),
    ("door_gate", "gate", "gate-at-buffer", "256 bytes cannot be held: decided offline", 200,
     padded({"opened": True, "reason": "ok", "unlock_seconds": 15}, 256)),
    ("door_gate", "events", "gate-events-extra-fields", "the same events reply on the gate", 200,
     {"accepted_through": 7, "recorded": 1, "future": True}),
]
BUFFERS = {("court_box", "activate"): 512, ("court_box", "walkup"): 512, ("court_box", "extend"): 512,
           ("court_box", "events"): 192, ("door_gate", "gate"): 256, ("door_gate", "events"): 192}
scan_cases = []
for device, endpoint, cid, note, status, body in SCAN:
    raw = raw_of(body)
    scan_cases.append({"id": cid, "device": device, "endpoint": endpoint, "note": note, "status": status,
                       "body_hex": raw.hex(), "expect": classify(endpoint, status, raw, BUFFERS[(device, endpoint)])})

budgets = [{"id": f"{d}-{fw}-{ep}-{dirn}", "device": d, "firmware": fw, "endpoint": ep, "direction": dirn,
            "firmware_buffer": buf, ("server_max" if dirn == "response" else "server_min_accept"): srv, "note": note}
           for d, fw, ep, dirn, buf, srv, note in BUDGETS]
for b in budgets:
    if b["direction"] == "response" and b["firmware"] in ("bridge-3.0.0", "gate-2.0.0"):
        assert b["server_max"] * 5 <= b["firmware_buffer"] * 4, b["id"]


def budget(device, firmware, endpoint, direction):
    return next(b for b in budgets if (b["device"], b["firmware"], b["endpoint"], b["direction"])
                == (device, firmware, endpoint, direction))


# The widest pinned vectors of the other families must sit inside these budgets, so the two
# families can never disagree about a number.
_http = json.loads((ROOT / "http" / "cases.json").read_text())
_gate = json.loads((ROOT / "gate" / "cases.json").read_text())


def _len(family, section, cid):
    return len(bytes.fromhex(next(c for c in family[section] if c["id"] == cid)["body_hex"]))


assert _len(_http, "responses", "v3-heartbeat-response-widest") <= budget(
    "court_box", "bridge-3.0.0", "heartbeat", "response")["server_max"]
assert _len(_http, "requests", "v3-heartbeat-request-widest") * 5 <= budget(
    "court_box", "bridge-3.0.0", "heartbeat", "request")["firmware_buffer"] * 4
assert _len(_gate, "requests", "gate-heartbeat-request-v3-telemetry") * 5 <= budget(
    "door_gate", "gate-2.0.0", "heartbeat", "request")["firmware_buffer"] * 4
for c in _http["responses"]:
    if c.get("kind") in ("activate", "walkup", "extend"):
        assert len(bytes.fromhex(c["body_hex"])) <= budget("court_box", "bridge-3.0.0", c["kind"], "response")["server_max"], c["id"]
for c in _gate["responses"]:
    if c.get("kind") == "gate":
        assert len(bytes.fromhex(c["body_hex"])) <= budget("door_gate", "gate-2.0.0", "gate", "response")["server_max"], c["id"]

cases = {
    "description": (
        "Forward compatibility for the frozen firmware: budgets both sides hold every device body to, "
        "and what a v3 court box and a v3 door gate adopt from bodies a later server might send."
    ),
    "server_max_depth": SERVER_MAX_DEPTH,
    "firmware_max_depth": FIRMWARE_MAX_DEPTH,
    "budgets": budgets,
    "court_box": {"base_hex": dump(CB).hex(), "prior": cb_prior, "cases": court_box_cases},
    "door_gate": {"base_hex": dump(GB).hex(), "prior": gt_prior, "cases": gate_cases},
    "scan": scan_cases,
}
manifest = {
    "description": cases["description"],
    "authority": "docs/specs/device-api.md section 11; gen_cases.py beside this file is the reference implementation.",
    "generator": "src/contracts/device-protocol/compat/gen_cases.py",
    "read_by": {
        "budgets": ["csharp", "fw-court-box", "fw-door-gate"],
        "court_box": ["fw-court-box"],
        "door_gate": ["fw-door-gate"],
        "scan": ["fw-court-box", "fw-door-gate"],
    },
    "case_count": {
        "budgets": len(budgets),
        "court_box": len(court_box_cases),
        "door_gate": len(gate_cases),
        "scan": len(scan_cases),
        "scan_court_box": sum(1 for c in scan_cases if c["device"] == "court_box"),
        "scan_door_gate": sum(1 for c in scan_cases if c["device"] == "door_gate"),
    },
}

(HERE / "cases.json").write_text(json.dumps(cases, indent=2, ensure_ascii=True) + "\n")
(HERE / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=True) + "\n")
print(f"wrote {HERE}")
print(json.dumps(manifest["case_count"]))
