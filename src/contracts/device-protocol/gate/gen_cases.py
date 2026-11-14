#!/usr/bin/env python3
"""Generates this directory's cases.json and manifest.json. Run it as
`python3 src/contracts/device-protocol/gate/gen_cases.py` from anywhere in the repo.

The bodies are written as SHAPES here, never as hand-typed hex, so a field added
or renamed below is one edit rather than a transcription exercise. Two properties
have to hold for the output to be usable as a contract at all, and both are
enforced by `DeviceGateProtocolCorpusTests` on the .NET side rather than trusted
here:

  * byte-identity with what System.Text.Json actually emits for the server's own
    response records and anonymous shapes — so `separators` is the compact form
    and key order below is DECLARATION order in the C#, not alphabetical; and
  * executed == declared, which is why `manifest.json` is written from the same
    run and not maintained by hand.
"""
import json
import pathlib

MAC = "5ccf7f0a1b2c"
API_KEY = "k7Qz3mR9vT1bXf5NpYw2LcJd8HsA4EgU"
BEARER = f"Bearer {API_KEY}"
SERVER_TIME = "2023-11-14T22:13:20+00:00"

# Crockford base32 minus I, L, O and U — the alphabet AccessCodeService mints from.
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def compact(obj: dict) -> str:
    """System.Text.Json's default: no whitespace anywhere."""
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def body_hex(obj: dict) -> str:
    return compact(obj).encode("utf-8").hex()


def token(n: int) -> str:
    """A deterministic twelve-character code. Deterministic so a regeneration is a
    no-op diff — a corpus that churns on every run teaches reviewers to skip it."""
    out = []
    state = (n + 1) * 6364136223846793005 + 1442695040888963407
    for _ in range(12):
        state = (state * 6364136223846793005 + 1442695040888963407) & ((1 << 64) - 1)
        out.append(ALPHABET[(state >> 33) % len(ALPHABET)])
    return "".join(out)


def entry(tok: str, opens_in: int, closes_in: int) -> str:
    """The roster element. The relay field is always 0 on a gate: the grammar is
    shared with the court box so the firmware's parser is, and a door has one lock."""
    return f"{tok}|0|{opens_in}|{closes_in}"


def heartbeat(device_code: str, gate_key, roster, unlock_seconds: int = 15,
              tenant_slug: str = "crusaders") -> dict:
    """Key order is the declaration order of the anonymous object in
    DeviceEndpoints.HeartbeatAsync's gate branch. Changing one without the other
    is what the byte-identity test exists to catch.

    The 1.x body carries `unlock_seconds` only. The gate firmware has always read
    `device_fault_reporting` (bool) and `device_fault_max_per_hour` (int, clamped
    [1, 120]) out of this same `gate` object, and the server never sent them
    (FC-8). From v3 they are sent to a v3 gate, inside `gate` after the three v3
    settings (V3_GATE below); a 1.x gate is answered byte for byte as before.

    `unlock_seconds` defaults to FIFTEEN, which is the tenant default
    `TenantSettingsView.DefaultGateUnlockSeconds` — it was three, Carl's
    `delay(3000)`, which is how long a lock takes to throw rather than how long a
    person takes to notice a lamp and pull a door. The clamp is unchanged at
    [1, 30]. The `expect` block of gate-heartbeat-response-empty-roster carries
    the same number by hand and has to move with this one."""
    return {
        "server_time": SERVER_TIME,
        "tenant_slug": tenant_slug,
        "device_code": device_code,
        "kind": "gate",
        "gate_key": gate_key,
        "heartbeat_seconds": 60,
        "gate": {"unlock_seconds": unlock_seconds},
        "roster": roster,
    }


def scan(opened: bool, reason: str, unlock_seconds: int) -> dict:
    return {"opened": opened, "reason": reason, "unlock_seconds": unlock_seconds}


requests = [
    {
        "id": "gate-heartbeat-request",
        "note": (
            "the one field the court box's heartbeat does not carry: `kind`. It is a HINT, "
            "honoured only when the MAC is unknown — a board cannot re-kind a row that already "
            "exists. Absent or \"court_box\" is today's behaviour exactly; anything else is 400 "
            "kind_unknown."
        ),
        "method": "POST",
        "path_and_query": "/api/v1/device/heartbeat",
        "authorization": BEARER,
        "body_hex": body_hex({
            "mac": MAC,
            "firmware_version": "1.0.0",
            "uptime_ms": 86400000,
            "kind": "gate",
        }),
    },
    {
        "id": "gate-heartbeat-request-no-push",
        "note": (
            "the diagnostic counter a board with one LED and no screen has nowhere else to put. "
            "`no_push` is how many heartbeats the board could not push — a body that did not fit "
            "its buffer, arrived incomplete, or failed its read on an otherwise-200 response — "
            "plus its watchdog-arm failures. It is a SINCE-BOOT TOTAL and is never reset by the "
            "server acknowledging it: the board has no way to know which report the server kept, "
            "so a counter reset on send would lose the whole count on any lost response. Read a "
            "rise between two heartbeats, not the absolute value. Optional and additive: a board "
            "that sends nothing is a board reporting zero, which is why it is not in the vector "
            "above. The server LOGS it against the device code and stores nothing (a column would "
            "be an EF migration for a diagnostic), and it never changes the response: a counter "
            "must not be able to take a door out of service."
        ),
        "method": "POST",
        "path_and_query": "/api/v1/device/heartbeat",
        "authorization": BEARER,
        "body_hex": body_hex({
            "mac": MAC,
            "firmware_version": "1.0.0",
            "uptime_ms": 86400000,
            "kind": "gate",
            "no_push": 4,
        }),
    },
    {
        "id": "gate-heartbeat-request-events-lost",
        "note": (
            "`events_lost` joins `no_push` as the second diagnostic counter: how many queued "
            "events the board's ring overwrote before they could be uploaded. Both are SINCE-BOOT "
            "TOTALS, both are omitted at zero, and both SATURATE rather than wrap — the firmware "
            "stops at INT32_MAX (2147483647), which is the value here, so a board that has been "
            "losing events for a decade reports a ceiling rather than a small number. The server "
            "binds both as 64-bit so a saturated or over-large value is still a clean 200; see "
            "gate-heartbeat-request-counters-out-of-range. Omitted at zero is why the vector "
            "above carries only one of them."
        ),
        "method": "POST",
        "path_and_query": "/api/v1/device/heartbeat",
        "authorization": BEARER,
        "body_hex": body_hex({
            "mac": MAC,
            "firmware_version": "1.0.0",
            "uptime_ms": 86400000,
            "kind": "gate",
            "no_push": 4,
            "events_lost": 2147483647,
        }),
    },
    {
        "id": "gate-heartbeat-request-counters-out-of-range",
        "note": (
            "the counters at values no honest board emits, pinned because the answer must be a "
            "clean 200 anyway. `no_push` here is INT32_MAX + 1, which an `int?` binding rejects "
            "with a 400 for the WHOLE heartbeat — the roster included — so a diagnostic field "
            "would have taken the door out of service, which is exactly what the vector above "
            "says it must never do. `events_lost` here is negative, which is not a counter at "
            "all. Both are IGNORED: not logged as counts, not stored, and not refused. The "
            "binding is 64-bit for this reason, not because any board sends these."
        ),
        "method": "POST",
        "path_and_query": "/api/v1/device/heartbeat",
        "authorization": BEARER,
        "body_hex": body_hex({
            "mac": MAC,
            "firmware_version": "1.0.0",
            "uptime_ms": 86400000,
            "kind": "gate",
            "no_push": 2147483648,
            "events_lost": -1,
        }),
    },
    {
        "id": "gate-scan-request",
        "note": (
            "a scan the gate could not answer from its roster, or chose not to. Same three "
            "fields as /device/activate minus `court` — a door is not on a court, and the row's "
            "gate_key is the server's business, not the board's."
        ),
        "method": "POST",
        "path_and_query": "/api/v1/device/gate",
        "authorization": BEARER,
        "body_hex": body_hex({"mac": MAC, "method": "qr", "token": "7Q3F9KM2XZ8B"}),
    },
    {
        "id": "gate-events-request-gate-open",
        "note": (
            "an open the gate decided from its own roster while offline. `court` is -1 because "
            "there is no relay bank to index; `duration_ms` is how long the lock was released. "
            "The API already knows about online opens, so this kind is queued for offline ones only."
            "\n\n"
            "`boot_id` IS THE IDEMPOTENCY KEY'S MISSING THIRD FIELD, and it is here because "
            "(device, seq) was not one. The ring is RAM-only, so no event survives a reboot, and "
            "`seq` resumes from a checkpoint in flash — one record, written in blocks of 64. Erase "
            "or tear that record and the board renumbers from 1, against a PERMANENT unique index "
            "on the server: every event of the next evening is silently receipted as a duplicate "
            "and discarded, INCLUDING the `boot` event the firmware queues precisely so that an "
            "operator can see a board restarted. Two boards accidentally sharing a MAC dedup each "
            "other the same way. `boot_id` is a per-boot random 32-bit value — `esp_random()` on "
            "the board, seedable in the simulator — so the key is (device, boot_id, seq): a "
            "renumbered board collides with nothing, and a genuine retry of the same event still "
            "carries the same three fields and is still deduplicated. It is a NUMBER, up to "
            "4294967295, which is why the server binds it as 64-bit. `accepted_through` is "
            "unchanged: the board holds one boot's events at a time, so the highest seq in the "
            "batch means what it always meant."
        ),
        "method": "POST",
        "path_and_query": "/api/v1/device/events",
        "authorization": BEARER,
        "body_hex": body_hex({
            "mac": MAC,
            "boot_id": 2596069104,
            "uptime_ms": 86400000,
            "events": [{
                "seq": 7,
                "uptime_ms": 86390000,
                "kind": "gate_open",
                "court": -1,
                "method": "qr",
                "subject": "7Q3F9KM2XZ8B",
                "duration_ms": 3000,
            }],
        }),
    },
    {
        "id": "gate-events-request-no-boot-id",
        "note": (
            "THE COMPATIBILITY SHAPE, and the reason `boot_id` could be added without a flag day. "
            "A body that omits it means boot_id 0 on the server, which is exactly the behaviour "
            "(device, seq) always had: every such board shares one boot identity and dedups "
            "against itself as before. That covers the COURT BOX, whose renderer omits the field "
            "today, and every gate image flashed before this change. The field is additive and "
            "optional on the wire and REQUIRED in practice on a gate — the gate's renderer always "
            "sets it, and this vector exists so the server's tolerance of its absence is pinned "
            "rather than assumed. A subject of `\"` is in here too: the bytes come off a QR code "
            "and the renderer escapes them, so the corpus carries an escaped one rather than "
            "leaving that to a reviewer's imagination."
        ),
        "method": "POST",
        "path_and_query": "/api/v1/device/events",
        "authorization": BEARER,
        "body_hex": body_hex({
            "mac": MAC,
            "uptime_ms": 86400000,
            "events": [{
                "seq": 8,
                "uptime_ms": 86390000,
                "kind": "unknown_scan",
                "court": -1,
                "method": "qr",
                "subject": "A\"B",
                "duration_ms": 0,
            }],
        }),
    },
    {
        "id": "gate-events-request-replayed",
        "note": (
            "MCV1-10: a replay the door refused from its OWN state while its link was up. It is the "
            "`unknown_scan` event every offline refusal already is, with the v3 event field `cause` "
            "set to `replayed` and the link as it was (`online`), appended inside the event after "
            "`duration_ms`. The server re-checks the code as for any offline refusal and records "
            "the outcome `replayed` rather than `refused_offline`, which is what lets the console "
            "say 'code used again' instead of 'the door could not check it'. `cause` is the one "
            "additive field every v3 event has (a court box's release carries it too); the gate's "
            "first 2.0.0 cut sent `reason` instead, which the server ignores as unknown — so the "
            "wire is pinned here, on both sides."
        ),
        "method": "POST",
        "path_and_query": "/api/v1/device/events",
        "authorization": BEARER,
        "body_hex": body_hex({
            "mac": MAC,
            "boot_id": 2596069104,
            "uptime_ms": 86400000,
            "events": [{
                "seq": 9,
                "uptime_ms": 86395000,
                "kind": "unknown_scan",
                "court": -1,
                "method": "qr",
                "subject": "1ABCDEFGHJKMNPQRSTU",
                "duration_ms": 0,
                "cause": "replayed",
                "online": True,
            }],
        }),
    },
]

# The WORST case this response can be, not a representative one. A budget pinned by a
# comfortable vector is not pinned: every field here is at the widest the server can
# actually emit — a 64-character tenant slug and gate key (the column bound in
# MainframeDbContext), the long `gate-<full mac>` device code auto-registration falls
# back to on a collision, twelve-character tokens (AccessCode.Length), and relative
# seconds at the far end of the six-digit range a 1440-minute roster window allows.
WIDE_SLUG = "w" * 64
WIDE_GATE_KEY = "g" * 64
WIDE_DEVICE_CODE = f"gate-{MAC}"
full_roster = [
    entry(token(i), -86400 + i * 137, 899000 + i * 137) for i in range(48)
]

responses = [
    {
        "id": "gate-heartbeat-response-empty-roster",
        "kind": "heartbeat",
        "note": (
            "`roster` is present and empty rather than absent. The firmware replaces its cache "
            "wholesale on every push, so an omitted key would leave a stale roster live — a "
            "cancelled booking is expressed by its absence from the NEXT push."
        ),
        "body_hex": body_hex(heartbeat("gate-0a1b2c", "front-door", [])),
        "expect": {
            "kind": "gate",
            "gate_key": "front-door",
            "roster": [],
            "heartbeat_seconds": 60,
            # FIFTEEN, AND IT WAS THREE. The tenant default `gate_unlock_seconds`
            # moved from Carl's `delay(3000)` to fifteen seconds — a number about
            # a person reaching a handle rather than about a strike throwing. The
            # clamp is unchanged at [1, 30] and a club that wants three back sets
            # three. This has to track `heartbeat()`'s own default above, because
            # the body is generated from that and this is what the FIRMWARE's
            # corpus suite checks the body against.
            "gate": {"unlock_seconds": 15},
        },
    },
    {
        "id": "gate-heartbeat-response-null-gate-key",
        "kind": "heartbeat",
        "note": (
            "a gate nobody has named yet — auto-registration leaves gate_key null and an admin "
            "sets it. The key is still PRESENT on the wire as null: a firmware that reads an "
            "absent key as an empty string and a null one as an error would diverge here. "
            "It is also the UNNAMED half of the named/unnamed pair: an unnamed gate's roster is "
            "ALWAYS empty, whatever the club has booked, so the offline fallback does not start "
            "until an admin has named the door. Online scans work from the first heartbeat. "
            "Pair this with gate-heartbeat-response-roster-single, which is the named half and "
            "is the only shape that may carry entries."
        ),
        "body_hex": body_hex(heartbeat("gate-0a1b2c", None, [])),
        "expect": {"kind": "gate", "gate_key": None, "roster": []},
    },
    {
        "id": "gate-heartbeat-response-roster-single",
        "kind": "heartbeat",
        "note": (
            "one rostered booking, 30 minutes from its early-entry window opening and 90 minutes "
            "from its slot ending. Same TOKEN|relay|opens_in|closes_in grammar as the court box "
            "so devlink::parseRosterElement and roster::Roster are reused unchanged; the relay "
            "field is always 0. The NAMED half of the pair above: gate_key is set, so this board "
            "is allowed a roster at all. A non-empty roster beside a null gate_key is a body the "
            "server does not emit."
        ),
        "body_hex": body_hex(heartbeat("gate-0a1b2c", "front-door", [entry("7Q3F9KM2XZ8B", 1800, 5400)])),
        "expect": {"kind": "gate", "roster": ["7Q3F9KM2XZ8B|0|1800|5400"]},
    },
    {
        "id": "gate-heartbeat-response-roster-negative-opens",
        "kind": "heartbeat",
        "note": (
            "opens_in is SIGNED and goes negative once the early-entry window is open — this "
            "member may already come in. A firmware that parsed it unsigned would read -900 as "
            "an enormous positive wait and lock out somebody whose court starts in five minutes."
        ),
        "body_hex": body_hex(heartbeat("gate-0a1b2c", "front-door", [entry("K4TQ8N2ZV7BM", -900, 2700)])),
        "expect": {"kind": "gate", "roster": ["K4TQ8N2ZV7BM|0|-900|2700"]},
    },
    {
        "id": "gate-heartbeat-response-roster-full",
        "kind": "heartbeat",
        "note": (
            "GateRosterMaxEntries = 48 is a CONTRACT CONSTANT, not a tenant setting: it bounds "
            "Roster<48> on the board and, through it, the 4608-byte static response buffer the "
            "gate has to hold this in. max_bytes is the budget for the WHOLE body, not the roster "
            "alone, and every field in this vector is at the widest the server can emit — a "
            "64-character slug and gate key, the long device_code auto-registration falls back to, "
            "and six-digit relative seconds. A budget pinned by a comfortable vector is not pinned."
        ),
        "body_hex": body_hex(
            heartbeat(WIDE_DEVICE_CODE, WIDE_GATE_KEY, full_roster, tenant_slug=WIDE_SLUG)),
        "expect": {
            "kind": "gate",
            "gate_key": WIDE_GATE_KEY,
            "roster": full_roster,
            "max_bytes": 4096,
        },
    },
    {
        "id": "gate-scan-response-ok",
        "kind": "gate",
        "note": (
            "unlock_seconds is what goes on the lock's release timer — the tenant's "
            "gate_unlock_seconds clamped to [1, 30]. Never 0 on an open: a zero-second release "
            "is a door that clicks and stays shut."
        ),
        "body_hex": body_hex(scan(True, "ok", 3)),
        "expect": {"opened": True, "reason": "ok", "unlock_seconds": 3},
    },
    {
        "id": "gate-scan-response-denied-not-recognised",
        "kind": "gate",
        "note": (
            "unknown, expired, or another club's code — one reason for all three on purpose, "
            "because telling them apart at a door turns it into an oracle for which codes are real. "
            "It also covers a booking code presented AFTER its own booking has ended, or for a "
            "booking that is no longer Booked: the AccessCode row outlives the slot by the grace "
            "window, and a door that distinguished 'spent' from 'never existed' would be that "
            "same oracle. 200, not 4xx: a refusal the firmware can act on must never look like an "
            "outage it should fall back from."
        ),
        "body_hex": body_hex(scan(False, "not_recognised", 0)),
        "expect": {"opened": False, "reason": "not_recognised", "unlock_seconds": 0},
    },
    {
        "id": "gate-scan-response-denied-member-not-active",
        "kind": "gate",
        "note": (
            "the club has suspended, rejected or not yet approved this member. Named rather than "
            "collapsed into not_recognised because a door has no LCD to explain itself and the "
            "distinction is what the desk needs from the audit row afterwards."
        ),
        "body_hex": body_hex(scan(False, "member_not_active", 0)),
        "expect": {"opened": False, "reason": "member_not_active", "unlock_seconds": 0},
    },
    {
        "id": "gate-scan-response-denied-no-membership",
        "kind": "gate",
        "note": (
            "the scanner read a real, live ident code for a real user of this club who has NO "
            "membership row at all. Previously this opened the door: MembershipAccess tested "
            "'the club recorded a decision and it was not approval', and about such a user it "
            "recorded none, so under active_member the door released for somebody the club has "
            "never admitted. Named rather than folded into member_not_active because the desk's "
            "next action differs — there is nothing to un-suspend, the person needs enrolling — "
            "and the door says neither out loud."
        ),
        "body_hex": body_hex(scan(False, "no_membership", 0)),
        "expect": {"opened": False, "reason": "no_membership", "unlock_seconds": 0},
    },
    {
        "id": "gate-scan-response-denied-no-booking",
        "kind": "gate",
        "note": (
            "policy booking_window only: an active member with nothing booked inside "
            "[StartsAt - gate_early_entry_minutes, EndsAt]. Unreachable under the default "
            "active_member policy, which is why the policy is a tenant setting and this is a vector."
        ),
        "body_hex": body_hex(scan(False, "no_booking", 0)),
        "expect": {"opened": False, "reason": "no_booking", "unlock_seconds": 0},
    },
    {
        "id": "gate-scan-response-denied-too-early",
        "kind": "gate",
        "note": (
            "a BOOKING-ACTIVATION code presented before its own booking's entry window opens. A "
            "booking code is not a standing building key: under EVERY policy it opens a door only "
            "while now is inside [StartsAt - H, EndsAt] of the booking it names, where H is "
            "gate_early_entry_minutes under booking_window and "
            "max(gate_early_entry_minutes, roster_window_minutes + activation_cue_window_minutes) "
            "under active_member — the same horizon in which the member's own phone would show "
            "that code at all. Distinct from not_recognised because this one is worth telling a "
            "member apart from a dead code: they are early, not refused, and the door will open "
            "later. A sixty-second MemberIdent code never answers this — it names no booking."
        ),
        "body_hex": body_hex(scan(False, "too_early", 0)),
        "expect": {"opened": False, "reason": "too_early", "unlock_seconds": 0},
    },
    {
        "id": "gate-scan-response-denied-method-not-supported",
        "kind": "gate",
        "note": (
            "anything but qr or code. A PIN against the whole membership roll is an oracle rather "
            "than an identification, and a door has no candidate set to check one against."
        ),
        "body_hex": body_hex(scan(False, "method_not_supported", 0)),
        "expect": {"opened": False, "reason": "method_not_supported", "unlock_seconds": 0},
    },
    {
        "id": "gate-scan-response-denied-not-a-gate",
        "kind": "gate",
        "note": (
            "the MAC resolved to a CourtBox row. 200 with opened:false rather than a 404 or a 400, "
            "so a misconfigured board shows a refusal and stops rather than retrying an endpoint "
            "that will never answer it differently."
        ),
        "body_hex": body_hex(scan(False, "not_a_gate", 0)),
        "expect": {"opened": False, "reason": "not_a_gate", "unlock_seconds": 0},
    },
]


# --- Heartbeat v3 (gate 2.0.0): key rotation, network changes, and what survives a
# reset. docs/specs/door-gate.md section 14 and docs/specs/device-api.md.
KEY_NEXT = {"id": "k2", "key": "Zq7Hn2Vb5Rt8Wy1Lp4Mk6Xc9Ds3Fg0Jh_a-QeUoIiEr"}
NET = {"ver": 4, "base": "http://192.168.1.20:8088", "wifi0_ssid": "CRUSADERS", "wifi0_psk": "squash-court-4",
       "wifi1_ssid": "CRUSADERS-NEW", "wifi1_psk": "new-router-pass"}
V3_CAPS = ["codes:m1", "key:1", "net:1"]
V3_GATE = {"unlock_seconds": 15, "power_restore_trust_minutes": 20, "net_fallback_minutes": 10,
           "device_fault_reporting": True, "device_fault_max_per_hour": 60}
# The gate's telemetry (docs/specs/device-api.md section 13): the same `diag` object as the court
# box's, sent on every beat after the v3 fields and before caps.
V3_DIAG = {"reset": "task_wdt", "exc": 0, "epc1": 0, "heap": 151552, "heap_min": 139264, "block": 110592,
           "stack_min": 4416, "sketch_free": 1310720, "flash_mb": 4}


def heartbeat_v3(extra=(), gate=None):
    """Key order: the 1.x body, with the v3 settings appended INSIDE `gate` after
    unlock_seconds (the two v3 ones, then the two fault settings), then the transient v3
    objects (key_next, net) after `roster`. The gate object holds scalars only, for the
    life of the frozen readers (FC-12): a nested object here is never a setting."""
    body = heartbeat("gate-0a1b2c", "front-door", [entry("7Q3F9KM2XZ8B", 1800, 5400)])
    body["gate"] = dict(gate or V3_GATE)
    for k, v in extra:
        body[k] = v
    return body


requests += [
    {
        "id": "gate-heartbeat-request-v3",
        "note": (
            "gate 2.0.0 on a quiet beat. The 1.x fields, then net_ver and net_src, then "
            "caps LAST. `caps` names every v3 capability the image has; the server keys every new "
            "response field on it, so a 1.x gate is answered exactly as before."
        ),
        "method": "POST",
        "path_and_query": "/api/v1/device/heartbeat",
        "authorization": BEARER,
        "body_hex": body_hex({
            "mac": MAC, "firmware_version": "2.0.0", "uptime_ms": 86400000, "kind": "gate",
            "net_ver": 4, "net_src": "server", "caps": V3_CAPS,
        }),
    },
    {
        "id": "gate-heartbeat-request-v3-cold-restore",
        "note": (
            "the first beat after a POWER-ON reset that found the server down: `restore` says what "
            "the board ran on meanwhile — cold (its flash roster, trusted for "
            "power_restore_trust_minutes from boot because the outage length is unknowable), warm "
            "(an RTC-dated roster after a watchdog or panic reset), or none. Sent on the first "
            "accepted beat of a boot only; the server records it on the board's activity."
        ),
        "method": "POST",
        "path_and_query": "/api/v1/device/heartbeat",
        "authorization": BEARER,
        "body_hex": body_hex({
            "mac": MAC, "firmware_version": "2.0.0", "uptime_ms": 412000, "kind": "gate",
            "net_ver": 4, "net_src": "server", "restore": "cold", "caps": V3_CAPS,
        }),
    },
    {
        "id": "gate-heartbeat-request-v3-telemetry",
        "note": (
            "the gate's telemetry, after the v3 fields and before caps: `diag` is the reset reason "
            "(esp_reset_reason() as a word), exception cause and epc1 (0 on an ESP32), free heap now "
            "and lowest since boot, largest free block, the loop task's stack high-water mark in bytes, "
            "the inactive app slot's size and the real flash size in MB; `drift` (absent here) names "
            "what the board could not read in the last answer. Every number a JSON integer."
        ),
        "method": "POST",
        "path_and_query": "/api/v1/device/heartbeat",
        "authorization": BEARER,
        "body_hex": body_hex({
            "mac": MAC, "firmware_version": "2.0.0", "uptime_ms": 86400000, "kind": "gate",
            "net_ver": 4, "net_src": "server", "diag": V3_DIAG, "caps": V3_CAPS,
        }),
    },
]

responses += [
    {
        "id": "gate-heartbeat-response-v3",
        "kind": "heartbeat",
        "note": (
            "the gate's v3 settings, inside `gate` after unlock_seconds: power_restore_trust_minutes "
            "(tenant device_power_restore_trust_minutes, 0-120), net_fallback_minutes "
            "(device_net_fallback_minutes, 3-60), then device_fault_reporting and "
            "device_fault_max_per_hour (the tenant settings of the same names, 1-120), which every gate "
            "firmware reads and no server sent before v3 (FC-8). Sent only to a gate whose caps include "
            "key:1 or net:1."
        ),
        "body_hex": body_hex(heartbeat_v3()),
        "expect": {"kind": "gate", "gate": V3_GATE, "roster": ["7Q3F9KM2XZ8B|0|1800|5400"]},
    },
    {
        "id": "gate-heartbeat-response-v3-key-next",
        "kind": "heartbeat",
        "note": "a key rotation in its grace window; the same object, and the same rules, as the court box's.",
        "body_hex": body_hex(heartbeat_v3([("key_next", KEY_NEXT)])),
        "expect": {"kind": "gate", "key_next": KEY_NEXT, "roster": ["7Q3F9KM2XZ8B|0|1800|5400"]},
    },
    {
        "id": "gate-heartbeat-response-v3-net",
        "kind": "heartbeat",
        "note": "a network change; the same object, and the same all-or-nothing adoption, as the court box's.",
        "body_hex": body_hex(heartbeat_v3([("net", NET)])),
        "expect": {"kind": "gate", "net": NET, "roster": ["7Q3F9KM2XZ8B|0|1800|5400"]},
    },
]

cases = {
    "device_api_key": API_KEY,
    "device_mac": MAC,
    "requests": requests,
    "responses": responses,
}

manifest = {
    "description": (
        "Door-gate HTTP request and response body shapes: the heartbeat's `kind` hint, its two "
        "since-boot diagnostic counters and its gate-shaped answer, the scan decision, and the "
        "offline gate_open event with the per-boot identity its deduplication key rests on."
    ),
    "authority": (
        "docs/specs/door-gate.md — the behaviour oracle; "
        "src/backend/Crusaders.Mainframe.Api/Endpoints/DeviceGateEndpoint.cs and the gate branch "
        "of DeviceEndpoints.cs are the reference implementation the firmware must match."
    ),
    "case_count": {"requests": len(requests), "responses": len(responses)},
}

here = pathlib.Path(__file__).resolve()
root = None
for parent in here.parents:
    if (parent / "src" / "contracts" / "device-protocol").is_dir():
        root = parent
        break
if root is None:
    raise SystemExit(
        "src/contracts/device-protocol was not found above this script. Run it from inside "
        "the repository: a generator that guesses at a path would silently write the corpus "
        "into the wrong checkout."
    )

out = root / "src" / "contracts" / "device-protocol" / "gate"
out.mkdir(parents=True, exist_ok=True)
(out / "cases.json").write_text(json.dumps(cases, indent=2, ensure_ascii=False) + "\n")
(out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")

full_bytes = len(compact(
    heartbeat(WIDE_DEVICE_CODE, WIDE_GATE_KEY, full_roster, tenant_slug=WIDE_SLUG)).encode())
print(f"wrote {out}")
print(f"requests={len(requests)} responses={len(responses)}")
print(f"roster-full body = {full_bytes} bytes (budget 4096)")
