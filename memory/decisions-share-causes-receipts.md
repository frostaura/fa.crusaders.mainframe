---
name: crusaders-mainframe-decisions-share-causes-receipts
description: "What a partner's share receipt says when the club acted: club-refund and no-show-penalty headlines, your share stands only to a partner who paid, a cancelled game asks for nothing, paid by hand."
type: decision
last_verified: 2026-11-20
---

# Live decisions — what a share receipt says when the club acted

How the cause and the actor are decided: [`decisions-share-causes.md`](decisions-share-causes.md). Headlines are built in
`Services/Players/ShareLedger.cs` (`RefundHeadline`, `NoShowHeadline`); the causes in words are
`ShareRefundCauses.Because` (`Email/EmailTemplatesPlayers.cs`).

- **The club refunded the session** (R10 E10-7): `ShareLedger.ClubRefundOf` — outage, displaced, no-show (never after a
  reversal; a collect or removal keeps its own words) — sets `club_refund` on the `players.share_moved` payload and
  mail. Headline: "16 minutes of your share of Court 4, Sun 18 Oct, 12:00 came back — the club refunded the session:
  the court's box was offline" (the organiser's: "… went back to Sam for …"); the court and day were added in R16 E16-4.
- **A no-show return names the penalty part** (R11 E11-2): `kept_minutes` = paid before the return − returned, on the
  headline, mail and payload — "11 minutes of your share of … came back — nobody checked in, and 4 minutes are your
  part of the no-show penalty". *Why:* "The club refunded the session" alone left a partner who paid 15 and got 11
  back with 4 minutes unexplained. A zero penalty keeps the club-refund words.
- **"Your share stands" only to a partner who paid one** (R17 E17-2): on a started game the club cancels, the
  `cancelled_share_stands` frame, the inbox ending and the mail's "stands" go only to a live seat with `PaidAsync > 0`;
  paid 0 reads "it had started, but you had paid no share, so nothing moves" (`GameCancelledPayload.PaidNoShare`).
- **A cancelled game asks nobody for anything** (R17): `ShareLedger.UnpaidAsync` treats a Cancelled booking as closed even
  with `evenIfClosed`, and `PlayerNotices.NeedsConsent(booking, seat)` is false on one (no single-argument overload, so
  no caller can forget the booking). Reconcile's own `IsClosed` is NOT changed: a cancelled court lit after all still
  collects partners' shares through Owed.
- **Paid by hand says what came back** (R17 E17-3): `PlayerNotices.SettledOutsideAsync(…, paidInApp)` — partner "— the
  N minutes you paid in the app go back to you", organiser "— … go back to them"; "nothing moves in the app" only when
  nothing was paid in the app. Every server string says "paid by hand" (`AdminChangeActions.cs:350`).
