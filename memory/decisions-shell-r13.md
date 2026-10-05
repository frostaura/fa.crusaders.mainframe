---
name: crusaders-mainframe-decisions-shell-r13
description: "R13 FA13: an admin's tabs join the bar at 61rem from xl, bell grouped with chip and avatar; selects capped to the screen; paged lists all on usePagedFocus; shell copy scanned."
type: decision
last_verified: 2026-10-05
---

# Live decisions — shell, select and paged focus (review round 13, lane FA13)

Tests: `e2e/shell-r13-fa13.spec.ts` (Chromium geometry), `lib/removedDoorName.test.ts`, the three
`*PagedFocus.test.tsx`, `credit-scan.test.ts`.

- **An admin's tabs join the top bar at 61rem of bar content from xl, 44rem below** (L13-3,
  `PrimaryNav` `INLINE.admin`, written `max-xl:@[44rem]/appbar:` + `xl:@[61rem]/appbar:`). *Why:*
  from xl the crest sits over the rail (24vw at large text) and the row wrapped up to 58rem of
  content; the club's name joining the crest at 60rem makes 60–61 the tightest fit. Swept 154 xl
  combinations (1280–1920 px, 16–32 px text, "99+", "208 h 20 min") — all one row. Not per route,
  so the tabs never jump between top and bottom from My Code to the console.
- **Container queries measure the CONTENT box**: a "64rem bar" at 1024 px is 60rem inside its
  2rem gutters. Threshold sweeps record `clientWidth - padding`, not the bar's width.
- **The bell, chip and avatar are one group** (`[data-app-header-actions]`, `ml-auto`): a wrap
  takes all three. The bell pulls back the group's gap on the wide bar (`@[44rem]/appbar:-mr-2`) —
  768 px holds the admin's whole row with ~8px to spare, so every px there is load-bearing.
- **Trap: an arbitrary property in a plain `@[…]/appbar:` variant loses to its base** — Tailwind
  emits `[--x:…]` after the plugin's container rules, so inline tab labels were always 12px. A
  media-stacked variant (`max-xl:@[…]`) DOES win, which is how a refactor silently grew every tab
  8px and wrapped 768. Measure computed styles before and after moving any class.
- **A select's list is capped**: `min(--radix-select-content-available-width, 100vw - 1rem)`, floor
  `min(8rem, 100vw - 1rem)`, options `[overflow-wrap:anywhere]` (L13-1).
- **A removed door is never named by its UUID**: `removedDoorName` ends in `doorDisplayName`;
  `removed_doors` lacks `device_code` (asked of the backend, R13), so today it is "Unnamed scanner".
- **Every paged list is on `usePagedFocus`** (X13-1): Recent alerts, My door history (a page that
  only grew the last collapsed group focuses the last row), My results (the booking link). A row
  whose face is one `[tabindex]` box gives that box.
- **`credit-scan` also reads `index.html` and `public/*.webmanifest|html|js`** (D13-2).
