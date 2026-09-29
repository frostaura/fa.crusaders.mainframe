---
name: crusaders-mainframe-gotchas-clock
description: "Clock traps: red in the last half-hour of a UTC day, a code step crossed mid-test, a zone-less member payload read in the phone's zone. Cold entry points carry the club timezone; Playwright runs in New York."
type: gotcha
last_verified: 2026-09-29
---

# Gotchas — the wall clock as a hidden test input

- **The suite cannot pass in the last ~30 minutes of a UTC day.** Six tests go red together — one
  in `WalkUpBookingTests` and five in `DeviceEventHttpTests` — all from one cause: a 30-minute
  purchase truncated at the club's midnight close and the pro-rata price that follows. CI is green
  only by the hour it happens to run. **Reproduce a red run on the untouched base commit in a
  second worktree before believing your diff caused it.** Sweeping for these means running under
  several synthetic clocks — and moving the club timezone in the test host alone manufactures false
  failures unless every fixture pinning `"timezone":"UTC"` moves with it.
- **A fixture reset that names a status is racing every worker that changes one.**
  `door_evening.py` cleared the seeded bookings `where "Status" = Booked`; the seeder plants demo
  bookings at 18:00 and 19:00 local and `NoShowWorker` sweeps every 30 s, so an evening starting
  just after either hour found one already `NoShow` with `EndsAt` truncated. Two lanes hit it the
  same day from opposite sides: `ck_bookings_no_overlapping_slot` excludes `Cancelled` and
  **nothing else**, so D8's back-shift over the slot was refused (one step red, four behind it);
  and `GateAccess.HoldsALiveBookingAsync` counts `Booked`, `NoShow` and `Completed`, so the
  survivor granted the member the RELIEF and a deliberately-`too_early` code opened (five red
  across D5, EDGE, POL, D10, D11). The reset clears every status; the rule is in
  [`decisions-gate-access.md`](decisions-gate-access.md). **A test that books relative to `UtcNow`
  inherits the wall clock as a hidden input.**
- **A test booking `UtcNow.AddHours(3)` fails every afternoon.** The fixture's peak window is
  16:00–19:00 UTC and a Regular member may not take a peak slot that far ahead, so a cancellation
  test throws `PeakHoursLeagueOnly` and reads as a broken refund path. `BookableSlot()` steps clear
  of the window; `BookableSlotFrom(now, hours)` exists so a fix is tested at all 24 hours.
- **Some tests cannot fail on this Mac, by construction.** `DateTimeOffset.UtcNow` here always
  lands on a 100 ns boundary, so a sub-microsecond remainder that survives differently through
  Postgres on Linux cannot arise locally — one test was red on five CI runs at four different hours
  and green here every time. Diagnosing it needs the CI log and a deliberately tick-offset fixture,
  not another local run. **`-v q` suppresses the assertion message in CI**, leaving only `[FAIL]`
  and a name; pass `-v n` when a CI-only failure has to be read rather than guessed.
- **A member-code test that builds a code and then sends it races the 30 s step.** A ±1 offset
  becomes ±2 when a boundary falls between (CI run of 2026-09-29, `offset: -1`). The door,
  activation and pay-for take their instant from the DI `TimeProvider`; a test passes
  `MemberCodeClub.Wired(…, clock)` with a `PinnedClock` and builds with `Code(…, at: clock.Now)`.
  A test about something other than the club's midnight seeds `MemberCodeClub.SettingsAtNoon()`
  (an `Etc/GMT±N` zone at local noon). **Still open:** the UTC-club midnight-close family in
  `WalkUpBookingTests`/`DeviceEventHttpTests` (bullet one) — it needs every fixture's clock moved.
- **Every member payload that is a cold entry point carries the club's `timezone` at top level;
  Playwright's browser runs in `America/New_York`.** The client learns the zone from any
  top-level `timezone` and until then formats in the reader's zone. The booking detail carried
  none, so "Court 1 · 18:00" read 16:00 on a UTC runner and right on this SAST Mac (CI run
  36532040584). `/me/profile` (read at boot), the booking detail, `/invites/{token}`,
  `/me/invites` and `/me/notifications` now carry it. The browser zone is neither the club's
  nor UTC, so a zone-less screen cannot coincide with the right answer; spec processes run in
  UTC. An expectation built from a `lib/` formatter must pass `CLUB_ZONE` (`e2e/playersKit`).
