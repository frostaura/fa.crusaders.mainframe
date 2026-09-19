# Door gate

The behaviour oracle for a door controller: what it is told, what it decides, what it may
never do, and what it does when the network is gone.

`src/contracts/device-protocol/gate/manifest.json` names this file as its authority, so a
sentence here that the corpus contradicts is a defect in one of the two — not a difference
of opinion. Every behavioural sentence below is pinned by a test, and the pins are listed at
the end; a sentence with no pin is a sentence that will quietly stop being true.

---

## 1. What it is, and what it deliberately is not

One ESP32 per door: a QR scanner on a UART, one relay on the lock, one LED. A member holds
their phone up, the door releases for a few seconds, and that is the whole product.

**It is the court box's shape with the money taken out.** Same club key, same device group,
same rate limit, same auto-registration, same roster grammar. What it does not have:

| A court box has | A gate has | Why |
|---|---|---|
| `court_numbers` | nothing | a door is not on a court |
| a relay bank of four | one lock | one door, one relay |
| a button map | nothing | no keypad |
| `/walkup` — it sells court time | nothing | a door sells nothing |
| `/activate` — it starts a session | `/gate`, which starts nothing | a door starts nothing |
| attendance: it stamps `CheckedInAt` | no attendance, ever | see below |

**Walking through a door is not attendance, and that is the single most important sentence
in this document.** A member coming through the front door may be collecting a racquet,
watching somebody else's league night, arriving an hour early for a court they then cancel,
or leaving. Nothing about an open licenses an inference about a court. So a gate never
stamps `CheckedInAt`, never reverses a no-show, never charges lit time and never writes a
ledger row — not as an omission to be filled in later, but because there is no court to
attribute any of it to.

This will come under pressure the first time somebody wants entry statistics, or asks why
the member who scanned at the door is still being swept as a no-show. The answer to the
second is that the courtside terminal and the court box are what record attendance, and the
answer to the first is that `gate.opened` audit rows are the statistics.

---

## 2. Identity, and what authenticates

Unchanged from the court box, deliberately. `Authorization: Bearer <tenant device API key>`
plus the board's MAC (twelve lowercase hex) in every body. The key names a **club** and
nothing finer; the MAC names the board. A row is created by the first heartbeat and there is
no provisioning step.

`gate_key` — "front-door", "side-door" — is a **label, not an access-control input**. Every
gate in a club is handed the same roster and applies the same policy. It exists so a
`gate.opened` row says "front-door" instead of "gate-0a1b2c", and so a club that one day
wants per-door rules has something to hang them on. Nothing reads it to decide anything, and
that is why one firmware image serves every door.

The three board-identity failures keep the shapes every other device route uses, and are
deliberately *not* the 200 a decision gets, because none of them is a decision:

| Condition | Answer |
|---|---|
| `mac` not twelve hex characters | `400 {"error":"mac_required"}` |
| unknown MAC (any route but `/heartbeat`) | `404` |
| the board is disabled | `403` |
| unknown or missing bearer key | `401` |

---

## 3. Heartbeat — `POST /api/v1/device/heartbeat`

### The request gains exactly one field

```json
{"mac":"5ccf7f0a1b2c","firmware_version":"1.0.0","uptime_ms":86400000,"kind":"gate"}
```

`kind` is a **hint, not an instruction**, and the three rules are not symmetric:

- **Absent, or `"court_box"`** — today's behaviour exactly. Every board in the field sends
  nothing, so the field is additive and the court box's wire is untouched.
- **`"gate"` on an UNKNOWN MAC** — the row is created as a gate: `Kind=Gate`,
  `Hardware=Esp32`, `Name="Door gate"`, `DeviceCode="gate-<last six hex>"` (falling back to
  `gate-<full mac>` on a collision, as `box-` does), `CourtNumbers=[]`, `ButtonMapJson=null`,
  `GateKey=null`, `AutoRegistered=true`. Audited `device.auto_registered` with `kind`.
- **Any `kind` on a KNOWN MAC** — ignored. **A board cannot re-kind its own row**, in either
  direction. A gate that could turn itself into a court box would be handed the club's
  courts; a box that could turn itself into a gate would drop off the settlement model's map
  of which courts have a working door, and start waiving no-show penalties on them. Changing
  a kind means deleting the row and letting the board register again — the same reset a
  misconfigured box already has.
- **Anything else** — `400 {"error":"kind_unknown"}`, **checked before the MAC is resolved**,
  so a firmware that believes in a device kind this server does not have is told so whether
  or not its row exists. Ignoring a bad hint on a known MAC would mean the board gets clean
  200s for as long as its row lives and discovers the problem the day somebody deletes it.

### The response for a `Kind=Gate` row

```json
{
  "server_time": "2023-11-14T22:13:20+00:00",
  "tenant_slug": "crusaders",
  "device_code": "gate-0a1b2c",
  "kind": "gate",
  "gate_key": "front-door",
  "heartbeat_seconds": 60,
  "gate": { "unlock_seconds": 3 },
  "roster": ["7Q3F9KM2XZ8B|0|1800|5400"]
}
```

A court box's response is unchanged and carries no `kind` at all.

Two things about this shape are contract rather than convenience:

- **`gate_key` is present even when null.** A firmware that read an absent key as an empty
  string and a null one as an error would diverge on exactly the gate nobody has named yet
  — which is every gate on its first heartbeat.
- **`kind` is stated outright** rather than inferred from which keys are present, so a board
  that registered as a gate and came back a court box (somebody deleted the row and it
  re-registered without the hint) is a fault the firmware can see and refuse to act on.

`unlock_seconds` here and `unlock_seconds` on a scan answer come from one function, so what
the gate does offline is what it would have been told online.

---

## 4. The roster — the offline fallback, and nothing else

### Source

Bookings that are `Booked` (checked in or not), held by a member the club has not barred, on
**any court of the club**, whose entry window intersects the roster horizon:

```
[StartsAt − gate_early_entry_minutes, EndsAt]  ∩  [now, now + roster_window_minutes]  ≠  ∅
```

Ordered by `StartsAt` then `Id`; capped at **48** *after* ordering. The tie-break is not
decoration: a club with forty-eight bookings in its window plausibly has several starting on
the same slice boundary, and a cap over an unstable order sends a different forty-eight on
every heartbeat.

**The roster is the club's, not the board's.** `BuildAsync` takes no device. Two doors on one
tenant are handed the same list.

**A barred member is excluded here as well as online.** Without that, a suspension holds only
while the gate can reach the API — and the one window in which a club most wants it to hold
is the one where nobody is watching.

### Element grammar

`TOKEN|relay|opens_in|closes_in` — the court box's grammar, unchanged, so
`devlink::parseRosterElement` and `roster::Roster` are reused rather than forked.

- `TOKEN` — the booking's `BookingActivation` access code, twelve Crockford characters,
  minted lazily through the court builder's own helper so the code on the member's phone, the
  code in a court box's cache and the code in a door's cache are the same bytes under the same
  expiry rule.
- `relay` — **always `0`**. A door has one lock and nothing to index. The field exists only
  to keep the grammar identical, and it costs two bytes an entry.
- `opens_in` — **signed** seconds to `StartsAt − gate_early_entry_minutes`, negative once the
  member may already come in. A firmware parsing it unsigned would read `-900` as an enormous
  wait and lock out somebody whose court starts in fifteen minutes.
- `closes_in` — seconds to `EndsAt`.

Both floored, both relative to the response instant: the gate has no RTC, and an absolute
time is meaningless across the reboot that clears `millis()`.

**Always sent, empty included.** The firmware replaces its cache wholesale, so a cancelled
booking is expressed by its absence from the *next* push; an omitted key would leave a stale
roster live.

### The bounds are contract constants, not settings

| Constant | Value | Bounds |
|---|---|---|
| `GateRosterMaxEntries` | 48 | `Roster<48>` on the board |
| `MaxResponseBytes` | 4096 | the board's 4608-byte static response buffer |
| token length | 20 | `roster::kMaxTokenLen`, shared with the court box |

A tenant setting cannot resize a buffer in a doorway, which is why these are constants.
Forty-eight against the court box's sixteen because a gate draws on every court in the club
at once rather than on the four one box drives.

**The 4096 is a ceiling with headroom, and the headroom is stated rather than implied.** The
widest body the server can actually emit — a 64-character slug and gate key, the long
`gate-<full mac>` device code, 48 entries, six-digit relative seconds — is **1800 bytes**.
That is what `gate-heartbeat-response-roster-full` carries, and a test asserts the vector
really is at those extremes, because a budget pinned by a comfortable vector is not pinned.
The remaining 2296 bytes are room for a field added to the envelope later without reflashing
every board, not slack in an estimate.

An entry whose token would breach the length bound is **left out** rather than sent to be
refused: a token cut short matches a different member.

---

## 5. The scan — `POST /api/v1/device/gate`

```
Request   {"mac":"…","method":"qr","token":"7Q3F9KM2XZ8B"}
Opened    {"opened":true,"reason":"ok","unlock_seconds":3}
Refused   {"opened":false,"reason":"<code>","unlock_seconds":0}
```

No `court` field, and no gate identifier: the row the MAC resolves to carries the
`gate_key`, and a board that told the server which door it was would be a board that could
claim to be a different one.

### Every refusal is a 200

The firmware falls back to its cached roster on **anything that is not a clean 200** — a
timeout, a 401, a 5xx — because those mean the server could not be reached or could not
answer. **A refusal is an answer.** Returning 403 for a barred member would make the gate
treat a decision the server definitely made as an outage, second-guess it against a roster
fetched minutes ago, and let in whoever the club had just suspended.

### The decision, in order

The order is not arbitrary; each step exists to keep the one after it from being reachable.

1. **The board's kind.** A `CourtBox` row gets `not_a_gate` and stops. (Answered rather than
   404'd so a board flashed with the wrong image shows a refusal and stops, instead of
   retrying an endpoint that will never answer it differently.)
2. **The method.** Only `qr` and `code` identify a member globally; anything else is
   `method_not_supported`, checked **before** the code table is touched so an unsupported
   method cannot be used to probe it. A PIN against the whole membership roll is an oracle,
   not an identification, and unlike a court there is no candidate set at a door to check one
   against.
3. **The token,** resolved at the request instant. Unknown, expired, malformed and another
   club's all answer `not_recognised` — one reason for four cases, because a door that
   distinguished them would be an oracle for which codes are real, and there is nobody
   standing at a door to be told anything more useful.
4. **The membership.** Not-`Active` — suspended, rejected, *or still pending* — is
   `member_not_active`. A user with **no membership row** is not barred: those are operator
   accounts, and they have to be able to get into the building they work in.
5. **The policy.** `active_member` opens. `booking_window` opens only for a member with a
   `Booked` booking, on any court, inside `[StartsAt − gate_early_entry_minutes, EndsAt]`;
   otherwise `no_booking`.
6. **The release** is `clamp(gate_unlock_seconds, 1, 30)`.

### Reasons

| `reason` | Means |
|---|---|
| `ok` | opened; the only reason carrying `opened:true` |
| `not_recognised` | code unknown, expired, malformed, or another club's |
| `member_not_active` | the club has suspended, rejected or not yet approved them |
| `no_booking` | `booking_window` only: nothing booked inside the entry window |
| `method_not_supported` | anything but `qr` or `code` |
| `not_a_gate` | the MAC resolved to a court box |

Every reason has a corpus vector and every vector's reason is one the endpoint can answer.
Both directions are asserted: a reason with no vector is a refusal the firmware has no
screen for, and a vector with no reason is a screen for a refusal that never comes.

### Side effects

A contact note exactly as `/activate` writes one — a board asking this question is a board
that is reporting, on every branch including the refusals — and **one audit row per
decision**: `gate.opened`, or `gate.denied_<reason>`, with `SubjectUserId` set as soon as the
code resolved (including on the refusals after that point) and details
`{device_id, device_code, gate_key, reason, method}`.

That row matters more than a court box's equivalent, because it is the **entire** record that
anything happened: no ledger entry, no booking, no receipt to reconstruct it from afterwards.
"Nobody could get in through the side door all Tuesday" is a question the desk will
eventually ask, and the refusals are the only place the answer lives.

**The token is deliberately not in the details.** A live access code in a trail an admin can
read is a credential in a log.

---

## 6. Offline opens — `gate_open` on `/api/v1/device/events`

A gate queues `gate_open` **only for an open it decided from its own roster**. An online open
already wrote its own audit row; queuing it again would put one open in the trail twice with
two different timestamps. `court` is `-1`, the wire's "no relay".

The server writes a receipt and **one** audit row, `device.gate_open`, with the subject
resolved **at the scan's own time** rather than at the upload's — a code that was live when
the member held it up identified them then, and judging it by the upload clock turns a member
who walked in during an outage into a stranger.

The outcome is always `ok`, even when the code resolved to nobody, so there is no second
`device.gate_open_<code>` row. There is nothing for a desk to do about an offline open whose
token has since been pruned: the door opened, the member is inside, no money turns on it.
This is the one place a gate's event handling is deliberately quieter than a court box's, and
it is quieter because nothing is at stake, not because nothing can go wrong.

The receipt carries **no** `BookingId` even when the token was a booking code, so a later
`release` — which pairs on device, relay and booking — can never pair against it. A door has
no relay session to settle, and pairing one would re-price a court from a doorway.

---

## 7. What a gate may not do, stated rather than assumed

A gate row arriving at any of the four court-box paths is refused **by name**:

| Path | Answer |
|---|---|
| `POST /device/activate` | `200 {"activated":false,"reason":"not_a_court_box","granted_seconds":0}` |
| `POST /device/walkup` | `400 {"error":"not_a_court_box"}` |
| `POST /device/events`, kind `activation` | receipted and acknowledged; outcome `not_a_court_box`; nothing stamped, nothing charged |
| `POST /device/events`, kind `release` | the same |

**Every one of these already refused a gate before the check existed** — a gate has no court
numbers, so the activation path fails its relay-index test against an empty list and the
walk-up fails `court_not_on_device`. Both are wrong sentences: the court was never the
problem. Worse, both stop being refusals at all the moment anybody puts a court number on a
gate row, which is one PATCH away. The rule is "a door never sells court time and never
checks anyone in", and a rule enforced by the emptiness of an unrelated list is not enforced.

The event paths are receipted and acknowledged rather than 4xx'd, because an event a board
cannot change is a board retrying for ever.

---

## 8. Tenant settings

| Key | Default | Range | Meaning |
|---|---|---|---|
| `gate_unlock_seconds` | 3 | 1–30 | how long the lock is released per open |
| `gate_access_policy` | `active_member` | `active_member` \| `booking_window` | who may open a door |
| `gate_early_entry_minutes` | 30 | 0–240 | how long before a booking its holder may enter |

Three seconds is long enough to push a door and short enough that it has shut again before
the next person reaches it. Thirty minutes is the club's own habit — a member due on court at
six arrives at half past five to change — and it is deliberately much longer than
`activation_cue_window_minutes`, because getting into the *building* early is ordinary and
getting the *lights* on early is somebody else's court.

`gate_early_entry_minutes` is read two ways and they are the same window on purpose: it is
how far ahead of a slot the roster carries it, and it is the window `booking_window` tests
online. A member let in offline and a member let in online are let in on one rule.

`gate_unlock_seconds` is bounded on the PUT **and clamped again on the way out**, because the
PUT is not the only way a number reaches that column — a hand-edited settings document is.

### `gate_access_policy` is the one setting in this tree that fails CLOSED

Everywhere else — the button map, the operating hours — a settings document somebody has
broken falls back to something permissive, because the alternative is a club whose courts all
stop working over a typo with nobody to ask. **A door is the other way round.** The two
failure modes are "a member is sent to the desk" and "the building is open to whoever holds
any live code", and only one of those is recoverable by a person.

So:

- **absent** → `active_member`, the documented default. That is the common case and not a
  failure at all.
- **present and not one of the two** — an unknown string, an empty string, a number, a JSON
  null → `booking_window`. The PUT validates strictly, so the only way such a value exists is
  a hand-edited column; the safe reading of a hand-edited door policy is the narrower one.

The PUT refuses anything outside the closed set with `gate_access_policy_invalid` and writes
**nothing at all**, including the fields that were valid.

### Both key spellings bind on the PUT

This endpoint answers snake_case and binds camelCase, and the cost of a client picking the
wrong one is not an error — it is `null`, which the PUT reads as "omitted, leave unchanged",
so the save returns `{"saved": true}` and changes nothing. That is the silent write
`Opening_the_settings_page_and_saving_it_changes_nothing` exists to prevent. For three
settings that decide who gets into a building it is worth removing rather than documenting,
so `gateUnlockSeconds` and `gate_unlock_seconds` both bind, and so on for the other two.

---

## 9. Admin

`PATCH /api/v1/admin/devices/{id}` gains `gate_key`: a string of at most 64 characters,
trimmed, with `""` clearing it. Two-valued rather than three — a door either has a name or has
not, so there is no "run the club's default" state to distinguish a JSON null from.

| Sent | To | Answer |
|---|---|---|
| `gate_key` | a gate | applied, trimmed |
| `gate_key` longer than 64 | a gate | `400 gate_key_too_long` |
| `gate_key` | a court box | `400 gate_key_not_a_gate` |
| `court_numbers` or `button_map` (**including an explicit null**) | a gate | `400 court_fields_on_a_gate` |
| `kind` | anything | not a field; ignored, and the row's kind is unchanged |

Refused rather than silently dropped, which is what the code did before: a PATCH that reports
success while changing nothing leaves the admin believing the courts are assigned, the row
saying otherwise, and nothing anywhere saying which. An explicit `button_map: null` counts as
sent — on a box it means "run the club's map", a real instruction; on a gate there is no map
to run.

`name` and `enabled` work on a gate exactly as on a box. Taking a gate out of service refuses
it `403` on every device route, as it does a box.

**No EF migration.** `Kind` and `GateKey` have been columns with indexes since the device
table shipped, and nothing here persists anything new.

---

## 10. Degraded mode — the honest statement

**Offline, a gate admits rostered bookings and nobody else.**

Under the default `active_member` policy an active member with no court booked **gets in
online and does not get in offline**. That is not a bug to be fixed later; it is the
consequence of two facts that are not going to change:

- a sixty-second `MemberIdent` code cannot be in a cache fetched minutes ago, by
  construction; and
- the alternative is pushing the club's entire membership roll to a board in a doorway, which
  is a different product and a far worse secret to leave in a cupboard.

So the degraded mode is **narrower** than the court box's, where everyone who turns up has a
booking and the roster therefore covers the whole population the box serves. A club that
wants its doors to keep working through an outage for everybody has to accept the roll on the
board, and nobody has asked for that.

A stale roster admits nobody: the firmware's own six-hour `ROSTER_MAX_AGE_MS` is what stops a
board that has been offline for a week letting in a member whose suspension it never heard
about.

---

## 11. Safety

**This section describes a boundary, and most of what matters is on the far side of it.**

### The door is open when there is no power — and software cannot make that true

The founder's stated default is that the door is released when the power is out. **That is a
property of the lock and its supply, not of this software and not of the firmware.** A
fail-safe (fail-unlocked) lock is released when its own supply is cut; a fail-secure lock
stays locked whatever the relay does, and no build flag, no setting and no line of code
changes that. Specifying and fitting the right lock is an electrical decision on the go-live
checklist, and this document's only contribution is to say plainly that it is not ours.

### Mechanical egress is not software's to provide

**Getting *out* of the building must not depend on this system at all.** Not on the ESP32,
not on the relay, not on the API, not on a scan, and not on the power being on. Free
mechanical egress — a lever, a push bar, a thumbturn — is a building-code requirement and a
physical one, and any reading of this document that puts software anywhere on the exit path
is a misreading. Everything here is about *entry*.

The corollary for the failure analysis: a gate that is wedged, unpowered, unreachable or
refusing every scan is an inconvenience, never a trapping hazard, and it is only ever an
inconvenience because egress is mechanical.

### What the firmware does guarantee

Three things, and they are worth stating here because they are the reason the flags exist:

1. **LOCKED is asserted explicitly at boot, before anything else** — and the pin level is
   written *before* `pinMode(OUTPUT)`, so the relay never glitches through a released state
   on the way up. This matters most on a watchdog reset, which is exactly when nobody is
   watching.
2. **The relay can never stay released longer than the hard cap**, whatever the server says.
   The server clamps `unlock_seconds` to 30 and the firmware caps it again at
   `GATE_UNLOCK_HARD_CAP_MS`; two independent bounds, because one of them will be wrong
   eventually.
3. **The two polarity flags are independent, and both are tested in all four combinations.**

### What each polarity flag means

| Flag | Default | Says |
|---|---|---|
| `GATE_RELAY_ACTIVE_HIGH` | 1 | which pin level **energises the relay coil**: 1 = HIGH energises, 0 = LOW energises (an active-LOW relay module, which is the common cheap kind) |
| `GATE_UNLOCK_ENERGISES_RELAY` | 1 | whether **energised means released**: 1 = energised releases the door (the club's existing sketch), 0 = energised means LOCKED, so a dead or rebooting board leaves the door released |

They are orthogonal: the first is about the relay module's input, the second about how the
lock is wired through the relay's contacts. Combining them gives the pin level the board
holds in each state:

| `ACTIVE_HIGH` | `UNLOCK_ENERGISES_RELAY` | pin while LOCKED | pin while RELEASED |
|---|---|---|---|
| 1 | 1 | LOW | HIGH |
| 1 | 0 | HIGH | LOW |
| 0 | 1 | HIGH | LOW |
| 0 | 0 | LOW | HIGH |

**Which combination gives "released with no power" is a question about the relay, and only
half an answer about the door.** With no power the coil is de-energised whatever
`GATE_RELAY_ACTIVE_HIGH` says, so the relay's de-energised state means *released* exactly
when `GATE_UNLOCK_ENERGISES_RELAY = 0`. Whether the **door** is then released still depends
on the lock being fail-safe, per the first sentence of this section. The wiring table that
turns this into instructions for a person with a screwdriver belongs in the firmware
project's own README, beside the flags it documents; it is not restated here, because a
wiring fact written in two places is a wiring fact that will disagree with itself.

---

## 12. What is pinned, and where

Every behavioural sentence above has a test that fails if it stops being true. This table is
the audit of that claim — an entry removed from the code should remove its row here, and a
new sentence above with no row is the defect this table exists to expose.

| Sentence | Pinned by |
|---|---|
| A gate never stamps attendance or posts a ledger row | `DeviceGateTests.An_open_stamps_no_attendance_and_posts_no_ledger_entry` |
| Absent or `court_box` is today's behaviour exactly | `DeviceGateHttpTests.A_board_that_says_nothing_or_says_court_box_is_a_court_box` |
| `gate` on an unknown MAC registers a gate with no courts | `DeviceGateHttpTests.A_board_that_calls_itself_a_gate_registers_as_one…`, `DeviceGateTests.A_gate_registers_itself_with_no_courts_and_no_button_map` |
| A board cannot re-kind its own row, in either direction | `DeviceGateHttpTests.A_board_cannot_re_kind_a_row_that_already_exists` |
| An unknown `kind` is 400 whether or not the row exists | `DeviceGateHttpTests.A_kind_this_server_does_not_have_is_refused`, `DeviceGateTests.The_kind_hint_is_parsed_strictly` |
| The device code is `gate-<six>`, falling back to the full MAC | `DeviceGateTests.A_gate_code_collision_falls_back_to_the_full_mac` |
| Registration is audited with its kind | `DeviceGateTests.Gate_registration_is_audited_with_its_kind` |
| The gate response carries no `court_numbers`, `config` or `button_map` | `DeviceGateProtocolCorpusTests.A_gate_heartbeat_carries_none_of_the_court_boxs_keys` |
| `gate_key` is present even when null | `DeviceGateProtocolCorpusTests` (`gate-heartbeat-response-null-gate-key`), `DeviceGateHttpTests.A_board_that_calls_itself_a_gate_registers_as_one…` |
| The wire shape is byte-for-byte what the server serialises | `DeviceGateProtocolCorpusTests.Every_heartbeat_vector_is_what_the_server_really_serialises`, `…Every_scan_vector_…` |
| Every roster entry is on relay 0 | `DeviceGateTests.Every_gate_roster_entry_is_on_relay_zero` |
| `opens_in` counts to `StartsAt − early` and goes negative | `DeviceGateTests.The_relative_seconds_are_measured_…`, `…The_roster_arithmetic_holds_at_every_minute_of_the_day` |
| The cap is 48, applied after ordering | `DeviceGateTests.The_cap_keeps_the_forty_eight_earliest`, `…The_cap_is_forty_eight_and_the_grammar_bounds_the_token` |
| The 4096 budget is declared against the widest possible body | `DeviceGateProtocolCorpusTests.The_byte_budget_is_declared_against_the_widest_body_the_server_can_emit` |
| An over-long token is left out, not truncated | `DeviceGateTests.The_cap_is_forty_eight_and_the_grammar_bounds_the_token` |
| The roster window is `roster_window + early_entry` either side | `DeviceGateTests.Bookings_just_outside_the_roster_window_are_absent_and_just_inside_are_present` |
| A barred member is off the roster too | `DeviceGateTests.A_barred_members_booking_is_not_pushed_to_any_gate` |
| The roster is the club's, not the board's | `DeviceGateTests.Two_gates_at_one_club_are_handed_the_same_roster` |
| The token is the booking's own code, minted once | `DeviceGateTests.The_token_is_the_bookings_activation_code_minted_once` |
| Every refusal is a 200 | `DeviceGateHttpTests.Every_refusal_is_a_200_the_firmware_can_act_on_and_is_audited_by_reason` |
| Board-identity failures keep 400/404/403/401 | `DeviceGateHttpTests.The_board_identity_failures_keep_their_own_shapes` |
| Only `qr` and `code` identify | `DeviceGateTests.Only_a_method_that_identifies_globally_is_accepted`, `…A_code_read_or_typed_identifies` |
| Not-`Active` is refused by name; no membership row is not barred | `DeviceGateTests.A_member_the_club_has_not_approved_is_refused_by_name`, `…A_user_with_no_membership_row_is_not_barred` |
| Unknown and expired both answer `not_recognised` | `DeviceGateTests.An_unknown_or_expired_code_is_not_recognised_and_names_nobody` |
| The booking window opens at early entry and shuts at the slot's end | `DeviceGateTests.The_booking_window_opens_at_early_entry_and_shuts_at_the_slots_end` |
| The window is the setting, not a constant | `DeviceGateTests.The_entry_window_is_the_clubs_setting_and_not_a_constant` |
| Any court of the club counts | `DeviceGateTests.A_booking_on_any_court_opens_the_door` |
| Only a `Booked` booking counts | `DeviceGateTests.A_booking_that_is_not_live_does_not_open_the_door` |
| An operator with no membership passes; an admin member does not | `DeviceGateTests.An_operator_with_no_membership_passes_the_booking_check_…`, `…A_non_admin_with_no_membership_and_no_booking_is_still_refused` |
| A booking code opens the booking it names | `DeviceGateTests.A_booking_code_opens_the_door_for_the_booking_it_names` |
| The release is the club's setting, clamped to 1–30 | `DeviceGateTests.The_release_is_the_clubs_setting_clamped`, `DeviceGateHttpTests.The_release_on_the_wire_is_the_clubs_setting` |
| Every reason has a vector and every vector a reason | `DeviceGateProtocolCorpusTests.The_refusal_reasons_and_their_vectors_are_the_same_set` |
| One audit row per decision, subject named, token absent | `DeviceGateHttpTests.An_active_member_opens_the_door_and_the_open_is_audited` |
| Another club's code opens nothing here | `DeviceGateTests.Another_clubs_code_is_not_recognised_at_this_clubs_gate`, `DeviceGateHttpTests.Another_clubs_code_does_not_open_this_clubs_door` |
| Another club's bookings never reach this club's roster | `DeviceGateTests.Another_clubs_booking_never_appears_…`, `DeviceGateHttpTests.Another_clubs_bookings_never_reach_…` |
| `gate_open` is receipted, names the subject at the scan, settles nothing | `DeviceGateHttpTests.An_offline_gate_open_is_receipted_and_names_the_member_without_checking_them_in` |
| An unresolvable `gate_open` is still recorded | `DeviceGateHttpTests.An_offline_gate_open_with_an_unresolvable_token_is_still_recorded` |
| A gate cannot activate or sell a walk-up | `DeviceGateHttpTests.A_gate_cannot_activate_a_court_or_sell_a_walk_up` |
| A gate's `activation` upload settles nothing | `DeviceGateHttpTests.An_activation_uploaded_by_a_gate_is_recorded_and_settles_nothing` |
| The three settings round-trip; omitted means unchanged | `AdminSettingsHttpTests.The_gate_settings_are_readable_and_writable_and_omitted_means_unchanged` |
| Both key spellings bind | `AdminSettingsHttpTests.A_gate_setting_binds_under_either_spelling` |
| The bounds are 1–30 and 0–240 | `AdminSettingsHttpTests.A_gate_number_outside_its_bounds_is_refused` |
| The policy is a closed set; a refused save writes nothing | `AdminSettingsHttpTests.An_access_policy_outside_the_closed_set_is_refused`, `…Both_access_policies_are_accepted` |
| An unreadable stored policy narrows the door | `DeviceGateTests.An_unreadable_access_policy_narrows_the_door_rather_than_widening_it` |
| The admin PATCH holds each kind to its own fields | `DeviceGateHttpTests.The_admin_patch_holds_each_kind_to_its_own_fields` |
| A PATCH cannot change a kind | `DeviceGateHttpTests.A_patch_cannot_change_a_boards_kind` |

The two sentences in §11 that are **not** pinned by a test are the two that cannot be: that
the lock must be fail-safe, and that egress must be mechanical. Neither is a property of any
code in this repository. They belong on `docs/go-live-checklist.md`, where a person signs
them off, and saying so is the closest this document can get to pinning them.
