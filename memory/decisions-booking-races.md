---
name: crusaders-mainframe-decisions-booking-races
description: "Booking writes that race: a deadlocked or serialisation-failed unit is retried whole (3×), a lost optimistic race is decided again, and anything that escapes is 503 conflict_retry with Retry-After, never 500."
type: decision
last_verified: 2026-11-20
---

# Live decisions — booking writes that two requests can race

Member-facing words for these answers: [`decisions-frontend-unknown-outcomes.md`](decisions-frontend-unknown-outcomes.md);
seat acts have their own twin rules in [`decisions-players-acts-races.md`](decisions-players-acts-races.md).
Cancels that find the booking not open, who may cancel, and which clock each path reads:
[`decisions-booking-races-cancels.md`](decisions-booking-races-cancels.md).

## Aborts: retried as one rolled-back unit (R16)

- **`Persistence/DatabaseRetry.RunAsync(db, unit)` / `SaveAsync(db)`** re-runs a unit PostgreSQL aborted with 40P01
  or 40001, up to `Attempts` = 3 (`DatabaseRetry.cs:32`), pausing `Random.Shared.Next(5, 20) * attempt` ms (`:185`).
  *Why:* `ck_bookings_no_overlapping_slot` is re-checked on every booking INSERT and on any UPDATE writing a new row
  version, so an overlapping INSERT and UPDATE can each wait on the other — found on twin walk-up retries (1 in 36
  loaded class runs, 0 in 80 standalone). The `DeviceRateKey` middleware did not cause it, only shifted the timing by
  one round trip. Every booking write had the same 500.
- **A retried unit is one whose writes all roll back together** — one `SaveChanges` or one `PayerLock` transaction —
  which is what makes a double charge impossible. Mail, events and outbox publishes stay after the commit, never repeated.
  **Where that invariant is pinned:** `R16DeadlockRetryHttpTests` (29 cases; a `DbCommandInterceptor` raises a real
  40P01 / 40001 once, twice, then past every retry; each asserts one booking or block, one charge, one audit row, equal
  balances) and `R16WalkUpDeadlockHttpTests` (a real 40P01 on twin walk-ups).
- **Between attempts the change tracker is restored to a mark** (each entry's state, current and original values,
  modified flags; entries the attempt added or loaded are detached), never reloaded. *Why:* callers stage work that
  must commit WITH the unit (the booking row `CreateAsync` adds before `CommitAsync`; the pay-for nonce row and its audit
  row). `ForgetFailedSaveAsync` (detach Added, reload Modified) survives only in the walk-up's outer loop, where it
  replaced a handler that reloaded only the booking and left a light-state row Modified with values never saved.
- **No retry inside somebody else's transaction** (`CurrentTransaction` open → run once): the abort killed the
  caller's transaction and only its owner can restart it. In-memory unit suites run once too.
- **Applied to:** `BookingService.CommitAsync` (locked half `ChargeUnderLockAsync`: member, desk, both bulks, walk-up),
  `ChargeOnActivationAsync`, `CancelAsync`, `VoidUnstartedWalkUpAsync`, `ReinstateAsync`, the narrowing save in
  `NarrowReversedWindowAsync`, `CourtActivationService`'s check-in and repeat-arrival saves (the charge above them has
  already committed and is idempotent), `AdminBlockService` create/lift. The no-show reversal treats an abort as `Lost`, so `/events` re-reads and goes again (3 tries).
- **Known residue:** `ChargeLitCancelledBookingAsync` / `ReduceLitChargeAsync` are ledger-only INSERTs (an abort is a
  503 and an idempotent re-settle); a reinstatement failing past its retries after the narrowing committed is skipped
  by the retry (predates R16).

## Lost optimistic races: decided again (R17)

- **`DatabaseRetry.ReDecideOnLostRaceAsync(db, unit, ct)`** (`:94`) re-runs a unit on `DbUpdateConcurrencyException`,
  up to 3, with no rewind: the unit may already have committed an earlier save (the charge under the payer lock). It
  forgets what the losing attempt added, keeps what the CALLER staged unsaved (a desk change record, a pay-for nonce
  row), and re-reads every tracked booking and
  seat plus any row the attempt changed; a miss rolls back to EF's savepoint without aborting the transaction.
- Applied to `CourtActivationService.ActivateAsync` (every courtside path) and `BookingService.CancelAsync`.
  Activation re-decides only while its booking is still `Booked`; one the sweep settled under an upload goes to
  `/events`' own loop, which REVERSES it (`ConcurrentDecisionTests`). On the second look a lit booking is a repeat
  arrival — only the scanner's seat. *Why:* 5 parallel activations gave 1 OK + 4×500 and lost partners' seat stamps.

## The global net

- **`InternalErrors.Classify` maps `DatabaseRetry.IsLostRace`** (a concurrency exception, 40P01 or 40001) **and any
  escaped 23505**, anywhere in the exception chain, to `503 {"error":"conflict_retry"}` + `Retry-After: 1`, on member
  and device routes alike. *Why 503, not 409:* a box keeps its event on any 5xx, `ApiBreaker` backs off, `/events`
  settles before writing the receipt (the retry re-settles idempotently), and a bulk book dying mid-batch replays by
  its idempotency key.
