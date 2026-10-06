---
name: crusaders-mainframe-decisions-backend-r17b
description: "Backend round 17 (lane BE17b): a lost optimistic race is decided again (never 500), every seat check-in is a court.checked_in row, desk cancel refusals and record, desk replays quote their own balances."
type: decision
last_verified: 2026-10-06
---

# Live decisions: backend, review round 17 (lane BE17b)

- **A save that loses an optimistic-concurrency race is decided again, never a 500** (J17-1).
  `DatabaseRetry.ReDecideOnLostRaceAsync(db, unit, ct)` runs a unit again (up to `Attempts` = 3) on a
  `DbUpdateConcurrencyException`. It does NOT rewind to a mark like `RunAsync`: the unit may have
  committed an earlier save (the charge under the payer lock). It forgets what the losing attempt
  added, keeps what the CALLER staged unsaved (a desk change record, a pay-for nonce row), and re-reads
  every tracked booking and seat plus any row the attempt changed. Runs inside a transaction too: a
  concurrency miss rolls back to EF's savepoint and does not abort PostgreSQL's transaction.
  Applied to `CourtActivationService.ActivateAsync` (every courtside path) and `BookingService.CancelAsync`.
  Activation re-decides only while its booking is still `Booked` (`stillMine`): a booking the sweep
  settled under an upload lets the race through to `/events`' own loop, which REVERSES it
  (`ConcurrentDecisionTests` pins that).
  *Why:* 5 parallel activations of one booking gave 1 OK + 4×500 and lost partners' seat stamps.
  On the second look a lit booking is a repeat arrival: only the scanner's seat. A cancel that lost
  the row to another cancel says `booking_not_open` (desk) / 404 (member), not "not found" by accident.
- **The global net:** `InternalErrors.Classify` maps `DatabaseRetry.IsLostRace` — any
  `DbUpdateConcurrencyException` in the chain, or a 40P01/40001 — to `503 conflict_retry` with
  `Retry-After: 1`. The status is 503, not 409, so a box keeps the event (any 5xx) and the member
  screens' existing `conflict_retry` handling applies unchanged.
- **Every seat check-in is on the record** (J17-4): `SeatCheckIn.StampAsync` (in
  `CourtActivationService.cs`) stamps the seat AND stages `court.checked_in`. Actor = subject = the
  scanner, `ScanAt` = the scan. Details: `booking_id`, `participant_id`, `organiser_user_id`,
  `court_number`, `method`, `occurred_at`, `lit_court` (the same scan also wrote `court.activated`),
  `reversed_no_show`. It is written on the first activation, a repeat arrival and a no-show reversal.
  A booking with no seats writes none. The Night mapping is BE17c's (`TraceKinds.SeatCheckedInAction`).
  lights.on per player (E17-4): nothing new written; BE17c maps the existing `court.lights_on`.
- **The desk's cancel of a booking that is not open** (E17-6/J17-7): already cancelled is
  `409 {"error":"booking_not_open"}`; played, no-show or blocked is
  `409 {"error":"not_cancellable","status":"completed|no_show|blocked"}`
  (`CancellationResult.NotOpen` / `NotCancellable`). A member's own cancel of such a booking stays
  404, as before: a 409 would tell a stranger the id is real. Bulk: `NotOpen` = already cancelled;
  `NotCancellable` = failed `not_cancellable`.
- **The desk cancel's change record says what it did** (E17-7): `AdminCancelRecord.CompleteAsync` fills
  the staged row's after side before the cancel's save: `refunded_minutes`, `penalty_minutes`,
  `penalty_waived`, `started`, `checked_in_at`, and `checked_in_by {user_id,name}`. The record is
  append-only once saved, which is why it is filled while staged. The `booking.cancelled` audit row
  keeps the desk's words as `reason`, and `waive_reason` only when a penalty was waived.
  `BookingCancellation.ReasonOf` (BE17c) reads `reason`, then `waive_reason`, because rows written
  before R17 carry the reason only under `waive_reason`.
- **A desk movement's replay quotes its own balances** (J17-6): `ReplayBalancesAsync` reads
  `balance_before/after_minutes` off the movement's `credit.adjusted` audit row (`entry_id`). If that
  row is missing it falls back to the balance now. *Why:* a raced double-click answered from a balance
  read before its twin committed, and a later replay answered from today's balance.
- **A desk-made booking's charge frame names the club** (E17-1): `LedgerPosting.ByClub` →
  `WalletFrame.ByClub` (merged with OR) → `actor_name: "The club"` (`LedgerService.ClubActorName`). The
  rule is the mail's `MadeByClub` (actor ≠ member). `court_name` and `booking_starts_at` were already
  sent. No inbox line: the member inbox has no club-booking kind (catalogue is BE17c's).
- BE17c's asks taken: frames carry `checked_in_by_you` (the late check-in was this member's own scan);
  the settle-outside change label says "Recorded a share as paid by hand".
- Tests: `R17BookingRaceHttpTests`. Real parallel scans (1 and 3 partners), parallel cancels (desk and
  member), parallel desk movements. An `OtherWriter` interceptor commits a competing UPDATE just before
  ours, 1×, 2× and past every retry (503). 25/28 were red at 1970da31 (the 3 that passed are guards).
