---
name: crusaders-mainframe-decisions-attendance-r19
description: "Round 19 (lane BE19c): a pay-for payer's scan is nobody's attendance; seatless organiser row reads their own scan; the no-show sweep writes its verdict before its money."
type: decision
last_verified: 2026-10-06
---

# Live decisions: attendance evidence and sweep order, review round 19 (lane BE19c)

- **A payer's scan is not a game's evidence (E19-3).** `bookings.CheckedInAt` is whoever lit the court
  (money rule) and a pay-for payer with no accepted seat is not a player (R18 E18-6), yet attendance rule 2
  counted it: the seatless organiser got a session at the payer's instant and accepted partners who never
  came were credited. Rule now (`Services/Play/PlayerEvidence.cs`, read by `AttendanceQuery.SessionsAsync`):
  - `CheckInIsAPlayersScan`: while `PaidByUserId` is null or the booker, the booking's check-in IS a
    player's scan (only a pay-for payer lights somebody else's court, and paying makes them the payer).
  - Otherwise the game's evidence is players' own scans only: any seat's `CheckedInAt`, or the booker's own
    `court.activated` / seatless `court.checked_in` row (actor = booker, `details.booking_id`; time =
    `ScanAt` for checked_in, `details.occurred_at` for activated), read by the actor index from start − 1 day.
  - Rule 1 (own seat) unchanged. **Rule 2 (walk-behind partners count) is KEPT** but needs a PLAYER's scan:
    payer lights, organiser scans later → organiser AND accepted partner attend from the organiser's scan.
    **Why:** play.md §1 records rule 2 as the founder's default "until the founder says otherwise" (§14 Q4);
    a fix lane does not reverse it. The integrator's brief asked for "own seat only" everywhere — that
    stricter reading is a founder call, flagged in the R19 report, not taken here.
- **Booking page (E19-3):** seatless organiser row `checked_in_at` and `players_checked_in` read one value,
  `PlayerEvidence.SeatlessOrganiserCheckInAsync` (booking check-in if a player lit it, else the booker's own
  scan, else null). Seated games unchanged (each seat prints its own stamp).
- **"Played with" (recent partners, picker tiebreak)** use `PlayerEvidence.CheckedInByAPlayer` (SQL twin:
  player-lit check-in, or any seat stamped). Known gap: a booker's seatless audit-row scan is invisible
  there — harmless, those lists only read games with seats, where the booker's scan stamps seat 1.
- Recompute: the booker's later seatless scan stages no play marker; stats are live (`SessionsAsync`), and
  badges re-evaluate at the session end (PlaySweep re-marks lit bookings at `EndsAt`), so nothing is lost.
- **No-show sweep: cause before money (E19-5).** `NoShowWorker.CauseThenMoney`: the `booking.no_show` row
  is stamped `CreatedAt = ScanAt = now.Storable()`, the refund/penalty ledger rows 1 µs later. **Why:** the
  row took the wall clock at construction, after the sweep instant the money is posted at (R15 D14-4), so
  the Night read refund, penalty, then the no-show. Same rule cancellations keep since R15 E15-4.
- Tests: `R19AttendanceHttpTests` (6 red before the fix: seatless payer only, payer then organiser, partner
  with/without organiser seat, no-show order with and without a partner; 2 controls).
