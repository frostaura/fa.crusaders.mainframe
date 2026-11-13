# Device API v3 — the heartbeat as the source of truth, and fixing a board without a cable

The device API is what the court boxes (WeMos Mega 2560 + ESP8266 bridge) and the door gates
(ESP32) call, outbound, on the club LAN: `POST /api/v1/device/heartbeat`, `/activate`, `/walkup`,
`/extend`, `/events`, `/gate`, and since v3 `GET /api/v1/device/firmware/{id}`. One per-tenant
bearer key in `Authorization`; the board's MAC in the body. The bodies themselves are pinned byte
for byte by `src/contracts/device-protocol` (`http/`, `gate/`, `membercode/`, and since v3 `ota/`
and `provision/`); this document says what they mean and what each side does with them. The door's
own behaviour is [`door-gate.md`](door-gate.md); the Mega↔bridge wire is
[`device-serial-protocol.md`](device-serial-protocol.md); the single rotating member code is
[`member-code.md`](member-code.md).

**Why v3 exists.** Founder decisions, 2026-11-13, taken for go-live:

1. **The next USB flash is the last.** So both ESP chips gain **signed HTTP OTA** (§7), and the
   Mega — which can never be updated over WiFi — becomes a generic renderer and relay guard the
   bridge steers ([`device-serial-protocol.md`](device-serial-protocol.md), v3).
2. **Nothing an operator does may force a reflash.** Device keys rotate with an overlap window
   delivered over the heartbeat (§6); WiFi credentials and the server URL change without a cable
   — from the server (§8) or at a setup portal entered by a button gesture (§8). The values
   compiled into `secrets.h` are only the first-boot defaults.
3. **The backend is the source of truth for hardware state.** Every heartbeat answer carries a
   complete snapshot of what should be lit, chained paid extensions included, and the box
   **reconciles continuously** — not once per boot (§4). The bridge persists that snapshot, its
   roster and its undelivered events to flash, so a power cut with no network still restores paid
   courts and loses no attendance.
4. **The LCD layout is runtime-selectable** and the landing screen shows every court (§5).

**The addendum (same day, after late gap reports).** Four more lanes found what the first draft
of v3 had not: parsers that broke on one added field, budgets nobody pinned, hardware facts that
were single compiled constants, and boards that reported nothing about their own health. So v3
also makes the frozen firmware **forward-compatible for its whole life** (§11), moves every
hardware fact the Mega had compiled in to a backend setting with a safe default and a bench
procedure (§12), and makes every board report what only it can see (§13).

This reverses the 2026-09-05 "hobby grade" decision's *no OTA, no runtime credential store*
clauses, deliberately: their premise was that a USB reflash costs nothing, and the last-flash rule
removed it. One per-tenant key, auto-registration and plain HTTP on the LAN stand.

---

## 1. Capabilities, and what each pairing does

A board names what it can do in `caps`, the **last** field of every heartbeat request (the
member-code contract's mechanism, [`member-code.md`](member-code.md) §5.1). The server keys every
v3 response field on the caps of **this** request:

| Cap | Meaning | Unlocks in the response |
|---|---|---|
| `codes:m1` | member codes (unchanged) | `code_step`, `code_days`, `code_keys` |
| `hb:3` | snapshot reconcile and the v3 display (court box) | `courts`, the v3 `config` keys (§5) |
| `lcd:2` | the Mega renders both layouts (court box) | `lcd_layout`, `lcd_marquee_enabled` mean something |
| `ota:1` | signed OTA (§7) | `ota` |
| `key:1` | key rotation (§6) | `key_next` |
| `net:1` | network changes (§8) | `net` |

- **A 2.x box (bridge 2.3.0) or a 1.x gate on a v3 server** names at most `codes:m1` and is
  answered **byte for byte as before**: no new key, the 2048-byte court-box contract, `relays` for
  its one-shot restore. It cannot learn a new key, so a key retirement strands it (§6), and it
  cannot be updated: it is flashed once more by cable, to v3, and that is the last flash.
- **A v3 board on a pre-v3 server** gets none of the new keys and degrades to v2 behaviour:
  no `courts` means no reconcile (a v3 bridge then applies `relays` exactly as 2.3.0 did, once per
  boot, ON only), no `config` display keys means compact with the marquee on, and no `ota`,
  `key_next` or `net` means nothing changes. Absent is always "no opinion", never "off".
- **Body budgets.** Court box: **2048** bytes for a 2.x box (unchanged; bridge 2.3.0 reads into
  2560), **4096** for a `hb:3` box (a 3.0.0 bridge reads into 5120; widest vector
  `v3-heartbeat-response-widest`, 4087 bytes — every v3 key at its widest and as many of the 64
  member-code keys as fit, 42). Gate: **4096** for a 1.x gate (unchanged), **6144** for a v3 gate
  (a 2.0.0 gate reads into 8192; the widest — `membercode/gate.json`'s
  `gate-heartbeat-response-codes-full` plus every v3 object at its bound, the gate object's two
  fault settings included — measures 5085 bytes, and the backend lane pins it with a server-side
  size test because the gate family's vectors must be byte-identical to what the server
  serialises). The server keeps every body inside its contract by
  dropping `code_keys` last-first (they are written in priority order, §11.4) — never `courts`,
  `roster`, `config` or the lifeline objects `ota`, `key_next` and `net`. If a future field ever
  made the rest of a body exceed its budget with every key dropped, the server alternates a
  **lifeline-only** body (§11.1) with the full one rather than drop the lifeline. Every budget,
  both directions, every endpoint, is the `compat/` family's `budgets` (§11.4).

---

## 2. The heartbeat request, v3

After the 2.x fields (`mac`, `firmware_version`, `uptime_ms`, the gate's `kind`, `no_push`,
`events_lost`, the court box's `relay_state`), in this order, then `caps`:

| Field | Who | Meaning |
|---|---|---|
| `relay_state` | box | Unchanged grammar, one rule tightened: **absent** until the first `!STATE` of the current Mega boot has been received — never `[]`, which the server reads as "confirmed off" for every relay (BR-12). |
| `mega_version` | box | From `!BOOT` or `!PONG`; absent until heard. The server already stores it. |
| `fw_state` | both | `committed` · `probation` (a new image not yet proven, §7) · `downloading` · `rolled_back` · `failed` (an offer refused or a download abandoned). |
| `fw_failed` · `fw_error` | both | With `rolled_back`/`failed`: the version, and why — `probation`, `sig`, `sha256`, `size`, `http`, `space`, `flash`, `target`, `version`, `busy`. |
| `net_ver` · `net_src` | both | The network configuration version applied (0 = the compiled defaults or the setup portal's) and where it came from: `server`, `local` (the setup portal) or `compiled`. |
| `lcd_layout` | box | The layout the Mega has **acknowledged** (`compact`/`expanded`), so the console can say what the glass is actually doing. Absent until a `!CFG,LAYOUT` was acknowledged this Mega boot. |
| `restore` | both | First accepted beat of a boot only: `warm` (a non-power reset; state carried in RTC memory with a valid clock), `cold` (a power-on reset that used the flash copy inside the trust window, §4), `none`. |
| `relight` | box | `"<relay>|<ref>"` for every relay the bridge re-lit **from the snapshot** since the last accepted beat. Replaces `restored_relays`, which a v3 box never sends. |
| `mega` | box | What the Mega said about itself this Mega boot (§13): `reset` (`MCUSR` from `!BOOT`), `lcd`, `relay`, `scan_baud`, `scan_end`, `keys` (from `!HW`), `diag` (the five `!DIAG` counters). Absent until the Mega has been heard. |
| `diag` | both | The board's own health (§13): reset reason, exception, heap, largest free block, stack low-water mark, OTA space, flash size. Every beat. |
| `drift` | both | Up to eight names of keys the board could not read in the **previous** answer (§11.2), e.g. `"roster"`, `"config.lcd_layout"`; absent when there were none. How a server change that a frozen reader cannot follow is found within one beat instead of at the club. |

The request renders into a **1536**-byte buffer on both v3 boards (bridge 2.3.0: 256); the widest,
`v3-heartbeat-request-widest`, is 1023 bytes.

Pinned: `http/` `v3-heartbeat-request`, `-first-beat`, `-rolled-back`, `-relight`, `-telemetry`,
`-widest`; `gate/` `gate-heartbeat-request-v3`, `-cold-restore`, `-rolled-back`, `-telemetry`.

---

## 3. The heartbeat response, v3 (court box)

After the 2.x keys, in this order: `server_time`, `tenant_slug`, `device_code`, `court_numbers`,
`heartbeat_seconds`, `config` (the twelve 2.x keys, then the thirteen of §5, then `button_map`),
**`courts`**, `roster`, the member-code keys, then the transient objects **`ota`**, **`key_next`**,
**`net`**. `relays` is not sent to a `hb:3` box. The gate's v3 answer is in
[`door-gate.md`](door-gate.md) §14.

### `courts` — the snapshot

```json
"courts": ["0|1|2700|b|3fa85f64", "1|0|0|-|-", "2|1|7140|e|9c1d0e22", "3|0|0|-|-"]
```

One element per **mapped** relay of `court_numbers`, in relay order, **always complete**:
`<relay>|<lit>|<seconds_left>|<kind>|<ref>`.

- `lit` 1 means some checked-in, not-cancelled booking is in play on that court **now** — and "in
  play" starts at `StartsAt − activation_cue_window_minutes`, the same window `/activate` lights
  in. A booking lit during its cue window is in the snapshot from the moment it is lit (MCV1-05:
  v2's `StartsAt <= now` left it out, and a power cut in those minutes left it dark).
- `seconds_left` is the **uncapped** paid remainder to the end of the **chained run** — the booking
  in play plus every checked-in booking that starts where the previous one ends (an extension is a
  separate booking from the end of play, `decisions-court-box-extend`), up to 16 links, the same
  walk as `DeviceExtendEndpoint.InPlayEndAsync`. Relative to the instant the response was produced,
  like the roster's seconds. 0 when dark. This is BD-1/BR-04/DL-11/FSF-08: the v2 restore plan
  stopped at the end of the segment in play and an extended court went dark at the original end.
- `kind`: `b` booking, `w` walk-up, `e` an extension is in play, `-` dark. **No names**: the glass
  is read by anyone standing at the court, and the booking grid's photo-and-name rule is for
  signed-in members only.
- `ref`: the first eight hex of the booking in play, for pairing and the trace; `-` when dark.
- **Sent only to an acknowledged box.** An auto-registered board's court map is a guess until an
  admin confirms it; a fresh board was served another box's lit court (BR-13). Unacknowledged: no
  `courts` key, so no reconcile and no restore.
- **Sent whether or not `relay_restore_enabled`.** The landing shows paid minutes from it either
  way; the setting governs only whether the box may **re-light** from it.
- **A release excludes a booking only if a member made it.** v3 release events carry a `cause`
  (§9). The snapshot drops a booking after a `member` release paired with that session — the
  member pressed OFF — and **never** after `mega_reset`, `autooff`, `cap` or `reconcile`. v2
  dropped it after any release at all, including the one the bridge synthesised when a Mega
  watchdog reset opened every relay (BD-2, BR-03, FSF-03). Releases are matched **by court**, not
  by device.

- **Element arity is frozen and may only grow at the end** (§11.2): a v3 board reads the first five
  fields and ignores any after them; new per-element data goes in a new field at the end or a new
  parallel array, never in place of one of these five.

Pinned: `http/` `v3-heartbeat-response-snapshot`, `-unacknowledged`, `-widest`; `compat/`
`court_box` (the tolerance cases).

---

## 4. What the box does with the snapshot

**On every accepted heartbeat, on every Mega boot (`!BOOT`, or a `!PONG` uptime that went
backwards), and whenever a `!STATE` contradicts it**, the bridge computes, per relay, whether light
is **owed**: the snapshot (aged by the bridge's own clock since it was received) says `lit` with at
least `relay_reconcile_min_seconds` left, `relay_restore_enabled` is true, and no suppression
applies. If any owed relay is dark, or lit with a deadline more than 30 s short of
`min(seconds_left, 5400)`, it sends **one `!WANT`** naming every owed relay and `-` for the rest.
Each relay is re-lit at most once per 60 s; three failed attempts on one relay are the fault
`relight_failed`. **The server's snapshot never switches anything off** — an empty or absent
`courts` changes nothing, so a dropped or truncated response cannot darken a court mid-game, and a
body that is not a complete JSON object is never applied at all (BR-02, FSF-04).

- **Member-release suppression.** A relay the member switched off (OFF button, `!EVT,OFF`) is never
  re-lit for the same `ref`, even while the server — whose release event is still queued — keeps
  listing it; the suppression ends when the snapshot stops listing that `ref`, or after 15 minutes.
- **The box's own provisional lights.** After a **power-on** reset with no network, the bridge
  re-lights from its flash snapshot for at most `device_power_restore_trust_minutes` (the outage
  length is unknowable without a clock) and marks those lights provisional. The first accepted
  snapshot confirms them (`!WANT` to the true remainder) or, where it says dark, the bridge itself
  switches them off — the one case the box switches a light off on the server's word, because the
  box lit it on stale evidence, not the server. Its release carries cause `reconcile`.
- **A Mega-only reset** is the case v2 lost for good. With the snapshot persisted and aged, the
  bridge sends `!WANT` within seconds of `!BOOT`, before any release could be synthesised; a relay
  it re-lights produces no release event, and one it cannot (no snapshot, restore disabled) is
  released with cause `mega_reset`.
- **The landing's minutes** come from the same snapshot: `!LAND` per relay after every accepted
  beat, so a chained extension past the 90-minute cap shows its whole paid remainder.
- **Ages never go negative.** Every age the bridge computes from two of its own instants is
  `now − then` with `then` stamped no later than `now`; a `then` that reads as later (stamped
  after `now` was read in the same pass) is age 0, never a 49-day wrap. A court whose `!ON` was
  sent less than the reconcile grace ago is never reconciled as released. MCV1-01: the first
  online activation after a boot emitted a release with `duration_ms` 4294967272 and the server
  dropped the court from the restore.
- **A v3 bridge on a pre-v3 server** (no `courts`) applies `relays` exactly as 2.3.0 did, once per
  boot and ON only, with one change: the restore is spent only by a **complete** body whose
  `relays` was read and whose `court_numbers` was adopted (this beat or earlier). A cut, empty,
  HTML or BOM-prefixed 2xx, or an unreadable court list, leaves it pending for up to ten minutes
  of uptime (FC-2, BR-02).

**What the bridge persists to flash** (LittleFS; written when the content changes, at most once a
minute for the snapshot, so wear is negligible; each record carries its own check digits and a
damaged one reads as absent):

| Record | Why |
|---|---|
| the last accepted heartbeat's `courts`, `court_numbers`, `config` and `button_map`, with the uptime it was received at | a box that boots with the server down still has its court map, buttons, layout and settings, and can restore (BR-06, BD-4) |
| the roster and member-code sync | offline scans after a power cut, under the same trust window |
| **every undelivered event** (activations, releases, faults) — written on push, cleared on the server's `accepted_through` | a power cut with the network down no longer turns members who played into no-shows (BR-07) |
| the network set and keys (§6, §8), the OTA state (§7) | how the box reaches the club |

**Flash writes happen only at the top of `loop()`.** A record that changed is marked dirty where
it changed and written by the loop itself, never from inside a parse, a decision or an event push.
On the ESP8266 the deepest stack in the image is a LittleFS write with directory compaction
(about 3.8 KB of a 4 KB continuation stack when reached from inside a scan decision, ESPR-1);
from the top of `loop()` the same write sits about 900 bytes shallower.

**Warm and cold.** After a non-power reset (watchdog, exception, software restart) the ESP's RTC
memory survives and its RTC counter keeps time, so every age continues and the trust window does
not apply (`restore: warm`). After a power-on reset nothing measures the outage: the flash copy is
trusted only inside `device_power_restore_trust_minutes` from boot, offline member-code
verification waits for the first heartbeat (the step clock cannot be re-derived), and the first
accepted beat replaces everything (`restore: cold`).

**The server's side of the same loop.** A v3 box's restore audit is per court and continuous:
`relight` entries become `RestoreAfterPowerDip` light-state rows for exactly the relays named;
a court the snapshot has said is lit while `relay_state` has said it is dark for two consecutive
beats of an acknowledged `hb:3` box with restore enabled files `restore_not_confirmed` for that
court (BD-6: v2 recorded a partial restore as a full one). The v2 "first heartbeat inside an uptime
window" rule does not apply to v3 boxes, so a late first beat after a long outage is still
recorded (BD-5).

---

## 5. The display and hardware settings

Inside `config`, read one level deep like the 2.x settings, each **clamped independently** by the
bridge (a bad value never costs its neighbours) and passed to the Mega as the `!CFG` key in
brackets. Every number is a `tenant_settings.<key>` with validation and an admin row.

| Key | Default | Bounds | Mega | Meaning |
|---|---|---|---|---|
| `lcd_layout` | `compact` | `compact` · `expanded` | `LAYOUT` | 16×2 (rows 0–1, 16 columns) or 20×4. Unknown → compact. **Per-board override.** |
| `lcd_marquee_enabled` | `true` | bool | `MARQ` | Long rows scroll; off, they are cut and the compact landing pages instead. **Per-board override.** |
| `lcd_marquee_step_ms` | 400 | 250–1000 | `STEP` | One character per step. |
| `lcd_landing_page_seconds` | 4 | 2–15 | `PAGE` | Landing page turn. |
| `lcd_screen_ceiling_seconds` | 60 | 15–120 | `CEIL` | Absolute life of any non-landing state. |
| `lcd_landing_dwell_seconds` | 3 | 0–10 | `DWELL` | Landing held after a ceiling. |
| `lcd_after_lights_on_seconds` | 15 | 5–60 | `AFTON` | Back to landing this soon after a court lights. |
| `lcd_reinit_seconds` | 60 | 30–600 | `REINIT` | Controller re-init and full repaint on landing. |
| `relay_authorisation_cap_minutes` | 240 | 90–720 | `CAP` | A relay re-lit by the bridge alone opens this long after its last grant. |
| `relay_reconcile_min_seconds` | 60 | 30–600 | — | No re-light for less paid time than this (no ten-second pulses). |
| `device_power_restore_trust_minutes` | 20 | 0–120 | — | §4; 0 disables cold restore. Also the gate's. |
| `device_net_fallback_minutes` | 10 | 3–60 | — | §8. Also the gate's. |
| `device_ota_probation_minutes` | 10 | 3–60 | — | §7. Also the gate's. |
| `hw_relay_active_level` | `high` | `high` · `low` | `RPOL` | §12. **Per-board override.** Unknown → no change. |
| `hw_lcd_i2c_address` | 0 | 0 (probe) · 32–39 · 56–63 | `LCDA` | §12. **Per-board override.** Unknown → no change. |
| `hw_scanner_baud` | 0 | 0 (auto) · 9600 · 19200 · 38400 · 57600 · 115200 | `SBAUD` | §12. **Per-board override.** Unknown → no change. |
| `hw_scanner_line_end` | `auto` | `auto` · `crlf` | `SSUF` | §12. **Per-board override.** Unknown → no change. |
| `hw_scanner_gap_ms` | 150 | 50–500 | `SGAP` | §12. **Per-board override.** |

`lcd_hint_seconds` (`HINT`) and `lcd_revert_seconds` (`SCANH`) are the 2.x settings, now delivered
to the Mega as well (BR-15, FWM-16). The **per-board override** for layout and marquee is three-
valued exactly like the button map: absent or null means the club's value, a value means the
board's own; the server resolves it before sending, so the box sees one value. The box echoes the
layout the Mega acknowledged in `lcd_layout` (§2), so the console can show "showing expanded since
18:05" or "asked for expanded, box still compact", and a one-press "Back to compact" is always one
heartbeat from taking effect — and a box that cannot reach the server is compact already.

The five `hw_*` keys follow the thirteen display keys, in the table's order, before `button_map`.
The bridge also derives the Mega's `KEYS` mask from `button_map` (every key whose meaning is not
`minutes:N`) and sends it with the set.

Pinned: `http/` `v3-heartbeat-response-display-expanded`, `-display-out-of-range`, `-hardware`;
the glass itself, `display/`.

---

## 6. Key rotation, and a key that can be restored

v2's *Regenerate key* killed the old key "on the next request", and every board then needed a
reflash (BA-01, BD-3, IO-02). v3 replaces it:

1. **Rotate.** An admin starts a rotation; the server mints key `k<n+1>` and keeps **every
   unretired key valid**. Keys have ids `k1`, `k2`, …; `k0` names the compiled key and is never
   sent.
2. **Deliver.** Every heartbeat of a `key:1` board that has not yet authenticated with the new key
   carries `"key_next": {"id": "k2", "key": "<43 base64url>"}`. The board validates it
   (`provision/` `keys`), persists it atomically, and **authenticates the next request with it**.
   On a 401 it retries that request once with its previous key and keeps both; it never erases a
   key on a 401. It holds at most two: the current and the previous.
3. **Track.** The server records, per board, the id it last authenticated with. The console shows
   each board: *on the new key*, *still on the old key*, or *cannot rotate* (no `key:1`).
4. **Retire.** The old key is retired automatically once every acknowledged `key:1` board is on
   the new one **and** `device_key_grace_hours` (default 168, bounds 1–720) has passed — **never
   automatically while any acknowledged board without `key:1` exists**, because retiring strands
   it. An admin may retire early with a typed confirmation that names the boards it will strand.
5. **Restore a known key.** After a database loss the club must be able to put back the key the
   boards already hold: an owner-only, typed-confirmation *Restore a key* that sets a specific
   43-character key as current, and `Bootstrap:DeviceApiKey` for a rebuilt production stack
   (BD-3, IO-01). The value is never shown again after it is saved, and never logged. "Owner" is
   a deployment's inherent administrator (`Admins:Emails`) — the person who holds the club's secret
   backup; the key that was current stays valid as a previous key until retired.
   `Bootstrap:DeviceApiKey` applies only to a club that has no key yet, never over a live one.

The key travels in plain HTTP on the club LAN, as every request's bearer key already does; v3
changes how a key is replaced, not the threat model. Pinned: `http/`
`v3-heartbeat-response-key-next`, `gate/` `gate-heartbeat-response-v3-key-next`, `provision/`
`keys`.

---

## 7. Signed OTA for the ESP8266 bridge and the ESP32 gate

**The release.** The founder builds an image (`court_bridge` or `door_gate`), and signs it with
`src/iot/tools/ota_sign.py` using the private key only the founder holds. The signature is
**RSASSA-PKCS1-v1_5 with SHA-256, RSA-2048**, over the canonical manifest text

```
crusaders-ota/1\n<target>\n<version>\n<size>\n<sha256 of the image, lowercase hex>\n
```

so the target and the version are inside what is signed: a bridge image cannot be offered to a
door, nor an old signed image as a new version. The public modulus is compiled into each image
(`secrets.h`, `OTA_PUBLIC_KEY_N`, refused at compile time if it is the corpus's test key or a
placeholder) and configured on the server (`DeviceOta:PublicKeyModulus`). RSA verification is a
few dozen lines of modular exponentiation in `devcrypto`, identical on both chips and on the host,
so one implementation is tested against `ota/cases.json` everywhere.

**The server.** An admin uploads the image and the manifest the tool wrote; the server **refuses an
upload whose signature does not verify** against its configured key, whose size exceeds the
target's bound, or whose version is not newer than every release of that target. Releases are
tenant-scoped rows (`tenant_id`, target, version, size, sha256, signature, bytes, uploaded by, at)
with an EF migration and a cross-tenant injection test. A rollout is per release: **off**, **one
board**, or **every acknowledged board of the target**, pausable. `GET /api/v1/device/firmware/{id}`
serves the bytes to an authenticated board of the same tenant with `Content-Length` equal to the
size and `Content-Type: application/octet-stream`, never chunked.

**The offer.** In the heartbeat of a board the rollout includes, whose reported `firmware_version`
is older and which has not reported that version as failed:

```json
"ota": {"target": "court_bridge", "version": "3.0.1", "size": 372144,
        "sha256": "<64 hex>", "sig": "<342 base64url>", "path": "/api/v1/device/firmware/<id>"}
```

**What the board does**, in order; the first failing step is the `fw_error`:

1. **Grammar and gate** (`ota/` `offers`, `versions`): every field present and well formed; target
   its own; version **strictly newer** than the running one, numerically; not in its own list of
   versions that failed (up to four, persisted); `path` matches `^/api/v1/device/firmware/[A-Za-z0-9_-]{1,64}$`.
   **The board pulls only from its configured server**: it builds the URL from its own base URL and
   that path, and an absolute URL is refused. A downgrade is published as a higher version.
2. **Only when idle**: no scan remembered, no button window armed, no pending screen or relay
   acknowledgement, no member input in the last 60 s; on the gate, the lock engaged and no scan
   waiting. Lit courts are fine — the Mega holds them through a bridge restart. The bridge sends
   `!NOTE,…,UPDATING` and `!LIVE,120`; the gate feeds its watchdog per chunk.
3. **Stream and hash**: GET with the bearer key, write into the inactive area (ESP8266: the OTA
   staging space of the 4m2m layout; ESP32: the other app slot) while computing SHA-256; the byte
   count must equal `size`.
4. **Verify before boot**: the SHA-256 equals the offer's, and the signature verifies over the
   manifest text built from the offer's fields. Only then is the image committed (ESP8266: the
   eboot copy command is written; ESP32: the boot partition is switched). Anything else abandons
   the staging area and the running image is untouched.
5. **Probation.** The new image boots in `probation` and is **committed** only when a heartbeat is
   accepted (and, on the court box, the Mega has been heard) within `device_ota_probation_minutes`.
   Three resets before that, or the window passing, **roll back**: the ESP32 switches back to the
   other slot, which still holds the previous image; the ESP8266, whose staging copy overwrites the
   running image, keeps a copy of the previous image in LittleFS (`/ota/prev.bin`, written before
   step 3, its SHA-256 recorded) and flashes it back. The probation counter lives in RTC memory and
   a flash record, and is checked first thing in `setup()`. The board then reports `rolled_back`
   with `fw_failed`, and never takes that version again.

Pinned: `ota/` (all of it), `http/` `v3-heartbeat-response-ota-offer`, `gate/`
`gate-heartbeat-response-v3-ota-offer`. The test keys in `ota/gen_cases.py` sign nothing that is
ever offered to a board.

---

## 8. Network changes, the setup portal, and the link supervisor

**From the server.** A club's device network is a tenant-scoped configuration — up to two WiFi
profiles (SSID, password) and the server base URL — with a version that increments on every save.
Passwords are write-only (never returned by a GET, never logged) and encrypted at rest. A `net:1`
board whose reported `net_ver` is lower, and whose `net_src` is not `local`, is sent:

```json
"net": {"ver": 4, "base": "http://192.168.1.20:8088",
        "wifi0_ssid": "CRUSADERS", "wifi0_psk": "…", "wifi1_ssid": "CRUSADERS-NEW", "wifi1_psk": "…"}
```

- **All or nothing** (`provision/` `nets`): one invalid field and nothing is adopted. A base URL is
  `http://` plus an IPv4 literal or a lowercase DNS name, an optional port, no path — never
  `https`, which the boards cannot open (`provision/` `base_urls`).
- **The previous set is kept as the fallback.** WiFi profiles are tried new first, then the
  previous set, then the compiled defaults; a router migration is therefore *add the new network as
  the second profile, wait for every board's `net_ver`, then switch the router* — no visit. A new
  base URL that yields no accepted heartbeat within `device_net_fallback_minutes` is abandoned for
  the previous one (and reported), so a typo cannot strand the fleet.
- The board reports the version as soon as it is persisted, so the password is not re-sent every
  beat.

**At the board: the setup portal.** For the cases no server can reach — a new router with nothing
pre-staged, a server that moved — a technician:

- **Court box**: power-cycles the box, and within 60 s of power-on holds **court A and court D
  together for five seconds** (the Mega reports `!HELD,09,5`).
- **Door gate**: powers it up, waits for the boot blinks, then holds the board's **BOOT button for
  five seconds** within 60 s (never *during* power-on, which enters the ROM loader).

The board opens a WPA2 access point `CRUSADERS-SETUP-<last four hex of the MAC>` with the password
compiled as `SETUP_AP_PASSWORD` (printed on a label inside the enclosure), serves one page at
`http://192.168.4.1/` (WiFi SSID and password, an optional second profile, the server base URL, and
optionally a device key), validates it with the same rules, saves it as `net_src: local`, and
reboots. The portal closes after ten minutes either way. The court box shows `SETUP AP 1A2B` as a
landing `!NOTE`; the gate shows its setup lamp pattern. A `local` configuration is never overwritten
by the server's `net` until an admin explicitly pushes the club's configuration to that board.

**The link supervisor** (`provision/` `supervisor`), on both chips: the core's own reconnect is
left alone for 30 s; then the board disconnects and reconnects on its next profile, backing off 30,
60, 120, 240 and 300 s; after fifteen minutes down it restarts the chip. The ESP32 core stops
reconnecting for good after some disconnect reasons (DG-3) and the ESP8266 is no better; a restart
is safe on both — the Mega holds its relays, and the gate writes LOCKED before it drives.

**The stall watchdog** (HW-8), on both chips, beside the supervisor: if the link is **up** but no
heartbeat has been accepted for **six hours** (a radio or lwIP state that keeps yielding, which no
hardware watchdog ever trips), the board restarts itself the next time it is idle (§7, step 2's
rule), at most once per six hours, and reports `diag.reset: software` on the next accepted beat.
Like the supervisor's timings it is a recovery mechanic, not a club preference, so it is a
contract constant and not a tenant setting.

---

## 9. Smaller v3 fields

- **`/activate` answers `play_remaining_seconds`** beside `granted_seconds`: the uncapped time to the
  end of the chained run. `granted_seconds` stays capped at 5400 for the relay; the bridge arms its
  `!EXT` relighting from the uncapped field, falling back to `granted_seconds` when it is absent. A
  105-minute booking activated online went dark at minute 90 (FSF-05). Pinned:
  `v3-activate-response-play-remaining`.
- **Release events carry `cause`**: `member`, `autooff`, `cap`, `mega_reset` or `reconcile`; absent
  reads as `member` (every 2.x box). §3 says what the snapshot does with it. Pinned:
  `v3-events-request-release-cause`.
- **An implausible release never pairs.** A release whose `duration_ms` exceeds the longest a relay
  can stay closed (`relay_authorisation_cap_minutes` at its upper bound, 720 minutes, plus a
  minute) is a box's arithmetic error, not a member leaving: it is receipted and audited
  (`device.release_implausible`) and never removes a booking from the snapshot (MCV1-01).
- **The events reply is frozen** at `{"accepted_through": <seq>, "recorded": <n>}` and at most 96
  bytes: every firmware reads it into 192 (FC-5). New information goes in the heartbeat.

---

## 10. The admin surface each setting needs

Every row below states its bounds (served by the API, never duplicated in the client — FA-2/BA-05
were a client range that drifted from the server's), its "takes effect within one heartbeat"
wording, and reads back after a save.

- **Settings › Box screens & scanning**: every 2.x box setting the heartbeat already delivers and
  the console never showed (`lcd_choice_seconds`, `lcd_card_seconds`, `scan_memory_seconds`,
  `clock_trust_minutes`, `relay_restore_enabled`, `device_fault_reporting`,
  `device_fault_max_per_hour` — FA-4, BA-03), with copy that names what each governs (FA-5), plus
  the twelve v3 club settings of §5 and `device_key_grace_hours`. A **landing preview** renders both
  layouts from live control-board data with the `display/` composition rules. The dead
  `rapid_scan_window_seconds` row goes (FA-10).
- **Boards, per board**: layout and marquee overrides (club / compact / expanded; club / on / off)
  with the acknowledged layout and since when, and a one-press *Back to compact*; firmware — running
  version against the latest release of its target, `fw_state`, failed versions, and the Mega's
  version and last reset cause (FA-12); key status (§6); network version and source (§8); caps.
- **Boards, per board, hardware** (§12): the five `hw_*` overrides (club / a value) beside what the
  Mega reports it is actually running with (`mega.lcd`, `mega.relay`, `mega.scan_baud`,
  `mega.scan_end`, `mega.keys`), *no LCD answered* as an attention state, and the bench procedure's
  steps as a checklist; health (§13): last reset reason in plain words, free heap and largest block
  against the planning floor, stack low-water mark, OTA space, the `!DIAG` counters' rises, and a
  *could not read part of the server's answer* notice while `drift` is reported.
- **Member codes › Rollout** (FA-3, MCV1-03, MCV1-09): the phase, the boards blocking cut-over —
  including every enabled court box that is unacknowledged — with *Acknowledge* and *Disable*
  beside each, the manual hold, and the keys each acknowledged board was last sent and how many
  were trimmed ([`member-code.md`](member-code.md) §8).
- **Boards › Device key**: *Rotate key* (replacing *Regenerate*), per-board status, *Retire old key*
  (blocked or typed-confirmed as §6 says), *Restore a key* (owner only).
- **Boards › Club network**: the two WiFi profiles (passwords write-only) and the server base URL,
  validated with the `provision/` rules and warned in plain words ("every board will try this
  address; if it is wrong they return to the old one after 10 minutes"); per-board applied version;
  *Push to this board* for a `local` one.
- **Boards › Firmware**: upload an image and its manifest (refused unless the signature verifies),
  the releases per target, the rollout (off / one board / all), pause, and per-board progress.
- **Control board**: a lit court's countdown is the **lights'** time left (`lights.seconds_remaining`),
  not the booking's (FA-8); *lights on, nothing booked* and *checked in, lights confirmed off* are
  attention states (BA-04); the offline banner names the boxes' last-heard time (BA-09). Faults copy
  explains a board restart and a Mega reset cause in plain words, and a door's "stopped reporting"
  talks about doors (BA-22).

---

## 11. Forward compatibility for the life of the frozen firmware

The Mega 3.0.0 image is the last that chip will ever get. Each ESP image can be replaced over the
air — but only for as long as its heartbeat parser, its key ring and its OTA download keep working
against whatever server it meets next. A server change that breaks any of those three strands the
fleet on its current image for good, with no cable flash left to fix it. So the contract binds
**both** sides for the life of the firmware, and the late analysis found every place it did not
(FC-1…FC-13).

### 11.1 The lifeline

The **lifeline** is the bearer key and `key_next` (§6), `net` (§8), the `ota` offer and the
firmware download (§7), and the bare heartbeat that carries them. Its rules are **append-only
forever**: no field is renamed, retyped or removed; the offer grammar, the manifest text, the
download path and the bearer header stay exactly v3's; a later server may add fields to these
objects, and a v3 board ignores them.

- **The lifeline is read independently of everything else.** A board adopts `ota`, `key_next` and
  `net` from any complete object, even when its `config`, `courts`, `roster` or member-code keys
  are in a grammar the board no longer understands (`compat/` `cb-lifeline-with-drifted-rest`).
- **The server never starves it.** Budget pressure sheds member-code keys first and never a
  lifeline object; if the rest of a body could ever not fit with every key shed, the server
  alternates a **lifeline-only** body — `server_time`, `tenant_slug`, `device_code`,
  `heartbeat_seconds` and the lifeline objects — with the full one (`http/`
  `v3-heartbeat-response-lifeline-only`). Absent is "no opinion", so the board keeps everything
  else.
- **Probation commits on an accepted beat, not a readable one**: a new image is committed by a 2xx
  complete object (§7 step 5), so an image whose roster reader is broken can still be replaced by
  the next.

### 11.2 How a v3 board reads a server body

Every rule here is code in `compat/gen_cases.py` and a vector in `compat/cases.json`.

1. **One complete object.** A UTF-8 BOM and leading whitespace are skipped and whitespace between
   tokens is tolerated; anything that is not one complete object — cut, HTML, a top-level array,
   empty, nested past 32 levels, or as long as the board's buffer — adopts **nothing** and spends
   nothing (no restore, no probation, no clock). The server sends compact JSON with no BOM, no
   newline and nesting at most three deep (body → object → array).
2. **Known keys are read only where they live.** Top-level keys at the top level; `config` keys
   one level inside `config` (`button_map` included — never by a flat search of the whole body,
   FC-7); the gate's settings as scalars at the top level of `gate` (a nested object there is never
   a setting, FC-12); a lifeline object's fields inside that object. An unknown key, of any JSON
   kind, at any position, is skipped whole. Duplicate keys resolve first-wins; the server never
   emits one.
3. **Kinds are exact.** An integer setting is a JSON integer literal: a fraction, an exponent, a
   quoted number, a negative (for an unsigned field) or a bool reads as **absent** — the previous
   value is kept and the key is reported in `drift` — never truncated (FC-11: 2.3.0 read 45.9 as
   45 and 4.5e1 as 4). A bool is `true` or `false` only. An out-of-range integer clamps.
4. **Enumerations fall to safe.** An unknown `lcd_layout` is compact; an unknown value of any other
   enumerated setting keeps the current value — in particular a relay drive level is never flipped
   by a value the board does not know.
5. **Element grammars only grow at the end** (FC-1). Each `|`-separated element is read by its
   first *N* fields — roster 4, `courts` 5, `relays` 3, `code_days` 2 — and anything after them is
   ignored; a `code_keys` element is its first 21 characters, followed by nothing or by `|`.
   Unreadable elements are skipped one by one. **A non-empty array of which nothing was readable
   keeps the previous value** and is reported in `drift`: a grammar the board does not know is
   never committed as "no bookings" or "no keys". An explicit `[]` is committed (empty roster,
   empty key ring — the withdrawal rule of [`member-code.md`](member-code.md) §5.2), except
   `courts`, where an empty snapshot changes nothing (§4). `court_numbers` is positional, so one
   unreadable element keeps the whole previous map.
6. **Every 2xx is a success** (FC-4). 2.3.0 read any success but exactly 200 as a decided refusal
   at walk-up and extend — the member was charged and the court stayed dark. For each endpoint:

   | Endpoint | 2xx, readable | 2xx, unreadable | 401 | 408, 429, 5xx, no answer | other 4xx |
   |---|---|---|---|---|---|
   | heartbeat | adopted | nothing adopted; the link is up | retry once with the previous key (§6) | backoff | backoff |
   | activate | decided by the body | **undecided**: the roster decides | undecided | undecided | undecided |
   | walkup · extend | decided by the body | **undecided**: `BUSY` / `PRESS AGAIN`, scan **and nonce kept**, so the retry is the same purchase | undecided | undecided | decided refusal (the body's `error`, or unknown) |
   | events | `accepted_through` released | nothing released, retried with backoff | — | backoff | backoff |
   | gate | decided by the body | **undecided**: decided offline | undecided | undecided | undecided |

   "Readable" means the fields the decision needs are present with the right kinds: `activated`
   (and `granted_seconds` when true), `granted_minutes`, `extended_minutes`, `accepted_through`,
   `opened` (and `unlock_seconds` when true). The server answers every device success with
   exactly **200**; the table is what keeps a proxy or a later framework's 201 from charging a
   member for a dark court.

### 11.3 What the server must never do, and the tests that hold it

The backend pins each of these with a test against its **real** serialisers, not the corpus:

- every device success is status 200 exactly (`/heartbeat`, `/activate`, `/walkup`, `/extend`,
  `/events`, `/gate`, `/pay-for`), and the firmware download is 200 with `Content-Length`;
- device bodies are compact, ASCII (non-ASCII as `\uXXXX`), with no BOM, no newline, no duplicate
  key and nesting at most three;
- every numeric field of every device body is an integer kind and every flag a bool;
- every element's arity: roster 4, `courts` 5, `relays` 3, `code_days` 2, `code_keys` 21
  characters; `button_map` appears only inside `config`; the `gate` object holds scalars only;
- the events reply has exactly its two keys;
- each endpoint's widest real body stays inside its `compat/` `budgets` row, built at the **true**
  widest (false bools, every number at its widest width, the 64-character slug, maximum court
  digits — FC-3's complaint was a widest test that under-modelled all of these);
- the server's shedding is **counted and surfaced**: every heartbeat whose `code_keys` were trimmed
  records how many, shown per board, and raises a device notice the first time (FC-3: 2.x shed
  keys silently with 20–50 bytes of headroom).

### 11.4 Budgets

`compat/cases.json` `budgets` is the single table: for each device, firmware generation and
endpoint, the buffer the board reads into (or renders into, for a request) and the most the server
may send (or the least it must accept). For every v3 response **the server's maximum is at most
80% of the board's buffer**, so a field added later cannot reach the edge unnoticed. v3 court box:
heartbeat 4096 of 5120, activate/walk-up/extend 300 of 512 (2.3.0: 384), events 96 of 192;
heartbeat request 1536. v3 gate: heartbeat 6144 of 8192, scan decision 110 of 256 (1.x: 128),
events 96 of 192. The C# suite asserts its widest bodies against `server_max`; each firmware suite
asserts its compiled buffer constants equal `firmware_buffer`.

**Key priority.** A v3 court box's key ring holds **64** keys (2.x: 24; MCV1-07 found booked
members refused offline because the 24-key cap trimmed them). The server writes `code_keys` in
priority order — slot-0 keys of entries whose window is already open, then by window start, slot-1
keys last — so shedding last-first drops the least-needed. At the true widest body 42 fit; a
realistic body fits all 64.

### 11.5 The server's real replies, through the board's real parsers

The corpus pins bytes somebody wrote down; it cannot notice that the server has started sending
something else (FC-9). `make device-replay-check` closes that gap:

1. The backend's `DeviceReplyEmitterTests` (Postgres-backed) drive the real endpoints through a
   scenario matrix — a fresh box and an acknowledged one, every caps combination a 2.x and a v3
   board send, empty and full rosters, a snapshot with a chained extension, an OTA offer, a key
   rotation, a network change, the widest body, and each scan endpoint's grant and refusals — and
   write each reply, when `DEVICE_REPLAY_DIR` is set, as `<endpoint>/<scenario>.json`:
   `{"device": "court_box"|"door_gate", "caps": [...], "endpoint": "...", "status": 200,
   "body_hex": "...", "expect": {...}}`, where `expect` is what the server knows it sent (court
   numbers, snapshot elements, roster and key counts, the config values, the lifeline objects'
   ids). It also writes `index.json`: `{"count": n, "files": [...]}`. Without the variable the
   same test still runs and asserts every reply against its budget.
2. The court box's `test_server_replies` and the gate's `test_gate_server_replies` (native) read
   every file the index names, feed each body through the board's own adoption or classification
   code exactly as the device would, and assert: the body is complete and inside the buffer,
   `drift` is empty, and every `expect` value was adopted. They fail if they read fewer files than
   the index declares, and if `DEVICE_REPLAY_DIR` is set and the index is missing.

CI runs it on every push that touches `src/backend/**/Device*`, `src/iot/**` or
`src/contracts/**`.

## 12. Hardware facts, delivered at runtime

Every fact the Mega fixed at build time was evidenced by somebody's sentence, an old sketch or a
photo that is no longer on disk (HW-1…HW-11). On the last image each becomes a setting (§5's five
`hw_*` keys, per board, sent in `config` and passed to the Mega as `!CFG`), with a default that is
safe when it is wrong, and each effective value is reported back (`mega` in the heartbeat, from the
Mega's `!HW`). The Mega's half is
[`device-serial-protocol.md`](device-serial-protocol.md), *Hardware facts*.

| Fact | Default | Wrong default means | Remote fix | Reported |
|---|---|---|---|---|
| Relay drive level | `high` (the 2.1.0 build) | courts stay **dark** when lit — never lit when off, because a released relay is an input | `hw_relay_active_level` | `mega.relay` |
| LCD backpack address | probe 0x27, 0x3F, 0x20–0x26, 0x38–0x3E | nothing — the probe finds it | `hw_lcd_i2c_address` | `mega.lcd` (`00` = none answered) |
| LCD geometry | compact (16×2) | nothing — compact is whole on either panel | `lcd_layout` | `lcd_layout` |
| Scanner baud | auto from 9600 | nothing — auto-detect while idle | `hw_scanner_baud` | `mega.scan_baud` |
| Scanner line end | CR, LF or a 150 ms gap | nothing — a suffix-less scanner works | `hw_scanner_line_end`, `hw_scanner_gap_ms` | `mega.scan_end` |
| Which keys are court keys | from `button_map` | — | `button_map` (per board) | `mega.keys` |
| Mega firmware and reset cause | — | — | — | `mega_version`, `mega.reset` |

**What is still physical, and is a bench step, not a setting** — the button wiring order (remapped
by `button_map` once observed), the relay module's part number, rating and output type and whether
it switches a contactor coil or the load ([`../../memory/safety-relays.md`](../../memory/safety-relays.md)),
the panel's real geometry, the bootloader surviving a watchdog reset (FWM-11), and the ESP8266's
flash size. The procedure, step by step, is
[`lights-controller.md`](lights-controller.md) *Commissioning the hardware facts*.

## 13. What every board reports about itself

After the last cable flash the club's only window into a board is its heartbeat. A field crash, a
brown-out, a wedged LCD or a heap running out must be visible from the office, or it shows up as
"the box is unreliable" (HW-3, HW-6, ESPR-2).

**`mega`** (court box), absent until the Mega has been heard this Mega boot:

| Key | From | Meaning |
|---|---|---|
| `reset` | `!BOOT` | `MCUSR`, two uppercase hex digits: bit0 power-on, bit1 external, bit2 brown-out, bit3 watchdog |
| `lcd` | `!HW` | the backpack address that answered, two uppercase hex digits; `00` none |
| `relay` | `!HW` | `high` or `low`, the level the Mega drives "on" at |
| `scan_baud` | `!HW` | the rate in use; 0 while auto has not locked |
| `scan_end` | `!HW` | `auto` or `crlf` |
| `keys` | `!HW` | the unarmed-forward mask, two uppercase hex digits |
| `diag` | `!DIAG` | `[lcd_errors, lcd_reinits, rx_overruns, ceilings, cap_offs]` since that Mega boot |

**`diag`** (both boards), every beat:

| Key | Meaning |
|---|---|
| `reset` | why this boot began: `power_on`, `external`, `software`, `exception`, `hw_wdt`, `soft_wdt` (ESP8266), `task_wdt`, `int_wdt`, `panic`, `brownout` (ESP32), `deep_sleep`, `unknown` |
| `exc`, `epc1` | the exception cause and faulting address after an `exception`/watchdog reset on the ESP8266 (`ESP.getResetInfoPtr()`); 0 otherwise and on the ESP32 |
| `heap`, `heap_min` | free heap now, and the lowest the loop has seen since boot |
| `block` | the largest free heap block now |
| `stack_min` | the lowest free stack since boot: the ESP8266's continuation stack (`ESP.getFreeContStack()`, never reset), the ESP32's loop task high-water mark, in bytes |
| `sketch_free` | the space an OTA image can be staged into (the 4m2m OTA area; the ESP32's other app slot) |
| `flash_mb` | the real flash size, in MB |

Every value is a JSON integer except the named strings. The server stores the latest per board,
shows them (§10), and raises a device notice when a board restarted for a reason other than
`power_on`/`software`, when `block` falls below **4096** or `stack_min` below **512** (the planning
floors: ESPR-6 measured the bridge's whole heap at 33,440 bytes with about 20–23 KB free in steady
state, and its worst static stack path within about 300 bytes of the 4 KB continuation stack), and
while `drift` is reported. The floors are contract constants for the same reason as the
supervisor's.

**A CI budget gate holds the margins** that this telemetry can only report after the fact
(ESPR-4): the `court_bridge`, `door_gate` and `court_mega` CI builds compile with `-fstack-usage`,
and `src/iot/tools/stack_budget.py` fails the build when — bridge — `loop()`'s own frame exceeds
256 bytes, any project frame exceeds 512, or the computed worst path from `loop()` exceeds 3000 of
the 4096-byte continuation stack (leaving room for the 256–624 bytes an interrupt adds on the
same stack); gate — the worst path from `loopTask` exceeds 6000 of 8192; Mega — static RAM exceeds
4096 of 8192 bytes. It also fails the bridge when static RAM leaves less than 24 KB of heap. The
worst-path analysis resolves `-mlongcalls` literals, tail calls and vtable slots, and covers the
SDK, lwIP and libc objects, as the analysis's `stackan.py` did.

## 14. Decided against, and deferred

- **No remote "switch a court off" in v3.** The Mega already obeys `!OFF`, so the capability can be
  added later by a server change and a bridge OTA alone, with no Mega flash; it is not on the
  founder's list, and an off authority on the heartbeat is the one thing a dropped or replayed
  response must never be able to exercise. Deferred, not rejected (FA-9, BA-27).
- **No admin-signed configuration QR at the door** (DG-1 c). The setup portal covers the same case
  with less code; a long-line scanner path would be a second parser on a board with no screen.
- **No relay state in the Mega's EEPROM** — [`device-serial-protocol.md`](device-serial-protocol.md),
  v3, *Relay reconcile*.
