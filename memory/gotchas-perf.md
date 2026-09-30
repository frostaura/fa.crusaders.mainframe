---
name: crusaders-mainframe-gotchas-perf
description: "Backend performance at volume: how P10 measured it, the partial index that could not answer an any-status seat probe, and JIT on a mis-estimated plan — fixed in code in P12; admin members list is next."
type: gotcha
last_verified: 2026-09-30
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
- **Postgres JIT is on in `postgres:16-alpine`; a mis-estimated OLTP plan pays it per call.**
  `AttendanceQuery.SessionsAsync` was one statement (`booker OR EXISTS seat`, plus correlated
  subqueries): a seq scan estimated at ~11k rows for 1.8k, costed ~615k — past `jit_above_cost`
  (100k) and `jit_optimize_above_cost` (500k) — so every `/me/play` and admin `/members/{id}/play`
  compiled 61 functions: ~240 ms idle, ~1 s at load 20, for a ~30 ms plan. **Fixed in code in P12,
  not in compose** (the stack's Postgres settings are Dean's): the member's seats by
  `(TenantId, UserId, Status)`, then a UNION ALL of own bookings and a semi-join onto seated
  ones, joined in memory. Estimates within ~5%, total cost ~3k, no JIT. A/B on the same seed at
  load ~8: p50 380 → 42 ms, p95 481 → 48 ms (both endpoints); `AttendanceEquivalenceTests` pins
  it to the old statement. **Diagnose with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` and read its
  `JIT` key** — JIT output does not appear under `COSTS OFF`. **The cure is a plan the planner can
  estimate** (no OR across a join, no per-row subplan on a big scan), never a per-query `SET jit`.
- **Next over the line: `GET /admin/members/`** — a per-member correlated ledger `sum`, costed
  ~89k at 506 members and 50k ledger rows; estimates are right, it is simply linear in members
  × ledger, and the ledger only grows. A grouped `sum … GROUP BY "UserId"` join would take it to
  a few thousand. Not JIT-ing yet (P12 scan of the P11/P12 reads found nothing else above ~2k).
- **Perf round (2026-09-30), local stack at load 60-160** — latency is noise there; count
  connection opens instead (`qcount.mjs`): book 25 → 17 (pre-handler 4 → 1), book with two
  players 47 → 20, decline 25 → 22. Gzip: entry JS 715 → 216 KB, ledger 276 → 31 KB, members
  110 → 24 KB. Paging (`cursor=`) cuts both to one page; the member list is still 217 rows unpaged.
  Decisions: [`decisions-perf.md`](decisions-perf.md).
- **EF logs "Executed DbCommand (n ms)" when the reader opens, not when it drains.** A plan whose
  correlated subplans run per streamed row shows a short command and a long silent gap before the
  next one. Attribute by timestamp (`Logging__Console__FormatterOptions__TimestampFormat`) with
  `IncludeScopes` on, which puts `RequestPath` on every EF line; the workers' queries interleave.
- **Every background worker runs against the scratch database** — there is no switch — and they
  sweep 20k bookings' worth of no-shows and play recomputes on first boot. Measure after they
  settle, never while a test suite shares the CPU (the same endpoint read 5.1 s under load).
- **A perf seed must plant around the dev seeder's bookings**: `ck_bookings_no_overlapping_slot`
  refuses any overlap, and a plain `generate_series` over whole days collides with its 07:00s.
