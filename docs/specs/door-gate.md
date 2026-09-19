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
  "gate": { "unlock_seconds": 3 },
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

### The heartbeat request carries an optional `no_push`

A board with one LED and a boot log has two failures it must report and must never show a
member: a heartbeat body that did not fit its buffer or arrived incomplete, and a watchdog
that would not arm. They ride the heartbeat request as one optional non-negative integer,
`no_push` — additive, so a board that sends nothing is reporting zero, and the court box's
wire is untouched.

The server **logs it against the device code and stores nothing**: a column would be an EF
migration for a counter nothing decides anything on, and §9's "no EF migration" still holds.
It changes no part of the response, and a negative value is ignored rather than refused,
because a diagnostic must not be able to take a door out of service. Corpus vector
`gate-heartbeat-request-no-push`.

**A `gate_open` uploaded by a `CourtBox` row is refused by name**, the mirror of §7: receipted
and acknowledged, outcome `not_a_gate`, and the `device.gate_open` row **names nobody**.
Nothing settles on this path either way, so no money turns on it; what the guard prevents is a
record. Without it, anything holding the club key with a box's MAC could post an arbitrary
access code and have the trail say that person opened a door — for a door that does not exist.
A false record of who was in the building is a worse artefact than a refusal.

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
on.

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
| `gate_unlock_seconds` | 3 | 1–30 | how long the lock is released per open |
| `gate_access_policy` | `active_member` | `active_member` \| `booking_window` | who may open a door |
| `gate_early_entry_minutes` | 30 | 0–240 | how long before a booking its holder may enter |
| `device_alert_cooldown_minutes` | 60 | 5–1440 | how long before the same board may mail the club again |

Three seconds is long enough to push a door and short enough that it has shut again before
the next person reaches it. Thirty minutes is the club's own habit — a member due on court at
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
reads is worse than no alert because the club believes it has one. Auto-registration then
makes it a capability rather than a nuisance: anything holding the club's device key can mint
boards with invented MACs, and each one could mail the whole club on demand.

Three rules, and the third is the door's:

- **At most one outage mail per board per cooldown.** Derived by replaying that board's own
  outage rows rather than stored on them, so it needs no migration; each row is announced iff
  the cooldown has elapsed since the last *announced* one, not since the last row — otherwise
  a board flapping just inside the window chains past it for ever.
- **A recovery mail is sent only if its outage mail was.** Same replay, same rows, so the two
  decisions cannot disagree. The one thing that can move between them is the setting itself,
  and a club that changes it mid-outage may get an all-clear for an alarm it did not get; that
  is the price of not adding a column and it is bounded to the boards in outage at that moment.
- **A gate no admin has named mails nobody** (§4's acknowledgement, applied to alerts). The
  outage row and the `peripheral.*` events are still written — the Devices page is where an
  admin looks at a board on purpose, and what is withheld is the interruption, not the record.

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

**Naming a door now does something**, which it did not when this section was first written: it
is what starts that board's offline fallback (§4). The console says so where an admin can act
on it rather than leaving it to be discovered when the network drops.

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

**A club admin has no degraded mode either**, and for the same structural reason: the
`booking_window` carve-out is an online rule, a roster holds bookings, and staff on shift hold
none. At a cut-off door a club admin is refused like anyone else without a booking.

**An unnamed board has no degraded mode at all** (§4): it is pushed an empty roster, so the
moment it loses the server it opens for nobody. That is a narrower failure than the one it
replaces — a board anybody could self-register being handed the club's whole live code set —
and it lasts exactly until an admin names the door.

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
   *deadline + one call's worth*, and that call's worth is the **connect timeout plus the
   response timeout** — two separate budgets, which is the trap. They are four seconds each,
   so one call is **8 seconds**, or **8 010 ms** counting the loop's ≤10 ms idle; the
   worst case across a whole pass is **38.01 s**. Those are the firmware project's own
   numbers and its README is where the split and the compile-time assertion tying them to the
   watchdog period live — quoted here so the two documents cannot disagree, and not
   re-derived. The earlier sentence here — that the relay can *never* stay released longer
   than the cap — was the deadline's property stated as the relay's, and the earlier
   arithmetic quoted one four-second budget where there are two.

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
| No settings combination, legal or hand-edited, reaches further than four hours | `DeviceGateTests.No_settings_combination_lets_a_door_reach_further_than_four_hours`, `…A_club_with_an_enormous_phone_horizon_still_has_a_four_hour_door`, `DeviceGateHttpTests.The_door_reaches_four_hours_however_wide_the_clubs_own_horizon_is` |
| The release is the club's setting, clamped to 1–30 | `DeviceGateTests.The_release_is_the_clubs_setting_clamped`, `DeviceGateHttpTests.The_release_on_the_wire_is_the_clubs_setting` |
| Every reason has a vector and every vector a reason | `DeviceGateProtocolCorpusTests.The_refusal_reasons_and_their_vectors_are_the_same_set` |
| One audit row per decision, subject named, token absent | `DeviceGateHttpTests.An_active_member_opens_the_door_and_the_open_is_audited` |
| Another club's code opens nothing here | `DeviceGateTests.Another_clubs_code_is_not_recognised_at_this_clubs_gate`, `DeviceGateHttpTests.Another_clubs_code_does_not_open_this_clubs_door` |
| Another club's bookings never reach this club's roster | `DeviceGateTests.Another_clubs_booking_never_appears_…`, `DeviceGateHttpTests.Another_clubs_bookings_never_reach_…` |
| `gate_open` is receipted, names the subject at the scan, settles nothing | `DeviceGateHttpTests.An_offline_gate_open_is_receipted_and_names_the_member_without_checking_them_in` |
| An unresolvable `gate_open` is still recorded | `DeviceGateHttpTests.An_offline_gate_open_with_an_unresolvable_token_is_still_recorded` |
| An offline door event fingerprints its token instead of logging it, and two scans of one code still correlate | `DeviceGateHttpTests.An_offline_door_event_fingerprints_the_token_instead_of_logging_it` |
| EVERY kind's subject is fingerprinted, the court box's `activation` included | `DeviceGateHttpTests.A_court_boxs_activation_event_fingerprints_its_token_as_well`, `DeviceEventHttpTests.Activation_event_with_unknown_token_is_acked_and_audited` |
| `kind` is normalised once and every later decision reads that value | `DeviceGateHttpTests.A_door_event_kind_is_normalised_before_anything_is_decided_from_it` (five spellings), `…An_unknown_kind_is_recorded_as_normalised_and_still_fingerprinted` |
| A respelt `gate_open` cannot step around the court-box refusal | `DeviceGateHttpTests.A_court_box_cannot_post_a_door_open_by_respelling_the_kind` |
| A missing, empty or over-long `kind` is receipted as `malformed`, never 500, and the queue drains past it | `DeviceGateHttpTests.A_malformed_event_kind_is_receipted_rather_than_five_hundred` |
| `no_push` is accepted, logged, stored nowhere, and changes nothing | `DeviceGateHttpTests.A_no_push_counter_is_accepted_and_changes_nothing`, `DeviceGateProtocolCorpusTests.Request_vectors_bind_to_the_records_the_endpoints_take` |
| A `gate_open` from a court box is `not_a_gate` and names nobody | `DeviceGateHttpTests.A_gate_open_uploaded_by_a_court_box_names_nobody_and_says_not_a_gate` |
| A gate cannot activate or sell a walk-up | `DeviceGateHttpTests.A_gate_cannot_activate_a_court_or_sell_a_walk_up` |
| A gate's `activation` upload settles nothing | `DeviceGateHttpTests.An_activation_uploaded_by_a_gate_is_recorded_and_settles_nothing` |
| An unnamed board is pushed no roster; naming it starts the fallback | `DeviceGateHttpTests.An_unnamed_gate_is_pushed_no_roster_until_an_admin_names_the_door` |
| A board out of service is 403 on the heartbeat as well as the scan | `DeviceGateHttpTests.A_gate_taken_out_of_service_is_refused_on_the_heartbeat_too`, `…The_board_identity_failures_keep_their_own_shapes` |
| …and on this surface a 403 can mean NOTHING ELSE | `DeviceForbiddenMeansOutOfServiceTests` (five tests: the group's routes and policy, the scheme's role claim, the source of everything that serves or wraps it, no refusal a working board can provoke, and the forward direction on all five routes) |
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
| A gate no admin has named alerts nobody, and still records its outage | `PeripheralHealthTests.A_gate_no_admin_has_named_alerts_nobody_and_still_records_its_outage` |
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
  polarity combinations and the watchdog budget, and §7's right-hand column — what a board
  does with a `403` versus with a timeout. Those are pinned in `src/iot/door-gate`'s own host
  tests. What is pinned here is the SERVER half: that a board out of service really is
  refused `403` on the heartbeat and the scan. Restating the claim here and pinning it there
  is the split this table is honest about rather than hiding.
- §7's residual and all of §10a: they are statements about what the system does **not**
  guarantee, and a test cannot pin an absence of a guarantee. They are here so that nobody
  infers the guarantee from the surrounding text.
- §10a's cleartext-HTTP posture, which is a deployment fact rather than a behaviour.
