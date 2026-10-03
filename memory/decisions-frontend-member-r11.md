---
name: crusaders-mainframe-decisions-frontend-member-r11
description: "Member screens, review round 11 (lane FC11): the chip owns stream movements, a cancel is said once, a gone slot offers Pick another time, share toasts say why, accepted games on the quota banner."
type: decision
last_verified: 2026-10-03
---

# Live decisions — member screens, review round 11 (lane FC11)

Earlier: `decisions-frontend-member-r10.md`, `decisions-minutes-words.md`.
Specs: `e2e/member-r11-fc11.spec.ts`; tests named `*R11*` / `*.r11.test.tsx`.

- **One owner per wallet movement: the chip** (X11-1). `MinutesChip.useClubMovementToast` says
  every movement the stream brought unbidden, worded by the frame's reason; the Wallet page's
  `useMoneyAnnouncement` stands down while the provider's delta is `source: "club"` and says only
  what no frame told the chip (its own Refresh landing a figure the stream missed). *Why:* on
  /wallet one club adjust raised two toasts, "The club added 7 minutes…" and "Xavi added 7…".
- **A cancel from a booking's page is said once — by the Cancel sheet's toast** (X11-2, it carries
  the figures); the page no longer adds "The booking is cancelled." Focus goes to the cancelled
  banner (`[data-cancelled]`, `focusAfterAction`), never `<main>` — the panel unmounts with its trigger.
- **A gone slot is never offered again** (X11-3). After a refusal that proves the slot gone
  (`provesStaleGrid` minus duplicate_request / booking_not_found / block_not_found) the Book sheet's
  primary is "Pick another time" (`BOOK_SHEET_GONE`), focused on mount, closing onto the refreshed grid.
- **"Counts toward your own daily limit" only for a member with one** (J11-3,
  `players/invites/useDailyCap`): read off the game day's grid `rules` (kept, shared with Bookings);
  0/null caps or an unreadable day are no limit — the line is drawn only on a known cap.
- **A package given at no charge is "Given by the club", not "Bought"** (J11-4) — coded to the
  report's optional `given_minutes` (a subset of `top_ups_minutes`); absent, all funding reads
  Bought as before. Server field asked of BE11; types of the integrator.
- **Share toasts say why the share moved** (E11-1): the frame's `share_cause` (+ `share_kept_minutes`
  on a no-show) flows `liveBalance` → `BalanceDelta.shareCause` → `walletCopy.shareRowSentence` /
  `shareMovementPlain`, in the inbox's words ("— the club refunded the session: the court's box was
  offline", "— nobody checked in, and 4 minutes are your part of the no-show penalty", "taken again
  … — the session was attended"). Unknown causes say the old sentence. Ledger rows store no cause,
  so the Wallet's share rows keep their wording (BE11: needs a schema change).
- **The quota banner counts games said yes to** (E11-6): accepted seats (`isMine`, `role: "partner"`)
  fill the cap but are somebody else's booking — all accepted: "Your 4 slots for Saturday are games
  you said yes to … Pick another day."; some: "Cancel one of your own bookings…". The locked cell
  says "you've used your 4 slots", not "booked".
- **L11-4 was the Button primitive** (FA11 e27e7183, buttons wrap): verified at 320/390 with 200 %
  text — docked Invite and Cancel inside; the spec guards it.
