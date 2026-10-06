---
name: crusaders-mainframe-decisions-frontend-shell-r13-r14
description: "Shell and layout, R13 FA13 + R14 FE14l: admin tabs join the bar by container width, selects capped, paged lists on usePagedFocus, sticky boxes clear every bar, long names get a line first."
type: decision
last_verified: 2026-10-05
---

# Live decisions — shell and layout (review rounds 13 and 14)

## Round 13 (lane FA13) — shell, select and paged focus
Tests: `e2e/shell-r13-fa13.spec.ts`, `lib/removedDoorName.test.ts`, `*PagedFocus.test.tsx`, `credit-scan.test.ts`.

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
- **Every paged list is on `usePagedFocus`** (X13-1; R14's source scan enforces it, `decisions-frontend-member-r14.md`).
- **`credit-scan` also reads `index.html` and `public/*.webmanifest|html|js`** (D13-2).

## Round 14 (lane FE14l) — layout
Tests: `e2e/layout-r14-fe14l.spec.ts` (mobile + desktop; `FE14L_SWEEP=1` adds the 24-route × 5-size rail sweep).

- **Anything sticky and height-capped subtracts EVERY bar fixed over `<main>`** (L14-1): the admin
  rail, `WithAside`'s aside and `SplitView`'s list cap at `100dvh - --app-chrome-height -
  --app-bottom-bar-height - --context-bar-height`. *Why:* since R13 an admin's tabs drop to the
  bottom bar from xl at large text; the rail still subtracted only the top bar, so Settings and
  Webhooks sat under the tab bar and a click on Webhooks opened My Code.
- **A finished game draws only the teams somebody sat on** (L14-2, `PlayerChips.drawnTeams`):
  cancelled, completed and no-show games draw no free seats and no empty team; a lone team takes
  the block's width, chips two-up from a 32rem team box. A booked game keeps both teams and free seats.
- **Chromium's `hyphens: auto` never splits a Capitalised word** (re-measured R14, `lang="en"` set) —
  so it is no last resort for surnames. The cure is room: give the name a line of its own, and on
  the narrowest boxes (a phone at 200 %) step the type and inset down a size (R11 precedent).
- **Members cards: `useLongNameCards` measures each name's longest word (canvas, the link's font)
  against the who column's FLOOR** (half the card less the avatar) and sets `data-long-name`; such
  a card puts the who across the first line and balance · badges under it. *Why the floor, not the
  current width:* judging by the width it has now would flip the card back and forth. Card range
  only (20rem–table); under 13rem the card is `p-2` and the name `text-xs`. It re-marks on the
  box's resize AND on row insertion (MutationObserver, childList — never attributes, so its own
  toggle cannot loop): a search swapping a same-size page left a new long row unmeasured. A long
  card's columns are `auto · 1fr · auto` so its badges wrap in ONE row (L6-9's 136px cap held).
- **Pass band from 14rem to 21rem: crest and avatar flank only overline and club; the member's name
  takes the band's width** (169px flanked at 150 % split "Wolfeschlegelstein").
- **Inbox headline: text-xs under 10rem, text-sm to 17rem, base from 17rem; Change record under its
  12rem list box: p-2 and names text-xs** — the reviewer's 17-letter surname stays whole at 320 / 200 %.
- **Account menu identity wraps (never truncates); the address breaks at "@" and dots
  (`EmailWithBreaks`); the avatar stands over the words under a 13.5rem row** (L14-4).
- **The word-split test**: a word may split only when its unbroken width (nowrap clone, same font)
  exceeds the row's content box; a 22-letter surname at 320 / 200 % is wider than any row there.
