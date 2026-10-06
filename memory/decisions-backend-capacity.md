---
name: crusaders-mainframe-decisions-backend-capacity
description: "Connection capacity (R18 BE18s, R19 BE19L): DB pool bounded under Postgres (40), stream reads gated, no connection is 503 service_busy, gateway keepalive, no nginx limit_req; test pools give slots back."
type: decision
last_verified: 2026-10-06
---

# Live decisions: connection capacity (review rounds 18 and 19, lanes BE18s and BE19L)

**An open SSE stream pins no DB connection** (measured: 500 held 35 s, ≤8 busy). Bus is in-process
fan-out. What hurt was *bursts*: concurrent stream opens and synchronised keep-alive guard reads
(epoch/family cache 15 s < keep-alive 25 s, so every keep-alive misses).

- **Pool bounded** (`Persistence/DatabasePool.cs`): Npgsql default Max Pool Size 100 == Postgres
  default `max_connections` 100, so the API alone could fill the server → `53300 too many clients`.
  Now: connection string's own bound wins; else `Database:MaxPoolSize`; else 40. Why 40: two
  replicas + migrations + an operator still fit under 100.
- **Npgsql pools are keyed by the WHOLE connection string** — the API's pool is the *bounded*
  string's. Anything clearing "the pool for X" must clear `DatabasePool.Bound(X, null)` too
  (PostgresFixture.ClearPools; without it every template clone failed "source database is being accessed").
- **Stream-side reads gated** (`Services/Realtime/StreamDbGate.cs`, singleton, permits = max(2, pool/5)):
  wallet opening frame + every stream guard (wallet + AdminStreamGuard). Admin streams' opening
  frames are not gated (admin-only, few).
- **No connection = `503 {"error":"service_busy"}` + `Retry-After: 2`** (InternalErrors.Classify):
  pool timeout (NpgsqlException wrapping TimeoutException), 53300, 57P03 — wrapped by EF or bare.
  Never 500. The client words it as busy (`decisions-frontend-shell-r18.md`).
- **"No connection" is not "nothing ran"** (R19): a request takes a connection per command, so the
  refused one can come after part of the request committed. Every retried path must replay, never
  assume a clean slate — the code-use races this exposed are in `decisions-member-code-backend.md`.
- **Gateway upstream keepalive** (`nginx/nginx.conf`): named upstreams `backend_api`/`frontend_spa`
  with `keepalive`, and every proxied location `proxy_http_version 1.1` + `Connection ""`. Without
  it each request spent a port for 60 s in TIME_WAIT (~28k ports) and a device flood made every
  request 502 (errno 99). Pinned by GatewayKeepalivePostureTests.
- **No nginx `limit_req` on /device/** (decided): behind cloudflared/NAT every board shares one
  `$remote_addr`, and all boards share one tenant API key, so neither key partitions per board — it
  would throttle the whole fleet together. The API's per-board limiter (`decisions-backend-r17a.md`)
  is the right place; with keepalive it answers a 9k req/s flood 429 while members stay served.

## The test server's slots (R19 BE19L)

**Round 19's shard-3 failures were the test server out of connection slots, not R19 code.**
`make test-integration-sharded SHARDS=3` runs ~30 classes at once on ONE Postgres
(`max_connections` 100); each class has its own database, so its own pool, and Npgsql keeps an idle
connection 300 s. Sampled: 99 sessions, 68 idle; the registration-cap test needed 33 at once and 4
were refused `53300` → `503 service_busy`. The per-request footprint was identical at `07e0d0c6`;
R19's extra classes only moved WHEN the crowding happened. CI shards run one process per server.
- **Test pools give slots back** (`PostgresFixture.ConnectionStringFor`): Connection Idle Lifetime 3 s,
  pruning 1 s; the API's bounded copy inherits both. Pinned by `R19TestServerSlotsTests`.
- **The cap test queues boards honestly**: counts waiters on THIS lock in THIS database
  (`classid<<32|objid`), re-asks a board refused `service_busy` after Retry-After as a box does,
  fails at once on any other answer, and fails in 20 s (under the 30 s command timeout) naming how
  far the queue got — never a silent minute then "0 rows, expected 16".
- **The walk-up burst retries only `service_busy`** (≤5, honouring Retry-After). `conflict_retry`
  stays a failure: R16's point is that a lost race is absorbed server-side.
