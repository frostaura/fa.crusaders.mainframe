---
name: technologies-crusaders-squash-control-system-decisions-mail-words
description: "What a member's mail and inbox line must say: court AND day on every line, who acted (the club, never an admin's name), what moved and what stands, a started session's share stands, and figures that agree with their words."
type: decision
last_verified: 2026-11-20
---

# Live decisions — what member mail and inbox lines say

Mail identity, bodies and the outbox are [`decisions-email.md`](decisions-email.md) and
[`decisions-email-outbox.md`](decisions-email-outbox.md); why a share moved is
[`decisions-share-causes.md`](decisions-share-causes.md). A mail is the one surface that leaves the building, so every
rule below came from a mail that told a member something the money did not do.

- **Every figure is whole minutes in words** (`MoneyFormat.Minutes`, `EmailTemplates.Min`); rand only where the member
  paid rand; a package named by its minutes is said once on the PayFast ledger line. Words agree with their figures
  (`Is/Was/Has(n)`; "20 minutes go", "1 minute goes").
- **Court AND day on every line** (R15–R16): `EmailTemplates.CourtOn` = "Court 4 on Tue 13 Oct at 06:00"; no-show,
  reversal and outage-reversal mails take `EmailTemplates.CourtSlot(court, startsLocal)` (subject "… — Court 1 on Tue 13
  Oct at 06:00" and a When row); every share, change and reminder inbox line names court and day; a cancellation mail
  names court AND time (`CancelledSlot`). One club date format, `Services/ClubDate` (`Thu 1 Oct, 10:00` in the club
  zone, the receipt adds the year); historical ledger comments keep the ISO text they were written with.
- **The club's acts are the club's** — a member is told "the club", never the admin's name; a club collect, add,
  removal or accept-on-behalf is the CLUB's doing (`players.club_seat`) with the admin's reason; the collect mail to the
  organiser is the club's; the club-seat mail says a share moves on accept OR a club collect; the revoke mail's reason
  is a labelled fact row; both admin-grant mails carry the required reason; the desk's code reset mails the member
  (`MemberCodeReset`) with its reason.
- **Share subjects and receipts say who and why** (R14–R15): organiser "Share returned to Sam: <why> — Court…";
  withdrawal "Your share came back: you withdrew — Court…"; removal, split and cancel receipts say who, with court and
  day; share mails after a cancel name who cancelled; settle-outside receipts carry the desk's reason
  (`ReconcileOptions.ClubReason`); a re-collection names whose check-in it was (`ScannerName`, `ScannedByReader`); a
  split change to a settled seat says nothing moves and asks no consent (`PlayerNotices.NeedsConsent`); a received
  share's mail says it is HELD and until when.
- **A member off the game is linked to their seat** (R13): `/bookings/{id}?seat={seat}` in share receipts,
  return-waiting and taken-off mails and inbox — the page's `NotOnGame` reads it (chosen over dropping the link).
- **A started session the club cancels** (R14–R17): the booker's mail says "Nothing — the session had started"
  (`CancelledSlot.SessionStarted`) and gets an inbox `players.game_cancelled` (not mailed); a partner who PAID reads "it
  had started, so your share stands"; one who paid nothing reads that nothing moves; the checker is named ("X had checked
  in already" / "You had…").
- **The organiser is told when the club cancels** (R18 J18-9): `ClubCancelNotices.ForOrganiser` via `ShareSweep`
  (partnered and seatless bookings), `players.game_cancelled` "The club cancelled your booking on {court}, {when}", key
  `game-cancelled:{booking}:{organiser}`, inbox only — not for the organiser's own cancel, a displacement, or a started
  game (BookingService's line covers that).
- **The organiser is mailed a decline or withdrawal** (`players.response`, not urgent); a part payment mails only the
  shortfall, subject "paid 6 minutes of their 10 minutes share" ([`decisions-players-acts.md`](decisions-players-acts.md)).
- **Reversals name the scanner** (R12): "Sam Partner checked in after all"; "You were … after all" only to the scanner;
  an outage refund reversed mails `OutageRefundReversed` (no penalty row). A take-back that leaves less than a court says
  so: "That leaves 10 minutes to spend — less than the 15 minutes a court needs" (spendable, not balance, against
  `slice_minutes`; `shortOfCourtLine`).
- **Durations in server prose are words** (R9): headlines, mail facts and new ledger lines say "after 6 minutes",
  "Silent for 12 minutes"; `SpokenUnitsTests` sweeps every `EmailCatalogue` message and every Api source line for
  `{…} min|h|d` (exempt: `MoneyFormat.cs`). Negative minutes in server prose use U+2212 (`MoneyFormat.Minutes`; rand
  untouched — machines read it); the receipt PDF maps U+2212 to `-` because WinAnsi dropped it, turning a debt into a
  balance.
