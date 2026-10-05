---
name: crusaders-mainframe-decisions-fx16-r16
description: "R16 FX16: malformed_body copy keyed on the server's plain details with its headline as title; a walk-up that loses a 40P01 deadlock is retried, never a 500."
type: decision
last_verified: 2026-10-05
---

# Live decisions: lane FX16, review round 16

- **`lib/deviceFaultCopy.ts` keys `malformed_body` on the server's constants verbatim**:
  `DeviceBody.ReplacedDetail`, `DeviceBody.NotJsonDetail`, `DeviceEndpoints.VersionTooLongDetail`
  (detail still `<route>: <detail>`). `deviceFaultCopy.r16.test.ts` holds a copy of each, so if the
  server rewords one, that test fails.
- **The server's headline is the title for every kind** (`DeviceErrorCodes.HeadlineOf(code, detail)`
  became variant-aware in d151a964). The client override `GARBLED_BUT_READ` is gone. The client gives
  a title only when a row has no headline, or was filed before d151a964 (`legacy` in `BODY_FAULT`):
  the server's headline for those is the dropped one, which is false for a read-anyway row.
  Pre-fix details (`invalid UTF-8 read as U+FFFD`, `body is not JSON`, `malformed`) stay mapped so
  the history reads without jargon. Version too long: "its record kept the one it had".
- **A walk-up's purchase and its activation are retried on a PostgreSQL abort** (40P01 deadlock,
  40001 serialization), up to 3 attempts (`Persistence/DatabaseRetry`, moved there by BE16c, `DeviceEventEndpoints.SaveAttempts`).
  *Why:* identical walk-up retries in flight together deadlock inside `ck_bookings_no_overlapping_slot`.
  The winner's activation UPDATEs its booking, which makes PostgreSQL check the constraint again for
  the new row version. At the same moment a twin's INSERT of the same slot is checking against that
  row. Each waits on the other, and PostgreSQL aborts one: either the activation save or the twin's
  purchase. Neither was caught, so the box got a 500. Measured before the fix: 1 in 36 loaded class runs, 0 in 80
  standalone runs, so it only showed under load on a warm host. After it: 0 of 32 loaded class runs
  failed, though real 40P01s happened in 4 of them and were absorbed. The DeviceRateKey middleware did not
  cause it. It only shifted the timing by adding one database round trip per device request.
- Between attempts the context is reset to what the database holds: Added entries are detached, and
  Modified or Deleted ones are reloaded. Reloading also replaces the old concurrency handler, which
  only reloaded the booking and left a light-state row Modified with values that were never saved.
  A retried purchase either sells, or the winner's booking refuses it and the nonce replay answers it.
- **The same deadlock shape existed off the walk-up**: any booking INSERT that overlaps a row being
  updated at that moment. BE16c closed it on every booking write, and added the 503
  `conflict_retry` net (see `decisions-backend-r16c.md`). `R16WalkUpDeadlockHttpTests` holds the
  interceptor that raises a real 40P01.
