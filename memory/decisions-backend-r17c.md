---
name: crusaders-mainframe-decisions-backend-r17c
description: "Backend round 17 (lane BE17c): 'stands' only to a partner who paid; cancelled games ask nothing; paid by hand says what came back; member_ref; attended excludes cancelled; Night seat acts."
type: decision
last_verified: 2026-10-06
---

# Live decisions: backend, review round 17 (lane BE17c)

- **"Your share stands" only to a partner who paid one** (E17-2). On a started game the club cancels, the
  `cancelled_share_stands` frame, the inbox ending and the mail's "stands" go only to a live seat with
  `PaidAsync > 0`. Paid 0 (desk accept, consent 0; an unanswered invite) reads "it had started, but you had paid
  no share, so nothing moves" (`GameCancelledPayload.PaidNoShare`). *Why:* the partner had paid nothing.
- **A cancelled game asks nobody for anything.** `ShareLedger.UnpaidAsync` treats a Cancelled booking as
  closed, even with `evenIfClosed`. `PlayerNotices.NeedsConsent(booking, seat)` is false on a cancelled game.
  There is no single-argument overload any more, so a caller cannot forget the booking. Reconcile's own
  `IsClosed` is NOT changed. *Why:* a cancelled court lit after all still collects partners' shares
  through Owed (ShareRules).
- **Paid by hand says what came back** (L17-8/E17-3). `PlayerNotices.SettledOutsideAsync(..., paidInApp, ct)`:
  the partner gets "— the N minutes you paid in the app go back to you", the organiser "— … go back to them".
  "— nothing moves in the app" stays only when nothing was paid in the app. The mail takes
  `PlayersChange.ReturnedMinutes`. Every server string says "paid by hand" (Night, receipts, mail
  subjects, ShareClause). The exception is `AdminChangeActions.cs:291`, which is not this lane's and
  was asked of BE17b/integrator.
- **Namesakes** (L17-2/J16-3). `member_since` is the CLUB date (`DoorClock.LocalDateOf`, was UTC). New
  `member_ref` on the directory, favourites and recent: `MemberRefs.Of(tenant, user)` is SHA-256 → 20
  bits → 4 Crockford chars. It is never the membership number or contact details. The picker escalates
  month → day → ref among rows it shows together (FE17m).
- **One definition of attended** (J17-5). `AttendanceQuery.SessionsAsync` drops any booking with
  `CancelledAt` set, so stats, streak, partners, badges, the monthly ring and time-on-court reports agree.
  *Why:* only the club can cancel once someone has checked in, and Profile and reports must not disagree (E8-4).
  This REVERSES play.md §1's "a cancellation after check-in stops the clock". A club-cancelled
  session's minutes no longer count anywhere. `PlayStats`/`TimeOnCourt`/`AttendanceEquivalence` tests
  were moved to the new rule; the doc delta was given to the integrator.
- **Night** (J17-4/E17-4/E17-8):
  - BE17b's `court.checked_in` (`TraceKinds.SeatCheckedInAction`) maps to kind `court.checked_in`.
  - It folds when `lit_court` is set, or when the same scanner has a `court.activated` for the booking.
  - The organiser's view reads "Sam checked in at Court 1"; the scanner's reads "Checked in at Court 1
    for Olive's booking" (`TraceFacts.SeatOfName`).
  - `court.lights_on` joins `PartnersViewActions`, but only for an accepted seat or the box payer
    (`PartnerGamesAsync`; lights details are nested, hence `PartnerBookingOf`).
  - New audit rows `players.invited` (organiser → invitee, organiser-made adds only),
    `players.accepted` (a fresh self-accept), `players.declined`. Kinds: `booking.invited|invited_player|accepted|partner_accepted|declined|partner_declined`.
- `BookingCancellation.ReasonOf` reads `reason` first and falls back to `waive_reason`. BE17b's
  E17-7 moved the desk's words; without this, R13's "Reason given by the club" went blank.
- Commit 9488f7fc. Tests: `R17PlayersHttpTests.cs` (`R17ShareWordsHttpTests`, `R17PickerPlayHttpTests`,
  `R17NightHttpTests`), 17 cases; 15 red first, and the 2 green were the controls. R15/R16 word
  tests were moved to "paid by hand" and `member_ref`.
