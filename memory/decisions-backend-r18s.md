---
name: crusaders-mainframe-decisions-backend-r18s
description: "Round 18 scalability lane: DB pool bounded under Postgres (40), stream reads gated to a fifth of it, no-connection is 503 service_busy, gateway keeps upstream keepalive."
type: decision
last_verified: 2026-10-06
---

# Live decisions: scalability, review round 18 (lane BE18s)

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
  Never 500. Client has no specific copy yet; the generic 503 sentence applies.
- **Gateway upstream keepalive** (`nginx/nginx.conf`): named upstreams `backend_api`/`frontend_spa`
  with `keepalive`, and every proxied location `proxy_http_version 1.1` + `Connection ""`. Without
  it each request spent a port for 60 s in TIME_WAIT (~28k ports) and a device flood made every
  request 502 (errno 99). Pinned by GatewayKeepalivePostureTests.
- **No nginx `limit_req` on /device/** (decided): behind cloudflared/NAT every board shares one
  `$remote_addr`, and all boards share one tenant API key, so neither key partitions per board — it
  would throttle the whole fleet together. The API's per-board limiter is the right place; with
  keepalive it answers a 9k req/s flood 429 while members stay served.

Measurements and the probe live in the lane report, not here.
