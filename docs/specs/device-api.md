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
  `v3-heartbeat-response-widest`, 3522 bytes). Gate: **4096** for a 1.x gate (unchanged), **6144**
  for a v3 gate (a 2.0.0 gate reads into 8192; the widest — `membercode/gate.json`'s
  `gate-heartbeat-response-codes-full` plus every v3 object at its bound — measures 5022 bytes, and
  the backend lane pins it with a server-side size test because the gate family's vectors must be
  byte-identical to what the server serialises). The server keeps every body inside its contract by
  dropping `code_keys` last-first, then `net`, then `ota` — never `courts`, `roster` or `config`.

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

Pinned: `http/` `v3-heartbeat-request`, `-first-beat`, `-rolled-back`, `-relight`; `gate/`
`gate-heartbeat-request-v3`, `-cold-restore`, `-rolled-back`.

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

- `lit` 1 means some checked-in, not-cancelled booking is in play on that court **now**.
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

Pinned: `http/` `v3-heartbeat-response-snapshot`, `-unacknowledged`, `-widest`.

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

**What the bridge persists to flash** (LittleFS; written when the content changes, at most once a
minute for the snapshot, so wear is negligible; each record carries its own check digits and a
damaged one reads as absent):

| Record | Why |
|---|---|
| the last accepted heartbeat's `courts`, `court_numbers`, `config` and `button_map`, with the uptime it was received at | a box that boots with the server down still has its court map, buttons, layout and settings, and can restore (BR-06, BD-4) |
| the roster and member-code sync | offline scans after a power cut, under the same trust window |
| **every undelivered event** (activations, releases, faults) — written on push, cleared on the server's `accepted_through` | a power cut with the network down no longer turns members who played into no-shows (BR-07) |
| the network set and keys (§6, §8), the OTA state (§7) | how the box reaches the club |

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

## 5. The display settings

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

`lcd_hint_seconds` (`HINT`) and `lcd_revert_seconds` (`SCANH`) are the 2.x settings, now delivered
to the Mega as well (BR-15, FWM-16). The **per-board override** for layout and marquee is three-
valued exactly like the button map: absent or null means the club's value, a value means the
board's own; the server resolves it before sending, so the box sees one value. The box echoes the
layout the Mega acknowledged in `lcd_layout` (§2), so the console can show "showing expanded since
18:05" or "asked for expanded, box still compact", and a one-press "Back to compact" is always one
heartbeat from taking effect — and a box that cannot reach the server is compact already.

Pinned: `http/` `v3-heartbeat-response-display-expanded`, `-display-out-of-range`; the glass
itself, `display/`.

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
   (BD-3, IO-01). The value is never shown again after it is saved, and never logged.

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

---

## 9. Two smaller v3 fields

- **`/activate` answers `play_remaining_seconds`** beside `granted_seconds`: the uncapped time to the
  end of the chained run. `granted_seconds` stays capped at 5400 for the relay; the bridge arms its
  `!EXT` relighting from the uncapped field, falling back to `granted_seconds` when it is absent. A
  105-minute booking activated online went dark at minute 90 (FSF-05). Pinned:
  `v3-activate-response-play-remaining`.
- **Release events carry `cause`**: `member`, `autooff`, `cap`, `mega_reset` or `reconcile`; absent
  reads as `member` (every 2.x box). §3 says what the snapshot does with it. Pinned:
  `v3-events-request-release-cause`.

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

## 11. Decided against, and deferred

- **No remote "switch a court off" in v3.** The Mega already obeys `!OFF`, so the capability can be
  added later by a server change and a bridge OTA alone, with no Mega flash; it is not on the
  founder's list, and an off authority on the heartbeat is the one thing a dropped or replayed
  response must never be able to exercise. Deferred, not rejected (FA-9, BA-27).
- **No admin-signed configuration QR at the door** (DG-1 c). The setup portal covers the same case
  with less code; a long-line scanner path would be a second parser on a board with no screen.
- **No relay state in the Mega's EEPROM** — [`device-serial-protocol.md`](device-serial-protocol.md),
  v3, *Relay reconcile*.
