---
name: crusaders-mainframe-decisions-booking-races
description: "Booking writes that race: a deadlocked or serialisation-failed unit is retried whole (3×), a lost optimistic race is decided again, and anything that escapes is 503 conflict_retry with Retry-After, never 500."
type: decision
last_verified: 2026-11-20
---

# Live decisions — booking writes that two requests can race

Member-facing words for these answers: [`decisions-frontend-unknown-outcomes.md`](decisions-frontend-unknown-outcomes.md);
seat acts have their own twin rules in [`decisions-players-acts.md`](decisions-players-acts.md).

## Aborts: retried as one rolled-back unit (R16)

- **`Persistence/DatabaseRetry.RunAsync(db, unit)` / `SaveAsync(db)`** re-runs a unit PostgreSQL aborted with 40P01
  or 40001, up to `Attempts` = 3 (`DatabaseRetry.cs:32`), pausing `Random.Shared.Next(5, 20) * attempt` ms (`:185`).
  *Why:* `ck_bookings_no_overlapping_slot` is re-checked on every booking INSERT and on any UPDATE writing a new row
  version, so an overlapping INSERT and UPDATE can each wait on the other — found on twin walk-up retries (1 in 36
  loaded class runs, 0 in 80 standalone). Every booking write had the same 500.
- **A retried unit is one whose writes all roll back together** — one `SaveChanges` or one `PayerLock` transaction —
  which is what makes a double charge impossible. Mail, events and outbox publishes stay after the commit, never repeated.
- **Between attempts the change tracker is restored to a mark** (each entry's state, current and original values,
  modified flags; entries the attempt added or loaded are detached), never reloaded. *Why:* callers stage work that
  must commit WITH the unit (the booking row `CreateAsync` adds before `CommitAsync`; the pay-for nonce row and its audit
  row). `ForgetFailedSaveAsync` (detach Added, reload Modified) survives only in the walk-up's outer loop.
- **No retry inside somebody else's transaction** (`CurrentTransaction` open → run once): the abort killed the
  caller's transaction and only its owner can restart it. In-memory unit suites run once too.
- **Applied to:** `BookingService.CommitAsync` (locked half `ChargeUnderLockAsync`: member, desk, both bulks, walk-up),
  `ChargeOnActivationAsync`, `CancelAsync`, `VoidUnstartedWalkUpAsync`, `ReinstateAsync`, the narrowing save in
  `NarrowReversedWindowAsync`, `CourtActivationService`'s check-in and repeat-arrival saves, `AdminBlockService`
  create/lift. The no-show reversal treats an abort as `Lost`, so `/events` re-reads and goes again (3 tries).
- **Known residue:** `ChargeLitCancelledBookingAsync` / `ReduceLitChargeAsync` are ledger-only INSERTs (an abort is a
  503 and an idempotent re-settle); a reinstatement failing past its retries after the narrowing committed is skipped
  by the retry (predates R16).

## Lost optimistic races: decided again (R17)

- **`DatabaseRetry.ReDecideOnLostRaceAsync(db, unit, ct)`** (`:94`) re-runs a unit on `DbUpdateConcurrencyException`,
  up to 3, with no rewind: the unit may already have committed an earlier save (the charge under the payer lock). It
  forgets what the losing attempt added, keeps what the CALLER staged unsaved, and re-reads every tracked booking and
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

## Cancels that find the booking not open, and who may cancel

- **Desk:** already cancelled → `409 booking_not_open`; played, no-show or blocked →
  `409 not_cancellable {status: completed|no_show|blocked}`; bulk: NotOpen = already cancelled, NotCancellable = failed row.
- **A member's own booking gets the same two 409s** (R18, replacing R17's 404), a double-tap's losing twin included
  (`BookingService.cs:1472,1702-1707`; `BookingEndpoints.cs:473-474`); a stranger still gets `404 booking_not_found`
  (`:1465`) — a 409 would confirm the id is real.
- **No member self-cancel once checked in** (D15-5): `409 already_checked_in`. *Why:* the refund is 0 after attendance
  and the slot went back on sale, so the club took twice. **The admin route is the club** (J15-2): neither this nor
  `already_started` applies, even on an admin's own booking; a lit started session cancels as `cancelled_no_refund`.
- **Clocks:** member create and cancel read the wall clock (`BookingService.cs:245,319,1476`); every device path reads
  the injected `TimeProvider` ([`decisions-device-bodies.md`](decisions-device-bodies.md)).
