---
name: crusaders-mainframe-decisions-frontend-bookings-layout-ticker
description: "Bookings after the ticker replaced the rail (PR #12): games lists stack on a phone, the 3xl column hugs the grid, the bar follows the grid in Tab order, pinch zoom stays on, e2e one-tap specs call singleTap."
type: decision
last_verified: 2026-11-20
---

# Live decisions — Bookings after the ticker replaced the rail (PR #12, 2026-11-13)

The rest of the screen's shape: [`decisions-frontend-bookings-layout.md`](decisions-frontend-bookings-layout.md).

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
- **e2e specs of the one-tap path call `singleTap(page)`** (`e2e/fixtures.ts`) after loading `/bookings`, as the unit
  tests call `singleTap()` (`test/bookingsKit.tsx`): it waits for the grid and turns selection mode off from the header.
  Not on a page that draws no grid (a skeleton spec) and not where the spec asserts focus is untouched on load. Now
  that the page scrolls past the grid, the phone's open-at-week scroll has room to act — specs read page scroll
  relative to where the page opened (`e2e/mobile-shell`).
