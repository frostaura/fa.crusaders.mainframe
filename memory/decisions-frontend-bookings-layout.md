---
name: crusaders-mainframe-decisions-frontend-bookings-layout
description: "The Bookings screen's shape: the grid carries no price (P13), a phone opens at the week, a Booking-for summary is the member's, too-far-ahead and offline cells drawn as such, lazy parts; the PR #12 ticker in a sibling."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the Bookings screen's shape (rounds 4–7, PR #12)

Reads and behaviour: [`decisions-frontend-bookings.md`](decisions-frontend-bookings.md); sheets:
[`decisions-frontend-book-sheets.md`](decisions-frontend-book-sheets.md). Tests `e2e/bookings-r4|r5|r8-fd1b`,
`pages/bookings-group-price.test.tsx`.

- **The grid carries no price at all** (P13): a booking costs its playing minutes for every member on every court, so no
  cell, header or Book sheet reads a price — not even one an older server still sends in the rules block. It
  SUPERSEDED R5 I5-1's "every price is the payer's group price" (`lib/viewerPrice`, deleted) and R4's group-rate line;
  pinned by `pages/bookings-group-price.test.tsx` with the REAL sheets.
- **A slot past now + the club's `advanceBookingDays` is "Not open yet"** (`CellFacts.notYetOpen`, `too_far_ahead`), for
  the desk too — the API refuses both. Fixtures dated 2030 carry `advanceBookingDays: 3650` (bookingsKit,
  schedule-quota-groups); a new 2030 fixture needs it too. Offline (the phone's copy) a free cell is muted "Free" (V5-8).
  4+ closed rows nothing is booked in fold into one row "00:30–06:00" (`TimeSlice.folded`).
- **Lifting a club hold confirms and takes a required reason** (A5-1, `LiftHoldSheet` → `adminUnblock(id, reason)` →
  `?reason=`); the lift stays optimistic. Booking for a member (`?as=`, A5-9), `DaySummary` shows THEIR spendable,
  named — no Buy minutes (the desk's own shelf would sell to the desk).
- **No `?date=`: the club's today, adopted from the first answer** (R6, `useScheduleDay` `toClubToday`) — a cold start
  had guessed the READER's day (New York at 23:50 UTC opened a UTC club's yesterday). The club's zone is now also kept on
  the phone (`lib/clubZone.ts`, `localStorage` `crusaders.club-zone`, R17; memory only if storage is refused; sign-out
  forgets it; a bad stored zone is ignored), so a cold OFFLINE start formats kept times in the club's zone. A day asked
  for stays.
- **A phone OPENS Bookings at the week** (§4.2, Dean's call R7, `useOpenAtWeek`): `<main>` is scrolled so the day picker
  sits under the app bar (first Book cell 555 → 315 at 390x844); once per visit, never on a re-read, phone width only,
  any date. *Why this, not removal:* nothing is dropped (games, invites, notices one swipe up). It ignores a scroll
  already on `<main>` from the last page (R9 — `<main>` is every page's scroller) and stands down only for a
  wheel/touch/pointer/key on `<main>` before the day draws; focus a person put in `<main>` cancels it; the announcer's
  heading focus (its retries run 5 s) is handed to the chosen day for 6 s (or the "Booking for" bar under `?as=`,
  `tabindex=-1`), and the target is re-pinned for 2 s while header and bar settle (scroll anchoring slid it 19px under the
  bar), until a touch/wheel/key (`useStickyDayStrip.ts` `SETTLE_MS`, `ANNOUNCER_WINDOW_MS`).
- **The ticker replaced the rail** (PR #12) — what it fixed and the e2e `singleTap` rule:
  [`decisions-frontend-bookings-layout-ticker.md`](decisions-frontend-bookings-layout-ticker.md).
- **Open for Dean:** the page now scrolls past the grid to the detail (Dean's 2026-10 rule is held as: the grid fills
  the first screen and scrolling it never moves the page, `overscroll: contain`); re-locking zoom means accepting the axe
  violation.
- **Bookings re-reads what others change** (R4 M4-3, `useScheduleLiveness`): on a wallet-stream move (balance or
  unread; the first figures are a load) and on return to view with a read > 10 s old; a move within 3 s of the page's
  own write is its echo.
- **Day strip and calendar**: day chips are 44px at 320 (`minmax(2.75rem,1fr)`, a row under 310px bleeds ≤12px into the
  gutters; `min-[25rem]:` is NOT emitted with this config's mixed-unit screens — use width maths); the calendar is a fluid
  7-column grid of squares ≤ 56 px, no rem widths; the phone's day strip sticks under the app bar when ≤ 40 % of `<main>`
  and publishes `--day-strip-height`; the grid frame is `relative z-base` so its sticky court header never paints over it.
- **The grid's height** has a 416 px comfort floor (BM-04), capped by the screen between the app bar and docked bars —
  pixels because `schedule-grid-bugs` pins a pixel ceiling (a rem grows with big text); from 1024px the selection bar
  spans the grid frame (V5-10, ActionBar `style`).
- **Lazy parts** (`lazyParts.test`, `walletActivity-lazy.test`): CancelSheet (mounted at first open, idle-fetched once the
  day shows), SplitStep (fetched when a share is asked, `players.paying`), WalletActivity's charts, the desk's "book as"
  picker (`BookAsChoice`; a member's Schedule chunk no longer pulls the combobox / cmdk) — a value import brings them back.
- **Split late cancel toast** subtracts the penalty from a `net_minutes` equal to gross − partners (M5-7) — remove once
  the server's net counts it.
