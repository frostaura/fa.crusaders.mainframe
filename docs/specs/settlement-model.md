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
| S5a | `NoShow` — swept while the court had **no reachable box** | `0` — refunded in full, no penalty (`feature-spec.md` §6a) |
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
powered. The queue is RAM (`src/iot/shared/lib/eventq/include/eventq/EventQueue.h`), so a box that
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

**How many boxes have to be dark: all of them.** S5a is a statement about the COURT, not about a
box — `feature-spec.md` §6a says "a booking whose court had **no reachable box**". A court driven
by two enabled boxes is dark only when both were past the threshold at the deadline; one dark box
beside a healthy one is a court a member could still have checked in at. The distinction is not
theoretical: a club that replaces a box and leaves the old row enabled in the table has exactly
that shape, and the old row is silent forever, so "any box was dark" would waive every no-show on
those courts permanently, for free, with nothing on any screen saying why. Switching the retired
row off removes it from the index (a disabled box is not expected to call in and contributes
nothing in either direction), but the rule must not rest on an admin remembering to.

**What the `Enabled` filter itself decides, now that the all-boxes rule carries the case above.**
It is no longer the retired-row case: with every box on the court required to be dark, one silent
extra box waives nothing by itself, so the filter is not what protects the club there — and the
test this document used to name as its pin,
`A_decommissioned_box_left_in_the_table_does_not_waive_the_penalty`, stopped discriminating it
(flip that fixture's `enabled` flag and nothing changes). The case the filter still prices is the
mirror: a court whose enabled boxes are **all** dark, with a switched-off box beside them that was
heard from seconds ago — a spare on the bench, or the replacement an admin has plugged in and not
yet configured. A disabled box is not evidence that the court was lit, so the waiver stands and
`Owed(b) = 0`; without the filter the bench spare reads as a live box on the court, the court stops
being dark, and the member pays the 30% for hardware that was driving nothing. Pinned in both
directions by `A_disabled_box_heard_from_seconds_ago_does_not_block_the_waiver` and
`A_stale_but_enabled_box_beside_a_healthy_one_does_not_waive_the_penalty`.

**A box only votes on deadlines it existed at.** `DeviceRegistryService.AutoRegisterAsync` puts any
unknown MAC onto the club's first four courts with `Enabled` defaulting true, so under the all-boxes
rule a single healthy unconfigured board — a spare on the desk, the replacement an admin plugs in
while the dead one is still in the cupboard — vetoed the S5a waiver on courts 1–4 and handed the
club's own outage back to its members at 30% each. The all-boxes rule created that: before it, an
extra board could only add waivers. A board therefore counts in **either** direction only from the
earliest instant it is known to have existed — the earliest of its row's `CreatedAt`, its
`LastSeenAt` and the start of any recorded silence — and before that it is skipped rather than
counted as dark, so a court whose only box arrived afterwards is "not dark" exactly as a court with
no box is. `feature-spec.md` §6a carries the reasoning, including why the narrower existence rule
was chosen over "an auto-registered box never votes". Pinned by
`A_board_that_appeared_after_the_deadline_does_not_block_the_waiver` and
`A_board_already_installed_at_the_deadline_still_blocks_the_waiver`, which differ only in the
board's install date.

**A court the club has put no box on at all is not dark**, even though it trivially has "no
reachable box". There is no evidence either way — the club has no hardware there — and reading the
phrase literally would waive every no-show at a club that has not installed a box yet.

**A court whose boxes have ALL been switched out of service is a different state, and it IS dark.**
This sentence used to read "a court no enabled box drives is not dark", full stop, and in that
form it cost members money. `Enabled` is not a filter on evidence when it is the last box on the
court: `DeviceIdentity.ResolveAsync` refuses a disabled board `403` on all five
`/api/v1/device/*` routes — `/heartbeat`, `/activate`, `/walkup`, `/events` and the door gate's
`/gate` — so once an admin takes the last box off a court, that box is refused every route it
calls, is no longer sent the roster that says which bookings it may open, and can never hand the
club what it is holding. (Refused is not the same as dark at the court: a box that falls back to
the roster it already holds can still light a booked court until that roster goes stale —
`feature-spec.md` says which ways in survive the switch. The settlement argument does not need
the stronger claim.) The sweep nevertheless
settled those bookings as ordinary no-shows carrying the full `penalty_pct`. That is a member
billed 30% for a door the club shut, which is the exact direction S5a exists to prevent. The
out-of-service switch reached a screen for the first time in finding M-F3, so the state went from
unreachable to one confirm-click away in the same change.

**The door is not shut everywhere, and this document said for two rounds that it was.** The
withdrawn claim was that *every courtside endpoint* answers `403` from the click, and one grep
disproves it: `grep -rn '"/api/v1/court' src/backend/Crusaders.Mainframe.Api --include="*.cs"`
returns `PinEndpoints.cs`, `QrEndpoints.cs` and `BiometricEndpoints.cs`, and none of those three
files mentions `Devices`, `Enabled` or `IsActive` at all. `/api/v1/court/{n}/pin/match`,
`/api/v1/court/{n}/qr/match` and `/api/v1/court/{n}/biometric/match` resolve a `Courts.CourtNumber`,
authenticate as the shared courtside terminal's `admin` role rather than as a box, and set
`CheckedInAt` through `CourtActivationService.ActivateAsync` exactly as they did before the switch
was thrown. `feature-spec.md` §6a puts the biometric reader on the on-site machine, not on the
board. **So three of the six ways in survive the switch**, and the enumeration "heartbeat,
activation, walk-up, PIN, QR or biometric" that this document, `Device.cs` and the waiver mail all
carried was wrong in its last three terms.

**The waiver still stands, and this is the argument rather than the assertion.** The sweep only
reaches bookings with `CheckedInAt == null` (`NoShowWorker`'s due predicate), so the question is
never "could this member have checked in somewhere" but "nobody did, and who carries it". Three
things decide it for the member. The club has taken the door away *at the court*: the box's
buttons, its scan, its walk-up and its `/activate` are all refused, and it is not even told which
bookings exist any more. What is left is a different machine in a different place, which the club
chose to make the only route when it threw the switch. And the club holds no evidence either way —
it cannot tell a member who arrived, found a dead box and left from one who never came — while
S5a's whole direction is that the club carries the cost of its own hardware decision instead of
billing it at 30%. **The cost of that choice, stated rather than implied:** a member who genuinely
did not turn up to a court whose boxes are all out of service is waived all the same. The terminal
was open to them; the club simply has no record of who tried it and who never came, and this rule
resolves that silence towards the member. It is bounded — it needs *every* box on the
court switched off, and it reaches only bookings nobody checked into — and it errs in the same
direction as every other clause in S5a.

Those two states — a court the club has put no box on, and a court whose boxes are all switched off
— are told apart by whether a board exists at all on that court, not by a judgement about intent: a
club with nothing on the court has never asked anyone to check in there, while a club with a
switched-off board has taken a working door away.

**But the switch itself does not reach backwards, and the first version of this clause let it.**
That version said a switched-off board darkens its court from the moment it existed, which read
the *present* value of `Enabled` as though it had always held. `Enabled` carries no history, so a
board that ran perfectly for thirty days and was switched off five minutes ago waived every
unsettled deadline back to the sweep's lookback floor (`no_show_lookback_days`, default 7) —
against the club, invisibly, on the next thirty-second tick. It is the same defect §6a rejects two
earlier rules for: it made the price of a settled fact depend on something that happened
afterwards, and priced identical facts two ways depending on whether an admin had clicked yet.

**The switch-off instant is recorded, and it is its own column.** `devices.OutOfServiceSince` is
stamped where the transition happens (`DeviceRegistryService.UpdateAsync`) and cleared when the
board goes back into service. **It is not `LastSeenAt`, and this document said for one round that
it was.** The argument then was that a disabled board is refused `403`, so the moment the switch is
thrown is the moment it stops being heard from — true, but the two instants are not the same one.
The switch lands some seconds or minutes *after* the board's last heartbeat, and that gap is money:
it is up to a heartbeat cadence wide, and a grace deadline inside it is priced one way if the gap
is read as "still in service" and the other way if it is read as "already switched off".

**So the rule is two parts, one on each side of the click, and each is answered from evidence that
existed at the instant asked about.** For a switched-off board and a deadline `D`, with the switch
thrown at `S`:

| | |
| --- | --- |
| `D` at or before `S` | **Judged by `offline_after_seconds`**, the same test, the same strictly-greater comparison and the same reading of `DeviceOutage` rows an *enabled* board gets. The board was in service at `D`; the click had not happened. |
| `D` after `S` | **Out of service, at once.** The club has declared the door shut and the board itself is refused `403` on all five `/api/v1/device/*` routes from that instant, so there is no ambiguity left to wait `offline_after_seconds` for. Strictly greater-than: a deadline landing exactly on `S` is on the near side and is judged by the row above. |

**The first row is not "Lit", and an earlier version of this table said it was.** That version split
it in two and called everything at or before the board's last heartbeat Lit — "positive proof it
was in service". There is no such proof. `BoxWasUnreachable` reads *every* silence recorded for the
board, closed `DeviceOutage` rows included, so a deadline the board was genuinely dark across is
dark here even when it falls before the board's most recent heartbeat: that is exactly what
`A_board_dark_across_the_deadline_still_waives_it_after_an_admin_switches_it_off` sets up (last
heartbeat 30 minutes ago, a recorded outage from 70 to 30 minutes ago, a deadline at 55 minutes
ago) and it asserts a full refund with no penalty. The rule has one test on each side of the click
and no third case; the last heartbeat is an input to that test, not a case of its own.

The first row is the whole of "the switch does not reach backwards": the same `BoxWasUnreachable`
call answers a past deadline on both sides of the click, so throwing the switch cannot change a
price that had already been decided. The second row is the half that was missing. Bounding the
branch by the board's silence instead — the rule that shipped — left the court reading **Lit** for
up to `offline_after_seconds` (180 s at the shipped default) after the click, while the board
itself was already refused on every route it calls: a member whose court the club had switched off
a minute earlier was charged the full `penalty_pct` and mailed the plain no-show notice. Bounding it at
`LastSeenAt` exactly — the other obvious candidate — closes that and reopens the retroactive
switch for every deadline in `(LastSeenAt, LastSeenAt + offline_after_seconds)`. Both were run: with
the second rule in place a sixty-second-old deadline moved from `97.60` to `100.00` on the click
alone and the whole backend suite stayed green. Only the recorded instant answers both.

**What the column cannot carry, stated rather than implied.** It is one instant, not a history.
Putting a board back in service clears it, so *the column* leaves no record of an off-period that
has ended. Something else does, and this paragraph argued from the opposite premise for a round:
`PeripheralHealthWorker` never opens a row for a disabled board, but the board's own return does.
`DeviceSilenceLog.NoteHeartbeat` writes a closed `DeviceOutage` on the first heartbeat after the
board is switched back on, whenever that heartbeat lands more than `offline_after_seconds` after
`LastSeenAt` — and `LastSeenAt` is still the last heartbeat *before* the switch was thrown, because
a disabled board was refused in between. So the recorded silence is **never narrower than the
off-period, and normally wider**: it starts at that last pre-switch heartbeat rather than at the
click — the two coincide only if the switch was thrown on a heartbeat — and it ends when the board
came back.

An unsettled deadline inside a *finished* off-period is therefore judged by that recorded silence,
exactly as an enabled board's would be, and the gap this leaves is narrower than "off-periods
shorter than the threshold". What still reads Lit is a deadline less than `offline_after_seconds`
after the board's **last pre-switch heartbeat** — which covers the whole of a short off-period, and
covers a longer one only in its opening minutes, or entirely if the board came back before the
total silence crossed the threshold at all, in which case no row is written. It is a known gap in
the club's favour and it is the price of one column instead of a table. Pinned by
`A_finished_off_period_is_covered_by_the_outage_row_the_boards_return_writes`.

`DeviceOutageIndex.CourtWasDark` therefore answers **dark** when every enabled box driving the
court was past the threshold at the deadline, **or** when no enabled box drove it and every
out-of-service board that did had its door shut then by the two-part rule above; and **not dark**
when a reachable enabled box drove it, when the last board on it was still in service and being
heard from at that instant, or when the club has no board on it at all.
`DeviceOutageIndex.DarknessAt` returns which of the two dark states it was, because they do not
carry the same promise to the member (below).

**A switched-off board only speaks for deadlines it existed at, exactly as an enabled one does.**
The floor is the earliest of the row's `CreatedAt` and its `LastSeenAt` — `LastSeenAt` may be null
here, unlike in the enabled set, because a board that was switched off before it ever heart-beat is
still hardware the club installed. The floor and the switch-off instant close different holes and
both are needed: the floor stops a board *registered* after the deadline from speaking for it, and
the recorded instant stops a board *switched off* after the deadline from speaking for it. Only the
first of the two existed after finding M-F3, and the pin table below listed it against the second.

**The waiver mail differs between the two dark states, and that is a settlement fact rather than
copy.** S5a is reversible by S6 only while the board is in service: an outage ends, the board
uploads what it queued, and the booking settles as attended. A board an admin has taken out of
service is refused `403` on `/device/events` too, so nothing it holds will ever be accepted and the
S5a settlement is final. The outage notice says the record arrives when the box reconnects; the
out-of-service notice says the refund is final and sends the member to the desk. Pinned by
`The_out_of_service_waiver_mail_does_not_promise_a_box_that_will_never_reconnect` and
`The_outage_waiver_mail_still_promises_the_upload_for_a_box_that_can_come_back`.

**The out-of-service notice no longer opens "No court box was answering", and recording the
switch-off instant is what made that sentence false.** A court is out of service from the click,
so the board this mail is sent about may have been answering perfectly a minute before the grace
window closed — it was simply switched off. What holds in both halves of the state is a claim
about the **box**, not about the court: it could not open the court and it will never report
anyone who played — before the click because it had gone quiet past the threshold, after it
because the API refuses it outright. That is what the sentence says now, and it is deliberately
narrower than the sentence it replaced, which said that no check-in on that court could have
reached the club. That one was false: the courtside terminal is not the box and was never refused
(see "The door is not shut everywhere" above), so a mail claiming it was told a member something
untrue about what they could have done. Every sentence in both mails is pinned to the letter by
`Every_sentence_of_the_out_of_service_waiver_mail` and `Every_sentence_of_the_outage_waiver_mail`,
because a verifier inverted four of this template's five sentences — "Penalty: None" to "Penalty:
30% of the booking" among them — with the whole backend suite green.

Pinned by `PeripheralHealthTests`, and each name pins the clause it is listed against rather than
the section as a whole:

| Clause | Pin |
| --- | --- |
| One dark box beside a healthy one is not a dark court | `A_stale_but_enabled_box_beside_a_healthy_one_does_not_waive_the_penalty` |
| Every box on the court dark **does** waive | `Two_boxes_on_one_court_both_dark_still_waives_the_penalty` |
| A disabled box is not evidence in either direction | `A_disabled_box_heard_from_seconds_ago_does_not_block_the_waiver` |
| A box bears only on the courts it drives | `An_outage_on_a_box_that_drives_other_courts_does_not_waive_the_penalty` |
| A board that did not exist at the deadline is not evidence about it | `A_board_that_appeared_after_the_deadline_does_not_block_the_waiver` |
| A board that did exist at it still is | `A_board_already_installed_at_the_deadline_still_blocks_the_waiver` |
| The settlement is the same once the retired row is switched off | `A_decommissioned_box_left_in_the_table_does_not_waive_the_penalty` |
| A court whose only box is out of service **is** dark | `A_court_whose_only_box_is_out_of_service_waives_the_penalty` |
| …from the instant the switch was thrown, with no waiting period | `A_court_is_out_of_service_from_the_instant_the_switch_was_thrown`, row `-90` |
| …and not one second before it: a deadline already past when the switch was thrown keeps its price | the same theory, row `-30` |
| …and not one TICK before it: a deadline landing exactly on `S` is on the near side | `A_deadline_exactly_on_the_recorded_switch_off_instant_is_judged_by_the_silence_test` |
| …and the member inside that window gets the waiver mail, not the no-show notice | `The_member_inside_that_window_gets_the_waiver_mail_and_not_the_no_show_notice` |
| The instant is stamped on the switch and cleared on the way back in | `Taking_a_board_out_of_service_records_the_instant_and_returning_it_clears_it` |
| …and a repeated `enabled:false` on an already-disabled board does not move it | the same test, its fourth step |
| A switched-off row with no recorded instant falls back to its silence alone | `A_switched_off_row_with_no_recorded_instant_is_judged_by_its_silence_alone` |
| Deadlines before the switch are judged by the board's silence, both ways | `A_switch_off_darkens_only_the_deadlines_the_board_had_already_gone_quiet_for` |
| …so a board still heart-beating when it was switched off does not waive an older deadline | `A_court_whose_only_box_was_just_switched_off_still_charges_the_older_deadline` |
| …not even hardened with a silence on both sides of it | `A_switched_off_board_heard_from_on_both_sides_of_the_deadline_does_not_waive_it` |
| …and a real outage keeps its waiver once the club switches the board off | `A_board_dark_across_the_deadline_still_waives_it_after_an_admin_switches_it_off` |
| A FINISHED off-period is covered by the outage row the board's own return writes | `A_finished_off_period_is_covered_by_the_outage_row_the_boards_return_writes` |
| A board never heard from was never in service | `A_board_installed_before_the_deadline_and_never_heard_from_waives_the_penalty` |
| A court with no board of its own is still not dark | `A_court_with_no_box_of_its_own_pays_the_penalty_even_beside_an_out_of_service_box` |
| A board **registered** after the deadline does not speak for it | `A_box_switched_off_after_the_deadline_does_not_make_its_court_out_of_service` |
| The out-of-service waiver mail does not promise a reconnect | `The_out_of_service_waiver_mail_does_not_promise_a_box_that_will_never_reconnect` |
| The outage waiver mail still does | `The_outage_waiver_mail_still_promises_the_upload_for_a_box_that_can_come_back` |
| Every sentence of the out-of-service mail, including both that state the money | `Every_sentence_of_the_out_of_service_waiver_mail` |
| Every sentence of the outage mail | `Every_sentence_of_the_outage_waiver_mail` |
| Both mails quote the booking's own refund rather than a constant | `Both_waiver_mails_quote_the_bookings_own_refund` |

**The row named "A board switched off after the deadline does not speak for it" was false, and it
is the reason the regression above shipped.** Its pin varies `installedAt` — a board *created*
after the deadline — which is a different fact from a board *switched off* after it, and nothing in
the suite varied the second one at all. The row above it, "that turns on the refusal, not on
silence", asserted the opposite of the corrected rule and its pin
(`A_court_whose_only_box_was_just_switched_off_waives_the_penalty_too`) was the fixture that carried
the defect; that test now runs the same fixture with the assertion inverted, under the name in the
table. Two rows added by the same commit contradicting each other is the tell.

The last two of the original rows are the ones this document previously over-claimed.
`An_outage_on_a_box_that_drives_other_courts_does_not_waive_the_penalty` puts its only box on a
court forty numbers away, so it passes through the *no box on this court* branch and never reaches
the all-boxes loop at all; and the decommissioned test is carried by its healthy replacement, as
above. Neither is evidence for the all-boxes rule. The decommissioned test was not even carried by
its replacement until 2026-09-07: `AddBoxAsync` defaults `CreatedAt` to now, so the replacement had
not existed at the deadline and was skipped by the existence rule, and the test was green because
*nothing* voted. It only surfaced when a court whose surviving hardware is switched off became
dark. Its fixture now gives the replacement the same thirty-day install date its sibling carries.

**A box whose silence had not yet reached the threshold at the deadline is reachable for
settlement purposes**, exactly as it is on the Devices page and in the alert. That is a decision
about which way to fall in a case nothing can see, and not a claim about the box: silence shorter
than the threshold does not distinguish a box that is up and between heartbeats from one that lost
power ninety seconds ago, and nothing in the API can tell them apart. An earlier version of this
paragraph asserted the first of those — "being powered and inside its cached roster, it is a box
that still lights the court and still queues the scan" — which the evidence cannot establish, and
it is withdrawn.

**What is checkable is the size of the band, and it is wider than this paragraph used to say.**
The band is `offline_after_seconds` — `HeartbeatCadence.OfflineAfterSeconds`, which is
`max(180, clamp(heartbeat_seconds, 15, 300) × 3)` — and `AdminConfigEndpoints` accepts
`heartbeat_seconds` anywhere in `[15, 300]`. So the band is **180 s at the shipped default
cadence of 60 s and at every cadence below it, rising with the cadence to 900 s at the 300 s
ceiling**. A club on the maximum cadence gives a box 15 minutes of silence that still reads as
reachable, and a member who stood at that court through those 15 minutes pays the 30% penalty. An earlier version of this paragraph said "floored at 180 s, so at most a few minutes" —
that is the ceiling of the *floor* stated as the ceiling of the *band*, and it was wrong at the
top of its own range. The real table is pinned by
`HeartbeatCadenceTests.The_offline_threshold_follows_the_effective_interval` (`300 → 900`), and
this paragraph's numbers are pinned against the constants by
`SettlementSpecPostureTests.The_band_this_spec_states_is_the_band_the_code_computes`.

**The 900 s band is accepted rather than bounded, and this is what was weighed.** Three things
rule out narrowing it:

- **The threshold is one number with three consumers** — the `peripheral.unhealthy` alert, the
  Devices page, and this ledger. A settlement-only ceiling would be a fourth definition of
  "offline" and would make the product tell an admin one thing while billing a member on
  another, which is the exact defect S5a's judging rule was rewritten to remove.
- **The multiplier cannot come down.** One dropped call costs `2 × cadence` of silence before the
  next beat lands, so `MissedBeatsBeforeOffline = 3` is one dropped call plus latency and nothing
  more. At the 300 s cadence a 600 s ceiling *is* two beats, i.e. offline on a single retry — and
  every box wrongly called offline waives the penalty on its courts, so narrowing moves money the
  other way, silently, on every court at that cadence rather than only during a real outage.
- **900 s is reached only by a club that chose the firmware's maximum cadence.** `[15, 300]` is
  `bridgelogic::kMinHeartbeatMs`/`kMaxHeartbeatMs` transcribed; the API accepts exactly what the
  fleet honours, and lowering the ceiling to shrink the band would put the API back to refusing
  settings the boxes do run.

**The admin who sets the cadence is told what it buys, which is what makes it a choice.** The
Settings screen's `heartbeat_seconds` hint states the derived threshold for the value currently in
the field — at 300 s it reads "that is 15 minutes" — from `lib/tenantSettings.ts`, which mirrors
`MinOfflineAfterSeconds`, `MissedBeatsBeforeOffline` and the `[15, 300]` clamp with the server
constant each one mirrors named beside it. So the band is chosen with its size on screen rather
than discovered afterwards.

**What would reopen this.** Two things. The hint attributes the threshold to the Devices page
only — it does not say a member's no-show penalty turns on the same number — so an admin widening
the cadence to reduce chatter is not told they are also widening the window in which a member pays
for a dark court. And the mirror in `lib/tenantSettings.ts` is a copy: if
`HeartbeatCadence`'s constants move and the copy does not, the club is shown one band and billed
on another. The copy is pinned in both directions by `tenantSettings.test.ts` and by
`SettlementSpecPostureTests`; the missing sentence in the hint is not.

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
queue is in RAM — `src/iot/shared/lib/eventq/include/eventq/EventQueue.h` says so, and the go-live
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

**The column is a closed marker with one owner, not a note field and not dead schema.**
`bookings.cancellation_reason` holds `ResoldTailRefunded` or null, written only by the
displacement path and cleared only by the reinstatement that reverses it; the two readers
above compare it against that one constant. No other path writes it — in particular an
admin cancelling on a member's behalf does not, and must not: the reason a desk types is
recorded on the `booking.cancelled` audit row (`feature-spec.md` §11), and putting free text
here would leave a money discriminator carrying prose. **Why this is spelled out:** a round-9
fix read the admin path's silence as "a column nothing writes", wrote that into
`feature-spec.md` §11, and its own hand-off proposed the column as dead schema someone could
clean up — which would have deleted the discriminator this invariant is defined by.

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

**The one exception, and what makes it one.** A posting *whose `ExternalReference` is the only
record the transaction has* is written even at zero. That is the walk-up charge and nothing
else: the box's nonce becomes the reference, `ReplayAsync` finds the purchase by reading that
reference off the ledger, and no second posting is ever made under it — the undo uses a
suffixed reference of its own. So the middle clause of the "why" above, which is the harm this
invariant is named for, cannot arise; and on a court priced at zero, dropping the row costs a
member their court. Measured, not argued: with the row suppressed, a box whose response was
lost retries the same nonce, finds no purchase to replay, books again, collides with the
member's own live booking and is answered **`court_in_use` — 409 where it should be 200**. The
glass then reads COURT NOT FREE about a court the member has already bought and cannot get
into, which is the H3 defect the nonce exists to prevent. Pinned in both directions by
`WalkUpBookingTests.A_free_court_is_bought_once_and_replays_to_the_same_purchase` and
`A_free_court_charges_nothing_and_still_leaves_a_record_of_the_purchase`.

Everywhere else the invariant is absolute, and that includes the ordinary booking charge: a
court priced at zero posts no `BookingCharge` row at all.

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
| Walk-up bought at the box | balance ≥ `P` under the payer's lock | row + `LightsPurchase −P` in one save, and the confirmation email is **held**. The same request then activates the court; only then is it sent. `Owed = P`. |
| Walk-up whose activation is then refused | the purchase's own activation answers anything but `Activated`; no `CheckedInAt` | `LightsPurchase +P` under `<purchase reference>:void` (I11 — same type, opposite sign, never netted), `Status := Cancelled`, one save. No penalty leg on either side: the court was never lit, so I2 does not apply. No confirmation is sent; the member is mailed that nothing was bought. `Owed = 0`. |
| Cancel, no check-in, outside window | — | `CancellationRefund +P`. `Owed = 0`. |
| Cancel, no check-in, inside window | — | `CancellationRefund +P` **and** `LateCancellationPenalty −penalty`, one save, never netted. `Owed = penalty`. |
| Cancel after check-in | — | nothing posted. `Owed = P`. |
| No-show sweep | `Booked`, no `CheckedInAt`, past grace | `CancellationRefund +P`, `NoShowPenalty −penalty`, `EndsAt := now`, `Status := NoShow`. `Owed = penalty`. |
| No-show sweep, court had no reachable box at the grace deadline | as above **and** at least one enabled box drives the court and **every** box that drives it had been silent longer than `offline_after_seconds` at that instant | `CancellationRefund +P` only — no penalty leg (I10 forbids the zero row). `EndsAt := now`, `Status := NoShow`. `Owed = 0`. |
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
| Walk-up purchase, and its undo | `Services/BookingService.cs` — `CreateWalkUpAsync`, `VoidUnstartedWalkUpAsync`; `Endpoints/DeviceEventEndpoints.cs` — `WalkUpForDeviceAsync`, which decides between them and owns the ordering of the confirmation |
| S5a | `Webhooks/NoShowWorker.cs` — `SweepOneAsync` (`courtWasDark`); `Services/DeviceOutageIndex.cs`; `Webhooks/PeripheralHealthWorker.cs` writes the evidence |
| S6, I3, I8, I9, I10, I12 | `Services/BookingService.cs` — `ReverseNoShowAsync`, `SettledLegsAsync`, `DisplacementAsync`, `RestoreEnd`, `ReinstateDisplacedAsync` |
| I10, the booking-charge half and its one exception | `Services/BookingService.cs` — `CommitAsync`, which posts nothing for a zero charge unless an `ExternalReference` makes the row the purchase's only record |
| S7, I1, I6 | `Services/BookingService.cs` — `ChargeLitCancelledBookingAsync`, `SettleReleaseAsync`; `Endpoints/DeviceEventEndpoints.cs` — `LitWindow` |
| S8, I5 | `Services/BookingService.cs` — `ChargeLitCancelledBookingAsync` guard, `ExpireCodes`; `Endpoints/DeviceEventEndpoints.cs` — displaced-collision audit |
| §6 overdraft override | `Services/BookingService.cs` — `CreateAsync` (`BookingPayer.AllowNegativeBalance`) and `CommitAsync`, which must lift the same guard under the payer's lock; `Endpoints/BookingEndpoints.cs` — the admin booking route |
| I4 | `Endpoints/WalletEndpoints.cs` — the adjust handler |
| I7 | `Endpoints/DeviceEventEndpoints.cs` — `SettleAsync`; `Services/CourtActivationService.cs` — `ActivateAsync` |
| §4 pairing | `Endpoints/DeviceEventEndpoints.cs` — `ReleaseOutcomeAsync` |

Pinning tests: `NoShowWorkerTests`, `PeripheralHealthTests`, `DeviceEventHttpTests`,
`WalkUpBookingTests`, `ConcurrentDecisionTests`, `SettlementModelTests`,
`AdminOverdraftBookingTests`, `AdminOverdraftBookingHttpTests`.
