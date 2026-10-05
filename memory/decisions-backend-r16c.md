---
name: crusaders-mainframe-decisions-backend-r16c
description: "Backend round 16 (lane BE16c): every booking write that can deadlock is retried as one rolled-back unit; an abort that outlives it is 503 conflict_retry with Retry-After, never 500."
type: decision
last_verified: 2026-10-06
---

# Live decisions: backend, review round 16 (lane BE16c)

- **`Persistence/DatabaseRetry.RunAsync(db, unit)` / `SaveAsync(db)`** (moved from `Endpoints/`): a
  unit PostgreSQL aborts with 40P01 or 40001 is run again, up to `Attempts` = 3, after a 5-20 ms
  jittered pause. *Why:* `ck_bookings_no_overlapping_slot` is re-checked on every booking INSERT and
  on any UPDATE that writes a new row version. An overlapping INSERT and UPDATE can each wait on the
  other, and PostgreSQL then aborts one of them. FX16 found this on the walk-up, and every other
  booking write had the same 500.
- **A retried unit is one whose writes all roll back together.** That means one `SaveChanges`, or
  one `PayerLock` transaction. *Why:* that is what makes double-charging impossible. Either the
  attempt committed, and is not retried, or nothing of it exists. Mail, events and outbox publishes
  stay after the commit and are never repeated.
- **Between attempts the change tracker is restored to the mark**, not reloaded. The mark records
  every entry's state, current and original values, and modified flags. Entries the attempt
  added or loaded are detached. *Why:* callers stage work that must commit WITH the unit. Examples
  are the booking row `CreateAsync` adds before `CommitAsync`, and the pay-for nonce row marked
  `Paid` plus its audit row. FX16's `ForgetFailedSaveAsync` (detach Added, reload Modified) would
  have dropped those. It is still used only by the walk-up's outer loop.
- **No retry inside somebody else's transaction**: if `CurrentTransaction` is open, the unit runs
  once. The abort also killed the caller's transaction, and only its owner can start it again.
  The provider is not Npgsql in the in-memory unit suites, and there the unit also runs once.
- **Where it is applied:** `BookingService.CommitAsync` (its locked half is now
  `ChargeUnderLockAsync`: member, desk, both bulks, the walk-up); `ChargeOnActivationAsync` (the
  whole method); `CancelAsync`'s one save; `VoidUnstartedWalkUpAsync`; `ReinstateAsync`; the
  narrowing save in `NarrowReversedWindowAsync`; `CourtActivationService`'s check-in and
  repeat-arrival saves (the charge above them has already committed and is idempotent);
  `AdminBlockService` create and lift. The no-show reversal treats an abort as `Lost`, so the
  `/events` settle loop re-reads and goes again (3 tries).
- **The global net:** `InternalErrors.Classify` maps 40P01/40001 anywhere in the chain to
  `503 {"error":"conflict_retry"}`, with `Retry-After: 1`, on every route. Firmware (`DeviceClient`)
  keeps an event on any 5xx, and `ApiBreaker` backs off. `/events` settles before it writes the
  receipt, so the retry re-settles idempotently. A bulk book that dies mid-batch is replayed by
  its idempotency key.
- **Client words** (`lib/errors.ts` `CONFLICT_RETRY_CAUSE`, `lib/bookingErrors.ts`
  `CONFLICT_RETRY_TEXT`):
  - The message says it was a clash, never "down or restarting".
  - `isDeploymentFault` is false for it, so Try again stays.
  - The booking sentences make no claim about what landed, per F1.1, because a batch may have
    landed some items.
  - The booking sheets still re-read on any 5xx (`outcomeUnknown`).
  - The players screens' own 409 `conflict_retry` wording wins over the generic one.
- **Known residue, not changed:**
  - `ChargeLitCancelledBookingAsync` and `ReduceLitChargeAsync` are ledger-only INSERTs. An abort
    there is a 503 and an idempotent re-settle.
  - `NarrowReversedWindowAsync`'s reinstatements happen after the narrowing commits. If a later
    one fails past its retries, the retry finds the window already narrowed and skips them. This
    behaviour predates the round.
- Tests: `R16DeadlockRetryHttpTests`, 29 cases, all red at dd20d42a. A `DbCommandInterceptor`
  raises a real `PostgresException` 1 or 2 times, then past every retry, for 40P01 and 40001.
  Each case asserts one booking or block, one charge, one audit row, and equal balances.
