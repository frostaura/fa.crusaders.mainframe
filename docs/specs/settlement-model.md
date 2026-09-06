# Settlement model

**What a member owes for a booking, after any sequence of events.**

This document exists because the money path had no single statement of it. Round-3 findings
2, 3, 14, 16 and 17 were five symptoms of that absence: each fix was locally reasonable and
they contradicted each other, so a played court could come out free (2), a 100-credit court
could bill 143 (3), a member who could have played was refunded and locked out (14), two
members were charged for one court (16), and one member's desk credit suppressed another
member's settlement (17). None of those is reachable from the rules below.

It is normative. Where code and this document disagree, one of them is a defect; say which.

---

## 1. Vocabulary

| Term | Definition |
| --- | --- |
| **Payer** `u` | `booking.PaidByUserId ?? booking.UserId`. Never the booker, when the two differ. |
| **Price** `P` | `booking.AmountChargedCredits` — quoted and locked at booking, never recomputed from settings that may since have moved. |
| **Sold window** | `[StartsAt, OriginalEndsAt)` where `OriginalEndsAt = StartsAt + SliceMinutes × SliceCount`. |
| **Sold minutes** `M` | `SliceMinutes × SliceCount`. Never changes. `EndsAt` may be truncated by the sweep; `M` is not. |
| **Tariff** | `proRata(m) = round(court.SlicePriceCredits × m / settings.SliceMinutes, 2, AwayFromZero)`. Away-from-zero everywhere, so the club never rounds in its own favour in one place and against itself in another. |
| **Cue window** | `activation_cue_window_minutes` before `StartsAt`. The earliest a scan may light a court. |
| **Grant** | `duration_ms` on an `activation` event: what the box's relay was *told* to run for. An upper bound on the lit time, never a measurement of it. |
| **Held** | `duration_ms` on the matching `release` event (`heldMs`): what the relay *actually* ran. The measurement. |
| **Lit window** | `[max(scan, StartsAt), litEnd)` — see §4. |
| **Displaced** | A booking cancelled by the system to make room for an earlier booking's late-arriving attendance evidence. `CancellationReason == "ResoldTailRefunded"`. |

`Owed(b)` is the amount the payer is due to have paid, net, for booking `b` — the sum of
every ledger row naming `b` for `u`, negated. Admin adjustments naming `b` are movements
inside that sum, not outside it (§6).

---

## 2. The statement

> For every booking `b` with payer `u`, `Owed(b)` is a function of `b`'s terminal state
> alone. Every event in the booking's life either changes that state or corrects the ledger
> towards the `Owed` of the state it is already in. No event adds a charge that is not one
> of the rows below.

| # | Terminal state | `Owed(b)` |
| --- | --- | --- |
| S1 | `Booked` / `Completed` — attended, or not yet decided | `P` |
| S2 | `Cancelled` before check-in, **outside** the penalty window | `0` |
| S3 | `Cancelled` before check-in, **inside** the penalty window | `penalty = round(P × PenaltyPct/100, 2)` |
| S4 | `Cancelled` after check-in | `P` — nothing back once the lights have been on |
| S5 | `NoShow` — swept, no attendance evidence | `noShowPenalty = round(P × PenaltyPct/100, 2)` |
| S5a | `NoShow` — swept while the court's own box was unreachable | `0` — refunded in full, no penalty (`feature-spec.md` §6a) |
| S6 | `NoShow` reversed by late attendance evidence | `P` (returns to S1) |
| S7 | S2/S3 **and** the court was later lit on this booking's own code | `min(P, priorOwed + proRata(litMinutes))` |
| S8 | **Displaced** (`ResoldTailRefunded`) | `0`, unconditionally |
| S9 | `AdminBlock`, or `UserId is null` | not settled — no money path |

S7 is the only state that composes: the retained late-cancellation penalty of S3 is *part of*
what the member has already been billed, so the lit-time charge is netted against it and the
total is capped at `P`.

S5a is S5 with the penalty leg removed, not a separate path: the same sweep, the same refund,
the same row count minus one. It composes with S6 without special-casing, because the reversal
reads the penalty **actually posted** (I3, `penalised = −Σ NoShowPenalty rows`) rather than
recomputing it from settings — a waived penalty is `penalised = 0`, `penaltyBack = 0`, and
`Owed` returns cleanly to `P`.

**S5a is the one deliberate exception to I2, and this used to say the opposite.** The claim here
was that a court that was lit holds an activation on the box and that activation arriving is
what turns S5a into S6, so I2 could not be weakened. That is true only while the box stays
powered. The queue is RAM (`src/iot/lib/eventq/include/eventq/EventQueue.h`), so a box that
lights courts from its cached roster through an outage and then loses power never uploads those
activations, S6 never happens, and `Owed(b)` stays `0` for a court that was played. Read I2 with
its exception below.

**Which instant "unreachable" is judged at, and by what threshold.** S5a asks whether a box
driving the court had been silent for longer than `offline_after_seconds` **at the grace
deadline** — the same threshold the alert and the Devices page use — answered from the last
heartbeat preceding that deadline, whether that comes from a `DeviceOutage` row or from
`Device.LastSeenAt`. It is deliberately *not* "an outage row exists that spans the deadline": a
row is only written once something notices, so that version priced the same facts differently
depending on how promptly the sweep ran.

**And it is not "whatever `LastSeenAt` says now" either**, which is the same defect in the other
direction: the heartbeat that ends an outage moves `LastSeenAt` past the whole of it. The silence
is therefore recorded by the recovery itself — `DeviceSilenceLog.NoteHeartbeat`, in the same save
that moves `LastSeenAt` — rather than only by the health sweep, whose thirty-second stride would
otherwise miss any outage that began and ended between two ticks. A silence ends at the *earliest*
instant the API is known to have heard from the box afterwards, which is what makes a row the
sweep has not closed yet and one it closed late answer the same question the same way.

**A box whose silence had not yet reached the threshold at the deadline is reachable for
settlement purposes**, exactly as it is on the Devices page and in the alert. That is a decision
about which way to fall in a case nothing can see, and not a claim about the box: silence shorter
than the threshold does not distinguish a box that is up and between heartbeats from one that lost
power ninety seconds ago, and nothing in the API can tell them apart. An earlier version of this
paragraph asserted the first of those — "being powered and inside its cached roster, it is a box
that still lights the court and still queues the scan" — which the evidence cannot establish, and
it is withdrawn.

What is checkable is the size of the band and what the alternative costs. The band is bounded by
`offline_after_seconds` (`HeartbeatCadence.OfflineAfterSeconds`, floored at 180 s), so at most a
few minutes of silence before the deadline reads as reachable. Narrowing it means calling a box
offline on ordinary WiFi jitter and waiving penalties for it; widening it means the money and the
Devices page disagree about the same box at the same instant. The band is the price of one number
meaning one thing in the alert, on the glass and in the ledger.

---

## 3. Invariants

Each is a rule the code must enforce, with the reason it exists. A change that breaks one is
a defect, not a trade-off.

### I1 — Ceiling: `0 ≤ Owed(b) ≤ P`

A booking never costs more than the price quoted when it was made, in any sequence of
events. **Why:** the price was quoted and accepted at booking; everything afterwards is a
correction of who owes what, not a second sale. Finding 3 billed granted minutes *plus* a
retained late-cancel penalty and reached 143 for a 100-credit court, with an email asserting
the lights ran 68 minutes whether the relay ran 30 seconds or the full hour.

### I2 — A court that was played is never free

If a court was lit on a booking's identity, `Owed(b) > 0` unless an admin explicitly waives
it with an adjustment. **Why:** the club's electricity ran and the slot was consumed.
Finding 2 made a played court free because any positive adjustment naming the booking
suppressed *both* money legs of the reversal.

**The one exception, accepted deliberately: S5a plus a lost event queue.** The box lights
courts from its cached roster while its uplink is down and queues the activations, but that
queue is in RAM — `src/iot/lib/eventq/include/eventq/EventQueue.h` says so, and the go-live
checklist accepts it. A court lit during an outage that ended in a power cut is therefore never
reported, the sweep concludes nobody played, S5a refunds in full, and `Owed(b) = 0` for a court
that ran. Nothing in the system can distinguish that case from the one S5a exists for, because
the evidence that would distinguish them is exactly what was lost.

It is stated here rather than denied because the alternative is worse and because the loss is
now **silent**. Before S5a the same lost activation cost the *member* a penalty they had not
earned: wrong, but visible on their own ledger and disputed by the member. Now it costs the
*club*, and a full refund on a dark court is indistinguishable from a correct one, so nobody
raises it. Two consequences are load-bearing and are enforced elsewhere: the outage alert must
not tell an admin to power-cycle the box first (that is the action that destroys the evidence),
and the recovery mail must not promise that everything recorded during the outage uploads. Both
are in `EmailTemplates`.

**Making the loss positively detectable is unbuilt, and the route this document used to name for
it does not work.** It said a `(device, seq)` gap after a reconnect would be derivable from the
`DeviceEventReceipt` rows already stored. It is not evidence of anything: `EventQueue` checkpoints
its sequence mark in blocks of `kSeqCheckpointStride` = 64 and `begin()` resumes at `mark + 1`,
with the comment "the previous boot may have issued any number inside that block, and there is no
way to know which". *Every* unclean reboot therefore skips up to 63 numbers whether or not a single
event was lost, and a power cut is precisely an unclean reboot. Compiled against the real header
with the recording store fake, a box that pushed three events and lost power reports its next event
as seq 65 — a 61-number gap with nothing lost at all. Detecting the loss needs something the box
does not emit today: a boot record carrying what it discarded, or a durable ring. Not arithmetic on
the receipts.

### I3 — A manual adjustment is netted per leg, never used as a signal

An `AdminAdjustment` naming a booking is **money that has already moved**. Both legs are
always attempted, and each is netted against the adjustments moving money in **its own
direction**. There is exactly one leg that gives money back and exactly one that takes it, so
the mapping is forced:

```
penaltyBack = max(0, penalised − Σ  positive AdminAdjustment naming b for payer u)
refundBack  = max(0, refunded  − Σ |negative AdminAdjustment naming b for payer u|)
```

**Why:** the *sign* of a hand adjustment says nothing about which leg it repaired, so an
adjustment can never be read as "the desk already fixed this" and used to skip a leg.
Doing that matched only the wrong-direction repairs — the honest outstanding after a sweep is
always negative, so a positive adjustment can never be the whole correction — and skipped the
refund reversal, making a played court free. Meanwhile the *correct* negative repair was not
`> 0`, so the reversal ran on top of it and charged the member twice.

Worked, on an 8-credit court at 30% with 100 seeded: charge −8, sweep +8 −2.40 → 97.60.
A desk that hands back the 2.40 penalty → 100; the reversal posts `refundBack 8`,
`penaltyBack 0` → **92**. A desk that posts the whole correction as −5.60 → 92; the reversal
posts `refundBack 2.40`, `penaltyBack 2.40`, netting to nothing → **92**. No desk action at
all → −8 +2.40 → **92**. All three land on `Owed = P = 8`.

The netting is capped at each leg. An admin who moves more than the leg is worth is making a
decision the model does not claw back; the excess stands on the ledger under their name.

### I4 — An adjustment may only name the payer's own booking

`AdjustRequest.RelatedBookingId` must resolve to a booking in the same tenant whose payer is
the member being adjusted — otherwise `400 booking_not_found` / `400 booking_not_members`.
The compensation query carries `l.UserId == payerUserId` as well, so a row that predates the
validation cannot cross members either. **Why:** without it, a desk crediting member U while
pasting member V's booking id silently changed V's settlement, and nothing on V's ledger
explained it (finding 17).

### I5 — A displaced booking is never charged for being lit, and cannot light anything

`CancellationReason == ResoldTailRefunded` ⇒ `Owed = 0`, and the booking's access code is
expired **in the same save** as the displacement. A late activation naming it is audited
`device.activation_displaced_collision`, naming the booking that displaced it, and charges
nothing. **Why:** the club took the court away from that member and told them so by email;
billing them pro rata for the collision charges two members for one court (finding 16).

### I6 — The lit window is bounded three ways, and measured when the measurement arrives

`litEnd = min(scan + grant, OriginalEndsAt, scan + heldMs when the release has landed)`, and
`litStart = max(scan, StartsAt)`. Minutes charged are `ceil(litEnd − litStart)` clamped to
`[0, min(M, RelayHardCap.Minutes)]`. **Why:** the grant is `closesAt − scan` measured from a
roster window that *opens* at `StartsAt − cue`, so it includes cue-window minutes the member
never bought; and it is what the relay was told, not what it ran. Three separate bounds
because each fails differently: the grant bounds a box that lit for less than the slot, the
sold window bounds a scan inside the cue window, and the release bounds a member who
switched the lights off early.

### I7 — The cue gate applies on every branch

A scan earlier than `StartsAt − cue` is `too_early` on the `NoShow` and `Cancelled` branches
exactly as it is on the live one. **Why:** the cue gate is what stops a box with a drifted
clock from buying court time before the window opens. It was present on the `NoShow` branch
and absent one branch below it, so the cancelled-then-lit charge was the one path a drifted
box could still spend a member's credits on.

### I8 — A reversal restores the window it can prove

`EndsAt` after a reversal is the **provisional** lit end `min(scan + grant, OriginalEndsAt)`,
truncated at the start of any overlapping booking somebody checked in on. When the matching
`release` lands it is corrected to the **real** lit end `scan + heldMs`. Displacement acts on
the window as then known. **Why:** restoring to the original end regardless of evidence
refunded a member who could have played and left the slot dark and unsellable (finding 14).

### I9 — Displacement is eager, and reversed when the release disproves it

A booking overlapping the provisional lit window that nobody checked in on is displaced at
the reversal, refunded in full with the penalty waived, its code expired, its member emailed.
If the release then proves the court went dark before that booking's start **and** the
booking has not yet started, it is **reinstated**: uncancelled, re-charged by a reversing
row, a fresh code minted, the member told.

**Why eager rather than lazy:** the two error directions are not symmetric. Displacing on a
window the court did not use costs a wrongly-refunded member and a dark slot; *not*
displacing on a window it did use puts two members on one lit court, both charged — the
exact outcome of finding 16. The safe default is the refund, and the release is what makes
it temporary. The server cannot tell the two cases apart at the moment the activation
arrives: the box uploads **one event per request** in sequence order, so the release is
always at least one request behind the activation it belongs to, and the heartbeat carries no
held-court state.

Reinstatement is bounded to bookings that have not yet started, because a member who was
told their court was gone and did not come cannot be un-told after the fact, and because a
booking they replaced by re-booking the same slot themselves must not collide.

### I10 — A posting of zero credits is not written

**Why:** a zero row moves nothing, burns its idempotency `ExternalReference` so the real
posting can never be made under it, and reads on a member's statement as a movement that did
not happen. A never-charged displaced booking was posting a zero-credit `CancellationRefund`.

### I11 — Two rows, never a netted one, and never an edit

A correction posts a new row of the **same type with the opposite sign**, tied to the booking
and to its own `ExternalReference`, and reads what it is reversing off the ledger rather than
recomputing it from settings. **Why:** the ledger is append-only and a single net row cannot
answer "how much penalty did I pay?", which is the question a disputed settlement asks. Same
type and opposite sign is also what makes every report bucket net back to the truth.

**Consequence, accepted:** a period bucket can be negative when a sweep falls in one day's
bucket and its reversal in another's. `refunds_credits` and `penalties_credits` are *net*
figures, not gross ones; a negative day means more was reversed than posted. This is the
netting working, not a defect. Only `penalty_count` counts gross, and it counts debits only.

### I12 — The lights-off cue fires once

The reversal does **not** clear `LightsOffCuedAt`. **Why:** the sweep had already cued the
lights off at the truncated end, and clearing the marker made the cue worker fire a second
`booking.lights_off` for the same booking with a different `ends_at`. Promotion to
`Completed` does not depend on the marker — `LightsCueWorker`'s attended-and-over pass
promotes a reversed booking whether or not the cue already fired.

---

## 4. The lit window, in order

An `activation` event carries `(device, relay, scan, grant, token)`. The `release` event that
follows it carries `(device, relay, releasedAt, heldMs)` and **no token** — it names no
booking, so it is paired by device, relay and time:

1. the latest `activation` receipt for the same `(device, relay)` with `OccurredAt ≤ releasedAt`;
2. accepted only when `|(activationAt + heldMs) − releasedAt| ≤ 2 minutes` — both times come
   from the same uptime accumulator, so they agree to within the Mega's timer resolution;
3. otherwise audited `device.release_unpaired` and dropped. A release that cannot be paired
   corrects nothing; it must never be allowed to correct the *wrong* session.

`litEnd` is then, in order of evidence:

| Evidence available | `litEnd` |
| --- | --- |
| release paired | `min(scan + heldMs, OriginalEndsAt)` |
| activation only, `grant > 0` | `min(scan + grant, OriginalEndsAt)` |
| activation only, `grant == 0` | `OriginalEndsAt` |

`litStart = max(scan, StartsAt)`. `litMinutes = clamp(ceil(litEnd − litStart), 0, min(M, 90))`.

---

## 5. Event → transition table

| Event | Precondition | Effect |
| --- | --- | --- |
| Booking created | balance ≥ `P` under the payer's lock, **or** an admin on-behalf booking carrying `feature-spec.md` §8's explicit override (§6) | row + `BookingCharge −P` in one save. `Owed = P`. |
| Cancel, no check-in, outside window | — | `CancellationRefund +P`. `Owed = 0`. |
| Cancel, no check-in, inside window | — | `CancellationRefund +P` **and** `LateCancellationPenalty −penalty`, one save, never netted. `Owed = penalty`. |
| Cancel after check-in | — | nothing posted. `Owed = P`. |
| No-show sweep | `Booked`, no `CheckedInAt`, past grace | `CancellationRefund +P`, `NoShowPenalty −penalty`, `EndsAt := now`, `Status := NoShow`. `Owed = penalty`. |
| No-show sweep, court's box unreachable at the grace deadline | as above **and** an open or closed `DeviceOutage` covering that instant for a box driving the court | `CancellationRefund +P` only — no penalty leg (I10 forbids the zero row). `EndsAt := now`, `Status := NoShow`. `Owed = 0`. |
| Late activation on a `NoShow` | scan ≥ cue open (I7) | `CancellationRefund −refundBack`, `NoShowPenalty +penaltyBack` (I3), `Status := Booked`, `CheckedInAt := scan`, `NoShowReversedAt := now`, `EndsAt := provisional litEnd` (I8), displacement (I9). `Owed = P`. |
| Late activation on a `Cancelled` row | scan ≥ cue open (I7); **not** displaced (I5); no `CheckedInAt` | `LightsPurchase −min(proRata(litMinutes), P − retainedPenalty)` (I1, I6). `Owed ≤ P`. |
| Late activation on a **displaced** row | — | nothing posted; audit `device.activation_displaced_collision`. `Owed = 0`. |
| `release` paired to a cancelled-then-lit charge | `litEnd` earlier than charged | `LightsPurchase +difference`. `Owed` falls to the true pro rata. |
| `release` paired to a reversed no-show | `litEnd < EndsAt` | `EndsAt := max(litEnd, StartsAt)`; displaced bookings starting after `litEnd` and not yet started are reinstated (I9). |
| Admin adjustment naming a booking | booking exists in tenant, payer is the member (I4) | `AdminAdjustment ±x`. Netted into the next reversal per leg (I3). |

---

## 6. What `Owed` does **not** include

- **Top-ups and payment reversals.** They fund the wallet; they name no booking.
- **The payer override** (`I'll pay` at the court). It moves the whole charge from one member
  to another as a refund/charge pair; `Owed(b)` is unchanged, only `u` is.
- **An admin adjustment that names no booking.** Goodwill, corrections of a mis-keyed top-up,
  anything the desk does that is not about one booking.
- **The wallet going below zero.** `feature-spec.md` §8 lets an admin book on behalf of a
  member who cannot cover the court, by asking for the override explicitly. That leaves the
  member's **wallet** negative; it does not change `Owed(b)`, which is still `P`, posted as
  the same single `BookingCharge` at the same quoted price. Nothing above bounds the sign of
  the wallet, and I1's ceiling is per booking, not per member: a member overdrawn on two
  courts owes `P₁ + P₂`, each still inside its own `[0, P]`. Cancelling one behaves exactly
  as S2/S3 say, and an ordinary top-up nets against the rest, because the wallet is the sum
  of the ledger and there is no separate debt record for it to disagree with. It was already
  reachable before §8's override existed — a `release` correction landing on credit the
  member had since spent does the same thing.

---

## 7. Known residuals

Recorded here rather than left for the next reviewer to rediscover.

1. **An over-generous adjustment is not clawed back.** I3 nets only up to each leg. A desk
   that credits 100 for a 2.40 penalty leaves the member 97.60 up, visibly, under the admin's
   own actor id, and a desk that posts the same correction twice leaves them short by it.
2. **A displaced booking that has already started is not reinstated** even when the release
   proves the court was free (I9). The member was told and did not come; the ledger already
   made them whole.
3. **A release that never arrives leaves the grant as the answer.** A box that dies between
   lighting a court and releasing it charges the grant, which is the upper bound. This is
   deliberate: deferring the charge until the release lands would make a lost release a free
   court, which breaks I2, and I2 outranks precision.
4. **`Owed` is not materialised anywhere.** There is no stored balance and there must not be
   one; `Owed` is a property of the rules, checked by the pinning tests, not a column.

---

## 8. Where this is enforced

| Rule | Code |
| --- | --- |
| S1–S5, I11 | `Services/BookingService.cs` — `CreateAsync`, `CommitAsync`, `SettleCancellation`, `CancelAsync`; `Webhooks/NoShowWorker.cs` — `SweepOneAsync` |
| S5a | `Webhooks/NoShowWorker.cs` — `SweepOneAsync` (`courtWasDark`); `Services/DeviceOutageIndex.cs`; `Webhooks/PeripheralHealthWorker.cs` writes the evidence |
| S6, I3, I8, I9, I10, I12 | `Services/BookingService.cs` — `ReverseNoShowAsync`, `SettledLegsAsync`, `DisplacementAsync`, `RestoreEnd`, `ReinstateDisplacedAsync` |
| S7, I1, I6 | `Services/BookingService.cs` — `ChargeLitCancelledBookingAsync`, `SettleReleaseAsync`; `Endpoints/DeviceEventEndpoints.cs` — `LitWindow` |
| S8, I5 | `Services/BookingService.cs` — `ChargeLitCancelledBookingAsync` guard, `ExpireCodes`; `Endpoints/DeviceEventEndpoints.cs` — displaced-collision audit |
| §6 overdraft override | `Services/BookingService.cs` — `CreateAsync` (`BookingPayer.AllowNegativeBalance`) and `CommitAsync`, which must lift the same guard under the payer's lock; `Endpoints/BookingEndpoints.cs` — the admin booking route |
| I4 | `Endpoints/WalletEndpoints.cs` — the adjust handler |
| I7 | `Endpoints/DeviceEventEndpoints.cs` — `SettleAsync`; `Services/CourtActivationService.cs` — `ActivateAsync` |
| §4 pairing | `Endpoints/DeviceEventEndpoints.cs` — `ReleaseOutcomeAsync` |

Pinning tests: `NoShowWorkerTests`, `PeripheralHealthTests`, `DeviceEventHttpTests`,
`WalkUpBookingTests`, `ConcurrentDecisionTests`, `SettlementModelTests`,
`AdminOverdraftBookingTests`, `AdminOverdraftBookingHttpTests`.
