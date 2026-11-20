---
name: technologies-crusaders-squash-control-system-decisions-device-bodies-clock
description: "Every device path reads the injected TimeProvider, never the wall clock: which record carries the clock on each route and service, and device-path ledger rows stamped at the act's instant."
type: decision
last_verified: 2026-11-20
---

# Live decisions — one device decision, one clock

How a board's body is read: [`decisions-device-bodies.md`](decisions-device-bodies.md). Member-facing create and cancel
keep the wall clock ([`decisions-booking-races-cancels.md`](decisions-booking-races-cancels.md)).

- **One device decision, one clock** (R14 D14-4, R15): `/activate` and pay-for pass `OccurredAt: now` (the instant the
  code was checked). Wiring, per path: `CourtActivationService` reads `ActivationPlumbing.Clock` (optional record param,
  so the DI `TimeProvider`; lights-on duration and the reversal stamp too); `/events` (liveness, the upload `now`, a
  settlement with no scan time) `DeviceEventServices.Clock` (optional, last positional); the heartbeat
  `HeartbeatServices.Clock` (required); the walk-up replay `WalkUpServices.Clock`. `DeviceIdentity` (`ShutHeardAt` /
  `LastSeenAt`), `MemberCodeService` (a use's `UsedAt` — on the wall clock an offline twin read as a forgery),
  `CourtLightStateService` (`UpdatedAt`, the live frame's `at`/countdown), the gate route's resolve,
  `ControlBoardReader`'s snapshot, `BookingService`'s walk-up start and reversal, and both workers take it too;
  device-path ledger rows carry `LedgerPosting.At` (`BookingService.PostOnClockAsync`), so `CreatedAt` and `minutes.*`
  `occurred_at` are the act's instant. No device path reads the wall clock (member create/cancel keep the wall).
