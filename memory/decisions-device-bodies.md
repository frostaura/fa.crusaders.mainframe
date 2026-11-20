---
name: crusaders-mainframe-decisions-device-bodies
description: "How the API reads what a board sends: a lenient body reader (bad bytes become U+FFFD, not-JSON is 400 only), saturating time maths, a per-board limiter chained ahead of the address bucket, one injected clock, one restore per boot."
type: decision
last_verified: 2026-11-20
---

# Live decisions — reading a board's requests on the server

The contract is [`decisions-device.md`](decisions-device.md) and the v3 topics; how a board reacts to each answer is
[`decisions-firmware-event-drain.md`](decisions-firmware-event-drain.md). Code: `Endpoints/Device*.cs`,
`Security/DeviceRateKey.cs`. Each rule protects one thing: a board answered 500 retries for ever and trips its breaker.

- **A device body is read by `Endpoints/DeviceBody` (a `BindAsync` on each request record), never the framework
  binder** (R15 D15-1). Invalid UTF-8, and a `\u0000` escape (R16), become U+FFFD and the body is parsed and USED: a
  garbled scan is a code nobody holds, so `/events` receipts it and the drain moves on. Not JSON at all → `400
  malformed_body` plus a server `malformed_body` fault (against the board if the bytes name a registered MAC, else
  folded by code — the key holder chooses the bytes). **Contract with the firmware: a malformed device body is 400
  only, never 401/403/408/429/5xx** — the firmware drops the head event on any other 4xx and its breaker counts only
  no-response and 5xx. A 400 on the batch would have dropped the genuine activations behind it.
- **The fault detail is plain words, the code unchanged** (D16-5): `DeviceBody.ReplacedDetail` ("some characters could
  not be read and were replaced; the rest was read and used"), `NotJsonDetail`, `DeviceEndpoints.VersionTooLongDetail`;
  `DeviceErrorCodes.HeadlineOf(code, detail)` gives the headline on every surface (list, CSV, SSE), so firmware and
  the closed vocabulary do not move. The console keys these constants verbatim ([`decisions-admin-boards.md`](decisions-admin-boards.md)).
- **A diagnostic field never takes a court out of service:** a heartbeat `version` past 32 characters is not stored
  (the row keeps the old one, never a cut string) and the heartbeat is still answered — a 400 heartbeat is a box with
  no roster (the `no_push` precedent). `no_push` / `events_lost` are clamped into int.
- **Arithmetic on a board's numbers saturates** (`Endpoints/DeviceTime`): uptime deltas in decimal, instants clamped to
  `DateTimeOffset.Min/MaxValue`, which every caller already reads as out of range (clock_clamped, unpaired release,
  bounded lit window). Never `AddMilliseconds` on a device number. A saturated `clock_clamped` claim is worded
  (`ClaimedDetail`: `BeyondStorableDetail` / `BeforeStorableDetail`), never "9999-12-31"; a clamp is a future claim or
  one past 30 days, recorded at arrival.
- **The device limiter is per BOARD** (`DeviceRateKey`, ahead of `UseRateLimiter`): key `device:{tenant}:{mac}` from
  the first 4 KB of the body, else `tenant:`, else `ip:`; the middleware authenticates the key itself (cached per
  request). *Why:* the Device scheme is not the default, so `UseAuthentication` never ran it and the limiter
  partitioned every device call by ADDRESS — one board spinning on a 403 (bridge 2.2.5, ~50,000 posts/min live)
  spent every board's minute AND anonymous `/auth/login`. Per-board cap = min(DevicePerMinute 120,
  GlobalPerMinute 600).
- **The global limiter is chained** (R17 D17-1, `Program.cs` GlobalLimiter + `DeviceRateKey.BoardOf`): stage 1 by
  member (`user:`), else by board when the club key was recognised, else by address (`ip:`, GlobalPerIpPerMinute 6000);
  stage 2 charges only device requests to `device-ip:{address}`. A refusal at stage 1 returns before stage 2
  (`CreateChained`), so a spinning board spends only its own buckets, while stage 2 keeps R16's bound on a stolen key
  spread over invented MACs (those do 429 the club's other boards — the stolen-key case, never anonymous callers). A
  keyless request at `/api/v1/device` is anonymous traffic (`ip:`). Retry-After survives the chain. No nginx
  `limit_req` on `/device/` ([`decisions-backend-capacity.md`](decisions-backend-capacity.md)).
- **One body, one board** (R18 D18-5): `DeviceBody.ReadAsync` refuses (`400 malformed_body`) a body whose top-level
  `mac` appears twice (any case) or differs from the MAC the limiter charged. **A body naming two boards is filed
  against neither** (R19 D19-4): `DeviceBody.FileAsync` collects each distinct MAC named (charged MAC, every `"mac"`
  in the raw text, nested too; ≤4) — one → that board; two or more → the club's folded row with
  `"<route>: <detail> (boards named: <mac>, <mac>)"` (lowercase hex), headline `MalformedBodyTwoBoardsHeadline` via
  `DeviceBody.WithoutBoards`. *Why:* filing against the first-named MAC blamed whichever board the regex saw first.
- **One device decision, one clock** (R14 D14-4, R15): `/activate` and pay-for pass `OccurredAt: now`; the device
  routes, `DeviceIdentity`, `MemberCodeService` (a use's `UsedAt` — on the wall clock an offline twin read as a
  forgery), `CourtLightStateService`, `ControlBoardReader` and both workers read the injected `TimeProvider`;
  device-path ledger rows carry `LedgerPosting.At` (`BookingService.PostOnClockAsync`), so `CreatedAt` and `minutes.*`
  `occurred_at` are the act's instant. No device path reads the wall clock.
- **One power-dip restore per boot** (R19 E19-1, `Endpoints/RestoreBoot.cs`): `restored_relays` rides every beat after
  a boot, so a `> 0` re-confirmed and re-served the plan each beat. Boot = server clock − the board's uptime; column
  `devices.RestoreServedBootAt` (migration `AddDeviceRestoreServedBootAt`) keeps the served boot past settlement; settle
  only with `RestoreServedAt` set and the same boot (±3 s); an expectation from an earlier boot is dropped without a
  verdict; out-of-range `restored_relays` (outside 0–255) settles nothing; unknown uptime reads as the same boot.
  Restore rows are about the booking's organiser; the light state's `CausedByUserId` stays the payer.
- **A suspended club's boards hear `403 club_suspended`** (ironclad pass 1), which the firmware reads as out of service
  (a door commits an empty roster) — declared the one other 403 source in `DeviceForbiddenMeansOutOfServiceTests`.
