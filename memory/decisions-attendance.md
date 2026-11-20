---
name: technologies-crusaders-squash-control-system-decisions-attendance
description: "Who attended a game: a player's own scan, or a player's scan lighting the court for its accepted partners; a pay-for payer's scan is nobody's attendance; a cancelled booking is never attended; one checker rule."
type: decision
last_verified: 2026-11-20
---

# Live decisions — attendance evidence (who played)

Money attendance (`CheckedInAt` decides refunds) is CLAUDE.md's invariant; this is what play stats, streaks, badges,
"N checked in", time on court and "played with" count. Rule code: `Services/Play/PlayerEvidence.cs`, read by
`AttendanceQuery.SessionsAsync`. Spec `docs/specs/play.md` §1.

- **`bookings.CheckedInAt` is whoever lit the court** (the money rule) — which may be a pay-for payer who is not a
  player. **A payer with no accepted seat is not a player** (P11: booker or accepted seat; D10 lets a member pay for a
  court they are not on): the session is not on their play record; their Night carries the payment and the scan (R18).
- **A scan stamps only the scanner's own seat** — a payer's seat if they hold one, never the organiser's (R18 E18-6).
  The booker of a seatless game who scans after a payer lit it gets one seatless `court.checked_in` row
  (`SeatCheckIn.StageBookerArrivalAsync`, `participant_id` null), once.
- **The rule** (R19 E19-3): while `PaidByUserId` is null or the booker, the booking's check-in IS a player's scan
  (`CheckInIsAPlayersScan` — only a pay-for payer lights somebody else's court). Otherwise the game's evidence is
  players' own scans only: any seat's `CheckedInAt`, or the booker's own `court.activated` / seatless `court.checked_in`
  row (actor = booker, `details.booking_id`; time = `ScanAt` for checked_in, `details.occurred_at` for activated), read
  by the actor index from start − 1 day. *Why:* counting the payer's scan gave the seatless organiser a session at the
  payer's instant and credited accepted partners who never came.
- **Rule 1 (own seat scanned) and rule 2 (walk-behind partners count) both stand; rule 2 needs a PLAYER's scan**:
  payer lights, organiser scans later → organiser AND accepted partner attend from the organiser's scan. *Why kept:*
  play.md §1 records rule 2 as the founder's default "until the founder says otherwise" (§14 Q4); a fix lane does not
  reverse it. One scan lights the court for everybody, and requiring each partner to scan would punish the ones who
  walked in behind. "Own seat only" is the open founder question ([`questions.md`](questions.md)).
- **A cancelled booking is never attended** (R17 J17-5): `SessionsAsync` drops any booking with `CancelledAt` set, so
  stats, streak, partners, badges, the monthly ring and time-on-court reports agree. *Why:* only the club can cancel once
  someone has checked in, and Profile and reports must not disagree. This REVERSES play.md §1's earlier "a cancellation
  after check-in stops the clock": a club-cancelled session's minutes count nowhere.
- **Time on court is ONE rule on member screens** (R8 E8-4): play.md §1 sessions (booker or accepted partner, minutes
  as the row stands) for `/me/play` and `/reports/me/wallet|daily`. The admin Night's `minutes_on_court` stays
  box-measured and is not shown to members. *Why:* the reports counted own bookings at sold length; a partner read 0
  beside 57 on Profile. `AttendanceEquivalenceTests` pins the query rewrite to the old statement ([`gotchas-perf.md`](gotchas-perf.md)).
- **Booking page:** the seatless organiser row's `checked_in_at` and `players_checked_in` read one value,
  `PlayerEvidence.SeatlessOrganiserCheckInAsync` (booking check-in if a player lit it, else the booker's own scan, else
  null); seated games print each seat's own stamp; "N checked in" counts a seatless booking someone else paid for from
  the organiser's own row only (`SeatCheckIn.AlreadyRecordedAsync`).
- **"Played with" (recent partners, picker tiebreak)** use `PlayerEvidence.CheckedInByAPlayer` (SQL twin: player-lit
  check-in, or any seat stamped); recent partners count only started, checked-in games. Known gap: a booker's seatless
  audit-row scan is invisible there — harmless, those lists only read games with seats, where the booker's scan stamps
  seat 1.
- **Recompute:** the booker's later seatless scan stages no play marker; stats are live (`SessionsAsync`), and badges
  re-evaluate at the session END (`PlaySweep` re-marks lit bookings at `EndsAt`), so nothing is lost.
- **The checker of a started session — one rule** (`ClubCancelNotices.CheckedInByAsync`, which
  `BookingService.CheckedInByAsync` calls, `BookingService.cs:1739-1741`): the seat stamped at `CheckedInAt`, else the
  earliest `court.activated` scanner (jsonb containment), else the booker. It names the scanner in cancel mail, inbox,
  frames and the desk record.
- **Every seat check-in is on the record** (R17 J17-4): `SeatCheckIn.StampAsync` stamps the seat AND stages
  `court.checked_in` (actor = subject = the scanner, `ScanAt` = the scan; details `booking_id`, `participant_id`,
  `organiser_user_id`, `court_number`, `method`, `occurred_at`, `lit_court`, `reversed_no_show`) on a first activation,
  a repeat arrival and a no-show reversal. A booking with no seats writes none.
