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
same rate limit (charged per board since R16 — see §13's *What is pinned, and where*), same auto-registration,
same roster grammar. What it does not have:

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
answer to the first is that `gate.opened` audit rows are the statistics — readable at
`GET /api/v1/admin/devices/{id}/activity` (§9), which for one round they were not: this
document assumed a reader in four places and no route read `audit_log` at all.

---

## 2. Identity, and what authenticates

Unchanged from the court box, deliberately. `Authorization: Bearer <tenant device API key>`
plus the board's MAC (twelve lowercase hex) in every body. The key names a **club** and
nothing finer; the MAC names the board. A row is created by the first heartbeat and there is
no provisioning step.

`gate_key` — "front-door", "side-door" — **names the door and does not decide anything about a
member**. Every named gate in a club is handed the same roster and applies the same policy to
the same people, which is why one firmware image serves every door. It exists so a
`gate.opened` row says "front-door" instead of "gate-0a1b2c", and so a club that one day wants
per-door rules has something to hang them on.

**It does decide one thing, and it is about the BOARD rather than about a member: a gate with
no `gate_key` is pushed no roster at all** (§4). Naming the door is the admin's acknowledgement
that this board is one of the club's, and until that happens the door works only while it can
reach the server. See §10 for why the only call that hands out credentials is the one that
needed a gate on it.

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
  "gate": { "unlock_seconds": 15 },
  "roster": ["7Q3F9KM2XZ8B|0|1800|5400"]
}
```

A court box's response is unchanged and carries no `kind` at all.

Two things about this shape are contract rather than convenience:

- **`gate_key` is present even when null.** A firmware that read an absent key as an empty
  string and a null one as an error would diverge on exactly the gate nobody has named yet
  — which is every gate on its first heartbeat.
- **`kind` is stated outright** rather than inferred from which keys are present. A board that
  registered as a gate and came back a court box — somebody deleted the row and it
  re-registered without the hint — is then a fault the board **can** see, because the server
  has told it the fact rather than left it to be guessed from which keys arrived. What the
  firmware does with that is the firmware's own contract and lives in `src/iot/door-gate`;
  this document's obligation is only to make the fact available, and it does.
- **`roster` is empty whenever `gate_key` is null**, whatever the club has booked — §4.

`unlock_seconds` here and `unlock_seconds` on a scan answer come from one function, so what
the gate does offline is what it would have been told online.

---

## 4. The roster — the offline fallback, and nothing else

### A board gets no roster until an admin has named the door

**`gate_key == null` ⇒ `roster: []`**, whatever the club has booked. The key is still present
and the list is still present and empty; only its contents wait.

Auto-registration is the whole provisioning story, which is what makes this necessary.
Anything holding a club's device key can heartbeat with a MAC it invented and `kind: "gate"`,
and a row appears — and that one call used to be answered with the club's live access codes
for every booking in the roster window. Up to forty-eight of them, each of which opens *every*
door in the club for the length of its booking. Self-registering a "gate" was a way to ask the
server for the club-wide code set on demand, and nothing about it looked like an attack.

Naming the door is the admin's acknowledgement that the board is one of theirs, and it costs a
real install nothing, because:

- **online scans work from the first heartbeat**, so the board is useful the moment it is
  powered; and
- the admin has to visit the Devices page to name it anyway.

What it costs is the offline fallback, for as long as the board is unnamed. A club that plugs
a gate in and never names it has a door that stops working the moment the network does — which
is the honest trade and is said in the console copy, not left to be discovered.

**This narrows the surface; it does not close it, and an earlier draft of this section claimed
otherwise.** A heartbeat from the same invented MAC with **no `kind` at all** auto-registers a
**court box** on the club's first four courts — with no naming step whatever — and is answered
with up to sixteen live booking codes for those courts. After §5, every one of those codes
opens every door in the club inside its own booking's window. So "the only call that hands a
caller other members' live codes in bulk" was false the moment the gate shipped; the gate's
naming step covers the 48-code call and leaves the 16-code one exactly where it was.

Whether an auto-registered, never-acknowledged **court box** should also be pushed no roster is
a live product question and is **not** decided here: taking a box's roster away until an admin
names it changes the court-box install story and the offline lighting path, which is money and
is the founder's call. It is recorded in `memory/questions.md` and restated in §10a rather than
quietly fixed in the gate's changelog.

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

### Who is locked out when a club overflows the cap

The cap is a real lockout and the club is owed a sentence about it: **on a busy night the
bookings beyond the forty-eighth cannot get in while the door is offline.** Which ones is
deterministic — the list is ordered by `StartsAt`, ties broken by `Id`, and the cap is applied
**after** the ordering, so it is the **latest-starting** bookings that fall off.

The tie-break is what makes that true rather than approximately true. A club with sixty
bookings in its window very plausibly has a dozen starting on the same slice boundary, and a
cap applied to an unstable order sends a different forty-eight on every heartbeat — a member
is in the cache at 18:00, out of it at 18:01, and nobody can tell them which they will be.

The console's sentence, for the settings and devices pages, is exactly this: *the offline list
holds at most 48 bookings; on a busy night the latest-starting beyond 48 cannot get in while
the door is offline.*

---

## 5. The scan — `POST /api/v1/device/gate`

```
Request   {"mac":"…","method":"qr","token":"7Q3F9KM2XZ8B"}
Opened    {"opened":true,"reason":"ok","unlock_seconds":15}
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
   `member_not_active`. A user with **no membership row** is not barred, because the test is
   "the club has recorded a decision about this person and it was not approval", and about
   such a user it has recorded none. That is not a staff carve-out and must not be read as
   one: no path in this product creates a user without a membership row. Staff get in by
   being admins — step 5.
5. **The booking code's own window,** for a `BookingActivation` code and only for one. A
   booking code opens a door only while `now ∈ [StartsAt − H, EndsAt]` of **the booking it
   names** and that booking is still `Booked` — *or* while the member holding it holds any
   qualifying booking whose door window contains now (*A member is not a credential*, below),
   which is how the code goes on working for the booking it names after a worker has moved
   that booking's status. Outside both: `too_early` before, `not_recognised` after. See *A
   booking code is not a standing building key* below.
6. **The policy.** `active_member` opens. `booking_window` opens for a **club admin**
   unconditionally, and otherwise only for a member with a qualifying booking, on any court,
   inside `[StartsAt − gate_early_entry_minutes, the instant that booking's code dies]`;
   failing that, `no_booking`. Same upper edge as step 5's relief and the same qualifying
   statuses — one rule for the whole door.
7. **The release** is `clamp(gate_unlock_seconds, 1, 30)`.

**Club admins always pass step 6.** A club that switches to `booking_window` must not thereby
lock its own staff out of the building, and staff do not hold bookings for the hours they are
working. It is keyed on `User.IsAdmin`. It used to be keyed on the *absence* of a membership
row, which is a state nothing creates — so the carve-out fired for nobody, the club's own
admins were refused on the first scan after a policy change, and the test that said otherwise
passed only because it deleted the row first. There is **no operator role in this product**;
where earlier versions of this document said "operator", the answer is "club admin" or
nothing.

**The carve-out is on step 6 alone, and it has THREE limits.** An admin is held to step 4
exactly as everybody is — a club that has suspended an admin's membership has said something
about that person, and a door is not where it gets quietly undone — and to step 5 exactly as
everybody is, so an admin presenting a booking code before that booking opens gets `too_early`
like anyone. Those two are pinned.

The third is the one nobody thinks of and no test can pin, because it is an ABSENCE: **the
carve-out is an online rule and does not exist offline.** A cached roster holds *bookings*,
and an admin working a shift has none — so at a door that cannot reach the server, a club admin
is refused exactly like any other member without a booking. "Club admins always pass" is a
sentence about the online booking check, not about doors, and it is worth saying out loud
because the club's own staff are the people most likely to be standing at a cut-off door
wondering why their key stopped working.

### A booking code is not a standing building key

A `BookingActivation` code is minted with its booking, lives until the slot ends plus the
grace window, and is a **stable token for the whole of it** — which is exactly what a court box
deciding offline needs, and exactly what made it dangerous at a door. Unbounded, the code a
member's phone showed them at 17:00 for a 19:00 court opened every door in the club at 03:00
the same night, under the default policy, for as long as the row survived.

So under **every** policy it is bounded by its own booking's window,
`[StartsAt − H, the code's own expiry]`:

| Policy | `H` |
|---|---|
| `booking_window` | `gate_early_entry_minutes` |
| `active_member` | `max(gate_early_entry_minutes, min(roster_window_minutes + activation_cue_window_minutes, 240))` |

The second term is **the horizon in which the member's own phone would show them that code at
all** (`POST /me/qr/generate?kind=auto`), and the two come from one function so the screen and
the door cannot drift. Narrower than the phone's and the product refuses a code it has just
put on somebody's screen; wider and it is the standing key again.

The `max` matters in the other direction too: `H` is never less than
`gate_early_entry_minutes`, which is the window the cached roster admits on. A door that
accepted a narrower window online would refuse, while it could reach the server, a member it
would have let in during an outage.

**`H` never exceeds four hours, and all three inputs are clamped on read.** `240` is
`GateAccess.MaxEarlyEntryMinutes` — the number this document has always quoted for
`gate_early_entry_minutes` — and it bounded that setting alone. The other term is two
settings the PUT bounds at 1440 each and cross-checks only against each other, so a club
could set both to their maxima through the console and give every booking code in the
building a **forty-eight-hour** door window, with this document, the console and the constant
all still saying four hours. All three numbers are now clamped where they are read
(`BookingCodeWindow`) and not only where they are written, because the PUT is not the only
way a value reaches that column — a hand-edited settings document is, exactly as it is for
`gate_unlock_seconds`.

**The phone is deliberately not narrowed to match.** Where a club's horizon exceeds the
ceiling the member's screen still shows the code and the door answers `too_early` — which is
honest, is actionable by the person standing outside, and is pinned. Hiding a booking's own
code from the member who owns it would be the worse half of the trade.

**The phone is TOLD the window rather than left to derive it.** `POST /me/qr/generate`
answers three more fields:

| Field | For a booking code | For an ident code |
|---|---|---|
| `doors` | whether the club has ≥ 1 **enabled** `Kind=Gate` row | the same |
| `door_opens_at` | `StartsAt − H` | `null` |
| `door_closes_at` | the code's own `ExpiresAt` | `null` |

The page cannot compute `H` for itself, and must not be able to: it is
`max(gate_early_entry, min(roster + cue, 240))` under one policy and `gate_early_entry` under
the other, and none of those three settings belongs on a member's API surface. A page
computing its own copy is how a member is told their code works at a time their club's door
refuses it, which is the drift `BookingCodeWindow` exists to make impossible — so the server
answers with the same function the door decides with.

`door_closes_at` is the CODE's expiry and not the booking's end, because that is genuinely
the door's upper edge and it is later than the slot by the grace window; understating it
would have the product denying its own generosity to the member walking back in for a
forgotten racquet. An ident code gets `null` for both because it names no booking and
therefore has no window of its own — under `active_member` it opens whenever the club's rules
allow, which is not an instant. `doors` counts **enabled** rows, because a board the club has
switched off is refused `403` on every route it calls and promising a member it will let them
in would be false.

### The upper edge is the code's own liveness, and there is only one of it

**A booking code opens a door until the CODE expires, not until the booking's `EndsAt`.**
`AccessCodeService.ResolveAsync` is the only way a scan reaches this decision at all and it
refuses anything that is not live, so the top of the window is the `AccessCode` row and
nothing else has to enforce it. The previous rule tested `EndsAt` as well — a second, lower
edge, wrong in two directions at once:

- the no-show sweep **truncates `EndsAt`** to its own clock five minutes into a slot, so a
  member six minutes late was refused on a booking that had not finished; and
- a member whose court simply ran to its end was refused for the whole grace window, during
  which the product was still holding a live code for them.

**The booking's STATUS is a second upper edge, and it is reached first.** Step 5's own-window
test refuses every status but `Booked`, and the two statuses a *worker* writes arrive long
before the code expires — `NoShow` five minutes after a slot starts, `Completed` within
fifteen seconds of its end. Neither is a refusal, because step 5's relief re-admits the member
on that same booking out to the same instant the code dies; what the status test really
decides is the club's own verdict on the booking, `Cancelled` and `AdminBlock`, which the
relief does not carry either. So the sentence *there is only one upper edge* is true of the
answer the door gives, and false of the code path that computes it — which is precisely how
`Completed` went unnoticed for two rounds, with the credential test refusing and the relief
silently not catching it.

The same edge governs the entitlement query behind step 5's relief and step 6's policy check,
where it is written as arithmetic — `StartsAt + SliceMinutes × SliceCount + grace_window_minutes`
— because a booking is minted lazily and may not have a code row yet. That expression is
exactly what `StageForBookingAsync` sets `ExpiresAt` to. Two consequences, both stated rather
than discovered:

- **The door is a grace window WIDER at the top than the phone**, which stops offering a
  booking's code at `EndsAt` (`POST /me/qr/generate?kind=auto`). That direction is intended
  and is pinned: narrower would be the product refusing a credential it minted and has not
  yet expired. Wider is a member walking back in after their court with a code the club has
  not taken away.
- **The offline roster still closes at `EndsAt`** (§4), so the cache is narrower at the top
  than the online decision by the same grace window. That is the one place offline is stricter
  than online; it is the roster's `closes_in` and changing it would change the firmware's
  contract for a few minutes at the end of a slot.

The arithmetic edge uses the club's **current** `grace_window_minutes`, while a code already
minted carries the one that was in force when it was minted. The two agree except across a
settings change, and the code's own row is the exact authority where there is one.

**Nothing in this product extends a booking.** The only writers of `EndsAt` after a mint —
the no-show sweep and the reversal narrowing in `BookingService` — shorten it or restore it
toward the end it was sold to. If an extend-booking feature ever lands, the mint path must
move with it or this edge silently narrows.

### A member is not a credential

A booking code bounded by its own booking is the right rule about the **code**. It was the
wrong rule about the **person**, and twice over:

- A member holding the QR for the court they played at 17:00, walking back in for the court
  they have booked at 19:00, was told `not_recognised`: your code is fake. It was not fake,
  it was theirs, it was live, and they were due on a court shortly.

  **How long that code lives is `grace_window_minutes` past the slot's end, and at the
  default of five minutes that is 18:05** — so the reachable version of this complaint is a
  member back at the door a minute or two after their court, not at 18:50. The relief cannot
  reach further than the code does: past 18:05 `AccessCodeService.ResolveAsync` refuses the
  token outright and the decision never gets here. 18:50 is the shape a club with a *long*
  grace window produces, and it is the fixture
  `A_spent_booking_code_still_opens_the_door_for_a_member_due_on_another_court` uses — minted
  with sixty minutes of grace, which is what a club that has since shortened the setting
  leaves in its members' hands. Read the example as "inside the life of the code they are
  holding", not as a number.
- A member **six minutes late** was told the same thing. The no-show sweep settles at
  `grace_window_minutes` past the start, sets `Status = NoShow` and truncates `EndsAt` to its
  own clock — so the booking QR answered `not_recognised` and the ident QR answered
  `no_booking`, **outside the building**, while the product's own way to reverse a wrong
  no-show is that member scanning at the court box **inside** it. A door that enforces a
  penalty by making it impossible to undo is the worst possible place for that rule to live,
  and a door settles no money in any case (§1).

So a booking code outside its own window still opens a door **iff the same member holds
another qualifying booking whose door window contains now**. Without one the refusal is
exactly what it was. Qualifying means:

| Status | Counts for a door | Because |
|---|---|---|
| `Booked` | yes | unchanged |
| `NoShow` | yes | a bet against attendance the member is in the middle of losing |
| `Completed` | yes | the record that they were *on the court* — see below |
| `Cancelled` · `AdminBlock` | no | decisions the CLUB took about the booking, and final |

**`Completed` was the `NoShow` defect with the sign reversed, and it was the worse half.**
`LightsCueWorker` runs every fifteen seconds and promotes a *checked-in* booking the moment
its `EndsAt` passes, so within about fifteen seconds of a slot ending the member who had
actually played was refused at the door — booking QR `not_recognised`, ident QR `no_booking` —
while the member who had *not* turned up was still being let in for the whole grace window by
the `NoShow` row above. The relief was reaching precisely the wrong one of the two.

It survived two rounds because of its FIXTURE, not its rule: the tests that pinned "a
completed booking's code opens nothing" set `Status = Completed` by hand on a row with
`CheckedInAt == null`, and that row is a state the product cannot produce — the only writer of
`Completed` requires attendance. `Completed` is not a decision about the booking at all; it is
the record that the member was on the court, which is a better reason to be in the building
than anything else this query can see.

The end they are measured against is the instant that booking's own code dies — see *The
upper edge is the code's own liveness* above — which for a `NoShow` is measured from the slot
as **sold**, because the sweep moves `EndsAt` and nothing else. The relief is therefore
exactly as long as the product would have gone on showing that member their code, and not a
minute more.

**The rule lives in one query**, asked twice with two horizons: step 5 asks it with the door's
own `H`, and step 6 asks it with `gate_early_entry_minutes`. It matches on the member and on
nothing else. It used to also match the code's own booking id, justified by a booking an
admin made on a member's behalf carrying a different user from the code's — a state no mint
path produces, and one that would have let the cached roster's barred filter (which keys on
the booking's user) and the online check (which keys on the code's) disagree about whom a
suspension binds. `AccessCodeService` now refuses to stage a code for a booking with no user
at all, so the two are the same person by construction.

**The two refusals are deliberately asymmetric.**

- **Before the window — `too_early`.** Named rather than folded into `not_recognised`, which
  is the opposite of the reasoning behind every other refusal here. The oracle argument
  applies to codes whose validity is the secret; this one tells the holder of a code the club
  itself minted for them that they are early, about a booking that is already theirs, which
  the door will honour later the same day. "Not recognised" would send a member with a valid
  booking to a desk that may not be staffed.
- **After the code expires, or for a booking that is no longer live — `not_recognised`**, and
  deliberately indistinguishable from a code that never existed. The row outlives the slot by
  the grace window, so a door that told "spent" from "unknown" apart would be exactly the
  oracle the rest of this section avoids.

The status test is on the **booking**, not on the code, because nothing revokes a code when
its booking is cancelled — revoking on cancel would strand a court box deciding offline from a
roster it fetched beforehand, which is the one thing that roster is for.

A sixty-second `MemberIdent` code is untouched by any of this: it names no booking, so it has
no window of its own. Under `active_member` it opens at any hour; under `booking_window` it
needs a qualifying booking exactly as before.

### Reasons

| `reason` | Means |
|---|---|
| `ok` | opened; the only reason carrying `opened:true` |
| `not_recognised` | code unknown, expired, malformed, another club's — or a booking code presented past the life of the code it is, or for a booking the club has `Cancelled` or blocked, by a member who holds no other qualifying booking |
| `member_not_active` | the club has suspended, rejected or not yet approved them |
| `no_booking` | `booking_window` only: not a club admin, and nothing booked inside the entry window |
| `too_early` | a booking code presented before its own booking's window opens |
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

**The token is not in the details here either**, which it was. §5 leaves it out of
`gate.opened` on purpose — a live access code in a trail an admin can read is a credential in
a log — and this path wrote it in full under `subject`, for a `gate_open` and an
`unknown_scan` alike. `RetentionWorker` anonymises a row's *subject* and never touches its
`DetailsJson`, so those bytes stayed readable for as long as the row did, and they open every
door in the club for the length of that booking's window.

**An offline refusal of a genuine code is named (review round 11, D11-2).** A door offline refuses a
v1 code it cannot accept from its own state — replayed, too early or late, a stale roster — and
uploads it as a plain `unknown_scan`. The server re-checks that code at the scan's instant for
identity only: no use is claimed, no forgery alert is raised, the code is never stored. A genuine
one is logged with reason `refused_offline`, the member named (the CSV says "Refused offline";
`?reason=not_recognised` no longer returns it); an unprovable one stays `not_recognised` with
nobody named. A court box's offline refusal (`device.court_unknown_scan`) is named the same way
and reaches the member's Night as `court.refused` with its court.

What `subject` carries is the **first eight hex characters of SHA-256 over the normalised
code**. Not reversible, not a lookup key, and it keeps the one property worth keeping: two
scans of one code still produce the same value, so "the same badge tried the side door eleven
times" is still a question the trail answers. The identity lives on `SubjectUserId`, which the
resolved `gate_open` path sets.

**It is keyed on nothing at all: every kind is fingerprinted, including the court box's own
`activation` and `release`.** It was keyed on the two door kinds, and that was wrong twice.

- **Mechanically.** The guard read the `kind` RAW while the receipt, the audit action and the
  malformed test all read it trimmed. So `" gate_open "` — one space — was stored, receipted
  and audited as `device.gate_open`, indistinguishable in the trail from an honest event,
  while the guard did not recognise it and wrote **the live access code in full**. The same
  spelling stepped around the `gate_open`-from-a-court-box refusal below. Anything holding the
  club key could do it by adding a character.
- **In substance.** The narrow version reasoned that an activation token "is the roster token
  for a booking the receipt already names", so hiding it gained nothing. That was true when it
  was written and stopped being true the moment this document existed: since §5, that same
  roster token opens **every door in the club** for the length of its booking's window. The
  receipt naming the booking does not make the bytes less live.

**So the `kind` is normalised ONCE, at the top of `/events` — trimmed and ordinal
lower-cased — and every decision after it reads that value**: the dispatch, the kind guards,
the fingerprint, the receipt's `kind` column and the audit action. A kind this server has
never heard of is recorded as it normalised (it is evidence, and a board cannot edit what it
has queued) and fingerprinted like every other. Lower-casing is ordinal and not the current
culture, because `ToLower()` on a Turkish locale maps `I` to a dotless `ı` and a server's
regional settings would then decide whether a board's events were recognised.

**Rows written before this change still hold their tokens.** Nothing rewrites them and
nothing here pretends otherwise; the remedy is the one the console already offers for a
leaked roster, which is rotating the club's device key and letting the codes expire.

### A malformed `kind` is receipted, never refused

A `kind` that is **missing, empty, or longer than 32 characters** is receipted and
acknowledged with outcome `malformed`, and the audit action is truncated to fit its column.

It is an outcome and not a 4xx, and that is the whole of the fix. A JSON null went straight
into `e.Kind.Length` and answered `500`; a two-hundred-character kind overflowed
`AuditLog.Action` (128) and answered `500` from the save. Either one is **permanent**: the
board drains its ring only up to `accepted_through` and re-posts the rest, so one malformed
event at the head stops every event behind it from ever arriving — including the `activation`
the no-show sweep is waiting on, which is real money. A board cannot edit what it has already
queued, so the only exit is a receipt.

### The heartbeat request carries two optional counters

A board with one LED and a boot log has failures it must report and must never show a member.
Two of them ride the heartbeat request as optional integers — additive, so a board that sends
nothing is reporting zero, and the court box's wire is untouched:

| Field | Counts |
|---|---|
| `no_push` | heartbeats the board could not push: a body that did not fit its buffer, arrived incomplete, or failed its read on an otherwise-`200` response |
| `events_lost` | queued events its ring overwrote before they could be uploaded |

**Both are SINCE-BOOT TOTALS, and three places in this repository said otherwise** — this
section, the heartbeat's own field comment, and the log line the server writes ("since the
last one it could"). A board cannot know which of its reports the server kept, and a lost
response is precisely the case `no_push` exists to report, so a counter reset on send would
lose the whole count exactly when it mattered. The reader takes the **rise** between two
heartbeats. Both **saturate** at `INT32_MAX` on the board rather than wrapping, so a board up
for years reports a ceiling instead of a small number.

**The watchdog half does NOT ride `no_push`, and this section said it did.** A watchdog that
will not arm is reported by the link pattern's fault variant on the LED and by the boot log.
It is not a heartbeat that failed to push, and folding it in would make one number mean two
unrelated things to whoever reads it.

The server **logs both against the device code and stores nothing**: a column would be an EF
migration for a counter nothing decides anything on, and §9's "no EF migration" still holds.
They change no part of the response.

**They bind as 64-bit, and an out-of-range or negative value is IGNORED rather than refused.**
`no_push` bound as a 32-bit integer, so the very first value past the board's own saturation
point answered **`400` for the whole heartbeat** — no `gate` block, no `roster`, nothing — and
a door that had been up long enough to saturate a counter then lost its cache at the next
stale deadline. The corpus vector's own note has said since it was written that a counter must
not be able to take a door out of service; it could. Vectors
`gate-heartbeat-request-no-push`, `gate-heartbeat-request-events-lost`,
`gate-heartbeat-request-counters-out-of-range`.

**A `gate_open` uploaded by a `CourtBox` row is refused by name**, the mirror of §7: receipted
and acknowledged, outcome `not_a_gate`, and the `device.gate_open` row **names nobody**.
Nothing settles on this path either way, so no money turns on it; what the guard prevents is a
record. Without it, anything holding the club key with a box's MAC could post an arbitrary
access code and have the trail say that person opened a door — for a door that does not exist.
A false record of who was in the building is a worse artefact than a refusal.

### An offline `unknown_scan` names nobody, and that is structural

A gate queues `unknown_scan` for a scan its **cached roster did not carry**. By construction
the server cannot then name the member either: if the token were resolvable it would have been
in the roster the board was holding, and the board would have opened the door. So the row has
`SubjectUserId = null` and a fingerprint, always — that is not a gap to be closed later and it
is worth stating, because the activity reader (§9) shows these rows and "unknown code ·
`1f4c9ab2`" is all a console can honestly render. The fingerprint is what makes them useful:
the same badge at the same door eleven times is a pattern the desk can act on without anybody
being named.

### Residual: `/events` receipts and audit rows are never purged

`RetentionWorker` anonymises a member's identity on old rows; nothing **deletes**
`device_event_receipts` or `audit_log`. A busy club's door therefore accumulates rows for as
long as the deployment lives. Nothing in this round changes that, and it is recorded rather
than left to be discovered:

- the activity reader bounds what one request can pull (§9, `limit` ≤ 200) but the table
  underneath it grows without limit;
- there is no index on `details_json`, which is what that route matches a board on;
- the receipts table is what makes an event upload idempotent, so a purge is not merely a
  delete — it has to be older than any board could still be retrying, which is
  `MaxEventAge`'s thirty days at least.

Carried on the watch list as `B8`. It is a capacity and cost question rather than a
correctness one, which is why it is a residual and not a fix.

---

## 7. What a gate may not do, and what a board out of service may not do

### A gate on a court box's path

A gate row arriving at any of the four court-box paths is refused **by name**, and a court box
arriving at the one gate-shaped event is refused the same way:

| Path | Answer |
|---|---|
| `POST /device/activate` | `200 {"activated":false,"reason":"not_a_court_box","granted_seconds":0}` |
| `POST /device/walkup` | `400 {"error":"not_a_court_box"}` |
| `POST /device/events`, kind `activation` | receipted and acknowledged; outcome `not_a_court_box`; nothing stamped, nothing charged |
| `POST /device/events`, kind `release` | the same |
| `POST /device/events`, kind `gate_open`, **from a court box** | receipted and acknowledged; outcome `not_a_gate`; the audit row names nobody |

**Every one of these already refused a gate before the check existed** — a gate has no court
numbers, so the activation path fails its relay-index test against an empty list and the
walk-up fails `court_not_on_device`. Both are wrong sentences: the court was never the
problem. Worse, both stop being refusals at all the moment anybody puts a court number on a
gate row, which is one PATCH away. The rule is "a door never sells court time and never
checks anyone in", and a rule enforced by the emptiness of an unrelated list is not enforced.

The event paths are receipted and acknowledged rather than 4xx'd, because an event a board
cannot change is a board retrying for ever.

### `403` is the club's word, and it is authoritative

A board an admin has taken **out of service** is answered `403` on all five
`/api/v1/device/*` routes — `/heartbeat`, `/activate`, `/walkup`, `/events` and `/gate`. For a
gate that status carries a meaning no other failure does:

| What the board gets | What it means | What it does |
|---|---|---|
| `403` on `/gate` | the club has taken this board out of service | **deny the scan; no roster fallback** |
| `403` on `/heartbeat` | the same | **commit an EMPTY roster** |
| `401`, `404`, `408`, `429`, `5xx`, `0`, a malformed `200` | the server could not be reached or could not answer | fall back to the cached roster |

The asymmetry is the whole point. Every other failure is evidence about the *link*; a `403` is
evidence about the *club's decision*, and a board that fell back to a roster it fetched before
that decision would keep admitting people the club has just stopped admitting.

**So the converse is a contract too, and it is now pinned: on this surface a `403` can mean
nothing else.** The backend used to pin only the forward direction — that a disabled board
really is refused — while the firmware depends on the reverse. A new endpoint filter, an
authorization policy with a second requirement, a middleware that starts applying to this
group: any of those would make a healthy board purge its roster and deny a member at the door,
with no test going red and nothing in the log telling it apart from an admin throwing the
switch. The group is therefore enumerated three ways — its routes and their metadata, the
source of everything that can serve or wrap it, and the behaviour of every refusal shape a
board can provoke.

The one documented exception is a **400**, not a 403, and is deliberate: an unrecognised `kind`
on the heartbeat is refused before the MAC is resolved (§3), so a disabled board sending one is
told its firmware is wrong rather than that it is out of service. A 400 is not a status D4 acts
on. The registration cap (§8's fourth rule) answers **409** for the same reason, stated there.

**That pin is APPLICATION-LEVEL, and the boards do not talk to the application.** They talk to
`nginx`. A gateway rule that answered `403` for any reason at all — an IP allow-list, a rate
limiter configured to forbid rather than to `429`, a WAF snippet pasted in during an incident —
would take **every door in the club out of service at once**, and keep them there until each
board's next ACCEPTED heartbeat: no code change, no API deploy, nothing red, and a symptom
("all the doors stopped working") that points at the application rather than at the file that
caused it. `nginx/nginx.conf` has no `deny` directive and no `return 403` today, and
`DeploymentPostureTests.The_gateway_never_answers_forbidden_itself` is what keeps it that way.
Anything in front of the gateway — a reverse proxy at the club, a tunnel, a CDN — is outside
this repository and outside that check, and the same reasoning applies to it: on the device
surface, `403` is a word the firmware obeys.

**The residual, stated because it is real and because nobody should discover it during an
incident:** this only reaches a board that can still reach us. A gate that has been **cut off**
— uplink pulled, switch dead, line down — never hears the `403`, and goes on admitting
whatever its cached roster still carries until that roster goes stale, six hours after it was
last received. Taking a door out of service is a withdrawal that takes effect at the server
immediately and at the board only when the board next asks.

So "out of service" is not a lock. Where a club needs a door shut *now* and cannot reach the
board, the answer is physical, the same way §11's is.

---

## 8. Tenant settings

| Key | Default | Range | Meaning |
|---|---|---|---|
| `gate_unlock_seconds` | 15 | 1–30 | how long the lock is released per open |
| `gate_access_policy` | `active_member` | `active_member` \| `booking_window` | who may open a door |
| `gate_early_entry_minutes` | 30 | 0–240 | how long before a booking its holder may enter |
| `device_alert_cooldown_minutes` | 60 | 5–1440 | how long before the same board may mail the club again |

**Fifteen seconds, and it was three.** Three is how long a lock takes to throw; it is not how
long a person takes to notice a lamp go solid, move a bag to the other hand, reach for a handle
and pull a door that opens towards them. A member who is half a second slow scans again, and at
a door that is offline that second scan is a second record for one arrival. The safety bound is
unchanged — the club may still set anything in [1, 30], and the firmware caps every release at
thirty seconds whatever the server answers (§11.2) — so a club that wants Carl's three back sets
three and has it on the next heartbeat with no reflash. What the number governs is the ordinary
open and the window before the server has spoken at all. §11a.6 carries the two consequences of
raising it, because neither is cosmetic. Thirty minutes is the club's own habit — a member due on court at
six arrives at half past five to change — and it is deliberately much longer than
`activation_cue_window_minutes`, because getting into the *building* early is ordinary and
getting the *lights* on early is somebody else's court.

`gate_early_entry_minutes` is read three ways and the first two are the same window on
purpose: it is how far ahead of a slot the roster carries it, and it is the window
`booking_window` tests online. A member let in offline and a member let in online are let in
on one rule.

The third is a **floor**: under `active_member` a booking code's own window is
`max(gate_early_entry_minutes, min(roster_window_minutes + activation_cue_window_minutes, 240))`
(§5), so raising this setting can widen the door but can never narrow it below what the cached
roster already admits. Two settings this club did not set for the doors —
`roster_window_minutes` and `activation_cue_window_minutes` — therefore reach the door under
the default policy, and they do so because they are what decides when the member's phone shows
the code at all. **Both of those, and this one, are bounded again on the way out**, and the
sum is capped at 240: see §5's ceiling for what it cost not to.

**Every number a door reads is bounded on the PUT *and* clamped again on the way out**, because
the PUT is not the only way a number reaches that column — a hand-edited settings document is.
That was true of `gate_unlock_seconds` from the day it shipped and of nothing else on this
list. The four bounds (`roster_window_minutes` 5–1440, `activation_cue_window_minutes` 0–1440,
`activation_forward_window_minutes` 1–1440, `gate_early_entry_minutes` 0–240) are named once
in the code, so the number an admin is refused at and the number the reader enforces cannot
drift apart.

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

### `device_alert_cooldown_minutes` is not a door setting, and lives here anyway

It bounds how often **any** board — court box or door — may mail the club about itself, and
it is on this list because the door is what made its absence expensive.

`PeripheralHealthWorker` had no cooldown and no minimum outage: every transition mailed every
admin of the club. A board on a marginal uplink flapping every few minutes was a mailbox full
of "not reporting" and "back online" until somebody muted the sender, and an alert nobody
reads is worse than no alert because the club believes it has one.

**The cooldown is per BOARD, and for one round this section claimed it also answered the
fleet.** It does not. Auto-registration is unbounded, so anything holding the club's device
key can mint boards with invented MACs — and twelve boards are twelve *first* outages, each
inside its own cooldown, so the club still gets twelve mails in one thirty-second tick and the
only ceiling was the tenant rate limit — and since R16 the device limiter is per board, so twelve
invented MACs are twelve buckets and only the device-only per-address ceiling (`device-ip:`, R17) is left. The naming rule that was supposed to cover it was a
DOOR rule, and a `kind`-less heartbeat registers a **court box**, which had no naming step at
all. Four rules, and the last two are what actually bound the fleet:

- **At most one outage mail per board per cooldown.** Derived by replaying that board's own
  outage rows rather than stored on them, so it needs no migration; each row is announced iff
  the cooldown has elapsed since the last *announced* one, not since the last row — otherwise
  a board flapping just inside the window chains past it for ever. This bounds a FLAPPING
  board and nothing else.
- **A recovery mail is sent only if its outage mail was.** Same replay, same rows, so the two
  decisions cannot disagree. The one thing that can move between them is the setting itself,
  and a club that changes it mid-outage may get an all-clear for an alarm it did not get; that
  is the price of not adding a column and it is bounded to the boards in outage at that moment.
- **A board NO ADMIN HAS ACKNOWLEDGED mails nobody**, whatever kind it is. `AutoRegistered`
  means exactly "nobody has looked at this row", it is already on every kind, and the first
  admin edit clears it — so a board a club genuinely installed becomes mailable the moment
  anybody touches it, and an invented one never does. The gate's own naming rule survives as
  the narrower of the two and is about a different thing: `gate_key` is what makes the message
  identify a door at all, and §4 keys the offline roster on it. The outage row and the
  `peripheral.*` events are still written — the Devices page is where an admin looks at a
  board on purpose, and what is withheld is the interruption, not the record.
- **A club may hold at most sixteen boards nobody has acknowledged** — the contract constant
  `DeviceRegistryService.MaxUnacknowledgedDevices`. Past it, auto-registration answers
  **`409 too_many_unacknowledged_devices`** and no row is created. It counts the
  *unacknowledged* rows rather than all of them, because a cap on the total would eventually
  refuse a club that genuinely has forty boards, at the worst possible moment; the way past it
  is the thing an admin was going to do anyway. It bounds **creating** a row and never serving
  one, so a flood cannot take a club's installed doors offline.

  **409 and not 403**, and that is load-bearing rather than taste: on this route group a 403
  means "this board is out of service" and nothing else (§7), and the firmware acts on it by
  committing an empty roster and refusing to fall back. A registration refusal wearing a 403
  would take every door in the club out of service for as long as the flood lasted.

**Taking a board out of service closes whatever outage it is in, silently**, at the instant
`OutOfServiceSince` records. The sweep skips disabled rows, so an outage open at that moment
stayed open for as long as the board was out of service — switch it back on and the first
heartbeat mailed the whole club "back after 43 200 minutes" about a board they had themselves
unplugged. The close is at the switch rather than at the board's last heartbeat because that
is the last moment the club was accountable for it, and because every settlement instant after
the switch is decided by `OutOfServiceSince` instead (`DeviceOutageIndex.DoorWasShutFor`), so
no deadline is re-priced by it.

### Both key spellings bind on the PUT

This endpoint answers snake_case and binds camelCase, and the cost of a client picking the
wrong one is not an error — it is `null`, which the PUT reads as "omitted, leave unchanged",
so the save returns `{"saved": true}` and changes nothing. That is the silent write
`Opening_the_settings_page_and_saving_it_changes_nothing` exists to prevent. For three
settings that decide who gets into a building it is worth removing rather than documenting,
so `gateUnlockSeconds` and `gate_unlock_seconds` both bind, and so on for the other three —
`device_alert_cooldown_minutes` included, which the console requires on the GET and sends
camelCase on the PUT. The GET serves it whether or not the club has ever set one: the
console's type carries no client-side default, so an omitted key is a settings page that
cannot render, on exactly the day a club's boards are misbehaving.

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

**`gate_key` itself is two-valued and both values are pinned**, from the API side and from the
console's. `""` clears the name; `null` and an absent key both mean "leave it alone". The
console sends `""` to clear, deliberately, because the other reading is the one a client gets
wrong for free: send `null` meaning "clear it" and the API answers `200` having changed
nothing, and nothing anywhere says so.

**Both spellings bind, for the reason §8 gives about the settings PUT** — and that argument
was made in this document and then not applied to the one field on this PATCH that carries the
same risk. This endpoint answers snake_case and .NET binds camelCase, so `{"gateKey": "x"}`
bound to `null`, which `gate_key` reads as "omitted", and the PATCH returned `200` with the
door's OLD name in the body. For a value that names the door in every audit row a club will
ever read back, a silent no-op is worth removing rather than documenting. snake_case wins
where both arrive, and every refusal in the table above applies to whichever value is used —
a spelling is not a way round a rule.

**Naming a door now does something**, which it did not when this section was first written: it
is what starts that board's offline fallback (§4). The console says so where an admin can act
on it rather than leaving it to be discovered when the network drops.

`name` and `enabled` work on a gate exactly as on a box. Taking a gate out of service refuses
it `403` on every device route, as it does a box.

### `GET /api/v1/admin/devices/{id}/activity` — what this board has been doing

Admin JWT, tenant-scoped, and the same route for a gate and a court box. It is the reader the
audit trail did not have, and the door is why it had to exist: §1, §5, §6 and go-live §12 all
assume somebody can read `gate.opened` rows back, and for one round nothing could.

```
GET /api/v1/admin/devices/{id}/activity?limit=50

{ "items": [ {
    "at":          "2026-09-19T18:04:11.271+00:00",
    "action":      "gate.opened" | "gate.denied_<reason>" | "device.gate_open" | …,
    "reason":      "ok" | "not_recognised" | … | null,
    "offline":     false,
    "member":      { "id": "<guid>", "name": "Jane Doe" } | null,
    "fingerprint": "1f4c9ab2" | null
} ] }
```

- **Newest first.** A console pages this and shows the first page; an ordering that was not
  stated would eventually be changed by an index.
- **`limit` is 1–200, default 50, and CLAMPED rather than refused.** A console asking for a
  million rows is a mistake to bound, not a request to answer with an error screen.
- **404 for another club's board**, because whether a device id exists at all is a fact about
  that tenant. Both filters are pinned — the device lookup and the row query — by a
  cross-tenant injection, because rows are attributed to a board by a `device_id` inside a
  jsonb document with no foreign key behind it.
- **`action` is the row's own action**, unrenamed. The console owns the dictionary that turns
  it into a sentence, and it needs both vocabularies: §5's refusal reasons and §6's outcomes.
- **`reason`** is a gate decision's `reason` or an uploaded event's `outcome`, whichever the
  row carries, else null. The two are not unified here on purpose: they are written by
  different paths about different things — a refusal the API decided, and what the server made
  of something a board had already done.
- **`offline`** is true when the row came from `POST /device/events`, keyed on the `seq` only
  that path writes. Not on the action's prefix, which would call an admin's `device.updated`
  an offline open, and not on a list of kinds, which goes stale the first time a board learns
  a new one.
- **It is the BOARD's trail, not a door-opens feed.** The registration row and the admin edit
  are in it, because an admin diagnosing a door should not have to know which half of the
  story to look in before they know what is wrong.
- **`DetailsJson` is never returned**, in whole or in part: it carries the club's internal
  device id, the gate key and a court box's relay and booking ids.
- **`fingerprint` is validated to BE one** — eight lowercase hex characters — rather than
  forwarded. Rows written before §6's fingerprint existed hold a live access code in `subject`
  in full, and `RetentionWorker` never touches `DetailsJson`, so a reader that trusted the
  field would have published every one of them to the console on the day it shipped. Such a
  row is still listed, with `fingerprint: null`: it is evidence, and hiding it would be the
  wrong half to withhold.

**No EF migration.** `Kind` and `GateKey` have been columns with indexes since the device
table shipped, and nothing here persists anything new. This route adds no column either — it
reads `audit_log`, which has always been there. It has no index on `details_json` and does not
need one at a club's volume; that, and the fact that nothing purges these rows, are recorded
as residuals in §6 rather than left to be discovered.

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

**A club admin has no degraded mode either**, and for the same structural reason: the
`booking_window` carve-out is an online rule, a roster holds bookings, and staff on shift hold
none. At a cut-off door a club admin is refused like anyone else without a booking.

**An unnamed board has no degraded mode at all** (§4): it is pushed an empty roster, so the
moment it loses the server it opens for nobody. That is a narrower failure than the one it
replaces — a board anybody could self-register being handed the club's whole live code set —
and it lasts exactly until an admin names the door.

**With the single rotating member code (firmware 1.1.0 and later — 1.1.2 since R18, [`member-code.md`](member-code.md))**
the offline rule is the same rule by members instead of by codes: a door that cannot reach the
server **verifies** a v1 code's OFF half against the per-day key its heartbeat delivered, then
admits the member only if a rostered booking names them — organiser or accepted partner — inside
that booking's window. A code the door has already opened for is refused as `replayed`; a sync
older than the roster's six hours is `roster_stale`; everything else it cannot prove is
`not_recognised`. What the door records is the scanned token, which the server re-checks with the
ON half no door ever holds. Online nothing changes: the bytes go up and the answer is final.

---

## 10a. The threat model, stated honestly

**None of what follows is a new weakness introduced by the gate.** It is the posture the court
box already has, written down because a door is where a reader will assume otherwise.

### The wire is cleartext HTTP on the club LAN

The roster, the bearer key and every scan travel as plain HTTP between the boards and the API
on the club's own network — the same posture as the court box, for the same reason: an ESP32
doing TLS with a current certificate store, on a network nobody administers, is a worse
failure mode than this one. Anyone who can see that LAN can read:

- the tenant device API key, from any request header; and
- up to forty-eight live access codes, from any heartbeat response to a named gate.

**And the key alone buys codes without waiting for one to cross the wire.** A heartbeat with an
invented MAC and no `kind` auto-registers a **court box** on the club's first four courts, with
no naming step, and is answered with up to sixteen live booking codes for those courts — each
of which, after §5, opens every door in the club inside its own booking's window. §4's naming
step gates the gate's 48-code response and nothing else. This is not new with the door: it is
the court box's provisioning story, unchanged, and the door is what turned those codes into
building entry. It is an OPEN QUESTION for the owner rather than a decision taken here
(`memory/questions.md`), because taking a box's roster away until an admin names it changes the
install story and the offline lighting path.

### What a captured roster code buys

**After §5's booking-code window, one captured code opens every door in the club — but only
inside its own booking's window**, and only while that booking is still `Booked`. Before that
change it opened every door at any hour for as long as the row survived, which is the
difference between "somebody's 19:00 court gets them in from 16:50" and "a building key".

The key itself is worth more than any code: it registers boards, reads heartbeats and, once a
door is named, pulls the whole current roster on demand. Rotating it is the club's remedy and
the console offers it.

### Codes are bearer tokens and nothing identifies the bearer

A code is a secret that opens a door, and that is the whole of it. There is no PIN beside it,
no photo, no second factor. **A member who shares a QR shares entry for that window**, and
nothing on the server, in the audit row or at the door can tell the difference: `gate.opened`
names *whose code it was*, which is not the same claim as who walked through.

That is a product decision rather than an oversight — a door with a camera and a second factor
is a different product, and this one is replacing a lock a member props open with a fire
extinguisher. But the audit trail must not be read as attendance or as presence, and §1
already says why it is not attendance for a different reason.

### What is therefore NOT claimed

- Not that a door proves who entered.
- Not that taking a board out of service stops it admitting anyone (§7's residual).
- Not that a suspension reaches a cut-off board before its roster goes stale.
- Not that the network is trusted; only that it is the same network the court box already
  runs on, and that the blast radius of what crosses it is now one booking's window rather
  than a standing key.
- Not that a club's booking codes are unreachable without a named gate: the court box's own
  auto-registration hands out sixteen at a time with no naming step at all (above).
- Not that the roster is the whole of the club's bookings. It is capped at 48 after ordering,
  so a club with more than that inside its window has a **49th booking that no door admits
  offline** — a member whose court is real, whose code is live, and who is refused during an
  outage because forty-eight other members were due earlier. The cap is a firmware buffer and
  not a policy, and the residual is stated rather than engineered around.
- Not that a suspension, a cancellation or a no-show reaches a board that has already been
  pushed. A roster is a snapshot: a booking swept to `NoShow` after the push is still in the
  cache and still opens the door offline until the next heartbeat replaces it — which, after
  §5's relief, is also what the ONLINE decision would now do inside the slot the member paid
  for, so the two agree for most of that window and diverge only past it.

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

1. **LOCKED is asserted explicitly at the top of `setup()`, before anything else the firmware
   does** — and the pin level is written *before* `pinMode(OUTPUT)`, so the relay never
   glitches through a released state on the way up. This matters most on a watchdog reset,
   which is exactly when nobody is watching.

   **"Before anything else" starts at `setup()` and not at the reset**, and the difference is
   about 0.3–0.7 seconds. From the reset until the sketch runs, the pin is **hi-Z** and no
   software on the board decides anything; what the relay does in that window is decided by
   the module's own input bias, which is a property of the hardware in front of you. It is
   therefore a **bench check** rather than a firmware guarantee, and it belongs with the
   dead-board row on `docs/go-live-checklist.md`, where somebody measures it on the actual
   module.

2. **No release deadline is ever set later than the hard cap**, whatever the server says. The
   server clamps `unlock_seconds` to 30 and the firmware caps it again at
   `GATE_UNLOCK_HARD_CAP_MS`; two independent bounds, because one of them will be wrong
   eventually.

   **The physical release can nonetheless overrun that deadline, by at most one blocking
   call.** The loop cannot read the clock while it is inside an HTTP request, so a deadline
   that falls during one is serviced when the call returns. The bound is therefore
   *deadline + one call's worth*, and a call is **three** budgets, not two — the connect, the
   status line and headers, and the response body, four seconds each. One call is therefore
   **12 000 ms**, or **12 010 ms** counting the loop's ≤10 ms idle, and the worst case against
   the thirty-second cap is **42.01 s**. §11a.1 sets out the three phases and where each
   number comes from; §11a.2 sets out the larger bound that applies to a peer this firmware
   cannot budget at all. The earlier sentence here — that the relay can *never* stay released
   longer than the cap — was the deadline's property stated as the relay's; the earlier
   arithmetic quoted one four-second budget where there are two, and then two where there are
   three.

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

## 11a. The board's own rules — what the firmware decides before the server is asked

Everything above §11 is the SERVER's half of the contract. This section is the board's, and it
is here because four of its rules are now visible to a club — two refusal words a desk will read
in a trail, a bound a technician measures with a stopwatch, and a field the deduplication key
rests on. Each sentence is checkable in `src/iot/door-gate`, and the pins are named beside it
rather than in §12's table, which is deliberately the server half only.

### 11a.1 One blocking call per pass, in three phases

The loop makes **at most one** blocking HTTP call per pass and kicks the watchdog immediately
before and immediately after it (`lib/gatelogic/GateApp.h:39`, `src/GateApp.cpp:223`), so the
longest the watchdog countdown ever runs unkicked is one worst-case call. A pass with three
complete tokens in the UART buffer decides one of them and leaves the other two for the passes
that follow, ten milliseconds apart (`src/GateApp.cpp:279`).

A call is **three** budgets on one peer, because the ESP32 core applies the first two separately
and the third is this firmware's own:

| Phase | Budget | Where it is applied |
|---|---|---|
| TCP connect | 4 000 ms — `kHttpConnectTimeoutMs` (`GateConfig.h:273`) | `HTTPClient::setConnectTimeout` |
| status line + headers | 4 000 ms — `kHttpResponseTimeoutMs` (`GateConfig.h:283`) | `HTTPClient::setTimeout` |
| response body | 4 000 ms — `kHttpBodyBudgetMs` (`GateConfig.h:298`) | `gatelogic::readBody`, on a deadline sampled **after** the headers return |

`kWorstBlockingCallMs` is their sum, derived and never written out, so changing a budget moves
everything built on it together: **12 000 ms** (`GateConfig.h:310`).

**The body's budget is separate on purpose.** It used to share one deadline computed from the
instant the whole call started, so a connect and a header phase that between them spent eight
seconds left a 4.6 KB roster a deadline already in the past — and a roster that was arriving
perfectly well was reported as a transport failure (`GateConfig.h:285`). That is a door with no
offline fallback, produced by a slow evening.

**The header budget is honest about what it is not.** `setTimeout` is an *inter-byte* timeout: a
peer that dribbles one byte every three seconds resets it forever, `POST()` cannot be interrupted
from this firmware, and no number in `GateConfig.h` bounds that case (`GateApp.h:82`). Two of the
three phases are genuinely bounded here; the header phase is bounded only nominally, which is
what §11a.2 exists for.

What the three budgets bound is the **physical** release:
`kMaxPhysicalReleaseMs = 30 000 (the hard cap) + 12 000 (one call in flight) + 10 (the pass tick)
= 42 010 ms` (`GateConfig.h:416`). Raising the default from 3 s to 15 s did **not** move it: the
first term is the cap, which no single answer and no sequence of re-arms may pass. A release that
exceeds it means the loop did not get back to its own lock inside the budget the whole arithmetic
rests on, and the board reports it as a `relock_overdue` fault (`src/GateApp.cpp:510`) — which
was a sentence in three files and a literal in one test while nothing on the board compared it to
what the relay actually did.

*Pinned by* `test_config_the_worst_call_is_connect_plus_headers_plus_body`,
`test_app_a_release_outlives_its_deadline_by_at_most_one_blocking_call`,
`test_app_the_watchdog_is_kicked_around_every_blocking_call`.

### 11a.2 The watchdog bound, term by term

Against a peer that dribbles headers the true bound is not 42.01 s — it is the **watchdog**, and
the reset that follows it. The arithmetic, rather than the total:

```
  the release window, bounded by GATE_UNLOCK_HARD_CAP_MS        30 000 ms
+ the task watchdog period, GATE_WATCHDOG_SECONDS                15 000 ms
+ the boot that follows it, which is what takes the lock back      ~500 ms
---------------------------------------------------------------------------
                                                          about 45 500 ms
```

- **30 s** is the cap (`GateConfig.h:108`), bounded again by a `static_assert` into the
  contract's own [1 s, 30 s] (`GateConfig.h:528`).
- **15 s** is `GATE_WATCHDOG_SECONDS` (`GateConfig.h:173`). It is not a free number: a
  `static_assert` requires it to exceed one worst-case call plus a whole pass's margin —
  `15 000 ≥ 12 000 + 2 000` (`kWatchdogMarginMs`, `GateConfig.h:316`; the assert,
  `GateConfig.h:616`). **Eight seconds against an eight-second call was a guaranteed reset loop**
  — the board panicked before the call it was waiting on could return, booted, and did it again,
  never loading a roster and admitting nobody. Twelve was right for a two-phase call and is not
  right for a three-phase one, which is why the assert moved with the third budget.
- **~0.5 s** is the boot, and it is the term that ends the release: `beginOutputs()` writes the
  LOCKED level into the output register *before* the pin drives anything, first of all in
  `setup()` (`src/gate/main.cpp:411`, `src/GateApp.cpp:37`). Nothing else takes the lock back,
  because nothing else is running.

**No code on this board can report the 45.5-second case**, and that is stated rather than left to
be inferred: the part has reset, so `relock_overdue` is unreachable for it (`src/GateApp.cpp:506`).
It shows up on the *next* boot as two fault codes — `wdt_reset`, meaning this board has been reset
by its watchdog at least once in a row, and `boot_reason_task_wdt`, this one boot's cause
(`src/GateApp.cpp:92`; the reason table, `src/gate/main.cpp:263`) — and as a held-back first call
(`BootRecovery.h`), so a dribbling peer cannot be reached again within a second of every reset.

**The simulator cannot reproduce it.** Its `SocketHttpPort` bounds its own header read, so every
number the simulator measures is the three-budget case (`GateApp.h:100`). Both numbers are true of
different peers and the larger one is the one to plan a door around.

*Pinned by* `test_app_a_dead_api_host_never_starves_the_watchdog_or_the_lock`,
`test_app_a_board_the_watchdog_reset_holds_its_first_call_back`,
`test_boot_recovery_backs_off_only_after_a_watchdog_reset`.

### 11a.3 The re-lock dwell is measured from the moment the lock RE-ENGAGES

**From the close, not from the unlock command**, and the difference is the whole release
duration. `UnlockTimer::tick` arms the dwell at the instant the window ends — the same instant
the relay is written open (`lib/gatelogic/UnlockTimer.h:162`; the relay write,
`src/GateApp.cpp:484`). Measuring it from the unlock command would let a door be re-opened before
it had physically latched, which is precisely the defect the dwell was added to close.

Two lengths, because two closes mean different things:

| Close | Dwell | Why |
|---|---|---|
| ordinary — the granted window ran out | `GATE_MIN_RELOCK_MS`, **400 ms** (`GateConfig.h:155`) | a relatch floor: a strike drops in tens of milliseconds, a maglock re-magnetises in about 300. Short enough that a second member arriving behind the first does not notice it |
| the HARD CAP forced it | `GATE_RELOCK_DWELL_MS`, **3 000 ms** (`GateConfig.h:138`) | that close is the board overruling somebody who has held the door open for the whole cap, and the point of overruling them is that the door shuts. Sized against a doorway's closer, not against the release time |

**The dwell is no longer "the same number as the default", and that justification is gone rather
than quietly falsified.** It was 3 000 ms because the default was 3 000 ms; the default is 15 000
now and the dwell is still 3 000, because the two answer different questions. A longer dwell is a
queue of innocent members refused for something one person did; a fifteen-second one would be a
door refusing a queue for a quarter of a minute. The relation is asserted both ways
(`GateConfig.h:542` and `:553`) and pinned in `test_config_defaults_are_carls_wiring`.

**Why any dwell at all.** The cap bounds a *window*, and the next accepted scan opens a fresh one
— legally. On this loop the two land in the **same pass**, because `pass()` pumps the lock out of
`afterBlocking()` and applies the decision that call produced two lines later
(`src/GateApp.cpp:229`). Measured on the compiled simulator with two alternating tokens every
50 ms: the relay was written OFF and ON at the same millisecond, dark for 0 ms, for ever. A relay
de-energised for zero milliseconds was never de-energised — the strike does not drop and the
maglock keeps its armature — so the door physically never relocked, with no single request
breaking any rule.

*Pinned by* `test_unlock_a_capped_window_is_followed_by_real_dark_time`,
`test_unlock_any_close_guarantees_the_lock_actually_relatches`.

### 11a.4 `relocking` and `too_fast` — two refusals that are not about the member

Every other reason in §5 is a statement about the person at the door. These two are statements
about the board, and they have distinct words for a reason a desk cares about: a trail full of
`relocking` reads "somebody is holding this door open", and a trail full of `too_fast` reads "this
door is being hammered". Neither is "your code does not work"
(`lib/gatelogic/GateFlow.h:120` and `:127`).

| | `relocking` | `too_fast` |
|---|---|---|
| **When** | the lock has not finished relatching — §11a.3's dwell is still running (`src/GateApp.cpp:366`) | this board will not ask the server again yet: `kMinScanCallSpacingMs`, a **250 ms** floor under `/gate` calls whatever token asks for one (`GateConfig.h:244`; the branch, `src/GateApp.cpp:372`) |
| **Is the API asked?** | **No.** Refused before the call, on the debounce's precedent — a 200 answering `opened` would put a door opening in the server's audit trail that did not happen, and a whole blocking call spent to be told yes about a door that cannot open is the pass spent on nothing | **No**, by definition |
| **Answered from the roster instead?** | No | **No, deliberately.** The roster does not know about a membership barred this morning, so letting a throttle send a scan there would be this board's own rate limiting opening a door the API would have refused |
| **What the member sees** | the denial blink — three fast blinks, the same as every other refusal (`src/GateApp.cpp:437`). The door does not say which refusal it is and there is no pattern to look for | the same |
| **What the server is told** | **nothing at the time.** Offline, the refusal is queued as an `unknown_scan` (`GateFlow.cpp:190`, `src/GateApp.cpp:465`) and reaches §6's path later; online, nothing — the API can see for itself that it was not asked | **nothing, ever.** `refuseTooFast(false)` never queues (`src/GateApp.cpp:386`): this branch only runs while the board is ONLINE, and a ring filling with a board's notes to itself is the eviction problem with a different cause |

Neither word is on the wire as a `reason`. Both are board vocabulary with no server equivalent,
and the server never answers either (`GateFlow.h:103`).

**`relocking` is applied twice, and the second time is not redundant.** A scan can be decided
before the dwell exists and applied after it does, because the pass that closes a window is very
often the pass that applies the decision a blocking call inside it produced. So a decision that
came back `released` is **rewritten** into the refusal rather than dropped: the lamp denies, and an
offline record says a scan was refused rather than that a door opened (`markRelocking`,
`GateFlow.cpp:206`; the call site, `src/GateApp.cpp:449`). An event still saying `gate_open` for a
door that never moved is the one thing an audit trail must never contain.

**Why 250 ms costs a legitimate member nothing.** Two members arriving together are hundreds of
milliseconds apart at best, and one member holding a phone at the reader is suppressed by the
two-second debounce instead (`kScanDebounceMs`, `GateConfig.h:210`). The debounce alone was not
enough and that is what the floor is for: it remembers recently-decided tokens, so **alternating
two tokens defeated it completely** — every scan differed from the one before, nothing was
suppressed, and the board made a measured ~18 POSTs a second to `/gate`. A code taped beside a
reader plus a member's own phone is enough to produce it. The debounce now remembers four
(`kDebounceSlots`, `GateConfig.h:226`) — four people at one door inside one window — and the floor
is what bounds somebody rotating five.

*Pinned by* `test_app_a_scan_inside_the_relock_dwell_costs_no_call_and_records_no_opening`,
`test_app_a_scan_inside_the_relock_dwell_never_reaches_the_api`,
`test_app_alternating_tokens_cannot_hammer_the_gate_endpoint`,
`test_app_a_rate_limited_scan_is_refused_rather_than_decided_from_the_roster`.

### 11a.5 `boot_id` — the third field of the idempotency key

Every event-upload body a gate sends carries `boot_id`: a per-boot random 32-bit value drawn once
before the loop from `esp_random()`, and **never zero** (`src/gate/main.cpp:211`). It is a
de-duplication tag, not a credential — nothing turns on it being unpredictable, only on two
consecutive boots of one board not colliding.

**`(device, seq)` alone was not enough, and the failure was silent.** The server deduplicates on a
**permanent** unique index; the board's event ring is RAM-only so no event survives a reboot; and
`seq` resumes from one checkpoint record in flash, written in blocks of 64. Erase or tear that
record and the board renumbers from 1 — so every event of the next evening is receipted as a
duplicate and discarded, **including the `boot` event the firmware queues precisely so an operator
can see that a board restarted**. Two boards accidentally sharing a MAC dedup each other the same
way (`shared/lib/devlink/include/devlink/EventUpload.h:65`). The key is
`(tenant, device, boot_id, seq)` now (`Persistence/MainframeDbContext.cs:344`), so a renumbered
board collides with nothing and a genuine retry still carries the same three fields and is still
deduplicated.

**An absent `boot_id` is read as 0**, which is exactly what `(device, seq)` always meant
(`Endpoints/DeviceEventEndpoints.cs:1374`, and the record's default at `:1390`). That is the
compatibility hinge rather than a convenience: a **court box**, whose composition root passes 0,
renders the body it has always rendered byte for byte, and every image flashed before this change
keeps working. A gate always passes a non-zero one, and a composition root that forgot it would be
degraded rather than broken.

*Pinned by* `test_app_every_uploaded_batch_carries_this_boots_identity`,
`test_app_two_boots_that_both_start_at_seq_one_are_told_apart`, and on the server side by
`DeviceEventHttpTests.A_batch_with_no_boot_id_deduplicates_exactly_as_it_always_did` and
`DeviceGateProtocolCorpusTests` (which asserts both the carried value and the legacy 0).

### 11a.6 Fifteen seconds is not a cosmetic change

`GATE_UNLOCK_DEFAULT_MS` is **15 000 ms** (`GateConfig.h:95`) and was Carl's `delay(3000)`. The
bounds did not move: [1 s, 30 s] on the server's clamp and on the board's, and the 30-second hard
cap stands (`GateConfig.h:108`, `:528`). Two things follow that are worth writing down, because
they are the reason this is not a number swap.

**The hard cap bounds the TOTAL release across re-arms, so a longer grant buys fewer of them.**
No deadline may ever fall later than the cap measured from the moment the door **first** opened
(`UnlockTimer.h:19`; the arithmetic, `UnlockTimer.h:148`). A member at a fifteen-second door gets
**one** extension from back-to-back scans and no more: the first scan opens the lock until
t = 15 s; a second at t = 14 s carries the deadline to t = 29 s; a third arriving just before that
gets only the ~1 s left of the cap; and the scan after it is refused `relocking`, because the
cap-forced close owes the door three seconds of dark time. **At the old three-second default the
identical rule allowed nine extensions.** That is the safe direction and it stays — nobody who
scans once notices it, and somebody holding a phone at the reader reaches the cap nine times
faster and then meets the dwell, which is what the cap and the dwell are for.

**The dwell-versus-unlock distinction in §11a.3 stops being invisible.** While both numbers were
three seconds, a reader could not tell "how long the door is open" from "how long a held-open door
must stay shut", and the header said outright that the dwell *was* the default. They are different
numbers with different jobs now, and a later edit that re-collapses them fails a test.

*Pinned by* `test_config_defaults_are_carls_wiring`,
`test_config_the_default_is_only_what_runs_until_the_server_answers` (the default is adoptable
over, at every clock base, which is what makes it safe to raise),
`test_unlock_the_hard_cap_bounds_both_one_answer_and_the_whole_window`.

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
| The overflow is the LATEST-STARTING bookings, ties by `Id`, and the same set on every heartbeat | `DeviceGateTests.The_overflow_locks_out_the_latest_starting_bookings_deterministically` |
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
| The booking window opens at early entry and shuts when that booking's code dies | `DeviceGateTests.The_booking_window_opens_at_early_entry_and_shuts_at_the_slots_end` |
| The door's upper edge, once the relief is counted in, is the code's liveness, and is never narrower than the phone's | `DeviceGateTests.A_booking_code_opens_a_door_only_inside_its_own_bookings_window` (asserts the two agree on every late row), `DeviceGateHttpTests.The_door_still_opens_on_a_code_the_phone_has_stopped_offering` |
| The window is the setting, not a constant | `DeviceGateTests.The_entry_window_is_the_clubs_setting_and_not_a_constant` |
| Any court of the club counts | `DeviceGateTests.A_booking_on_any_court_opens_the_door` |
| `Cancelled` and `AdminBlock` never count; `Booked`, `NoShow` and `Completed` all do | `DeviceGateTests.A_booking_that_is_not_live_does_not_open_the_door` |
| Club admins always pass the booking check, and nobody else does | `DeviceGateTests.A_club_admin_passes_the_booking_check_and_nobody_else_does`, `DeviceGateHttpTests.A_club_admin_with_a_membership_and_no_booking_still_opens_the_door`, `DeviceGateTests.A_non_admin_with_no_membership_and_no_booking_is_still_refused` |
| An admin is still held to the membership check | `DeviceGateTests.A_suspended_club_admin_is_refused_by_name_under_either_policy` |
| An admin is still held to a booking code's own window | `DeviceGateTests.A_club_admins_booking_code_is_bounded_by_its_own_window_too` |
| An admin has no offline carve-out — a roster holds bookings, and staff on shift hold none | *not pinned, and cannot be: it is the ABSENCE of a rule from the cached path. Stated in §5 and §10.* |
| A booking code opens the booking it names | `DeviceGateTests.A_booking_code_opens_the_door_for_the_booking_it_names` |
| A booking code opens only inside its own booking's window, under either policy | `DeviceGateTests.A_booking_code_opens_a_door_only_inside_its_own_bookings_window` |
| `too_early` before the window, `not_recognised` after it | same test, and `DeviceGateHttpTests.A_booking_code_presented_too_early_is_refused_as_a_200_and_audited` |
| A cancelled booking's code opens nothing, even while that code is still live | `DeviceGateTests.A_booking_code_for_a_booking_that_is_no_longer_booked_opens_nothing`, `…A_booking_the_member_did_not_lose_by_being_late_still_opens_nothing` |
| A swept no-show still gets in, to the end the slot was SOLD and no further | `DeviceGateTests.A_member_the_sweep_has_just_written_off_can_still_get_into_the_building` (drives the real `NoShowWorker`) |
| A member the lights sweep has just promoted to `Completed` still gets in, to the same end and no further | `DeviceGateTests.A_member_the_lights_sweep_has_just_completed_can_still_get_into_the_building` (drives the real `LightsCueWorker`, so the fixture is the one the product makes) |
| A code outside its own window opens for a member due on another court | `DeviceGateTests.A_spent_booking_code_still_opens_the_door_for_a_member_due_on_another_court`, `…An_early_booking_code_opens_the_door_for_a_member_whose_court_is_running`, `DeviceGateHttpTests.A_spent_booking_code_opens_the_door_for_a_member_whose_next_court_is_due` |
| An ident code has no booking window of its own | `DeviceGateTests.An_ident_code_has_no_booking_window_of_its_own` |
| The door's horizon under `active_member` is the phone's, and cannot drift from it | `DeviceGateTests.The_doors_horizon_under_the_default_policy_is_the_one_the_phone_shows`, `DeviceGateHttpTests.The_door_accepts_a_booking_code_exactly_while_the_phone_would_show_it` |
| The member's screen is told `doors`, `door_opens_at` and `door_closes_at`, and the door agrees with them | `DeviceGateHttpTests.The_member_screen_is_told_what_its_code_does_at_a_door` (drives the real decision at both edges of the stated window) |
| `doors` counts ENABLED gates only, and a court box is not a door | `DeviceGateHttpTests.A_club_whose_only_door_is_out_of_service_has_no_doors_on_the_member_screen` |
| No settings combination, legal or hand-edited, reaches further than four hours | `DeviceGateTests.No_settings_combination_lets_a_door_reach_further_than_four_hours`, `…A_club_with_an_enormous_phone_horizon_still_has_a_four_hour_door`, `DeviceGateHttpTests.The_door_reaches_four_hours_however_wide_the_clubs_own_horizon_is` |
| The release is the club's setting, clamped to 1–30 | `DeviceGateTests.The_release_is_the_clubs_setting_clamped`, `DeviceGateHttpTests.The_release_on_the_wire_is_the_clubs_setting` |
| Every reason has a vector and every vector a reason | `DeviceGateProtocolCorpusTests.The_refusal_reasons_and_their_vectors_are_the_same_set` |
| One audit row per decision, subject named, token absent | `DeviceGateHttpTests.An_active_member_opens_the_door_and_the_open_is_audited` |
| The trail has a reader, and it carries the online and offline halves of a board's day | `DeviceGateHttpTests.A_doors_activity_is_readable_and_carries_both_halves_of_its_day`, `…A_court_boxs_activity_is_readable_on_the_same_route` |
| It returns no raw details and no legacy token, and a fingerprint is validated to be one | `DeviceGateHttpTests.The_activity_route_returns_no_raw_details_and_no_legacy_token` |
| `limit` is clamped to 1–200 and defaults to 50 | `DeviceGateHttpTests.The_activity_limit_is_clamped_and_defaults_to_fifty` |
| Another club's board 404s, and another club's ROWS never appear | `DeviceGateHttpTests.Another_clubs_device_has_no_activity_here`, `…Another_clubs_audit_rows_never_appear_in_this_clubs_device_activity` |
| Another club's code opens nothing here | `DeviceGateTests.Another_clubs_code_is_not_recognised_at_this_clubs_gate`, `DeviceGateHttpTests.Another_clubs_code_does_not_open_this_clubs_door` |
| Another club's bookings never reach this club's roster | `DeviceGateTests.Another_clubs_booking_never_appears_…`, `DeviceGateHttpTests.Another_clubs_bookings_never_reach_…` |
| `gate_open` is receipted, names the subject at the scan, settles nothing | `DeviceGateHttpTests.An_offline_gate_open_is_receipted_and_names_the_member_without_checking_them_in` |
| An unresolvable `gate_open` is still recorded | `DeviceGateHttpTests.An_offline_gate_open_with_an_unresolvable_token_is_still_recorded` |
| An offline door event fingerprints its token instead of logging it, and two scans of one code still correlate | `DeviceGateHttpTests.An_offline_door_event_fingerprints_the_token_instead_of_logging_it` |
| EVERY kind's subject is fingerprinted, the court box's `activation` included | `DeviceGateHttpTests.A_court_boxs_activation_event_fingerprints_its_token_as_well`, `DeviceEventHttpTests.Activation_event_with_unknown_token_is_acked_and_audited` |
| `kind` is normalised once and every later decision reads that value | `DeviceGateHttpTests.A_door_event_kind_is_normalised_before_anything_is_decided_from_it` (five spellings), `…An_unknown_kind_is_recorded_as_normalised_and_still_fingerprinted` |
| A respelt `gate_open` cannot step around the court-box refusal | `DeviceGateHttpTests.A_court_box_cannot_post_a_door_open_by_respelling_the_kind` |
| A missing, empty or over-long `kind` is receipted as `malformed`, never 500, and the queue drains past it | `DeviceGateHttpTests.A_malformed_event_kind_is_receipted_rather_than_five_hundred` |
| `no_push` and `events_lost` are accepted, logged, stored nowhere, and change nothing — at any value, saturated or negative | `DeviceGateHttpTests.The_boards_diagnostic_counters_are_accepted_and_change_nothing`, `DeviceGateProtocolCorpusTests.Request_vectors_bind_to_the_records_the_endpoints_take` |
| `gate_key` binds under either spelling, and both refusals still fire under either | `DeviceGateHttpTests.The_admin_patch_binds_gate_key_under_either_spelling` |
| A `gate_open` from a court box is `not_a_gate` and names nobody | `DeviceGateHttpTests.A_gate_open_uploaded_by_a_court_box_names_nobody_and_says_not_a_gate` |
| A gate cannot activate or sell a walk-up | `DeviceGateHttpTests.A_gate_cannot_activate_a_court_or_sell_a_walk_up` |
| A gate's `activation` upload settles nothing | `DeviceGateHttpTests.An_activation_uploaded_by_a_gate_is_recorded_and_settles_nothing` |
| An unnamed board is pushed no roster; naming it starts the fallback | `DeviceGateHttpTests.An_unnamed_gate_is_pushed_no_roster_until_an_admin_names_the_door` |
| A board out of service is 403 on the heartbeat as well as the scan | `DeviceGateHttpTests.A_gate_taken_out_of_service_is_refused_on_the_heartbeat_too`, `…The_board_identity_failures_keep_their_own_shapes` |
| …and on this surface a 403 can mean NOTHING ELSE | `DeviceForbiddenMeansOutOfServiceTests` (five tests: the group's routes and policy, the scheme's role claim, the source of everything that serves or wraps it, no refusal a working board can provoke, and the forward direction on all five routes) |
| …and the GATEWAY in front of it never answers 403 either | `DeploymentPostureTests.The_gateway_never_answers_forbidden_itself` (no `deny` directive, no `return 403`, and a control that the file really is a proxy) |
| A barred member is off BOTH rosters on real Postgres, not only in memory | `DeviceGateHttpTests.A_barred_members_booking_is_filtered_out_on_real_postgres` |
| A silent door gets a door's alert and none of the court box's sentences | `PeripheralHealthTests.A_silent_gate_gets_a_door_alert_and_none_of_the_court_boxs_sentences`, `…A_gate_that_comes_back_gets_a_door_all_clear_and_none_of_the_court_boxs` |
| A silent box beside a silent door still gets the court box's alert | `PeripheralHealthTests.A_silent_box_beside_a_silent_gate_still_gets_the_court_boxs_alert` |
| A door darkens no court and waives no penalty — by rule, not because its court list happens to be empty | `PeripheralHealthTests.A_silent_gate_darkens_no_court_and_waives_no_penalty`, `…A_silent_gate_carrying_a_court_number_still_darkens_no_court`, `…A_healthy_gate_carrying_a_court_number_does_not_block_the_waiver` |
| A presented token's length is checked before anything is allocated | `AccessCodeTests.An_absurdly_long_token_is_refused_before_anything_is_allocated` |
| The three settings round-trip; omitted means unchanged | `AdminSettingsHttpTests.The_gate_settings_are_readable_and_writable_and_omitted_means_unchanged` |
| Both key spellings bind | `AdminSettingsHttpTests.A_gate_setting_binds_under_either_spelling`, `…The_alert_cooldown_binds_under_either_spelling_and_is_always_served` |
| The bounds are 1–30, 0–240 and 5–1440 | `AdminSettingsHttpTests.A_gate_number_outside_its_bounds_is_refused` |
| `device_alert_cooldown_minutes` is served whether or not the club has set one | `AdminSettingsHttpTests.The_alert_cooldown_binds_under_either_spelling_and_is_always_served` |
| One outage mail per board per cooldown, and the cooldown is the club's | `PeripheralHealthTests.A_flapping_board_mails_the_club_once_per_cooldown_and_not_once_per_flap`, `…The_cooldown_is_the_clubs_setting` |
| A gate no admin has named alerts nobody, and still records its outage | `PeripheralHealthTests.A_gate_no_admin_has_named_alerts_nobody_and_still_records_its_outage`, `…An_acknowledged_but_unnamed_gate_still_mails_nobody` |
| A board no admin has ACKNOWLEDGED alerts nobody, whatever kind, however many appear | `PeripheralHealthTests.A_board_no_admin_has_acknowledged_mails_nobody_however_many_of_them_appear` (twelve boards from the real `AutoRegisterAsync`) |
| A club holds at most 16 unacknowledged boards; the 17th is `409`, never `403` | `DeviceGateHttpTests.A_club_cannot_be_filled_with_boards_nobody_has_acknowledged` |
| Taking a board out of service closes its outage silently | `PeripheralHealthTests.Taking_a_board_out_of_service_closes_its_outage_silently` |
| The policy is a closed set; a refused save writes nothing | `AdminSettingsHttpTests.An_access_policy_outside_the_closed_set_is_refused`, `…Both_access_policies_are_accepted` |
| An unreadable stored policy narrows the door | `DeviceGateTests.An_unreadable_access_policy_narrows_the_door_rather_than_widening_it` |
| The admin PATCH holds each kind to its own fields | `DeviceGateHttpTests.The_admin_patch_holds_each_kind_to_its_own_fields` |
| `gate_key`: `""` clears, `null` and absent leave unchanged | `DeviceGateHttpTests.A_null_gate_key_leaves_the_door_named_and_an_empty_string_clears_it` |
| A PATCH cannot change a kind | `DeviceGateHttpTests.A_patch_cannot_change_a_boards_kind` |

**What is deliberately not pinned here, and why each one cannot be.**

- The two sentences in §11 that no code decides: **which lock the club fits** — this document
  does not say one "must" be fail-safe, because that is the founder's and the electrician's
  call and §11 only says which wiring gives "released with no power" — and that egress must be
  mechanical. They belong on `docs/go-live-checklist.md`, where a person signs them off.
- The pre-`setup()` reset window in §11.1, for the same reason: it is decided by the relay
  module's input bias and is measured on a bench, not asserted in a test.
- Every sentence about what the *firmware* does: §11's release-deadline overrun bound, the
  polarity combinations and the watchdog budget, **the whole of §11a**, and §7's right-hand
  column — what a board does with a `403` versus with a timeout. Those are pinned in
  `src/iot/door-gate`'s own host tests, which is why §11a names its pins inline rather than
  adding rows here. What is pinned in this table is the SERVER half: that a board out of
  service really is refused `403` on the heartbeat and the scan. Restating the claim here and
  pinning it there is the split this table is honest about rather than hiding.
- §7's residual and all of §10a: they are statements about what the system does **not**
  guarantee, and a test cannot pin an absence of a guarantee. They are here so that nobody
  infers the guarantee from the surrounding text.
- §10a's cleartext-HTTP posture, which is a deployment fact rather than a behaviour.

---

## 13. Doors in the console

Wave 1 gave the door trail a reader, a club-wide log, an export, a fleet control, two derived
signals and a member-facing half. **Nothing here is a new device route.** Every route below is
admin or member JWT, and `/api/v1/device/*` is untouched — which is load-bearing rather than
tidy: §7 and `DeviceForbiddenMeansOutOfServiceTests` pin in both directions that a `403` on
that group can mean one thing only, and a single admin route mounted under it would make the
firmware's authoritative signal ambiguous.

### The surfaces

| Route | Answers |
|---|---|
| `GET /api/v1/admin/doors` | every gate, its day, its signals, and which doors are shut together vs on their own |
| `GET /api/v1/admin/devices/{id}/activity` | one board's SCANS (`items`) and its own story (`events`) — two arrays |
| `GET /api/v1/admin/doors/activity` | the club's door log across all doors — door, time, outcome, reason |
| `GET /api/v1/admin/doors/activity.csv` | the same filters as a file, formula-safe, audited |
| `POST /api/v1/admin/doors/shut-all` · `/reopen-all` | the 403 path at fleet scale, one unit of work |
| `PATCH /api/v1/admin/devices/{id}` | gains `location_note` and `power_loss_behaviour` (gates only) |
| `GET /api/v1/me/door` | what a member standing at a door is told |
| `GET /api/v1/me/door/history` | that member's own door rows, and nobody else's |

### The rules that are not obvious from the shapes

**Four actions are a door scan, and two of them released a lock.** `gate.opened` and
`gate.denied_<reason>` are decisions the server made (§5); `device.gate_open` and
`device.unknown_scan` are things a board did while the link was down (§6). `DoorTrail` states
that set once, because six readers ask it and a fifth action added later must not become five
different subsets of the truth. A `device.auto_registered` or a `device.updated` is the BOARD's
story — it is not in the club log, not in the counts and not in a member's history, because
nobody stood at the door.

**All six readers ask `DoorTrail`, and the per-door feed was the one that did not.**
`GET /admin/devices/{id}/activity` returned every audit row carrying the board's `device_id`,
which is wider than a scan in two ways that both reached a screen. A console renders a row it
has no chip for through whatever branch is last, so `device.updated` was painted as a green
"Refused" and a door with thirteen admin edits and no scans reported "13 refused scans, newest
1 min ago" against an empty club log. And `device.event_time_clamped` — written *beside* every
clamped upload with identical details, same `seq`, a microsecond apart — doubled every offline
scan on that one screen. A door's feed now answers **two arrays**: `items`, the scans
`DoorTrail.IsScanRow` selects, and `events`, the board's own story under a closed neutral
vocabulary (`registered` · `edited` · `removed` · `clock_corrected` · `unrecognised`). Two
pages, not one page split afterwards, so a renamed door cannot push its scans off a `limit=50`.
A court box is not split — none of its trail is a door scan — and carries `events: []`, because
one response shape is worth more to a console than a key that appears and disappears.

**`DoorAuditActions` is the closed list the console's chip dictionary is pinned against.** It
is a static list in the API assembly with three disjoint parts — `Scans` (the four shapes, with
the refusal prefix expanded against `GateAccess.Reasons`), `Events`, and `Fleet` (`doors.*`,
which carry no `device_id` and so reach no door's feed). `DoorAuditActionsTests` scans the
API's **own source** for every `gate.*` / `device.*` / `doors.*` literal and fails on one that
is on neither the list nor an explicit not-a-door-surface list, so an action added in a month's
time cannot go unlisted by somebody who has never read this file.

**An offline row has two instants, and the wire carries both.** The row is written when the
board next calls in; `details.occurred_at` is when somebody stood at the door. W1.2 says
offline opens are scan-time stamped, and a club reading a 06:40 entry as 09:00 has the wrong
answer to the only question it asked. So `at` is the **scan** and `delivered_at` is the row's
own instant, non-null on offline rows only — never a copy of `at` on an online one, which would
invent a delay that did not happen. The log, the CSV and the member's history all order, page,
filter and count on the **delivery** axis, which is what keeps the keyset cursor total over an
append-only table; the response says both, so no screen has to infer one from the other.

**An upload is contact.** `POST /device/events` runs `DeviceSilenceLog.NoteHeartbeat` exactly
as the heartbeat does, so `LastSeenAt` moves to the upload and the outage it ended is closed.
"Last heard from 21:00" beside a scan "decided at 06:40" is therefore not a contradiction and a
page may not read either as the other: the board was silent until it called in, and it brought
an old scan with it.

**A deleted door is a door that was removed, not a row with no door.** `audit_log` has no
foreign key to `devices`, so deleting a board has never touched one of its scan rows — but the
wire said `door: null` and the console dereferenced it, and `/admin/doors/log` went white for
every admin in the club. Three reviewers found it independently, by a direct link, by the
outcome filter, and by pressing "Load older scans" until the cursor reached the rows. Every scan
row on the club log and in the export now carries `door: {id, name, gate_key, removed}` and
`removed: true` is how a renderer is told; both scan writers store the board's display name
beside the key, so a removed board can still be named. `GET /admin/doors/activity` lists
`removed_doors` — found through the `device.deleted` rows, which outlive the door retention
under `retention_years`, rather than by a `DISTINCT` over ninety days of jsonb — and
`?removed_door=<key>` filters to one. The per-BOARD feed is deliberately NOT changed: it is
reached by a device id, a deleted device 404s the whole route, and WIRE-W1 pins it at seven keys.

**The range is half-open, and a named day is what proved it had to be.** It was closed at both
ends, which nothing could see while the only range was "the last twenty-four hours from now".
"Yesterday" ends at the instant "today" begins, so a scan at exactly a club's midnight was
counted in both — two answers to "how many came through last night", from the same rows,
differing by one depending on which day you asked about.

**A club's day is built with the offset in force AT MIDNIGHT.** `DoorDay` used the offset at
*now*, which is the same number every day of the year in UTC and in Africa/Johannesburg and an
hour wrong on the two days a DST zone changes. `DoorClock` also handles a midnight that does not
exist (a zone that springs forward at 00:00) and one that happens twice. Five named periods and
`?day=` are resolved from it, server-side, and the response states the range it resolved so the
page can say it in words rather than infer it from what it sent.

**An edit says which edit it was, and who made it.** `device.updated` writes a `changes` list —
computed by comparing before with after, because a console sends the whole card on every save —
and the feed derives `change` from it (`renamed` · `details` · `shut` · `reopened`, and
`other` for every row written before the list existed). A PATCH that changes nothing writes no
audit row and answers `unchanged: true`, which with `shut_by_name` is what a stale tab needs to
be told "it was already shut — by Priya Naidoo at 21:48". `Device.ShutByUserId` is a column
rather than a derivation because a fleet shut writes ONE audit row for the whole club with no
`device_id` on it, so a door shut that way could not be attributed by any query.

**A door's name is resolved by `device_id` at read time, on every surface.** The online gate
path writes `gate_key` into its details and the offline upload path did not, so a member's own
history showed six releases at a null door — at a door the club had named — and the page then
told her the club had not named it. Both `/me` routes resolve it now, the club's `gate_key`
first and the board's display `Name` second, falling back to the key stored on the row only for
a board DELETED since the scan. The upload path stores the key too, which is what makes that
fallback worth having.

**A member sees the door's DISPLAY name, and `doors` means the club has scanners.** Round one
chose the `gate_key` on the argument that `Name` starts life as the auto-registration
placeholder. That is true of the placeholder and of nothing else, and it put `front-door` on a
member's history beside `Front door` on the admin log for the same scan — so the rule reversed:
the display name unless it is still `Door gate`, then the key, then nothing. And `doors` used to
mean "at least one scanner is switched on", which is the same answer a club with no scanners at
all gets: a club that shut its doors for the night handed its members a page with no door
section, no history link and nothing said about why the building would not let them in.
`doors` is now any gate row and `doors_shut` is `none` / `some` / `all`. Both halves stay true
at once — a shut board is 403 on every route it calls, AND a board that has lost the network
never hears the switch — so the page may say the club has shut its doors and may not say nobody
gets in. `early_entry_minutes` is null unless the policy is `booking_window`, because under
`active_member` the door's window is `StartsAt − DoorHorizonMinutes` and that number is not it;
and `next_booking` has no horizon at all, because a member with a court tomorrow was told nothing
about when the door would open for it on the page whose job is to explain that window.

**A limit is clamped and a date is refused, and the difference is the rule.** "Give me a
million rows" is unambiguous and bounded, so it is clamped and an error screen would be the
worse answer. `?from=not-a-date` is not a request the server can bound: it used to fall through
to the default window — for the CSV, to the whole retention period — and answer 200, so an
admin exporting "last Tuesday" was handed the club's entire log and filed it as last Tuesday's.
`from_invalid` · `to_invalid` · `cursor_invalid` · `outcome_invalid`, on the log, on the export
and (cursor) on the member's history. A refused export writes no audit row.

**A fleet reopen that changes nothing says why.** Reopen-all carries `left_shut`
`[{id,name,gate_key}]` and `GET /admin/doors` carries `shut_together` and `shut_individually`,
so the console offers the fleet control only while a shut-all is in force, labels it with the
count it will actually reopen, and names every door that stays shut. The semantics are
unchanged; what changed is that a zero-change result is no longer an unexplained empty list.

**The club's two contact strings are validated, because they are printed and dialled.** They go
on a door card that hangs on a wall and reach a member outside a building at night as `tel:`
and `mailto:` links. Phone: digits, space and `+ - ( ) ,`, at least five digits, ≤32. Email: a
single addr-spec with a dotted host, ≤254. `club_contact_phone_invalid` /
`club_contact_email_invalid`, under both spellings. And the `not_approved` login refusal
carries `{phone, email}` — that refusal only, those two fields only, tenant-scoped — because a
pending or suspended member is told to speak to the club and every other surface carrying its
contact is behind the door they are locked out of. An unknown address and a wrong password
still answer a bodyless `401`; a contact block on either would make the route an account
oracle.

**Today is the CLUB's day.** The count is taken in `timezone` on the server and the boundary is
on the wire, so the page names it rather than asserting one. A zone the platform does not know
is a day that cannot be established: `today` is then `null` for every door and never `0`,
because a zero on a failed read is a number an admin will quote in a committee meeting.

**Two numbers per door, never one, and no sort control.** One headline on a list of doors is a
footfall ranking by accident — the exact shape §1 exists to prevent.

**A signal carries no member, no fingerprint and no code.** The rows it is derived from name
members; the payload has nowhere to put one, which is cheaper than a convention. The unit is
**scans** — one person trying four times is four — and the subject of every signal is the door.

**The log filters by door, time and outcome, and by nothing else.** There is no member
parameter and no per-member admin history anywhere in this product; a member's history belongs
to the member. Unknown query parameters are ignored rather than refused, because a refusal
would confirm which names the server recognises.

**The range is clamped to `door_log_retention_days`, not merely defaulted to it.** The page
states that number and the rows survive on disk between nightly sweeps, so a read answering
past it would make the page's own sentence false.

**The export defuses before it quotes.** A cell beginning `=`, `+`, `-` or `@` is a formula in
a spreadsheet, and a door's name, a member's name and a gate key are all club-entered strings.
The value is kept intact and prefixed with an apostrophe, so the log stays readable and cannot
execute; quoting first would leave it a formula the moment a reader stripped the quotes.

**The export is for a spreadsheet, not for a parser.** Columns
`date,time,timezone,at_utc,door,door_name,outcome,reason,reason_code,offline,member,code_fingerprint,delivered_at_utc`
— the last one blank on an online row, because a delivery time for a decision the server made as
it happened would be a delay the file invented, and appended rather than inserted because a
club's saved formulae address columns by position. The filename carries the exact local range,
as two dates when both ends are club-local midnights and `YYYY-MM-DDTHHmm` when they are not:
`door-log-<date>-<date>.csv` over a rolling window was a name saying "a day" over a file
starting at 09:50. The file's first line is still the header row and not a comment — a club
opens this in a spreadsheet. An offline `unknown_scan` reads "Code not on the door's saved list"
rather than "No reason recorded": the reason IS recorded, it is the action, and a board deciding
alone has exactly one way to refuse.
The rest is unchanged: UTF-8 **BOM**, because Excel reads a BOM-less UTF-8 file in the machine's legacy code page and
a club whose door is named "Café" gets mojibake on a printed report; CRLF; `date` and `time` in
the **club's** zone with the zone named beside them, so the file is still unambiguous when it
is mailed on; `at_utc` to the second, because a round-trip ISO string with seven fractional
digits is a string Excel will not parse at all. `outcome` and `reason` are the product's words
(`DoorWords`) with the machine value kept beside them in `reason_code` — a club filtering wants
the stable one and a club reading wants the sentence. The file ignores paging, correctly, and
says how many rows it holds in `X-Crusaders-Rows`; that header and `X-Crusaders-Truncated` are
named in the CORS policy's exposed headers, without which a browser hands the page neither and
the console announces its own page size instead.

**`shut-all` is one unit of work and `reopen-all` is an undo, not an unlock.** The console's
"nothing was shut, every door is exactly as it was" is true only because of the single save. A
door an admin took out of service individually stays shut through a fleet reopen — they did it
for a reason this system knows nothing about — and `Device.ShutByShutAllAt` is the only thing
that can tell the two apart.

**The door card is measured, never inferred.** `power_loss_behaviour` defaults to
`not_established` because that is the honest state of every door in the field, and no firmware
flag bears on it: a board with no power drives nothing at all (§11).

**The trail is DELETED past `door_log_retention_days`, not anonymised**, which closes §6's
residual. Anonymising is enough for a booking and is not enough for a door: the row still says
which door at what minute, and a club's membership is small enough that a pattern is a person.
Receipts outlive it by `max(door_log_retention_days, MaxEventAge)`, because a purged receipt
turns an ordinary re-upload into a second row for one scan.

### Wave 1 tenant settings

| Key | Default | Range | Meaning |
|---|---|---|---|
| `door_log_retention_days` | 90 | 7–730 | how long a club keeps its door rows — the number the sweep DELETES against |
| `door_refusal_spike_count` | 8 | 3–100 | refusals at one door that raise the spike flag |
| `door_refusal_spike_minutes` | 20 | 5–240 | the window those refusals are counted in |
| `club_contact_phone` | *(empty)* | ≤32 chars, digits + `space + - ( ) ,`, ≥5 digits | who a refused member rings; empty means the club has set none |
| `club_contact_email` | *(empty)* | ≤254 chars, one addr-spec, dotted host | who a refused member writes to |

All five bind **camelCase and snake_case** on the PUT and are **clamped again on read**, per
§8's rule — the PUT is not the only way a value reaches that column, and this is the sharpest
case of that rule in the tree, because one of the five decides what gets deleted.

Two numbers are deliberately **not** settings: a credential granted **3** times within **60
seconds** raises "may not be releasing". A club does not tune those to its traffic — three is
the smallest count at which "scanned, walked away, came back" stops being the likelier story
than "the lock did not release" — and the flag's own copy states both, so a club reading the
notice is reading the rule that produced it.

### No new index, and what was measured

`audit_log` has carried `IX_audit_log_TenantId_CreatedAt` since `InitialCreate`, so the index
W1.3 asked for already exists and no migration adds one. Measured on Postgres 15 against
**400 000 rows across 20 tenants** (66 MB table, 28 MB index), every Wave 1 read plans as an
index scan on it:

| Read | Plan | Execution |
|---|---|---|
| club log, default 24 h window, page of 50 | Index Scan Backward + Incremental Sort | 0.03 ms |
| club log at the 730-day retention ceiling | Index Scan Backward + Incremental Sort | 0.03 ms |
| doors overview, a club day (838 rows matched) | Bitmap Index Scan | 0.21 ms |
| club log filtered to one door (`@>` on `device_id`) | Index Scan Backward, jsonb as a filter | 0.02 ms |

**The jsonb containment is a filter rather than an index, and that is the right trade at this
volume.** A GIN index on `DetailsJson` would serve the per-door filter, but the range predicate
has already narrowed the scan to one club's day before the recheck runs — so it buys nothing
measurable here and costs write amplification on the hottest table in the product. Revisit it
if a club's door ever outgrows a day's rows per page, which at a racquet club it will not.

### What is pinned, and where

| Sentence | Pinned by |
|---|---|
| The door card starts unmeasured, and every device view carries all three fields | `AdminDoorCardHttpTests.A_door_card_starts_empty_and_says_nothing_has_been_established`, `…A_court_box_carries_the_door_fields_and_they_are_empty` |
| `location_note` and `power_loss_behaviour` bind under either spelling | `AdminDoorCardHttpTests.The_location_note_binds_under_either_spelling`, `…The_power_loss_behaviour_binds_under_either_spelling` |
| `location_note`: `""` clears, absent leaves it alone, over-length is refused | `AdminDoorCardHttpTests.An_empty_location_note_clears_it_and_an_absent_one_leaves_it`, `…A_location_note_longer_than_the_column_is_refused_rather_than_truncated` |
| `power_loss_behaviour` is a closed set; a null, an empty string and a number are all refused | `AdminDoorCardHttpTests.A_power_loss_behaviour_outside_the_closed_set_is_refused` (four values) |
| A door field sent to a court box is `door_fields_on_a_court_box`, and the refusal writes nothing | `AdminDoorCardHttpTests.The_door_card_fields_are_refused_on_a_court_box`, `…A_refused_door_card_patch_writes_nothing` |
| The three columns exist in the MIGRATED schema, not only in the model | `AdminDoorCardHttpTests.The_three_columns_exist_in_the_migrated_schema` |
| `out_of_service_since` appears on the switch and clears on the way back | `AdminDoorCardHttpTests.Shutting_a_door_surfaces_the_instant_on_the_device_view` |
| A court box is not on the doors list | `AdminDoorsOverviewHttpTests.A_court_box_is_not_on_the_doors_list` |
| Order is name ascending, stable, with no sort parameter | `AdminDoorsOverviewHttpTests.The_doors_are_ordered_by_name_ascending_and_stably` |
| Today's counts are taken in the club's timezone against the stated boundary | `AdminDoorsOverviewHttpTests.Todays_counts_are_taken_in_the_clubs_own_timezone` |
| The counts carry both halves of the door's day, and no non-scan row | `AdminDoorsOverviewHttpTests.The_counts_carry_both_halves_of_the_doors_day` |
| The counts are door-scoped | `AdminDoorsOverviewHttpTests.The_counts_are_scoped_to_their_own_door` |
| A day that cannot be established yields `null`, and a quiet door yields `0` | `AdminDoorsOverviewHttpTests.A_day_that_cannot_be_established_yields_null_counts_and_never_zero`, `…A_door_with_no_scans_today_counts_zero_rather_than_null` |
| The spike fires at the club's own count, inside the club's own window, and states it | `AdminDoorsOverviewHttpTests.A_run_of_refusals_at_one_door_raises_a_spike_and_states_its_own_window`, `…A_run_one_short_of_the_clubs_threshold_raises_nothing`, `…Refusals_older_than_the_window_do_not_raise_a_spike` |
| "May not be releasing" is ONE credential three times in a minute, not three people | `AdminDoorsOverviewHttpTests.One_credential_granted_three_times_in_a_minute_flags_the_door`, `…Three_different_credentials_in_a_minute_flag_nothing` |
| A signal payload carries no member, no name, no id and no fingerprint | `AdminDoorsOverviewHttpTests.A_signal_payload_carries_no_member_and_no_fingerprint` (serialises the payload and greps it) |
| `shut_all_active` is the fleet's state and not "some door is shut" | `AdminDoorsOverviewHttpTests.Shut_all_active_is_false_until_a_fleet_shut_and_true_after_one`, `…One_door_shut_by_hand_does_not_raise_the_club_wide_banner` |
| Another club's doors and rows never appear, even naming this club's device id | `AdminDoorsOverviewHttpTests.Another_clubs_doors_and_rows_never_appear_here` |
| The log defaults to the last 24 h, newest first, and carries the retention number | `AdminDoorLogHttpTests.The_default_window_is_the_last_day_newest_first` |
| **A removed door's rows are still named**, and `door` is never null | `DoorRemovedHttpTests.Every_log_row_names_a_door_and_a_removed_one_says_so_rather_than_being_null`, `…An_old_row_from_a_removed_board_falls_back_to_the_code_the_board_announced` |
| **Deleting a door destroys no scan rows** — on the log, the export, the counts and a member's history | `DoorRemovedHttpTests.Deleting_a_door_destroys_no_scan_rows_on_the_log_the_export_the_counts_or_a_members_history` |
| A removed door with rows in range is offered as a filter, and narrows to its own rows | `DoorRemovedHttpTests.A_removed_door_with_rows_in_range_is_offered_as_a_filter_and_narrows_to_its_own_rows`, `…A_board_that_is_still_in_the_devices_table_is_not_a_removed_door` |
| The export names a removed door from what the row stored | `DoorRemovedHttpTests.The_export_names_a_removed_door_from_what_the_row_stored` |
| Another club's removed door reaches neither this club's filter nor its total | `DoorRemovedHttpTests.Another_clubs_removed_door_never_reaches_this_clubs_filter_or_its_total`, `DoorLogRangeHttpTests.Another_clubs_rows_are_not_in_this_clubs_total` |
| The response carries the RANGE's total, the resolved range and the club's zone | `DoorLogRangeHttpTests.The_response_carries_the_ranges_total_the_resolved_range_and_the_clubs_zone`, `…The_total_is_the_ranges_and_does_not_shrink_as_the_cursor_walks_it` |
| Five named periods and one named day, resolved server-side in the club's zone | `DoorLogRangeHttpTests.Every_period_resolves_to_a_range_the_response_states` (five), `…A_named_day_is_that_clubs_day_and_excludes_the_minute_before_it` |
| **A row at either midnight lands in exactly one club day** — the range is half-open | `DoorLogRangeHttpTests.A_row_at_either_midnight_lands_in_exactly_one_club_day` |
| A club's day is built with the offset in force AT MIDNIGHT, across both DST transitions | `DoorClockTests` (seven cases, incl. a day with no midnight and a 25-hour day) |
| Naming the range twice is `range_conflict`; `door` / `reason` / `period` / `day` that cannot be read are refused by name | `DoorLogRangeHttpTests.A_request_that_names_the_range_twice_is_refused` (three), `…A_filter_the_server_cannot_read_is_refused_by_name_on_both_routes` (six), `…A_well_formed_door_id_that_names_no_board_answers_an_empty_page` |
| The export's filename carries the exact local range, with times when it is not whole days | `DoorLogRangeHttpTests.The_export_filename_carries_the_exact_local_range_and_says_when_it_is_not_whole_days` |
| The export's last column is the DELIVERY instant, and an offline refusal says why | `DoorLogRangeHttpTests.The_export_carries_the_delivery_instant_and_says_why_an_offline_refusal_was_refused` |
| A zone the platform does not know is reported as UTC, never as itself | `DoorLogRangeHttpTests.A_zone_the_platform_does_not_know_is_reported_as_UTC_and_not_as_itself` |
| **Each kind of edit says which one it was, and who made it** | `DoorEventChangeHttpTests.Each_kind_of_edit_says_which_one_it_was_and_who_made_it`, `…An_edit_that_renames_and_shuts_at_once_is_reported_as_the_shut`, `…Every_change_word_a_door_can_carry_is_in_the_closed_set` |
| A PATCH that changes nothing writes no row and answers `unchanged: true` | `DoorEventChangeHttpTests.A_patch_that_changes_nothing_writes_no_row_and_says_it_changed_nothing`, `…A_repeated_shut_does_not_move_the_instant_or_the_name` |
| **A second admin is told who shut the door**, by hand or by the fleet, and reopening clears it | `DoorEventChangeHttpTests.A_second_admin_is_told_who_shut_the_door_and_reopening_clears_it`, `…A_fleet_shut_records_who_shut_each_door_and_a_fleet_reopen_clears_it` |
| No admin of another club is ever named on this club's door or its events | `DoorEventChangeHttpTests.Another_clubs_admin_is_never_named_on_this_clubs_door`, `…An_event_whose_actor_belongs_to_another_club_names_nobody` |
| The member is told which clock the club's times are in | `MeDoorHttpTests.The_member_is_told_which_clock_the_clubs_times_are_in` |
| **No shipped file turns on the dev sign-in block, and the seeded admin cannot exist outside Development** | `DeploymentPostureTests.No_shipped_compose_file_turns_on_the_dev_sign_in_block` (four files), `…The_frontend_image_cannot_be_asked_for_the_dev_sign_in_block`, `…The_development_seeder_is_called_from_one_place_and_only_under_Development` |
| Every row names its door, and an unnamed door's `gate_key` is null rather than absent | `AdminDoorLogHttpTests.Every_row_names_the_door_it_happened_at`, `…A_row_from_an_unnamed_door_carries_a_null_gate_key_rather_than_vanishing` |
| The filters are door, outcome (a closed set of three) and reason (both vocabularies) | `AdminDoorLogHttpTests.The_door_filter_narrows_to_one_board`, `…The_outcome_filter_is_a_closed_set_of_three`, `…An_outcome_outside_the_closed_set_is_refused`, `…The_reason_filter_reaches_both_vocabularies` |
| **There is no member filter, under any spelling** | `AdminDoorLogHttpTests.No_parameter_named_after_a_member_changes_anything` (five names, by id and by name, byte-identical answers) |
| The cursor walks the range once, stops, and does not promise a page that is not there | `AdminDoorLogHttpTests.The_cursor_walks_the_whole_range_once_and_stops`, `…The_last_page_carries_no_cursor` |
| The limit is clamped to 1–200 rather than refused | `AdminDoorLogHttpTests.The_limit_is_clamped_rather_than_refused` |
| A range wider than retention is clamped, and the retention is clamped on read | `AdminDoorLogHttpTests.A_range_wider_than_retention_is_clamped_and_the_response_says_by_how_much`, `…A_retention_outside_its_bounds_is_clamped_on_read` |
| The club log and the per-board feed are one projection, and the feed is seven keys (the six plus `delivered_at`) | `AdminDoorLogHttpTests.A_club_log_row_and_a_board_feed_row_agree_on_every_shared_key` |
| **One offline scan is ONE row on the feed, the log, the CSV and the day's count** | `DoorScanSetHttpTests.An_offline_scan_is_one_row_on_every_surface` (uploads three with their clamp twins and counts all four surfaces) |
| An admin edit and a registration are `events`, never `items`, and never a chip | `DoorScanSetHttpTests.An_admin_edit_is_never_a_scan_on_the_feed`, `DeviceGateHttpTests.A_doors_activity_is_readable_and_carries_both_halves_of_its_day` |
| An action with no word for it is a neutral `unrecognised` row, not an absent one | `DoorScanSetHttpTests.An_event_with_no_word_for_it_is_neutral_rather_than_absent` |
| The feed and the log select the same rows, over a fixture holding every door action | `DoorScanSetHttpTests.The_feed_and_the_log_select_the_same_rows` |
| A court box's feed is not split, and carries `events: []` | `DeviceGateHttpTests.A_court_boxs_activity_is_readable_on_the_same_route` |
| **The closed action list matches what the API's own source writes**, in both directions | `DoorAuditActionsTests.Every_action_literal_in_the_api_source_is_accounted_for`, `…The_list_and_the_scan_predicate_agree_in_both_directions`, `…Every_gate_refusal_reason_is_on_the_list`, `…The_three_lists_are_disjoint_and_All_is_their_union` |
| An offline row is stamped with the SCAN and names its delivery; an online row has neither to name | `DoorScanTimeHttpTests.An_offline_row_is_stamped_with_the_scan_and_names_its_delivery`, `…An_online_row_has_nothing_to_deliver`, `…The_log_is_stamped_by_the_scan_and_ordered_by_the_delivery` |
| **An upload moves `LastSeenAt`** — it is contact, like the heartbeat | `DeviceEventHttpTests.An_upload_that_ends_a_long_silence_records_the_outage_it_ended` |
| A member's row names the door by its DISPLAY name, then the club's key, then nothing — and never the auto-registration placeholder | `DoorScanTimeHttpTests.A_members_own_rows_name_the_door_even_when_the_row_did_not`, `…A_door_still_carrying_the_placeholder_name_falls_back_to_the_clubs_key`, `…A_deleted_board_falls_back_to_the_key_the_row_stored` |
| `from` / `to` / `cursor` that cannot be read are refused BY NAME, on the log and the export | `DoorLogRefusalHttpTests.A_parameter_the_server_cannot_read_is_refused_by_name` (seven cases × two routes), `…A_members_history_refuses_a_cursor_it_did_not_mint` |
| A refused export is not recorded as an export | `DoorLogRefusalHttpTests.A_refused_export_is_not_recorded_as_an_export` |
| The limit is clamped and never refused, on the log AND the member's history | `DoorLogRefusalHttpTests.A_limit_outside_the_range_is_clamped_and_never_refused` (seven values) |
| The CSV is spreadsheet-ready: BOM, club-local date and time, the named zone, `at_utc` to the second, the product's words | `AdminDoorLogHttpTests.The_csv_carries_the_stated_header_and_is_an_attachment`, `…The_csv_states_the_clubs_own_time_and_names_the_zone`, `…The_csv_exports_the_scan_and_not_its_delivery` |
| The CSV announces the FILE's row count, not the page's | `AdminDoorLogHttpTests.The_csv_announces_how_many_rows_the_file_holds` |
| **Every environment answers a 400, never a 500,** to a body that cannot be read (R15 D15-3): a device route answers `400 {"error":"malformed_body"}` and files a `malformed_body` device fault (against the box when its MAC still parses, else one row per club); invalid UTF-8 on a device route is read leniently (U+FFFD), so a garbled scan is just an unknown code and the queue drains past it (R15 D15-1). Other routes: `400 invalid_body` (unreadable body), `400 bad_request` (route/query value), `413 body_too_large`, `415 unsupported_media_type`. Production answers an opaque 400 to a malformed body, an unbindable parameter and a bad date | `DeploymentPostureTests.A_malformed_body_is_an_opaque_400_in_Production`, `…An_unbindable_query_parameter_is_an_opaque_400_in_Production`, `…A_refused_door_log_filter_names_the_error_and_nothing_else` |
| **A value PostgreSQL cannot store is the caller's 400, never a 500** (R16 D16-1). The auth, admin-device and webhook groups refuse a NUL (U+0000) before any work: `400 invalid_body` in a body field, `400 bad_request` in a route or query value (`Security/StorableText`). Columns are refused past their size by name, with the limit: `400 {"error":"url_too_long"\|"event_filter_too_long"\|"description_too_long", "max_length": 2048\|1024\|255}` on a webhook create, `400 {"error":"email_too_long", "max_length": 320}` and `membership_number_too_long` (64) on register. Anything that still reaches the database as SQLSTATE 22001 (too long) or 22021 (a NUL), anywhere in the exception chain, is `400 invalid_body` — `400 malformed_body` on a device route | `R16StorableInputHttpTests.An_auth_input_carrying_a_nul_is_400`, `…An_admin_board_field_carrying_a_nul_is_400_invalid_body`, `…A_webhook_field_that_cannot_be_stored_is_400_with_a_code`, `…A_webhook_description_of_exactly_its_column_is_stored`, `…A_registration_field_past_its_column_is_400_by_name`, `…A_value_postgres_cannot_store_is_400_not_500` |
| **A device body is never refused for a value it carries** (R16 D16-1): a `\u0000` escape is read as U+FFFD exactly like invalid UTF-8 (a `malformed_body` fault filed, the body used; an escaped backslash before `u0000` is text, not a NUL). A heartbeat `version`/`mega_version` past 32 characters is **not kept** — the row keeps the version it had, never a cut string — while the heartbeat and its roster are still answered and a `malformed_body` fault says why. An event uptime or a release duration past the calendar saturates (`Endpoints/DeviceTime`) instead of overflowing: the event's time is clamped and kept (`clock_clamped`; its detail is `claimed <ISO-8601 round-trip>`, or since R17 D17-3 `claimed a time beyond what can be stored` / `claimed a time too long ago to be stored` for a saturated claim), the release does not pair — never a 500 that pins the board's queue | `R16StorableInputHttpTests.A_heartbeat_version_too_long_to_keep_is_answered_and_not_kept`, `…A_heartbeat_version_of_exactly_32_characters_is_kept`, `…A_heartbeat_field_carrying_a_nul_is_read_with_a_replacement_not_500`, `…An_escaped_backslash_before_u0000_is_not_read_as_a_nul`, `…An_event_uptime_past_the_calendar_is_clamped_not_500`, `…A_release_whose_duration_is_past_the_calendar_is_receipted_not_500`, `…Device_time_saturates_at_the_calendar_edges` |
| **A `malformed_body` fault says in plain words which of three things happened, and its headline follows** (R16 D16-5). Details: "some characters could not be read and were replaced; the rest was read and used" (`DeviceBody.ReplacedDetail`), "the message could not be read at all, so nothing in it was used" (`DeviceBody.NotJsonDetail`), "it reported a version longer than 32 characters, which was not kept" (`DeviceEndpoints.VersionTooLongDetail`). `DeviceErrorCodes.HeadlineOf(code, detail)` gives the read-anyway and too-long-version rows their own headlines on the list, the CSV and the stream; only the unreadable one says "could not read". The code is unchanged, so firmware and the closed vocabulary are too | `R16StorableInputHttpTests.A_body_that_cannot_be_read_at_all_files_the_plain_unreadable_words`, `…A_heartbeat_field_carrying_a_nul_is_read_with_a_replacement_not_500` |
| **A database deadlock or serialization failure is never a 500** (R16 BE16c). Booking writes (member, admin and bulk booking, walk-up, pay-for, check-in, block create/lift, cancel, reinstate) run again on SQLSTATE 40P01/40001, up to 3 attempts, each a fully rolled-back unit, so nothing is charged twice. One that outlives its retries, on any route, is `503 {"error":"conflict_retry"}` with `Retry-After: 1`; a box keeps the event (any 5xx) and backs off, and a screen says someone else was changing the same thing and offers Try again. `conflict_retry` is also the players routes' 409. **Nor is a lost optimistic-concurrency race** (R17 J17-1): a save whose booking or seat `Version` moved between the read and the write (`DbUpdateConcurrencyException`) is decided again on the rows as they now are where the route decides from a row someone else may decide first — activation on every courtside path, and cancel (`DatabaseRetry.ReDecideOnLostRaceAsync`, up to 3 attempts; it forgets what the losing attempt added, keeps what the caller staged, re-reads every booking and seat). Activation re-decides only while its booking is still `Booked`: one the no-show sweep settled under an upload lets the race through to `/events`' own loop, which reverses it. A concurrency miss nobody re-decided, or one that outlives its retries, joins 40P01/40001 at the global net (`InternalErrors.Classify` → `DatabaseRetry.IsLostRace`): `503 conflict_retry` with `Retry-After: 1`, never 500 — 503 rather than 409 so a box keeps the event and the screens' existing `conflict_retry` handling applies. | `R16DeadlockRetryHttpTests.*`, `R16WalkUpDeadlockHttpTests.*`, `R17BookingRaceHttpTests.Every_player_scanning_at_once_is_checked_in_and_the_court_lit_once`, `…A_check_in_that_loses_the_booking_row_is_decided_again_and_lights_once`, `…A_check_in_that_loses_every_attempt_is_503_conflict_retry_and_writes_nothing`, `…Two_cancels_at_once_refund_exactly_once` |
| **The device rate limit is charged per BOARD** (R16): `RateLimits:DevicePerMinute` (120) per `device:{tenant}:{mac}`, the MAC read from the first 4 KB of the POST body by `Security/DeviceRateKey`, which runs after `UseAuthentication` and **before** `UseRateLimiter` and authenticates the device key itself (the Device scheme is not the default one, so nothing had authenticated it before the limiter ran). No MAC readable → the club's bucket (`tenant:`); key not recognised → the caller's address (`ip:`). Before R16 every device call was in fact partitioned by client address — every board behind the gateway in one bucket — so one board spinning on a 403 spent every box's and door's minute. Since R17 (D17-1) the GLOBAL limiter is chained as well: a recognised device request is charged to its board (`device:`/`tenant:`, `RateLimits:GlobalPerMinute`), then to a device-only `device-ip:{address}` ceiling (`GlobalPerIpPerMinute`), never to the anonymous `ip:` bucket — so a spinning board cannot 429 the other boards or an anonymous sign-in from the club's address. Invented MACs are bounded by that device-only ceiling and the sixteen-unacknowledged-boards cap | `R16DeviceRateHttpTests.A_board_spinning_on_403_does_not_429_the_other_boards` (a box and a door as the second board), `…One_board_past_its_own_budget_is_429`, `R17DeviceLimiterHttpTests.*` |
| The CORS policy exposes the two headers the console reads | `DeploymentPostureTests.The_cors_policy_exposes_the_headers_the_console_reads` |
| A fleet reopen NAMES the door it left shut, and a zero-change result still says why | `DoorShutDistinctionHttpTests.A_reopen_that_leaves_a_door_shut_names_the_door_it_left`, `…A_reopen_with_nothing_to_reopen_still_says_why`, `…A_shut_all_leaves_nothing_behind` |
| The overview separates `shut_together` from `shut_individually`, and every row carries what confirmed-vs-not needs | `DoorShutDistinctionHttpTests.The_overview_separates_shut_together_from_shut_individually` |
| A contact that is not one is refused by name, under both spellings, and writes nothing | `DoorContactHttpTests.A_contact_that_is_not_one_is_refused_by_name` (eight), `…A_contact_a_member_could_use_is_accepted` (seven) |
| **The `not_approved` refusal carries the club's contact, and only that** | `DoorContactHttpTests.A_member_the_club_has_not_approved_is_given_the_clubs_contact` (three statuses), `…A_club_that_has_set_no_contact_says_so_rather_than_inventing_one` |
| An unknown address and a wrong password are unchanged, and no sibling club's contact leaks | `DoorContactHttpTests.An_unknown_address_and_a_wrong_password_are_unchanged`, `…Another_clubs_contact_never_reaches_this_clubs_refusal` |
| A registration and an admin edit are not in the club log | `AdminDoorLogHttpTests.Rows_that_are_not_scans_are_not_in_the_club_log` |
| Another club's rows never appear, and its door id answers nothing | `AdminDoorLogHttpTests.Another_clubs_rows_never_appear_in_this_clubs_log` |
| The CSV's header, media type and filename are as stated | `AdminDoorLogHttpTests.The_csv_carries_the_stated_header_and_is_an_attachment` |
| A cell a spreadsheet would execute is defused, and separators stay in their cell | `AdminDoorLogHttpTests.A_cell_that_a_spreadsheet_would_treat_as_a_formula_is_defused` (four), `…A_name_full_of_separators_stays_in_its_own_cell` |
| An export writes one audit row naming the actor, the filters and the count | `AdminDoorLogHttpTests.An_export_writes_one_audit_row_naming_the_actor_the_filters_and_the_count` |
| The export stops at ten thousand rows and says it truncated | `AdminDoorLogHttpTests.The_export_is_bounded_and_says_so_when_it_truncated` |
| A fleet shut shuts every open door, stamps the instant, and touches no court box | `AdminDoorFleetHttpTests.A_fleet_shut_shuts_every_open_door_and_stamps_the_instant`, `…A_fleet_shut_does_not_touch_a_court_box` |
| The result carries what the per-door confirmation needs, including a door never heard from | `AdminDoorFleetHttpTests.Each_door_in_the_result_carries_what_the_confirmation_needs`, `…A_door_that_has_never_called_in_is_still_shut_and_carries_a_null_last_seen` |
| **Reopen-all leaves a door an admin shut individually shut** | `AdminDoorFleetHttpTests.Reopen_all_leaves_a_door_an_admin_shut_individually_shut` |
| Reopening one door by hand takes it out of the fleet reopen | `AdminDoorFleetHttpTests.Reopening_one_door_by_hand_takes_it_out_of_the_fleet_reopen` |
| A fleet shut does not re-stamp a door that is already out of service | `AdminDoorFleetHttpTests.A_fleet_shut_does_not_re_stamp_a_door_that_is_already_shut` |
| Each direction writes exactly one audit row, with no subject | `AdminDoorFleetHttpTests.A_fleet_shut_writes_exactly_one_audit_row` |
| A fleet shut reaches no other club's doors | `AdminDoorFleetHttpTests.A_fleet_shut_never_reaches_another_clubs_doors` |
| A door shut by the fleet is 403 on its own device routes, and reopens | `AdminDoorFleetHttpTests.A_door_shut_by_the_fleet_is_refused_403_on_its_own_device_routes` |
| The five settings are served with their defaults, bind under either spelling, are bounded on the PUT and clamped on read | `DoorSettingsHttpTests` (11 tests, including `A_hand_edited_number_is_clamped_on_the_way_out` and `A_hand_edited_contact_is_cut_to_the_bound_on_the_way_out`) |
| A refused save writes nothing, an omitted key is unchanged, an empty contact clears it | `DoorSettingsHttpTests.A_refused_door_setting_writes_nothing`, `…Omitting_a_door_setting_leaves_it_alone`, `…An_empty_contact_clears_it` |
| **Door rows past retention are DELETED, not anonymised** | `DoorRetentionTests.A_door_row_past_the_clubs_retention_is_deleted_and_not_anonymised` |
| A row inside retention survives untouched, and a non-door row is left to `retention_years` | `DoorRetentionTests.A_door_row_inside_the_clubs_retention_survives_untouched`, `…A_row_that_is_not_a_door_row_is_left_to_the_years_long_retention` |
| The cutoff is the club's own number, clamped | `DoorRetentionTests.The_cutoff_is_the_clubs_own_setting`, `…A_retention_below_the_floor_does_not_purge_a_weeks_worth_of_doors` |
| Door receipts outlive a short retention by the event horizon; a court box's receipt is not a door's | `DoorRetentionTests.Door_receipts_outlive_a_short_retention_by_the_event_horizon`, `…A_court_boxs_receipt_is_not_a_door_receipt` |
| The purge never crosses a tenant boundary | `DoorRetentionTests.The_purge_never_crosses_a_tenant_boundary` |
| **`doors` is "this club has scanners", and `doors_shut` is how many are shut** | `MeDoorHttpTests.A_club_with_no_door_says_so_and_the_page_stays_silent`, `…A_club_whose_only_door_is_out_of_service_still_HAS_a_door_and_says_it_is_shut`, `…A_club_with_no_gate_row_at_all_has_no_doors_and_nothing_shut`, `…One_door_shut_out_of_two_is_some_and_not_all` |
| Membership is three-valued, with the club's recorded status beside it, and no membership row is `none` | `MeDoorHttpTests.The_membership_state_is_reported_in_three_values`, `…The_membership_detail_is_the_clubs_own_recorded_status`, `…A_user_with_no_membership_row_is_none_rather_than_not_active` |
| The next booking's window is the one the door will honour, and there is **no horizon** on which booking counts | `MeDoorHttpTests.The_next_booking_carries_the_window_the_door_will_actually_honour`, `…The_next_booking_has_no_horizon_and_a_court_tomorrow_still_counts`, `…A_booking_whose_window_has_already_closed_is_not_the_next_one` |
| `early_entry_minutes` is the clamped value the door reads — and is **null** under the policy it is not the window for | `MeDoorHttpTests.The_early_entry_minutes_are_the_clamped_value_the_door_uses`, `…The_early_entry_minutes_are_null_under_the_policy_they_are_not_the_window_for` |
| **`is_club_admin` agrees with what the door really does under `booking_window`** | `MeDoorHttpTests.The_admin_flag_agrees_with_what_the_door_really_does_under_booking_window` (drives the real `/device/gate` for both people) |
| The club contact is whatever the club set, and null when it set none | `MeDoorHttpTests.The_club_contact_is_whatever_the_club_has_set_and_null_when_it_has_set_none` |
| The last decision is this member's newest row inside the 120-second fetch window | `MeDoorHttpTests.The_last_decision_is_this_members_newest_row_inside_the_fetch_window`, `…A_decision_older_than_the_fetch_window_is_not_returned` |
| An offline open is this member's decision and says it was offline | `MeDoorHttpTests.An_offline_open_is_this_members_decision_and_says_it_was_offline` |
| Only `too_early` carries an instant, and only when a booking is behind it | `MeDoorHttpTests.A_too_early_refusal_carries_the_instant_the_door_would_open`, `…A_refusal_that_is_not_about_time_carries_no_instant`, `…A_too_early_refusal_with_no_booking_behind_it_carries_no_instant` |
| **Another member of the same club's row is never this member's** | `MeDoorHttpTests.Another_members_decision_at_this_club_is_never_this_members` |
| A row that names nobody is nobody's history | `MeDoorHttpTests.An_unknown_scan_that_names_nobody_is_nobodys_history` |
| The history is own rows, newest first, stopping at the club's retention, paged | `MeDoorHttpTests.The_history_is_this_members_own_rows_newest_first_with_the_retention_number`, `…The_history_stops_at_the_clubs_retention`, `…The_history_cursor_walks_the_whole_range_once` |
| Another club's rows never reach this member's history | `MeDoorHttpTests.Another_clubs_rows_never_reach_this_members_history` |
| The member surface carries no fingerprint, device id, device code or MAC | `MeDoorHttpTests.The_member_surface_carries_nothing_of_the_trails_own_shape` |
| Both member routes need a session | `MeDoorHttpTests.Both_routes_need_a_session` |

**What is deliberately not pinned here.** The console's copy, its three-state reads and its
chip vocabulary are the frontend lanes' and are pinned there — this table covers the API half
only. And no test pins that `/api/v1/device/*` gained nothing: that is an absence, and it is
held by `DeviceForbiddenMeansOutOfServiceTests`' existing forward and reverse pair over the
five device routes, which would go red the moment an admin route joined that group.
