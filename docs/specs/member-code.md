# The single rotating member code (D1)

One code per member, on their phone, that opens a door, lights their own court — or a court they
are an accepted partner on — and pays for somebody else's court at the box. It changes every
thirty seconds, it is generated on the phone with no network, a door or a court box can check it
with no network, and money moves on it only when the server has checked it too.

This document is the behaviour oracle. `src/contracts/device-protocol/membercode/manifest.json`
names it as its authority, and the corpus is generated from these definitions by
`src/iot/tools/membercode_vectors.py` — Python's own `hmac`, `hashlib` and `zoneinfo`, so none of
the four implementations that read it (the court bridge, the door gate, the server, the phone) is
checked against itself. A sentence here that the corpus contradicts is a defect in one of the two.

Decisions it implements: **D1** (one time-based code, generated offline, verified offline by
devices, wallet spends online-only), **D10** (pay-for at the box), and the roster half of
**D11/D12** (a booking's roster entry names up to four players, so an accepted partner opens the
door and the court with their own code). Binding constraints, restated because every design
choice below is shaped by them: **no wiring or hardware change**, **the Mega is not reflashed and
its serial dialect is untouched** — which is why the whole token has to fit the limits the Mega's
firmware already enforces — and the club's WiFi credential appears nowhere.

---

## 1. What changes for a member, a box and a door

| Before | After |
|---|---|
| A booking code per booking (12 Crockford characters), plus a separate 60-second member QR for walk-ups | One code per member, 19 characters, rotating every 30 s, shown on **My Code** |
| A door or box offline matches the scanned bytes against its roster | It **verifies** the code's OFF half against a per-day key, then looks the **member** up in the roster |
| A roster entry names a booking by its code | A roster entry names a booking by its **players** (organiser first, then accepted partners) |
| Paying for somebody else's court happens in the app only | It can also happen at the box: scan, press the booked court, press it again (§9) |

Legacy codes keep working, online, until the cut-off (§8). Nothing about a legacy code's wire
bytes changes on any path.

---

## 2. The threat model, stated rather than implied

The device contract is hobby grade by founder decision (`memory/decisions-device.md`): cleartext
HTTP on the club LAN, one per-tenant bearer key, auto-registration. This design does not change
that; it narrows what a code is worth.

- **A code is a 90-second bearer token** (±1 step around a verifier's own step), not a standing
  key. Anybody holding the phone, or a photo of its screen, can use it inside that window —
  once: the server's use table and each device's replay ring make every code single-use per
  acting use (§4.4, §6.4), and a device records an online use too, so a code the server acted on
  cannot be used again offline at that device when the link drops. **One widening, stated:** the
  server checks a code at the instant the device says it was read (`scan_age_ms`, §4.2), so a
  holder of the club's device key could present a photographed, unused code as up to
  `scan_memory_seconds + lcd_choice_seconds` (at most 6 minutes) old. The device key is already
  worth more than any code (`door-gate.md` §10a).
- **OFF can be guessed, and that is bounded rather than denied.** Six digits tried at three steps
  is 3 in a million per guess, and a REF is public. A device therefore counts wrong codes: five
  inside a minute lock its offline verification for a minute, each further lock doubling to 30
  minutes, until a code verifies (`memcode/GuessGuard.h`). That leaves an attacker with a
  sustained offline door under a one-in-a-thousand chance a day (about 260 guesses), at the price — stated —
  that a lock refuses legitimate members offline too. Online, the server's own limits apply.
- **ON is keyed by the member secret S, which exists only on the server and on the member's
  phone.** No device ever holds S, an ON, or the master key. Every money movement needs ON.
- **OFF is keyed by K_day, which devices hold** for the members their roster names, for the club
  day(s) the roster covers. A stolen court box or a copied heartbeat body forges OFF halves for at
  most 24 (box) / 72 (door) members, for about a day — and every forgery is caught when its
  evidence reaches the server, because the server re-checks ON (§7).
- **A REF is not a secret.** It is printed inside every code. That is why a roster's REF lists
  are matched only against a REF the verifier has already PROVED, and a scanned string is never
  matched against a REF list (§6.3).

---

## 3. Definitions — exact

Notation: `HMAC` is HMAC-SHA-256 (RFC 2104). `|` inside a quoted label is the literal character.
UUIDs are canonical lower-case 36-character strings. All labels are ASCII.

### 3.1 The master key

`MemberCodes:MasterKey` — 32 to 64 random bytes, base64, server configuration only. The server
refuses to start anywhere but Development when it is absent, shorter than 32 bytes, a known
placeholder (the `JwtSecretPolicy` rule), a key published in the repository (the development key,
the test host's old fixed key, `derivation.json`'s `fixture_master_key_hex`), or visibly not
random (fewer than 16 distinct byte values). Changing it changes every member's secret at once (every phone
re-enrols); there is no key identifier and no dual-key window in v1.

### 3.2 The member secret S (32 bytes)

```
S = HKDF-SHA-256( salt = "crusaders/member-code/v1",
                  IKM  = master key,
                  info = "member-secret|" + tenant_id + "|" + user_id + "|" + generation,
                  L    = 32 )
```

`generation` is a positive decimal integer with no leading zeros, starting at 1. **Rotation is
`generation += 1`**; nothing else is stored. The server never persists S.

### 3.3 The REF (4 characters)

A member's identity inside the tenant: a 20-bit value `r` in `[1, 2^20 − 1]`, rendered as four
Crockford base32 characters, most significant first, alphabet
`0123456789ABCDEFGHJKMNPQRSTVWXYZ`. `0000` (r = 0) is reserved and never assigned. Assigned by the
server, randomly, unique within the tenant, **stable across rotations**, and never reassigned to a
different member while the old member row exists.

**Decoding normalises** (for the token only — §3.8): ASCII only, then case-fold; `I`, `i`, `L`,
`l` read as `1`; `O`, `o` read as `0`; `U`, `u`, a hyphen, whitespace, any non-ASCII character
(a dotless `ı` is not an `I`) or anything else refuses. **Server-produced
REFs (roster entries, key elements) must be canonical** — upper-case, no substitutions — and a
device refuses a non-canonical one rather than normalising it.

### 3.4 The step

`T = floor(unix_seconds / 30)`, T0 = 0 (RFC 6238). A 64-bit counter on the wire of the HMAC,
a 32-bit number everywhere else (good until the year 6053).

### 3.5 ON (8 digits)

```
ON = HOTP(S, T, 8) = ( DT( HMAC(S, T as 8 bytes big-endian) ) mod 10^8 )
```

`DT` is RFC 4226 §5.3 dynamic truncation over the 32-byte digest: `offset = digest[31] & 0x0F`,
`binary = (digest[offset] & 0x7F) << 24 | digest[offset+1] << 16 | digest[offset+2] << 8 |
digest[offset+3]`. This is exactly RFC 6238's SHA-256 mode; Appendix B's six SHA-256 vectors are
in `totp.json`. Rendered zero-padded to 8 digits.

### 3.6 The club day

The tenant-local calendar date (IANA time zone of the tenant) of the step's **first** instant,
`T × 30` seconds, formatted `YYYY-MM-DD`. A club day is the half-open step range
`[first, end)` from local midnight to the next local midnight: 2880 steps normally, 2760 or 3000
on a daylight-saving change, 3120 in the one inhabited zone that shifts by two hours
(Antarctica/Troll). Local midnight falls on a step boundary in every real zone.

### 3.7 K_day (12 bytes) and OFF (6 digits)

```
K_day = first 12 bytes of HMAC(S, "crusaders/kday/v1|" + club_day)
OFF   = HOTP(K_day, T, 6)
```

**Domain separation.** S keys two HMACs: ON's, over exactly 8 bytes, and K_day's, over the
28-byte label that begins `crusaders/`. No input to one can be an input to the other, so no K_day
equals, or says anything about, an ON digest.

**Why 12 bytes.** 96 bits against an attacker brute-forcing one day's key from observed codes is
not a practical attack, and 12 bytes is exactly 16 base64url characters — the difference between
a door's heartbeat body fitting its 4096-byte contract with headroom and not (§5.4).

### 3.8 The token (19 characters)

```
"1" + REF + ON + OFF          e.g.  1 18Y9 56008441 714835  →  118Y956008441714835
```

- **Length alone separates a v1 token from every legacy code**, which are all exactly 12
  characters (`AccessCode.Length`). Nothing can be read both ways.
- **Parse**: exactly 19 characters; the first is `1` exactly (never normalised); the REF decodes
  per §3.3 and is not `0000`; the last 14 are ASCII digits. Anything else is malformed.
- It uses only `[0-9A-Z]`, so it sits in `roster::isTokenChar` and in QR alphanumeric mode, and it
  fits every buffer between the scanner and the server: the Mega's scan line and `!SCAN`
  argument (24), the door's assembler and the roster token cap (20), an event subject (32).
  Those fits are `static_assert`s where the constants meet (`RosterTokenFits.h`, `GateFlow.h`,
  `CodeSync.h`).

Worked example — `derivation.json`, case `dean-gen1`, anchor `2026-09-23T18:00:17+02:00`,
`T = 59672640`: S = `aca5e9d6…9b5387`, REF `18Y9`, K_day(`2026-09-23`) = `1e4139587bd643439ef51765`
(`HkE5WHvWQ0Oe9Rdl`), ON `56008441`, OFF `714835`, token `118Y956008441714835`.

---

## 4. Verification by the server (online)

### 4.1 Where

Every device path that carries a scan accepts a v1 token in the field it already has (`token`):
`/api/v1/device/activate`, `/walkup`, `/gate`, `/pay-for`. Legacy tokens stay valid until the
cut-off (§8). The member endpoints never take a code.

### 4.2 `scan_age_ms`

Activate, walk-up and pay-for requests carrying a **v1** token append `"scan_age_ms": N` — how
long ago the scanner read it — **last** in the body. A walk-up or a pay-for is sent after one or
two button presses, so the code on the wire can be several steps old by then. Absent means 0 (the
door gate never sends it: it asks the moment it reads). A legacy token's body is byte-for-byte
what it always was. The server refuses a value above **`(scan_memory_seconds +
lcd_choice_seconds) × 1000 + 30 000`** — the tenant's own settings, at most 390 000 — as
`not_recognised`: the box never remembers a scan longer than scan memory plus one pay-for
question.

### 4.3 The check

```
r   = request_received_at − scan_age_ms
t   = floor(r / 30 s)
for s in t, t−1, t+1:
    if ON(S_current, s) == token.ON and OFF(K_day(S_current, club_day(s)), s) == token.OFF:
        accept at step s
```

Both halves, at the **same** step, under the member's **current** generation. A code from an older
generation is `not_recognised`. The REF resolves to a member of **this tenant**; another tenant's
REF, an unassigned REF, a member without a membership row that may act — all `not_recognised`,
one reason for every case, so the path is not an oracle for which REFs exist.

### 4.4 Single use

Table `member_code_uses(tenant_id, ref, step, use_class, used_at, device_id, kind)`, unique on
`(tenant_id, ref, step, use_class)`, where `use_class` is **`door`** (a gate opened), **`court`**
(an activation granted, online or as offline evidence) or **`money`** (a walk-up charged, a
pay-for paid). A code is used once **per class**: a member who opens the front door and scans at
their court inside the same 30-second step is doing two different things, and must not read
`CODE USED` at the court — or, offline, have their attendance treated as a duplicate. A row is
written **only when the server acts**, never for a refusal or a quote, so a member told
`too_early` who scans again is not refused as a replay. A second acting use in the same class is
refused with reason **`code_used`** — on `/activate`, `/gate` and `/pay-for` as a 200 decision,
on `/walkup` as `409 {"error":"code_used"}` (the court box reads every one of them — activation,
walk-up and pay-for alike, §9.3 — as `CODE USED / WAIT 30 SECONDS`, and none arms its buttons: a
used code may be a photo — the box forgets the scan as well, so nothing behind its button window
can send it as a buyer). Idempotent retries are
checked **before** the use table: a walk-up or pay-for replaying its own nonce is answered with the
first result (`replayed: true`), never `code_used`. Rows older than a day are purged.

**Money is refused across the court class too** (review round 8, D8-1). A photo of the code that
has just lit a court is a code whose `court` use is spent and whose `money` use is not, so per
class alone it bought a walk-up or paid for somebody's court on the member whose court it lit. A
walk-up, a pay-for quote and a pay-for confirm are therefore `code_used` when the same `(ref,
step)` holds a `court` **or** a `money` use; and an activation whose answer would be a booking
refusal — `no_booking`, `wrong_court` — is `code_used` instead when the code holds either, because
the box arms its buttons for those two and the photo, shown at a second box, would arrive as a
known member with nothing booked. **And the other way round:** an activation that would light a
court is `code_used` when the same `(ref, step)` holds a `money` use — the court class of a code
that bought a walk-up or paid for a court is unspent, so a photo of it, shown at a second box,
lit the member's own booking there. Same answer as any `code_used` on `/activate`: nothing lit,
nothing charged, no use row, no audit row. So, stated both ways: a code with a court use buys
nothing, and a code with a money use lights nothing. The member's own re-scans at the box that
acted are unaffected because they never reach this rule — the box refuses or answers a known
replay itself (§6.5: `ALREADY LIT` on the member's own court). The door class is in no rule:
front door then a court, or front door then a purchase, inside one step is still two things.
The member's next code, thirty seconds on, is unaffected.

---

## 5. What a device is sent

### 5.1 The capability

A device that speaks this contract says so on **every** heartbeat, as the last field:

```json
{"mac":"5ccf7f0a1b2c","firmware_version":"2.1.0","uptime_ms":86400000,"caps":["codes:m1"]}
{"mac":"5ccf7f0a1b2c","firmware_version":"1.1.0","uptime_ms":86400000,"kind":"gate","caps":["codes:m1"]}
```

After any diagnostics (`restored_relays`, `relay_state`, `no_push`, `events_lost`). A device that
names no capability renders exactly the body it always did. The server keys two things on the
**latest** heartbeat it saw: what it sends this device (§5.2), and the club's cut-over (§8).

### 5.2 The heartbeat answer to a `codes:m1` device

Four more **top-level** keys, after `roster`:

```json
"code_step": 59672640,
"code_step_ms": 17000,
"code_days": ["59670480|59673360"],
"code_keys": ["18Y90HkE5WHvWQ0Oe9Rdl", "BWDJ0IksrpX8Aq55NF6dh"]
```

- **`code_step` / `code_step_ms`** — the step the body was written in and how far into it, from
  ONE clock read, the same instant the roster's relative seconds are computed from. Sent to every
  `codes:m1` device in every phase. This is a step counter, not a time: `server_unix` stays off the
  wire. A phase outside `0..29999` is a server bug and the device ignores the pair.
- **`code_days`** — at most two slots, each `"<first>|<end>"`, half-open steps, 1 to 3120 steps
  long. Array position is the slot number, so a device keeps every element's position and ignores
  a third. Slot 0 is the club day containing `code_step`; slot 1 is the next club day, present **only**
  when some roster entry's window runs into it. Array position is the slot number.
- **`code_keys`** — each element exactly 21 characters, no separator:
  `REF (4, canonical) + slot ('0' | '1') + K_day (16 base64url characters = 12 bytes, unpadded)`.
- **`code_keys` and `code_days` carry keys only when** the tenant's phase is `v1` or `v1_only`
  (§8) **and** the device is acknowledged — a court box an admin has acknowledged, a door with a
  `gate_key`. **Every other `codes:m1` device is sent both arrays EMPTY, never omitted**: an absent
  `code_keys` means "this server does not do member codes" and a device keeps whatever ring it had
  (§5.5), so omitting them from a board that lost its entitlement — un-acknowledged, a door whose
  `gate_key` was cleared, a club that rolled back — would leave it verifying members until its day
  slots ran out. `codesync.json`'s `withdrawn` case pins the device half.

### 5.3 The roster's v1 element

Unchanged grammar `TOKEN|relay|opens_in|closes_in`; the TOKEN of a v1 entry is **`m` plus one to
four REFs**, organiser first, then accepted partners whose membership is active, in seat order:

```
"m18Y9BWDJ|1|-300|2400"        a booking two players may open
```

5 to 17 characters (4 × 4 + 1 ≤ 20). A lower-case `m` cannot begin a legacy code. A device refuses
an element whose REF list is not whole, canonical, non-reserved REFs. **One element per booking**:
a v1 element to a `codes:m1` device in phase `v1`/`v1_only`, the legacy element otherwise. The
roster's source, ordering, cap (16 / 48) and window rules are otherwise exactly as today.

### 5.4 Which keys, and the budget

For each roster entry in roster order, for each REF in the entry, for each slot whose day range
intersects the entry's window: add `(REF, slot)` once. Stop at **24** keys (court box) / **72**
(door); a REF whose key did not fit cannot be verified offline and that is all. The widest bodies
the contract allows, generated and asserted in the corpus:

| Device | Widest body (corpus id) | Bytes | Contract | Board buffer |
|---|---|---|---|---|
| Court box | `heartbeat-response-codes-full` — 16 four-player entries at 6-digit seconds, 24 keys, 2 days, a 64-char slug, 4 restores, all 9 LCD settings | **1984** | 2048 | 2560 |
| Door | `gate-heartbeat-response-codes-full` — 48 four-player entries, 72 keys, 2 days, 64-char slug and gate key | **3879** | 4096 | 4608 |

The court box's headroom is 64 bytes. The server must keep every body inside the contract by
omitting keys (last first) if a future field ever makes that necessary; with today's fields it
never fires.

### 5.5 Rules the device applies (the roster's own)

A body that is not one complete JSON object adopts nothing, not even the clock. Top level only —
a `code_keys` nested elsewhere is not the ring. An absent `code_keys` leaves the ring and its days
untouched; a present one replaces them wholesale, **empty included**. A malformed key, or a key
naming a slot `code_days` did not fill, is refused and counted; the rest is committed. The clock
needs `code_step` **and** `code_step_ms`. An array element that is not a string is skipped
whole and keeps its position — it never renumbers the day slots, and a string nested inside it is
not a key. An accepted heartbeat whose body is not a complete object (a response longer than the
court box's 2560-byte buffer arrives as an empty one) is counted as a `heartbeat_rejected` fault
rather than silently adopting nothing. Everything is RAM: a reboot verifies nobody until the
first accepted heartbeat, which is also when the roster returns. A door taken out of service (a
`403` on any path) empties its roster **and** its keys and forgets its clock.

---

## 6. Verification by a device (offline)

### 6.1 When

Only on the roster's path — the API could not be asked, or gave no decision. **Online, a device
verifies nothing**: it sends the scanned bytes, unchanged, exactly as for a legacy code, and the
server's answer is final. A scan is treated as a member code when it is 19 characters beginning
with `1`; a malformed one is refused, never tried as a legacy code.

### 6.2 The step and the check

The device's step is `code_step + floor((code_step_ms + since(received_at)) / 30000)`, measured
with `tb::since` so a sync taken just before `millis()` wraps still counts correctly after it, and
**trusted for as long as the roster is** (`ROSTER_MAX_AGE_MS`, six hours). Candidates `t, t−1,
t+1`, in that order; each finds the slot whose range holds it and the key `(REF, slot)`; the first
whose `OFF` matches wins. Verdicts, in order: `malformed`, `no_clock`, `no_key` (no candidate had a
key), `wrong_code` (a key was tried, nothing matched), `replayed`, `ok` — and ahead of all of
them `throttled`, while the guess guard (§2) has offline verification locked. Only `wrong_code`
feeds the guard: `no_key` and `malformed` can never become a success, and counting them would let
a member without a key lock the door for everybody. **ON is not checked** — a
device cannot — so a token whose OFF is right and whose ON is garbage is accepted offline; that is
exactly the evidence the server rejects (§7), and `verify.json` pins it.

### 6.3 The roster, by REF

An `ok` REF is matched against **v1 entries' REF lists only**, at whole-REF positions (a REF
straddling two slots matches nothing), and then decided by the roster's unchanged verdicts —
allow, too early, too late, wrong court, stale. A scanned string is matched against **legacy
entries only**. The two paths never cross: `m` + a REF presented as a barcode matches nothing.

### 6.4 Single use on a device

A replay ring holds, per REF, the highest step the device has **acted on** — a court actually lit
(`!ON` left the bridge), a lock actually given time — and refuses that step or any earlier one.
An **online** grant, open or charge on a v1 code is recorded too: at the step the device can
verify when it holds the member's key, otherwise at its own step plus one.
Capacity 16 (court box), 32 (door), oldest evicted: a REF evicted inside its own window could
replay once, which needs more distinct members at one device in 90 seconds than a club has, and the
server still sees both uploads.

### 6.5 What each device does with it

| Verdict | Court box (glass, rows 0–1) | Door (reason) | Recorded |
|---|---|---|---|
| ok + allow | the grant, as for any roster grant | `ok`, released for `unlock_seconds` | `activation` / `gate_open`, **subject = the scanned token** |
| ok + too early / late / wrong court / stale | the roster's own screens | `too_early` / `too_late` / `roster_stale` | `unknown_scan` |
| ok on a court already lit | `COURT B IS ON / ALREADY LIT` — the re-scan guard | — | nothing |
| replayed, on the member's own court already lit — a roster booking naming them (bridge 2.2.1), or a court this box lit online for their REF by activation, walk-up or pay-for (bridge 2.2.2) | `COURT B IS ON / ALREADY LIT`, the OFF bound to that court; the scan is spent, so it buys nothing | — | nothing |
| replayed | `CODE USED` / `WAIT 30 SECONDS` (arms nothing) | `replayed` | `unknown_scan` |
| throttled | `TOO MANY TRIES` / `TRY IN A MINUTE` (arms nothing) | `too_fast` | `unknown_scan` |
| no_clock | the stale roster's screen | `roster_stale` | `unknown_scan` |
| malformed / no_key / wrong_code | the unknown-token screen | `not_recognised` | `unknown_scan` |

Both lines fit the 16-column safe subset. Offline, a v1 code never buys anything: walk-ups and
pay-for need the network whatever code is presented.

---

## 7. Forgery handling

Events carrying a v1 subject (`activation`, `gate_open`) are re-checked when they arrive:
estimate the event's instant as today (uptime), search `s` in `[step(est) − 4, step(est) + 4]` for
an OFF match under the member's K_day, then check ON at that same `s`.

- **OFF matches nowhere** → the device accepted a code the server cannot reproduce: a firmware
  defect or tampering.
- **OFF matches, ON does not** → somebody held K_day and not S: a copied roster or a stolen box.
- **Both match, but `(ref, s, class)` is already in the use table** → one code used twice for the
  same kind of thing across devices.

All three raise the admin alert **`code.forgery_suspected`** (P9's catalogue; security kind, not
optional) naming the device, the member, the event and which of the three it was. The event is
still receipted — evidence is never refused — but it is **not** attendance: it does not stamp
`CheckedInAt`, does not reverse a no-show and does not enter settlement. A genuine offline use is
recorded in `member_code_uses`. Offline activation evidence resolves its booking by member, relay
and time (`FindForEvidenceAsync`, never `EndsAt`), organiser or accepted partner alike.

An offline **refusal** (`unknown_scan`, `court_unknown_scan`) of a v1-shaped code is re-checked for
identity only (review round 11, D11-2): a genuine code names its member as `refused_offline`; no
use is claimed and no forgery alert is raised, because the device opened nothing.

`member_display`, on every device answer that greets a member (activate, walk-up), is printable
ASCII 0x20–0x7E, at most 16 characters: accents are folded (Zoë → ZOE), anything else is dropped,
and a name with nothing printable left reads `MEMBER` (review round 11, D11-1). A double quote of either shape becomes `'`, and `\` and `~` separate words (the A00 character ROM prints them as ¥ and →); the surname initial is the first letter of the last word, never punctuation (review round 12, D12-1). The court box's
HD44780 has no glyphs beyond ASCII, so the server, not the firmware, owns the fold.

---

## 8. Capability negotiation and rollout

Tenant setting `member_code_phase` ∈ `legacy` (default) → `v1` → `v1_only`.

1. **Backend ships** accepting v1 and legacy on every path, in every phase, and sending
   `code_step` to `codes:m1` devices. Phones still show legacy codes. Dean can pilot v1 on his own
   phone: v1 tokens are accepted online everywhere, even from un-flashed boards, because a board
   passes scanned bytes through unchanged.
2. **Dean flashes** the ESP8266 bridge (2.1.0 brought member codes; the current bridge is 2.2.6 —
   2.2.0 shows pay-for amounts in minutes, §9.3, 2.2.1 shows the member who rescans the code
   that just lit their own court its ON screen rather than `CODE USED`, 2.2.2 does the same
   on a court the box lit online for them, §6.5, and 2.2.3 arms nothing for a used code and
   forgets its scan, §4.4, and waits on `ONE MOMENT / Checking code` while it asks, and 2.2.4
   keeps the scan through a walk-up refusal the member can fix by choosing less time, forgetting
   it only for a used or unknown code, and reads a used code at pay-for as `CODE USED`, §9.3, and 2.2.5 escapes the scanned token in every
   body it sends, so a scan carrying a quote, a backslash or a byte ≥0x80 can no longer make an
   unreadable request that jams its event queue — R15 D15-1, and 2.2.6 paces its event drain like the door
   (a post that moves nothing waits 15 s, doubling to 5 min, cleared the moment the queue moves) so a
   disabled or refused box can no longer spend the club's device rate budget, and keeps an event the
   server answers 404 until its next heartbeat registers it again — R16 D16-2, D16-3) and each
   ESP32 door (1.1.0) — the physical USB
   step, below. Each board then reports `codes:m1`.
3. **Cut-over, automatic**: the first time **every enabled device** of the tenant reports
   `codes:m1` on its latest heartbeat (and at least one does), the phase becomes `v1` and
   `member_code_cutover_at` is stamped. Phones switch to v1 codes; `codes:m1` devices get v1 roster
   elements and keys. Legacy codes are still accepted **online**; offline they stop, because
   rosters no longer carry them — the stated trade. The console lists the devices blocking
   cut-over; a dead board blocks it until an admin disables it.
4. **Cut-off, no sooner than 14 days later**: phase `v1_only`, legacy codes refused everywhere;
   then `access_codes` can be dropped.

The phase never reverts on its own. A board that later reports without `codes:m1` (a spare flashed
with old firmware) raises an admin notice; online it still works.

### 8.1 Flashing, which only Dean can do

**The Mega is not touched** — not reflashed, its sketch unchanged, its DIP positions for a Mega
upload never used. Only the ESP8266 half of the court box and the door ESP32s.

- **Court box bridge (ESP8266)**: Arduino IDE, sketch `src/iot/court-box/arduino/court_bridge/`
  with its `secrets.h` beside the `.ino` (never committed). DIP for an ESP8266 upload:
  **1–4 OFF, 5 ON, 6 ON, 7 ON, 8 OFF**; upload; then restore the run positions
  **1 ON 2 ON 3 ON 4 ON 5–8 OFF**. (`make flash-bridge` is the PlatformIO equivalent.)
- **Each door (ESP32)**: Arduino IDE, sketch `src/iot/door-gate/arduino/door_gate/`, board
  `esp32:esp32:esp32` (core 2.0.17), its own `secrets.h`; USB, upload.
- **Proof it landed**: the Devices page shows firmware **2.2.6** for the box (a box still on
  2.1.0, 2.2.0, 2.2.1, 2.2.2, 2.2.3, 2.2.4 or 2.2.5 also reports `codes:m1`) and **1.1.0** for each door, and — once the backend lane ships —
  `codes:m1`. The Mega stays **2.0.0**: the bridge is the only half of the box that is flashed.

---

## 9. D10 — paying for somebody else's court at the box

### 9.1 The flow

1. The payer **scans** their code. Online, `/activate` answers as today — a member with no booking
   of their own on this box reads the no-booking refusal, and the button window arms. Only a
   refusal about a member whose code is unused arms it (`no_booking`, `wrong_court`, `too_early`,
   `insufficient_balance`, `not_chargeable`, `ended`); `code_used`, `not_recognised` and a reason
   the box cannot name arm nothing, and the scan is forgotten (§4.4; `membercode/http.json`'s
   activate vectors pin each).
2. The payer **presses the court button** of a court somebody holds now — the box's roster has an
   open booking on that relay, or the relay is lit — **and that is not the court their own button
   window is bound to**: a member who lit a court, bought it or rescanned on it and presses its
   button is starting to switch it OFF, exactly as before D10. (Any other court press is the
   walk-up choice it always was.) **Which booking:** if the running session ends inside the club's
   cue window and the next booking's cue window is already open, the quote, the confirm and the
   light all apply to that next booking — the one about to start — never to a session with minutes
   left to run out; otherwise the earliest started or cue-open booking is the target (R14 E14-6).
   The box asks `POST /api/v1/device/pay-for` with `confirm:false` — the **quote**,
   which moves no money.
3. The glass asks (§9.3). The window re-arms; the court selection is cleared, so a duration
   press cannot turn the question into a walk-up on a court somebody is playing on (the only answer
   is the same court again, which re-selects it); and the scan stays remembered for the question —
   but never past `scan_memory_seconds + lcd_choice_seconds` from the scan itself.
4. The payer **presses the same court again**: `confirm:true`, echoing the label the glass showed.
   Paid → the booker is refunded, both are emailed (server side), and if nobody had started the
   booking the server may grant its remainder and the court lights as an activation would.

**Online only.** A quote that is not a decision — no connection, a 404 from a server that has not
shipped pay-for, a cut body — is the old walk-up choice (`ChooseTime`), so a box flashed before its
server is upgraded behaves exactly as before. `not_booked` is the same. A confirm that got no
decision (0, 429, 5xx, an unreadable 200) keeps the quote and its nonce armed — re-armed for a
full choice window — so the next press retries **the same payment** and is answered with the
first (`replayed:true`).

### 9.2 The endpoint

`POST /api/v1/device/pay-for` — device bearer auth, `mac` resolves the device as on every path.

```json
{"mac":"5ccf7f0a1b2c","method":"qr","token":"118Y956008441714835","court":2,"nonce":"9f2a4c6e8b0d1f3a","confirm":false,"scan_age_ms":4200}
{"mac":"5ccf7f0a1b2c","method":"qr","token":"118Y956008441714835","court":2,"nonce":"9f2a4c6e8b0d1f3a","confirm":true,"amount_label":"50","scan_age_ms":9100}
```

Field order `mac, method, token, court, nonce, confirm, [amount_label], [scan_age_ms]`; `court`
is the club court number the pressed relay maps to; `nonce` is 16 lower-case hex, the same for a
quote and its confirm; `amount_label` is confirm-only; `scan_age_ms` is v1-only (§4.2).

Every decision is a **200** (the door's rule: a refusal is an answer):

```json
{"payable":true,"reason":"ok","court_number":2,"amount_minutes":50,"amount_label":"50"}
{"payable":false,"reason":"split_booking","court_number":2}
{"paid":true,"reason":"ok","court_number":2,"amount_minutes":50,"amount_label":"50","balance_after_minutes":118,"replayed":false,"granted_seconds":0}
{"paid":false,"reason":"price_changed","court_number":2,"amount_label":"55"}
```

The quote body is `{payable, reason, court_number, amount_minutes, amount_label}` and the confirm
body `{paid, reason, court_number, amount_minutes, amount_label, balance_after_minutes, replayed,
granted_seconds}`, in that byte order; every amount is a whole number of minutes. The firmware reads
none of the `*_minutes` keys — only `amount_label` and the reason.

`amount_label` is the **server's** rendering of `amount_minutes` (`MoneyFormat.MinutesLabel`): the
whole number of minutes in invariant culture, **1–4 ASCII digits** with no sign, separator or
decimal point (`45`, `9999`). The box does no arithmetic on it and shows it verbatim. Its
`validAmountLabel` accepts exactly 1–4 digits, with a leading zero only for `"0"`; anything else is
not a quote the glass can ask, and the box treats it as no decision (the corpus's five-digit
`12345` falls back to the walk-up choice). A price above 9999 minutes never gets that far: the
server refuses it as `amount_unshowable` before any money moves, a reason the box does not know by
name, so it shows `SEE THE DESK`. `kMaxAmountLabelLen` (the server's `MaxLabelLength`) stays 6 as
the buffer and wire bound; four digits is the content rule. The server refuses a confirm whose
`amount_label` is not its current label with `price_changed`, so a member pays what they agreed to
or nothing.

A bridge still on 2.1.0 keeps working against this server, because a whole-number label passes its
older check, but its glass names the unit `cr` instead of `MIN` until it is flashed to 2.2.0 or later.

Reasons: `not_booked` (nothing live on that court — the box falls back to walk-up), `split_booking`
(**any** accepted partner holds a share — D11: shares are paid in the app, never at the box),
`own_booking`, `already_paid`, `insufficient_balance` (no overdraft at a device; god mode never
reaches device paths), `not_recognised`, `code_used`, `member_not_active`, `ended`,
`court_not_on_device`, `price_changed` (confirm only). Semantics: the payer takes over the
booking's charge — a debit to the payer and a refund to the organiser of the same amount, posted
together, actor = payer, subject = the booking — through `ChargeOnActivationAsync`;
`granted_seconds` > 0 only when the booking has not been started and is inside its cue window, in
which case the confirm also stamps `CheckedInAt` for the payer as `/activate` would. Idempotent on
`(tenant, device, nonce)`.

### 9.3 The glass, exactly — and why it fits

The firmware drives the fitted 20×4 panel with the **safe-subset contract**: rows 0–1 clipped at
16 columns must still be a complete message (a 1602 fitted by mistake degrades, never lies), row 3
holds what to press in columns 0–15 with the countdown in 16–19. Every screen below is in the
`ScreenScript` table and the table-driven contract test renders each at its widest facts —
court **9999**, label **9999** — and asserts all of it.

The founder's words, in minutes, are `CT2 BOOKED / PAY 50 MIN? PRESS CT2`. As two lines, row 1
would be 21 columns and the safe subset clips it to `PAY 50 MIN? PRES` — a question with its
instruction cut off. So the same words run down three rows:

| Screen | Row 0 | Row 1 | Row 2 | Row 3 | Hold |
|---|---|---|---|---|---|
| `PayForQuote` | `CT2 BOOKED` | `PAY 50 MIN?` | `PRESS CT2 TO PAY` | `A   B   C   D` + countdown | choice |
| widest | `CT9999 BOOKED` (13) | `PAY 9999 MIN?` (13) | `PRESS CT9999 TO PAY` (19) | court cells | |
| `PayForPaid` | `PAID FOR CT2` | `50 MIN PAID` | `Booker refunded` | `THANK YOU` | revert |
| widest | `PAID FOR CT9999` (15) | `9999 MIN PAID` (13) | | | |
| `PayForSplit` | `SPLIT BOOKING` | `PAY IN APP` | `Each player's share` | `NOTHING CHARGED` | revert |
| `PayForNothingToPay` | `NOTHING TO PAY` | `Already paid for` | — | `NOTHING CHARGED` | revert |
| `PayForPriceChanged` | `PRICE CHANGED` | `Nothing charged` | `Press court again` | court cells | revert |
| `PayForWorking` | `ONE MOMENT` | `Asking the club` | — | `PLEASE WAIT` | wait (6 s) |

The activation has its own wait, `CheckingCode` — `ONE MOMENT` / `Checking code` / — / `PLEASE
WAIT`, six seconds (bridge 2.2.3, review round 8 D8-2). `OneMoment`'s row 1 is `Buying your time`,
the walk-up's sentence, and a booked member read it while their booking activated.

The founder's `SPLIT - PAY IN APP` is 18 columns; it becomes `SPLIT BOOKING` over `PAY IN APP`,
keeping the instruction verbatim. Other refusals reuse the existing screens:
`insufficient_balance` → `TOO FEW MINUTES` (the `InsufficientBalance` screen: `TOO FEW MINUTES` /
`Buy more time` / `Buy in the app`; a walk-up or a scan refused for balance shows `TOO FEW MINUTES` /
`BUY & RETRY`), `not_recognised` → `CODE NOT KNOWN`, `code_used` → `CODE USED` / `WAIT 30 SECONDS`
(the `CodeUsed` screen — the same two lines §4.4 gives the activation and the walk-up, one situation
and one screen, bridge 2.2.4, review round 9 D9-2), and for both the box forgets the scan and
closes the window, so the next press cannot try a walk-up on it,
`ended` → `THAT SLOT ENDED`, anything else → `SEE THE DESK`; no connection on a confirm →
`NO CONNECTION`. When a paid confirm lights the court, rows 0–1 of `PayForPaid` go out as the
`!LCD` lines ahead of the `!ON`. **Everything reaches the Mega through `!ROW`/`!SHOW`/`!LCD`/`!ON`
/`!AUTH` — frames the Mega already speaks.** Nothing about the serial dialect changes.

---

## 10. The member's phone (PWA)

- **Enrol** — `POST /api/v1/me/code/enrol` (member JWT; rate-limited; audited
  `member_code.enrolled`; `Cache-Control: no-store`):

  ```json
  {"v":1,"ref":"18Y9","generation":1,"secret":"<S, 32 bytes, base64url unpadded (43 chars)>",
   "tz":"Africa/Johannesburg","step_seconds":30,"server_time_ms":1790179217123}
  ```

  The phone imports S with `crypto.subtle.importKey("raw", S, {name:"HMAC", hash:"SHA-256"},
  /* extractable */ false, ["sign"])`, stores the **CryptoKey** (a structured-clonable,
  non-extractable handle) in IndexedDB with `ref`, `generation`, `tz` and its clock offset, and
  drops the raw bytes.
- **Status** — `GET /api/v1/me/code` → `{"v":1,"ref","generation","tz","server_time_ms"}` (no
  secret). On every online open the phone refreshes its offset (`server_time_ms` minus the request's
  local midpoint) and re-enrols if `generation` moved.
- **Compute, offline**: `now = Date.now() + offset`; `T = floor(now / 30000)`;
  `ON = HOTP(sign(S, T as 8 bytes BE), 8)`; `day =` the `year`, `month` and `day` parts of
  `new Intl.DateTimeFormat("en-US", {timeZone: tz, year:"numeric", month:"2-digit",
  day:"2-digit"}).formatToParts(new Date(T * 30000))`, joined as `YYYY-MM-DD` — built from the
  parts, never from a locale's formatted string, whose layout is locale data the phone does not
  control;
  `K_day = first 12 bytes of sign(S, utf8("crusaders/kday/v1|" + day))`, imported as a
  non-extractable HMAC key; `OFF = HOTP(sign(K_day, T), 6)`; token `"1" + ref + ON + OFF`.
  Refresh at every step boundary; the countdown ring is `30000 − (now mod 30000)`.
  `derivation.json`, `token.json`, `totp.json`, `hmac.json` and `clubday.json` are its vectors.
- **Rotation** — password change, suspension, admin reset (`POST /admin/members/{id}/code/reset`),
  and sign-out-everywhere (`POST /api/v1/me/sessions/revoke-all`) set `generation += 1` (audited
  `member_code.rotated`) **and end every session the member had open** (§13); the phone's next
  status check re-enrols — from a session that survived the rotation. **Logout wipes the phone's
  key and does not rotate** (founder default).

---

## 11. Residuals, stated

- The court box's widest body has 64 bytes of headroom inside its 2048-byte contract.
- A key that did not fit the cap (24/72) is a member refused offline; the server orders keys by
  booking start so it is the latest-starting players who lose offline access.
- After cut-over, legacy codes work online only.
- A device replay ring can evict inside a window (§6.4); the server catches the second use.
- OFF can be guessed offline at 3 in a million a try; the guess guard bounds the rate and a lock
  refuses legitimate members offline while it lasts (§2).
- Within its day, a stolen box forges OFF for the members it holds; every forged use is flagged the
  moment it is uploaded, and an unacknowledged board holds no keys at all.
- Nothing here is a life-safety device; the door's egress rules (`door-gate.md` §11) are unchanged.

---

## 12. What is pinned, and where

| Sentence | Pin |
|---|---|
| SHA-256, HMAC, HKDF, TOTP match their RFCs | `membercode/{sha256,hmac,hkdf,totp}.json` → `shared/test/test_memcode` |
| Master → S → K_day → ON/OFF → token | `derivation.json` → `test_derivation_chain_master_to_token` |
| Token parse, Crockford normalisation, malformed forms | `token.json` → `test_token_encode_and_decode` |
| ±1 window, replay, wrong day, wrong REF, no key, no clock, OFF-only acceptance, the millis wrap | `verify.json` → `test_offline_verification_scenarios` |
| Roster REF lists, 1–4 players, the two paths never cross | `roster.json` + `test_a_scanned_ref_list_never_matches_and_a_ref_never_matches_a_code` |
| Code sync grammar and the roster rules | `codesync.json` → `test_key_and_day_elements`, `test_code_sync_applies_a_whole_body_by_the_roster_rules` |
| Court box bodies, capability, scan age, pay-for answers, the 2048 budget | `http.json` → `court-box/test/test_membercode` |
| Offline v1 at the box: partner lights, subject = scanned token, CODE USED (arming nothing), throttling, re-scan guard, the same code rescanned on its own lit court | `court-box/test/test_membercode` (`test_offline_v1_*`) |
| A code the device already acted on is refused locally, never asked about online | `test_a_code_this_box_acted_on_offline_is_not_asked_about_online`, `test_app_a_code_opened_offline_is_refused_locally_once_the_link_returns` |
| The guess guard; online uses recorded on the device | `test_guess_guard_locks_after_five_wrong_codes_and_backs_off`, `test_verify_guarded_throttles_guessing_and_a_good_code_resets_it`, `test_an_online_use_is_recorded_so_the_code_cannot_be_used_offline_after`, `test_the_door_throttles_offline_guessing` |
| `code_used` on activate and walk-up | `http.json` `activate-response-code-used`, `walkup-response-code-used` |
| Which activate refusals arm the buttons, and that a used code's scan is forgotten | `http.json` `activate-response-{code-used,no-booking,wrong-court,not-recognised,unknown-reason}`, `payfor-*-code-used`; `test_a_used_code_answered_online_arms_nothing_and_cannot_buy` |
| A code that lit a court buys nothing at the same step, and is `code_used` at a box where it has no booking | `MemberCodePhotoReuseHttpTests` |
| The activation waits on its own words | `test_an_activation_waits_on_its_own_words_never_buying_your_time` |
| Every pay-for screen fits the safe subset at its widest | `test_every_screen_holds_the_layout_contract` |
| Door bodies, the 4096 budget, offline door decisions | `gate.json` → `door-gate/test/test_gate_membercode` |
| The whole door: sync, offline open, recorded token, replay, capability, a 403 emptying keys and clock | `test_app_a_v1_member_code_opens_the_door_offline_once_and_is_recorded_as_scanned` |
| The corpus is what this file says | `make corpus-check` regenerates it and fails on any diff |

---

## 13. Backend notes — where the server's reality needs saying

What the backend lane (P7) built that this document does not already pin, or pins differently.
Each is a server behaviour; none changes a byte the corpus holds.

- **Where it lives.** Arithmetic: `Services/MemberCodeMath.cs`; wire shapes and their validators:
  `MemberCodeWire.cs`; REFs, the check, the use table, rotation and the evidence re-check:
  `MemberCodeService.cs`; capabilities and the phase: `MemberCodeRollout.cs`; pay-for:
  `Endpoints/DevicePayForEndpoint.cs`. `MemberCodeCorpusTests` executes every `csharp` case in the
  manifest, including the three device-behaviour sections (`roster.decide`, `codesync.apply`,
  `gate.offline`) through a small test-side device model built on the server's own parsers.
- **Players are the organiser and P11's accepted partners.** Every "organiser first, then accepted
  partners" above goes through one seam, `IBookingPlayers` (`PlayersOfAsync`, `IsPlayerAsync`,
  `IsSplitAsync`), registered as `ParticipantBookingPlayers` over `booking_participants`
  (`docs/specs/players-and-splits.md` §5): a roster entry names the organiser (active membership)
  then each ACCEPTED partner seat with an active membership, in seat order, at most four; an
  invited, declined, withdrawn, removed or lapsed seat — or a guest seat, which names nobody — is
  not a player. Evidence accepts an accepted partner's code whatever their membership is now
  (the scan was judged at the scan). "Split" is `BookingPlayerQueries.IsSplitAsync` — a live
  partner seat asked for a share, OR any share row on the booking — the same predicate that makes
  the box's payer override a no-op, so pay-for's `split_booking` and the ignored override cannot
  disagree. *Why that and not "any accepted partner":* a partner who came off with a return still
  pending leaves no live seat, and paying for that booking would hand the return to the volunteer.
- **A v1 roster admits a booking an ACCEPTED partner may play even when its organiser is barred.**
  The v1 entry names people, and the barred organiser is simply left out of it — the offline
  twin of `CandidatesAsync` and `GateAccess`, which already admit that partner online. The LEGACY
  roster keeps the organiser-only test: its entry is the booking's own code, the organiser's
  credential. (`DeviceRosterBuilder.WithAnEligiblePlayer`.)
- **Status and enrolment carry one field more than §10**: `phase` (the club's
  `member_code_phase`: `legacy` | `v1` | `v1_only`), last. A phone shows v1 codes in every phase
  (they work online throughout) and uses the phase only to say whether boards can check them
  offline yet. Both routes answer a barred member `403 {"error":"member_suspended" |
  "member_not_active" | "no_membership", "status":…}` — the booking routes' own refusal.
- **The door's `code_used` has no door vector.** `/gate` answers `{"opened":false,
  "reason":"code_used","unlock_seconds":0}`; the door firmware reads any reason off a 200 as a
  refusal, so no screen is owed, but `gate/` and `membercode/gate.json` hold no
  `gate-scan-response-code-used` case. `GateAccess.Reasons` (pinned both ways against the door
  corpus) therefore does not list it; it is `GateAccess.CodeUsed`. Owed to the contract lane.
- **A rotation ends every session open when it happened — by a per-account SESSION EPOCH.** The
  admin reset exists for "I lost my phone", and retiring the codes alone left the phone's
  signed-in PWA free to call `/enrol` and be handed the new secret. Every token carries the epoch
  it was minted under (claim `sep`; a token without one is epoch 0), and every rotation runs
  `UPDATE users SET "SessionEpoch" = "SessionEpoch" + 1` — one statement, committed at once,
  before the rotation's new generation commits. A token below its account's epoch is a 401 on
  every route: checked in the bearer handler, cached per account for `LiveAdminRole`'s 15 s and
  evicted by the increment. **Refresh** reads the row, refuses a presented epoch below it and
  mints with the value it read; **enrolment** reads the epoch under `FOR SHARE` in the same
  transaction as the code row, so a rotation's increment waits for it and an old session sees
  either the old epoch and the old generation or the new epoch and a 401 — never the new secret.
  *Why not a time:* the first version stamped a cut-off instant; a refresh inside the rotation
  read no cut-off and minted a token dated after it, which survived and enrolled (refuted
  2026-09-28). **The epoch is raised twice**: once before the caller's save (above), and again
  once that save has committed. Between the two, the OLD password still verifies and a lost
  phone's passkey still exists, so a sign-in in that gap is minted under the first raise; the
  second ends it (refuted 2026-09-28). A member's own replacement token is minted from the
  second value. The member's own password change keeps its session: `POST /me/password` answers
  `{"changed":true,"access_token":…}` minted under the new epoch, and the presented token is
  dead. **Open SSE streams** (wallet, control board, monitoring) re-ask the epoch before every
  frame and keep-alive and close when their session is stale.
- **Sign out everywhere and the desk's reset, with passkeys.** `POST /api/v1/me/sessions/revoke-all`
  (optional body `{"revoke_passkeys": bool}`, default **false**) answers
  `200 {"signed_out":true,"passkeys_revoked":…,"passkeys_removed":N}`. `POST
  /admin/members/{id}/code/reset` takes `{"reason": string, "revoke_passkeys": bool}` — `reason`
  **required** since review round 1 (B6; `400 reason_required`), passkeys defaulting to **true** — and
  adds `passkeys_revoked`, `passkeys_removed`, `member_notified` to `{"rotated":true,"generation":N}`.
  The reset is written to the change record (`member.code_reset`, with the reason) in its own save
  and the member is emailed that the club reset their code, why, and what to do next. Revoking deletes
  the member's WebAuthn credentials, audited `member.passkeys_revoked`. *Why true at the desk:* the
  lost phone's passkey signs straight back in under the new epoch and enrols for the new secret;
  *why false for oneself:* signing out a forgotten tablet should not cost the passkey on the phone
  in hand. A member without a code row still has their sessions ended.
- **Pay-for refusals beyond §9.2.** A price above 9999 minutes, whose label would exceed four
  digits, is refused as `amount_unshowable` before any money moves (the box reads it as SEE THE
  DESK) rather than sent for the box to discard.
  `not_chargeable` answers a booking the reassignment path will not touch — including one **never
  charged**: D10 takes over a paid charge, and the box's PAID glass ("Booker refunded") and both
  emails would be false with nobody refunded; the glass is firmware, so the server refuses instead.
  A booking costing nothing is `already_paid`. A confirm whose nonce another request is still
  paying is `503 {"error":"in_progress"}` — no decision — so the box retries the same payment and
  is answered with the first; an unpaid nonce row older than 60 s is a claim a crash abandoned and
  the retry decides afresh.
- **The confirm pays for the booking its quote named.** A quote records `(device, nonce) →
  booking` (`device_pay_for_quotes`, purged after a day); a confirm whose nonce was quoted for a
  different booking — the 17:00 slot ended between the presses and the 18:00 one costs the same —
  or never quoted at all is `price_changed`, the reason the box already answers with "press the
  court again", which re-quotes. No new reason; no corpus case changes. *(Corpus note for the
  contract lane: a `pay-for-response-price-changed` vector for the wrong-booking case would pin it.)*
- **Money commits once.** The nonce row's paid state, its audit row, the refund and the debit
  flush in the reassignment's one transaction; a payer who loses the race for a booking (the
  booking's concurrency token) is answered `already_paid`, never a 500, and its nonce and use are
  given back so a retry decides again.
- **A use claimed before an action that throws is given back** (`/activate`, `/walkup` unless its
  purchase committed, `/pay-for`); a walk-up whose purchase committed keeps its use even when the
  activation is then refused and the purchase voided — the use table records acts, and money
  moved under that code; a claim keyed by the box's nonce (`walkup:`/`payfor:` + nonce,
  `member_code_uses.ClaimKey`) is re-entered by the same device's identical retry, so twin retries
  in flight together are one purchase and neither is `code_used`.
- **Evidence and the previous generation.** Checked under the current generation, and under the
  previous one only within six hours of the rotation (the roster's life, `ROSTER_MAX_AGE_MS`) and
  only for a member active at the scan (active now and not re-decided since it). A board offline
  across a rotation verified the old codes honestly; past that, or for a suspended member, the old
  generation is a retired credential and its use raises the alarm. Online, only the current
  generation is accepted (§4.3), exactly as written.
- **A second use of one code is a DIFFERENT board.** The use table's unique index finds the taken
  row; the same device holding it is the same act — its fallback of an online grant whose answer
  was lost, or its own upload retried after a failure — and is a plain receipt (attendance already
  stamped, no alarm). Only another board's use is the `reused` forgery of §7. Precisely: an
  evidence claim is keyed by its own event (`evt:<boot>:<seq>`), so a re-upload re-enters it;
  the board's ONLINE claim (`activate`, `gate`) is the same act only when the event is at or
  after it, less `SameActTolerance` (5 s — the server's own error in placing the event; the board
  stamps its fallback event after the online call returned). An event clearly EARLIER than the
  board's online claim is a second act: a door that opened offline, got its link back and was
  shown a photo of the code before the open was uploaded (refuted 2026-09-28). **The devices
  close that path too**: before asking the server about a v1 code, a door or a court box that can
  already see it is a replay of a code it acted on (`memcode::knownReplay` against its ring)
  answers it locally, with no call, exactly as the offline path would (§6.5): the door says
  `replayed`; the court box says CODE USED unless the replay's REF holds a lit court here (its own
  game, by roster or by this box's online grant), which is that court's ON screen with the OFF
  bound and the scan spent.
- **A clamped event time.** When the server had to clamp an event's time (a future or >30-day
  claim), the step a v1 code was shown at is unknown: the event is never attendance or money, and
  what the step decides is recorded `unverifiable` (audited `device.activation_unverifiable` /
  `device.gate_open_unverifiable`, no notice) — an OFF that matched nowhere, or a genuine code.
  What needs no step still raises `code.forgery_suspected`: another board holding the code's use
  (`reused`), and an OFF that matched with an ON that did not (`on_mismatch`).
- **Which booking evidence belongs to.** `FindForEvidenceAsync` prefers a booking whose sold window
  `[StartsAt − cue, EndsAt]` holds the scan — the latest already started, else the earliest in its
  cue window — and falls back to one whose grace tail reaches it only when none does. Before, an
  18:02 scan between back-to-back 17:00 and 18:00 slots stamped the 17:00 one.
- **Legacy codes after the cut-off, everywhere.** `v1_only` refuses them on the device paths, the
  courtside `/court/{n}/qr/match` kiosk and the biometric payer override alike, and uploaded legacy
  evidence is judged at the scan (honoured only before `member_code_cutoff_at`). The cut-off —
  automatic or by hand — sets every live access code's expiry to the cut-off instant and marks it
  (`CutoffExpiredAt`, `ExpiresAtBeforeCutoff`); an administrator's rollback out of `v1_only` gives
  back every marked code whose own expiry is still ahead — a booking's code only while its booking
  is still booked and not ended (a booking cancelled or displaced since stays dead) — and clears
  the marks. *Why:* a club rolls
  back because v1 misbehaved, and the legacy codes are exactly the fallback it rolled back to.
- **A board losing `codes:m1` after cut-over** raises `device.codes_capability_lost` (non-security,
  once per board per firmware version).
- **The court box's body writes `relays` before `roster`**, matching both corpora; the firmware
  scans by key and does not care.
- **`member_code_phase`, `member_code_cutover_at`, `member_code_cutoff_at`,
  `member_code_cutoff_days`, `member_code_manual_hold` (+ `_by`, `_at`)** are tenant settings. The
  instants are server-written; the PUT accepts the phase, the delay (14–365) and the hold. A phase
  moved forward by hand is stamped as the automatic move would have been and clears the hold. **A
  phase moved back by hand sets the hold**, which the heartbeat's automatic move respects until an
  admin moves forward again or clears it — before it, every board still speaking `codes:m1` undid
  a rollback on the next heartbeat. Back to `v1` restamps the cut-over at now and clears the
  cut-off (the fourteen days restart); back to `legacy` clears both. `GET
  /admin/devices/member-codes` carries `manual_hold`, `manual_hold_by`, `manual_hold_at`.
- **Only acknowledged boards vote on the cut-over** (a court box an admin acknowledged, a door with
  a `gate_key` — the test that decides who gets keys). An auto-registered board is any MAC that
  presented the club's key: counted, a bench spare on old firmware blocked the club for ever, and a
  stranger's board could cast the deciding vote. The rollout view lists them as `unacknowledged`.
- **One cue window.** The pay-for's search, its activate-or-reassign choice and the activation
  gate all read `BookingCodeWindow.CueMinutes` (clamped), so a hand-edited value cannot make them
  disagree.
