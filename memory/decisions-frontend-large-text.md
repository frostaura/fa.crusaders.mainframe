---
name: technologies-crusaders-squash-control-system-decisions-frontend-large-text
description: "Screens at 320 px and 200 % text: a name gets a line before it breaks, narrow rows stack by rem container queries, boxes beside words are px, text grids are minmax(0,1fr), overflow-wrap anywhere, every route's skeleton fits."
type: decision
last_verified: 2026-11-20
---

# Live decisions — large text and narrow boxes (rounds 9–19)

The layout primitives and the "measure the box in rem" rule: [`decisions-member-layout.md`](decisions-member-layout.md);
the traps behind these: [`gotchas-frontend-layout.md`](gotchas-frontend-layout.md). "200 %" = `html { font-size: 32px }`.
Sweeps: `e2e/overflow-200.spec.ts` (every route), the L16-3 skeleton sweep (all 31 routes at 320 / 200 %, every run;
its failure names the elements past the edge), `e2e/layout-r14-fe14l.spec.ts` (`FE14L_SWEEP=1` adds a 24-route × 5-size
rail sweep — still opt-in).

- **A name gets a line before it is broken** (R14): Chromium's `hyphens: auto` never splits a Capitalised word
  (re-measured with `lang="en"`), so it is no last resort for surnames; give the name its own line, and on the narrowest
  boxes step the type and inset down. Members cards: `useLongNameCards` measures each name's longest word (canvas, the
  link's font) against the who column's FLOOR (half the card less the avatar) — judging by the current width would flip
  the card back and forth — and sets `data-long-name` (card range only, 20rem to the 48rem table); it re-marks on resize
  AND row insertion (MutationObserver childList, never attributes, so its own toggle cannot loop) — *why:* a search
  swapping a same-size page left a new long row unmeasured. In the pass band from 14 to 21rem the crest and avatar flank
  only the overline and club and the member's name takes the band's width (flanked, 169px at 150 % split
  "Wolfeschlegelstein"); inbox headlines step text-xs < 10rem, sm to 17rem, base above; the account menu identity wraps,
  the address breaking at "@" and dots (`EmailWithBreaks`), and the avatar stands over the words under a 13.5rem row
  (L14-4); a long-name card's columns are `auto · 1fr · auto` so its
  badges wrap in ONE row, and under 13rem the card is `p-2` with the name `text-xs`; the change record under its 12rem
  list box takes `p-2` and `text-xs` names. **The word-split test**: a word may split only when its
  unbroken width (nowrap clone, same font) exceeds the row's content box.
- **Narrow rows stack, by rem container queries** (R9–R18): a seat chip stacks its photo above the name under 16rem of its
  own width (an element cannot container-query ITSELF — the `@container` sits on the parent); the invite facts grid is one
  column under `@[16rem]`; the picker row `@container/row` 15rem; invite list items `@container/card` 17rem; the invite
  page card p-3 under 18rem; game facts lose their box under 13rem; record terms use an `auto` term column on a subgrid
  from 30rem (L15-3, MemberOverview, MemberDoors: every value in one column, the term column as wide as the longest term); under a 14rem box an Alert's mark takes its own line. Facts and figures pair
  from 44rem of `@container/invite`; the invite deep link is `content` width.
- **Boxes beside words at 200 % are px, and step aside in a rem container** (R18 L18-1/3): the sheet tile's racquet box is
  an inline 40 px and hides under a 12rem row; Split inputs are `calc(7ch + 1.5rem)` with the name above under a 16rem
  card; mode toggles `repeat(auto-fit,minmax(min(100%,5rem),1fr))`. `theme-vocabulary` bans arbitrary `w-[…]` and
  `p-[16px]`-style classes outside `components/ui`, so a px/ch width is an inline style. The door card's margin is
  `min(1.5rem,24px,4vw)` (≥ 70 % column at 320/390 · 200 %).
- **Text grids are `grid-cols-[minmax(0,1fr)]`** (R16–R17): `break-words` does not shrink an `auto` track — a long name
  sizes it (picker grids ran 18px past the sheet). **A loading skeleton row:** `min-w-0` on the flexible column,
  `shrink-0` on the fixed avatar, `max-w-full` on any fixed-width bar (not enough alone: a flex column's floor is its
  widest child, so a fixed-rem bar still pushed a 320 / 200 % phone 97px sideways), `minmax(0,1fr)` on a skeleton grid.
- **In a content-sized strip `max-w-full` caps nothing** — cap with `100cqw` (rail cards: the `w-rail-card` token,
  `min(16rem, 100cqw)`, `tailwind.config.ts:87`; the games lists now stack instead and use `min-w-0` items).
- **`overflow-wrap:anywhere`, never `break-all`, in sheets and running text** (R18 L18-5): break-all splits words that fit
  a line. `break-all` survives deliberately on unbroken machine strings — keys, codes, tokens, URLs
  (`DeviceApiKeyPanel.tsx`, `DoorCardSection.tsx`, `AdminWebhooks.tsx`, `Login.tsx`, `Profile.tsx`,
  `ResetPasswordControl.tsx`, `ClubContact.tsx`).
- **Figures stay whole**: a time range is `whitespace-nowrap` ("21:00–21:30" never splits); accept figures nowrap and wrap
  under their term; a figure beside a name wraps UNDER it; icons beside wrapping text are `shrink-0`; segmented links
  never shrink below word + padding (the bar wraps, `WalletNav`); a lone verb's docked bar hugs the verb.
- **A finished game draws only the teams somebody sat on** (R14 L14-2, `PlayerChips.drawnTeams`): cancelled, completed and
  no-show games draw no free seats and no empty team; a lone team takes the block's width, chips two-up from a 32rem
  team box (`@[32rem]/team`); a booked game keeps both teams and free seats. The booking page uses one gap token (`detailLayout.ts`).
- **Traps:** a `//` comment between JSX children paints as text (it shipped once on every accept sheet) — `{/* */}` only;
  arbitrary px spacing is banned outside `components/ui` — use containers.
