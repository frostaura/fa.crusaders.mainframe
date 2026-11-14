---
name: crusaders-mainframe-decisions-frontend-bookings-ticker
description: "After the rail went (ticker above the grid, games detail under it, multi-select by default, zoom lock): the lists stack on a phone, the 3xl column hugs the grid, the bar follows the grid in Tab order, My Code keeps the code first, pinch zoom stays on."
type: decision
last_verified: 2026-11-13
---

# Live decisions — Bookings and My Code after the ticker replaced the rail (PR #12, 2026-11-13)

What changed underneath: 0bd13f8 (selection mode ON by default), 0c8fdc0 (the rail and its sideways
games strip replaced by `UpcomingTicker`; My Code's checklist, use line and guide moved behind a help
icon), 014aa22 (the games detail back, UNDER the grid), fd8071a (viewport zoom locked). All four merged
while CI's frontend unit shards were red, so e2e never ran on them; PR #12 found and fixed what follows.

- **The games lists (`gameWhen.ts` `GAMES_LIST`) stack on a phone**, two a row from a 40rem detail
  block, three from 56rem. The old flat row of 16rem cards relied on the strip's own scroller; with
  none around it, it ran 652px off a 390 phone at 200 %. Tests: `e2e/layout-r16-fe16s` L16-5,
  `e2e/member-layout-r4` Bookings sweep.
- **From 3xl the grid column is `w-max` (capped at full)**, so the week strip and picker end where the
  capped grid does — what the rail's grid template did (R5 F5-6). `e2e/bookings-r5` F5-6.
- **The floating selection bar comes straight after the grid in the DOM**, before the detail under it,
  so Tab out of the grid lands on its actions. It is `fixed`; moving it moves nothing on screen.
  `e2e/schedule-grid` "is one tab stop…".
- **The page now scrolls past the grid** (to the detail). Dean's 2026-10 rule is held as: the grid
  fills the first screen and scrolling it never moves the page (`overscroll: contain`). On a phone
  the page opens at the week (`useOpenAtWeek`, R7), which now has room to act — specs read page scroll
  relative to where the page opened. `e2e/mobile-shell`, `e2e/bookings-landing`. **Open for Dean.**
- **My Code: the ticker and the help icon follow the pass, in one row.** In the header the icon gave a
  header the nav hides (`PageNamedByNav`) a row of its own; with the ticker above too, the QR sat 28px
  under a 320×568 fold (D8: the code first). `e2e/my-code` fold test, `e2e/onboarding` opens the icon.
- **Pinch zoom stays on.** fd8071a's `maximum-scale=1, user-scalable=no` failed axe `meta-viewport`
  (WCAG 1.4.4) on every page. The accidental zoom is the double-tap, ended by
  `html { touch-action: manipulation }`; inputs are 16px on a phone. Re-locking means accepting the
  violation in `e2e/admin-alerts` and friends. **Open for Dean.**
- **e2e specs of the one-tap path call `singleTap(page)`** (`e2e/fixtures.ts`) after loading
  `/bookings`, as the unit tests call `singleTap()` (`test/bookingsKit.tsx`). Not on a page that draws
  no grid (a skeleton spec) and not where the spec asserts focus is untouched on load.
