---
name: crusaders-mainframe-gotchas-perf
description: "Backend performance at volume: how the P10 pass measured it, the partial index that could not answer an any-status seat probe, and Postgres JIT adding ~240 ms to a mis-estimated OLTP plan."
type: gotcha
last_verified: 2026-09-29
---

# Gotchas — backend performance at realistic volume

**Measured 2026-09-29 (P10) on this Mac**, API from the Debug build against a scratch copy of the
dev seed plus 500 members, 20,000 bookings (4 courts × 16 slots × 331 days, one in ten the admin's),
30,000 seats (organiser + a partner on half), 50,000 ledger rows and 600 confirmed results; 40
sequential requests after 5 warm-ups, as the seeded admin (the heaviest member, ~2,000 sessions).

| Endpoint | p50 before | p50 after | p95 after |
| --- | --- | --- | --- |
| `GET /me/profile` | 8.7 ms | 6.6 ms | 9.8 ms |
| `GET /wallet` | 12.5 ms | 7.9 ms | 8.9 ms |
| `GET /me/play` | **1,068 ms** | **291 ms** (53 ms with JIT off) | 331 ms |
| `GET /schedule?date=` | 6.3 ms | 6.4 ms | 8.1 ms |
| `GET /admin/members/` (506 rows, 217 kB) | 17.2 ms | 17.8 ms | 19.7 ms |
| `GET /me/play/results` | 4.5 ms | 4.9 ms | 6.5 ms |

- **A partial index cannot answer a query that does not name its predicate.** Play's attendance
  read asks, per candidate booking, for the member's seat "in any status". The only
  `(TenantId, BookingId, UserId)` index on `booking_participants` is partial on the live statuses,
  so Postgres probed `(TenantId, UserId, Status)` instead — every seat the member ever held, once
  per booking: 1.6M buffer hits, O(sessions²). `IX_booking_participants_TenantId_BookingId_UserId_any`
  (migration `AddParticipantBookingUserIndex`) took it to 17.6k. **Check EXPLAIN (ANALYZE,
  BUFFERS) on a heavy member, not a fixture member** — at test volume both plans are instant.
- **Postgres JIT is on in `postgres:16-alpine`, and it is the rest of `/me/play`.** The sessions
  query's `OR EXISTS` shape is estimated at ~11k rows for an actual 1.9k, costed at 693k —
  above `jit_above_cost` and `jit_optimize_above_cost` — so every call compiles: 245 ms with JIT,
  17 ms without. Owed, not done: `-c jit=off` on the compose Postgres (a deployment change) or a
  rewrite of `AttendanceQuery.SessionsAsync` as a UNION of own and seated bookings. JIT output
  does not appear under `EXPLAIN (… COSTS OFF)`; compare with `SET jit = off`.
- **EF logs "Executed DbCommand (n ms)" when the reader opens, not when it drains.** A plan whose
  correlated subplans run per streamed row shows a short command and a long silent gap before the
  next one. Attribute by timestamp (`Logging__Console__FormatterOptions__TimestampFormat`) with
  `IncludeScopes` on, which puts `RequestPath` on every EF line; the workers' queries interleave.
- **Every background worker runs against the scratch database** — there is no switch — and they
  sweep 20k bookings' worth of no-shows and play recomputes on first boot. Measure after they
  settle, never while a test suite shares the CPU (the same endpoint read 5.1 s under load).
- **A perf seed must plant around the dev seeder's bookings**: `ck_bookings_no_overlapping_slot`
  refuses any overlap, and a plain `generate_series` over whole days collides with its 07:00s.
