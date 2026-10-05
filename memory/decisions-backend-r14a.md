---
name: crusaders-mainframe-decisions-backend-r14a
description: "Backend round 14 (lane BE14a): a lit booking holds the court from when it was lit, lit-then-cancelled bookings are cued off, covered reversals send no on, device routes read one clock, pay-for targets the next booking."
type: decision
last_verified: 2026-10-05
---

# Live decisions: backend, review round 14 (lane BE14a)

- **A lit booking holds the court from `min(StartsAt, CheckedInAt)`** (D14-1; refines R13's
  next-free rule). `LightsCueWorker.NextFreeAsync` (now `internal static`, without `now`) reads every
  LIT booking on the court (`CheckedInAt != null`) whose end is past the instant, ordered by when it
  was lit. *Why:* the walk used to read only bookings that had STARTED. A member who scanned in early
  across a gap (A 11:39–11:54, B 11:59 lit at 11:52) was missed, and A's off at 11:54 read B's paid
  session as dark. A scan after the previous end still leaves the gap dark: the off goes out at A's
  end, which is earlier by `occurred_at`.
- **A lit booking that is then cancelled is cued off** (D14-2). The off sweep also closes
  `Cancelled && CheckedInAt != null && LightsOffCuedAt == null` once `EndsAt` (the grant's end; cancel
  never moves it) has passed. It is stamped through the same next-free rule, under `CourtCueLock`,
  and is never promoted and never sent `booking.completed`. A lit cancelled booking is also a
  HOLDER in the walk, because its relay runs on. *Why:* the desk, a member who cancelled an
  early-scanned booking, and the club cancelling a lit walk-up all sent a `lights_on` with no
  `lights_off`. **Bounded to `EndsAt` within `CancelledLitLookback` (2 h)**, filtered in SQL: an
  older lit-cancelled row stays un-cued and is never re-read. Without the bound, the first deploy sent
  every consumer a stale off for each historical row. The sweep's query is a seq scan before and after
  (no index on `EndsAt`/`LightsOffCuedAt`). If it ever matters, the fix is a partial index
  `WHERE "LightsOffCuedAt" IS NULL`, which needs a migration.
- **Reversal on/off are a pair or nothing** (E14-4). `EmitReversedLightsOnAsync` decides under the
  cue lock with `NextFreeAsync`. When a lit survivor holds the court at the restored end, no
  `lights_on` is sent and the booking's `LightsOffCuedAt` is stamped at or after `NoShowReversedAt`,
  so the attended-and-over pass owes no off. *Why:* that on, stamped back at the scan and arriving
  after the survivor's, never got an off (the survivor's off closes the court), so a per-booking
  mirror kept it lit forever. The walk also treats a relit reversal still to be closed (Booked,
  reversed after its old cue) as a holder whose off is still to come. Not fixable at source: the no-show sweep's off was said before the upload reversed it. The
  consumer rule covers it: order by `occurred_at`, and an off that ARRIVED before the on of the same
  booking does not close that on.
- **One device decision, one clock** (D14-4). `/activate` and pay-for pass `OccurredAt: now` (the
  instant the code was checked). `CourtActivationService` reads `ActivationPlumbing.Clock` (optional
  record param, so the DI `TimeProvider`), including the lights-on duration and the reversal stamp.
  `/events` (liveness, the upload `now`, a settlement with no scan time) reads
  `DeviceEventServices.Clock` (optional, last positional; it has 13 deconstruct slots now). The
  heartbeat reads `HeartbeatServices.Clock` (required). The walk-up replay reads `WalkUpServices.Clock`.
  `DeviceIdentity` (a shut board's `ShutHeardAt`/`LastSeenAt`; `ResolveOrRegisterAsync` takes a
  `DeviceCall` bundle), `MemberCodeService` (a use's `UsedAt`, which an offline twin of the same scan
  is matched against: on the wall clock the twin read as a forgery) and `CourtLightStateService`
  (`UpdatedAt`, the live frame's `at`/countdown) take the injected clock too. Still on the wall clock:
  `BookingService` (walk-up start, reversal; asked of BE14b), the gate route's resolve and
  `ControlBoardReader` (asked of the integrator).
- **Pay-for targets the booking about to start** (E14-6, spec §9.2 delta). The candidates are the two
  earliest live member bookings that have started or whose cue window is open. If the earliest is
  running, ends inside the cue window, and a later one has not started, the LATER one is the target
  (quote, confirm, activation). Everything else in §9.2 is unchanged, and so are the LCD and firmware.
  `MemberCodeMoneyFixesHttpTests.A_confirm_pays_only_for…` now runs at cue 0, with the 18:00 booking
  starting at the turn between the presses, to keep its premise. The two writes stay separate saves
  because of the overlap constraint.
- D14-3: the `wrong_court` outcome of a v1 activation upload carries `SubjectUserId`. D14-5:
  `MemberDisplay` trims the end of a hard cut, and it skips JR/JR./SR/SR./JUNIOR/FILHO/NETO/II/III/IV
  (folded and upper-cased) when it picks the surname initial.
- Tests (each seen red first): `R14LightsCueHttpTests`, `R14DevicePathsHttpTests`, `R14MemberDisplayTests`.
