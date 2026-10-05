---
name: crusaders-mainframe-decisions-backend-r15b
description: "Backend round 15 (lane BE15b): club seat acts are on the record and every Night, share rows say direction and cause off the record, removed_by/added_by_club, member CSV columns, mail wording."
type: decision
last_verified: 2026-10-05
---

# Live decisions — backend, review round 15 (lane BE15b)

Earlier: `decisions-backend-r14b.md`. Tests (each seen red at HEAD 6aaa71b5 first): `R15MailWordsTests`,
`R15PlayersWordsHttpTests`, `R15NightAndCsvHttpTests`.

- **A started session's cancellation: the share stands** (E15-1). `GameCancelledPayload.SessionStarted`
  (booking had `CheckedInAt`); the partner mail (`CancelledGame.SessionStarted`) and inbox line say
  "it had started, so your share stands" — never "comes back … separate receipt".
- **Cause before effect** (E15-4). `ShareSweep.SettleBookingAsync` raises the partners' `players.game_cancelled`
  record + notice BEFORE `ReconcileAsync`. Not in the cancel's own save (that is BookingService, BE15a's),
  but saved before any share row it explains.
- **The club's seat acts are on the record** (E15-3), subject the partner, actor the admin, organiser in
  details (`PlayersService.SeatAuditFor`): `players.settled_outside`, `players.share_collected`
  (`collected_minutes`, in the money's own save), `players.added_by_club` (`accepted`). Night kinds by
  view (`TraceView` Own/Organiser/Partner): partner `booking.share_settled_outside` / `share_collected` /
  `added_to_game`; organiser `booking.partner_share_settled_outside` / `partner_share_collected` /
  `club_added_player` / `club_took_player_off` (admin removal — before, the organiser's Night had nothing);
  admin's own `booking.settled_share_outside` / `collected_share` / `added_player`.
- **A partner's Night carries the club's settlement of the game they paid into** (J15-4): `booking.no_show`
  / `booking.no_show_reversed` on a booking they hold a seat > 1 on (started within 7 days before the
  window) read as `booking.game_no_show` / `booking.game_no_show_reversed`, naming the organiser and scanner.
- **Share rows say direction and cause, read back off the record** (`ShareRowCauses`): the newest act at
  or before the row (+2 s, same-save slack) on THAT seat (a seat act never explains another seat) or its
  booking; collections are `club_collected` (its record), `attended` (after `NoShowReversedAt`) or
  `share_paid`; a return nothing explains is `share_back`. Ledger rows still store no cause (R11). The
  Night ("Paid Olive 16 minutes for their share of Court 1 — the club collected it") and the CSV use it.
- **J15-1**: 404 booking detail and `GET /me/invites/{pid}` carry `removed_by: "club"|"organiser"|null`
  (off the `players.removed` record; null when not removed or pre-R14); invites (list, single, token view)
  carry `added_by_club` (`InvitedByUserId` ≠ organiser, guests never).
- **Member wallet CSV** (E15-10): `created_at,type,amount_minutes,reason,counterparty,cause,done_by,given,
  zar_paid,court,booking_starts_at,related_booking_id`; no `external_reference` (it leaked the tenant id);
  admin `done_by` = "The club"; cells through `CsvCell` (formula-defused); `\r\n` lines.
- **Mail wording** (J15-11/E15-8/J15-9/J15-5): `EmailTemplates.CourtOn` = "Court 4 on Tue 13 Oct at 06:00";
  `Is/Was/Has(n)` agree with the figure; organiser share subjects "Share returned to Sam: <why> — Court";
  withdrawal "Your share came back: you withdrew — Court"; settle-outside receipts carry the desk reason
  (`ReconcileOptions.ClubReason`); a split change to a settled seat says nothing moves and asks no
  consent (`PlayerNotices.NeedsConsent`); a re-collection names whose check-in it was (`ScannerName`,
  `ScannedByReader`). Every share/change/reminder inbox line names court AND day.
