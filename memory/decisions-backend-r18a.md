---
name: crusaders-mainframe-decisions-backend-r18a
description: "Backend round 18 (lane BE18a): seat-act twins answer 200 (dedupe 23505 is 'already said'), accept locks the booking row, cancelled games take no result, organiser told of club cancels."
type: decision
last_verified: 2026-10-06
---

# Live decisions: backend, review round 18 (lane BE18a)

- **A dedupe-key collision is "already said", never a fault** (J18-2/J18-4). `SeatRaces`
  (Services/Players): a 23505 on `booking_participants` = a seat or member really taken →
  `seat_taken`; any other 23505 (`member_notifications`, `admin_notifications` dedupe keys) or a
  version miss = a lost race. `PlayersService.SaveAsync(ct, Landing)` and
  `PlayersAdminService.SaveAndSettleAsync(…, landed, …)` re-read the seat: in the act's target state →
  200 `{participant_id, status}` (the twin moved the shares); else `409 conflict_retry`. *Why:* parallel
  desk accept-on-behalf 500'd on `IX_admin_notifications_TenantId_DedupeKey`; twin declines read
  "That seat was taken".
- **Seat acts are idempotent in their target state:** decline on Declined, withdraw on Withdrawn,
  organiser/desk remove on Removed, desk accept-on-behalf on Accepted, settle-outside on a settled seat
  (J18-3) → 200 and NO writes (no change record, audit, notice; `SettledOutsideAt` keeps its first
  instant). A different state is still refused for what happened (decline after accept = `not_invited`).
- **Accept locks the booking row `FOR NO KEY UPDATE`** after the member and seat advisory locks, before
  reading the booking (J18-5). A cancel landing mid-accept waits; or the accept reads it and answers
  `409 booking_not_open {booking_id}` (was `invite_closed`) with no money moved. *Not* `FOR SHARE`: the
  accept's save updates the booking (play recompute marker) and two shared holders deadlocked upgrading.
- **A cancelled game takes no result** (J18-1). `ResultService.NotRecordableReason` answers
  `cancelled` first (`IsCalledOff`: Cancelled or `CancelledAt` set); record, edit and confirm refuse
  `409 result_not_recordable {reason:"cancelled"}`; dispute and withdraw still work. `PlayRecord.Attended`
  keeps only results on the member's ATTENDED sessions (AttendanceQuery, R17 J17-5), so matches, games,
  form, opponents and result badges share one definition; a since-cancelled result stops counting at once
  (badges already awarded are kept, play.md §3.3).
- **The organiser is told when the club cancels** (J18-9). `ClubCancelNotices.ForOrganiser` via ShareSweep
  (partnered and seatless bookings): `players.game_cancelled`, "The club cancelled your booking on
  {court}, {when}", key `game-cancelled:{booking}:{organiser}`, not mailed. Not for the organiser's own
  cancel, a displacement, or a started game (BookingService's line).
- **`cancelled_share_stands` names who checked in** (E18-2): `CheckedInBy` = `ClubCancelNotices.CheckedInByAsync`
  (seat at the check-in instant, else `court.activated` scanner, else booker) → `checked_in_by_name` /
  `checked_in_by_you`. Duplicates BookingService's private rule; asked BE18b to call this one.
- Asks: BE18s/integrator — global net maps any escaped 23505 to 503 `conflict_retry`; BE18b — reuse the
  scanner rule; FE18m — render `booking_not_open` on accept, `cancelled` result reason.
- Commit 7efaa20f. Tests: `R18PlayersHttpTests.cs` (`R18SeatTwinHttpTests`, `R18AcceptCancelHttpTests`,
  `R18ResultCancelledHttpTests`), 45 cases, real parallel requests plus a `TwinWriter` interceptor that
  runs the twin (HTTP or SQL with lock_timeout) just before our save; 38 red first (7 green = controls
  and the nondeterministic parallel accept-vs-cancel). `PlayResultsHttpTests` S4 case moved to the new rule.
