---
name: crusaders-mainframe-decisions-shell-r14
description: "R14 FE14l: rail and sticky asides clear the bottom bars; finished games draw only filled teams; long names get a line before a word splits; account menu wraps."
type: decision
last_verified: 2026-10-05
---

# Live decisions — layout, review round 14 (lane FE14l)

Tests: `e2e/layout-r14-fe14l.spec.ts` (68 cases, mobile + desktop; `FE14L_SWEEP=1` adds the
24-route × 5-size rail sweep, green 2026-10-05).

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
  toggle cannot loop): a search swapping a same-size page left a new long row unmeasured.
- **Pass band from 14rem to 21rem: crest and avatar flank only overline and club; the member's name
  takes the band's width** (169px flanked at 150 % split "Wolfeschlegelstein").
- **Inbox headline: text-xs under 10rem, text-sm to 17rem, base from 17rem; Change record under its
  12rem list box: p-2 and names text-xs** — the reviewer's 17-letter surname stays whole at 320 / 200 %.
- **Account menu identity wraps (never truncates); the address breaks at "@" and dots
  (`EmailWithBreaks`); the avatar stands over the words under a 13.5rem row** (L14-4).
- **The word-split test**: a word may split only when its unbroken width (nowrap clone, same font)
  exceeds the row's content box; a 22-letter surname at 320 / 200 % is wider than any row there.
