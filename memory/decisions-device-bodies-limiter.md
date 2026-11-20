---
name: technologies-crusaders-squash-control-system-decisions-device-bodies-limiter
description: "How a board's requests are rate-limited: a per-board device bucket keyed off the body's MAC, ahead of a chained global limiter whose device-only address stage bounds a stolen key over invented MACs."
type: decision
last_verified: 2026-11-20
---

# Live decisions — rate-limiting a board's requests

How the body itself is read: [`decisions-device-bodies.md`](decisions-device-bodies.md). Code: `Security/DeviceRateKey.cs`,
`Program.cs` (`GlobalLimiter`).

- **The device limiter is per BOARD** (R16, `DeviceRateKey`, ahead of `UseRateLimiter`): key `device:{tenant}:{mac}`
  from the first 4 KB of the body, else `tenant:`, else `ip:`; the middleware authenticates the key itself (cached per
  request) — one key lookup per device request before the limiter, bounded by the global per-address ceiling. *Why:*
  the Device scheme is not the default, so `UseAuthentication` never ran it and the limiter partitioned every device
  call by ADDRESS — one board spinning on a 403 (bridge 2.2.5, ~50,000 posts/min live) spent every board's minute AND
  anonymous `/auth/login`. A key holder can spread over invented MACs; that is a stolen key, not this limiter's job.
- **The global limiter is chained** (R17 D17-1, `Program.cs` GlobalLimiter + `DeviceRateKey.BoardOf`): stage 1 by
  member (`user:`, `GlobalPerMinute` 600), else by board when the club key was recognised (`device:{tenant}:{mac}` or
  `tenant:`, also `GlobalPerMinute`), else by address (`ip:`, `GlobalPerIpPerMinute` 6000); stage 2 charges only device
  requests to `device-ip:{address}` (also `GlobalPerIpPerMinute`), everything else a no-limiter partition. Effective
  per-board cap = min(`DevicePerMinute` 120, `GlobalPerMinute` 600). *Why:* a device request carries no member token,
  so it shared the club address's anonymous bucket with every phone behind the router.
- **Why chained rather than plain exemption:** a refusal at stage 1 returns before stage 2 (`CreateChained` stops at the
  first failed lease), so a spinning board spends only its own buckets, while stage 2 keeps R16's bound on a stolen key
  spread over invented MACs (those do 429 the club's other boards — the stolen-key case, never anonymous callers). A
  keyless request at `/api/v1/device` is anonymous traffic (`ip:`). Retry-After survives the chain. No nginx
  `limit_req` on `/device/` ([`decisions-backend-capacity.md`](decisions-backend-capacity.md)).
