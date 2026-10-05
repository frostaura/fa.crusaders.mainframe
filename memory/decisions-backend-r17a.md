---
name: crusaders-mainframe-decisions-backend-r17a
description: "Backend round 17 (lane BE17a): device requests leave the anonymous per-address global bucket (per-board then device-only per-address, chained); a saturated clock_clamped claim is worded."
type: decision
last_verified: 2026-10-06
---

# Live decisions: backend, review round 17 (lane BE17a)

- **The global limiter is chained, and a recognised device request never spends the anonymous
  address bucket** (D17-1, `Program.cs` GlobalLimiter + `DeviceRateKey.BoardOf`). Stage 1 partitions
  by member (`user:`, GlobalPerMinute 600), else by BOARD when `UseDeviceRateKey` recognised the club
  key (`device:{tenant}:{mac}` or `tenant:`, also GlobalPerMinute), else by address (`ip:`,
  GlobalPerIpPerMinute 6000). Stage 2 charges only device requests to `device-ip:{address}` (also
  GlobalPerIpPerMinute); everything else is a no-limiter partition. *Why:* a device request carries no
  member token, so it shared the club address's anonymous bucket with every phone behind the router;
  a 2.2.5 box spinning on a 403 (~50,000 posts/min on the live stack) 429'd every other board's
  heartbeat AND anonymous `/auth/login` for the rest of the minute (r17d17/flood-run*.out).
- **Why chained rather than plain exemption:** R16 relied on the per-address ceiling to bound the club
  key spread over invented MACs. Stage 2 keeps that bound for device traffic only. A refusal at stage 1
  returns before stage 2 is asked (`CreateChained` stops at the first failed lease), so one spinning
  board spends only its own buckets. Invented MACs past the device-ip ceiling do 429 the club's other
  boards — that is the stolen-key case, never anonymous callers.
- **A keyless request at `/api/v1/device` is anonymous traffic**: no `BoardOf`, so it spends `ip:` as
  before (guard test). Effective per-board cap is min(DevicePerMinute 120, GlobalPerMinute 600).
- **Retry-After survives the chain**: the 429 from a chained global refusal still carries the header
  (asserted).
- **A saturated `clock_clamped` claim is words, not 9999-12-31** (D17-3, `DeviceTime.ClaimedDetail`):
  `BeyondStorableDetail` "claimed a time beyond what can be stored" (MaxValue) and
  `BeforeStorableDetail` "claimed a time too long ago to be stored" (MinValue); any other claim stays
  `claimed {O}`. The client (`lib/deviceFaultCopy.ts` `claimedLine`) says "The board gave it <when>, so
  it was recorded at the time it arrived instead", recognises legacy saturated instants (9999-12-31T23:59:59
  / 0001-01-01T00:00:00 prefixes), and every fault-detail instant shows its YEAR when it differs from
  the current club year. The `clock_clamped` "means" no longer claims "a few minutes out" — a clamp is a
  future claim or one past 30 days, recorded at arrival.
- Tests: `R17DeviceLimiterHttpTests` (flood: box+gate and box+box, disabled 403 spin and enabled
  heartbeat spin; invented MACs; keyless guard), `R17ClampedClockDetailTests`,
  `deviceFaultCopy.r17.test.ts`. 6/7 backend and 7/8 frontend red before the fix.
