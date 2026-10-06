---
name: crusaders-mainframe-decisions-backend-load-r19
description: "R19 lane BE19L: sharded-run 503s were the test server's 100 slots full of idle pools, not R19 code; test pools release idle in 3 s; a given-back code use is claimed again and held."
type: decision
last_verified: 2026-10-06
---

# Live decisions: backend under load, review round 19 (lane BE19L)

**Root cause of the round-19 shard-3 failures: the test server ran out of connection slots.**
`make test-integration-sharded SHARDS=3` runs ~30 classes at once on ONE Postgres
(`max_connections` 100); every class has its own database, so its own Npgsql pool, and Npgsql keeps
an idle connection 300 s. Sampled: 99 sessions, 68 idle. The registration-cap test then needed 33
at once, 4 were refused `53300` → `503 service_busy` (Retry-After 2), and the walk-up burst lost
10 of 12 the same way. NOT round 19's code: the test's per-request footprint is identical at
07e0d0c6 and at R19 (33 and 13–15 sessions alone); the base run also touched 100 sessions,
2 s after its cap test had finished. R19's extra classes moved WHEN the crowding happened.

- **Test pools give slots back** (`PostgresFixture.ConnectionStringFor`): Connection Idle Lifetime 3 s,
  pruning 1 s. The API's pool is the bounded copy of that string, so it inherits both. Pinned by
  `R19TestServerSlotsTests`. CI shards run one process per server, so CI never saw this.
- **The cap test queues boards honestly**: it counts waiters on THIS lock in THIS database
  (`classid<<32|objid`), re-asks a board refused `service_busy` after Retry-After as a box does, fails
  AT ONCE on any other answer while the lock is held, and fails in 20 s (under the 30 s command
  timeout) naming how far the queue got — never a silent minute then "0 rows, expected 16".
- **The walk-up burst retries only `service_busy`** (≤5, honouring Retry-After). `conflict_retry`
  stays a failure: R16's point is that a lost race is absorbed server-side.

**Two product races found under that load, fixed red-first** (`R19BusyWalkUpHttpTests`):
- *"No connection" is not "nothing ran"*: a request takes a connection per command, so the one
  refused can come after the code's use was claimed. Twins (a box's retry in flight) then raced the
  give-back: a twin whose `ON CONFLICT DO NOTHING` met the row and then read it after it was gone
  answered `409 code_used` for a purchase nobody made. `TryClaimAsync` now claims again (3 tries)
  when the use vanished between insert and read — for every claimant, door and activate included.
- A twin that RE-ENTERED the claim and then bought after the maker gave it back left a purchase
  with no money use (the code could buy again). `MemberCodeService.HoldAgainAsync` re-claims a
  re-entered claim after the walk-up's purchase commits. Pay-for needs none: its DevicePayFor row
  serialises same-nonce twins (InFlight 503) before any claim.
- A single refused connection at ANY point of one walk-up, then the box's retry, is 200 for one
  purchase (swept open-by-open); kept as a regression guard.
