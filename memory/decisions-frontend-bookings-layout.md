---
name: crusaders-mainframe-decisions-frontend-bookings-layout
description: "The Bookings screen's shape: the grid carries no price (P13), a phone opens at the week, the ticker replaced the rail with games under the grid, multi-select by default, too-far-ahead and offline cells drawn as such, pinch zoom stays on."
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
  `?reason=`); the lift stays optimistic. Booking for a member, the rail's wallet is theirs (no Top up).
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
  heading focus goes to the chosen day (or the "Booking for" bar under `?as=`, `tabindex=-1`), re-pinned for 2 s while
  header and bar settle.
- **The ticker replaced the rail** (PR #12, 2026-11-13: `0bd13f8` selection mode ON by default, `0c8fdc0`
  `UpcomingTicker` + My Code's help icon, `014aa22` games detail UNDER the grid, `fd8071a` zoom lock — all merged while
  CI's frontend shards were red, so e2e never ran on them). What PR #12 fixed: **the games lists stack on a phone**
  (`gameWhen.ts` `GAMES_LIST`: a column, two a row from a 40rem detail block, three from 56rem — the flat row of 16rem
  cards ran 652px off a 390 phone at 200 %); **from 3xl the grid column is `w-max`** so the week strip and picker end where
  the capped grid does; **the floating selection bar comes straight after the grid in the DOM** (Tab out of the grid
  lands on its actions; it is `fixed`, so nothing moves on screen); **My Code keeps the code first** (ticker and help icon
  follow the pass in one row — the QR had sat 28px under a 320×568 fold); **pinch zoom stays on** (`maximum-scale=1,
  user-scalable=no` failed axe `meta-viewport`, WCAG 1.4.4, on every page; the accidental zoom is the double-tap, ended
  by `html { touch-action: manipulation }`, inputs 16px on a phone). The player card's guard under default multi-select
  is "nothing chosen yet" (`selection.count === 0`), else no member could open it.
- **Open for Dean:** the page now scrolls past the grid to the detail (Dean's 2026-10 rule is held as: the grid fills
  the first screen and scrolling it never moves the page, `overscroll: contain`); re-locking zoom means accepting the axe
  violation. e2e specs of the one-tap path call `singleTap(page)` after loading `/bookings`.
- **Bookings re-reads what others change** (R4 M4-3, `useScheduleLiveness`): on a wallet-stream move (the first figures
  are a load) and on return to view with a read > 10 s old; a move within 3 s of the page's own write is its echo.
- **Day strip and calendar**: day chips are 44px at 320 (`minmax(2.75rem,1fr)`, a row under 310px bleeds ≤12px into the
  gutters; `min-[25rem]:` is NOT emitted with this config's mixed-unit screens — use width maths); the calendar is a fluid
  7-column grid of squares ≤ 56 px, no rem widths; the phone's day strip sticks under the app bar when ≤ 40 % of `<main>`
  and publishes `--day-strip-height`; the grid frame is `relative z-base` so its sticky court header never paints over it.
- **The grid's height** has a 416 px comfort floor (BM-04), capped by the screen between the app bar and docked bars —
  pixels because `schedule-grid-bugs` pins a pixel ceiling (a rem grows with big text); from 1024px the selection bar
  spans the grid frame (V5-10, ActionBar `style`).
- **Lazy parts** (`lazyParts.test`, `walletActivity-lazy.test`): CancelSheet (mounted at first open, idle-fetched once the
  day shows), SplitStep, WalletActivity's charts, the desk's "book as" picker (`BookAsChoice`; a member's Schedule chunk
  no longer pulls the combobox / cmdk) — a value import brings them back.
- **Split late cancel toast** subtracts the penalty from a `net_minutes` equal to gross − partners (M5-7) — remove once
  the server's net counts it.
