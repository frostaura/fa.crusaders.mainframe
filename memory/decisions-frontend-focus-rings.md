---
name: crusaders-mainframe-decisions-frontend-focus-rings
description: "Focus seen and kept: a clipping box insets its rings unless it can hold a filled control (then it gives room); every overflow-hidden box is scanned; every paged list hands focus on through one hook."
type: decision
last_verified: 2026-11-20
---

# Live decisions — focus rings in clipping boxes, and paged focus

Guards: `src/clipped-focus-scan.test.ts`, `src/paged-focus-scan.test.ts`. Proof sweeps: `e2e/layout-r16-fe16s.spec.ts`
(always runs now; the `FE16S_SWEEP` switch is gone), `e2e/shell-r17-fe17s.spec.ts`.

- **Any box that clips or scrolls handles the rings inside it** (R15 L15-1 → R16 L16-1): `overflow-hidden`,
  `overflow-clip` and `overflow-x-auto` all clip (x-auto makes y auto), and a sticky head at `<main>`'s top edge is cut
  the same way. A door line focused by "Load older" was clipped before.
- **Inset the ring (`[&_:focus-visible]:-outline-offset-2`) only in a box that holds no filled control; otherwise give
  the outward ring ROOM** (R16 FE16s2). *Why:* in light mode `primary` IS `accent-strong` (navy 700), so a ring drawn
  over a primary button's edge vanishes — measured: the wallet aside's "Buy minutes" keeps a visible outward ring. The
  chart carousel, the admin rail, a court tile's event list and the table frame inset; split-view / with-aside panes
  (`p-1 -m-1 scroll-p-1`), the menu panel (`p-1 scroll-py-1`) and the sheet's header and body (16px gutter, `py-2`,
  `scroll-py-2`) give room. **Room needs scroll padding too** — padding is part of the scrolled content, so a control Tab
  scrolls into view lands flush with the edge unless `scroll-p*` keeps it clear. **Write the room in the same class string
  as the overflow it answers** — the scan reads each string on its own.
- **ScrollArea insets every ring inside it EXCEPT a control that draws its own outline**
  (`[&_:focus-visible:not(.outline)]`): WeekPainter's roving cell sets `outline outline-offset-1`, and inset its ring
  sat on the allowed cell's own inset ring (seen in a screenshot). ScrollArea's and Table's own region ring is the house
  outline inset (`focus-visible:-outline-offset-2`), never `outline-none` + `ring-2` — the shadow ring was cut by the card
  round it, and primitives never add `outline-none` (index.css).
- **The Command root insets its rings; its input takes `-mx-1 px-1`** so the inset ring clears the first letter (nothing
  inside a command is a filled button); a sort button in a clipped head gets `-mx-1 px-1` too.
- **`clipped-focus-scan` counts EVERY `overflow-hidden` box** (R17; it had required `divide-y`, so the combobox's Command
  root cut its input ring 4px). It scans tags AND loose class strings. Boxes that clip but cannot cut a ring live in
  `CLIPS_NO_RING` (`:55`), keyed by file AND a tag fragment, each asserted still present. **`MEASURED_UNCUT`** (`:42`)
  replaced the shrink-only `NOT_YET_INSET` ratchet (empty and gone): AppShell `<main>` (what sticks at its top carries
  `py-2`/`pt-1`) and `ui/dialog` keep the outward ring, each measured 0 cut; an entry whose file stops offending fails the
  guard, so it cannot go stale. Blind spot: an `Interactable` host that HOLDS controls (InviteCard's `CardWithActions`).
- **Every paged list hands focus on through `lib/usePagedFocus(rowSelector, run)`** (R12–R14): count rows at the press,
  focus row `before` after the page's update commits; a page that added nothing and took the button → last row; row
  target = itself if focusable, else its direct-child link, else tabindex −1. *Why:* fixed list by list in R8/R9 and four
  lists still dropped focus to `<body>`. **Enforced by source scan** (R14 X14-1, hardened after review): the handler on any
  interactive element with a paging label (and arrow-named attributes — "Next", "Previous", "Next week") must be bound by
  `const x = usePagedFocus(` in its file, or be a prop every call site passes such a handler (resolved across files);
  copy keys resolve per table via imports; allow-list entries must cite a behavioural test by title (`ALLOWED`:
  Transactions, the Members list, the member picker — [`decisions-admin-focus.md`](decisions-admin-focus.md)). *Why so
  strict:* the first version passed `onOlder={() => …}` because the file called the hook somewhere; the scan now runs
  five in-memory mutations that must go red.
- **Dialogs and editors hand focus back** ([`decisions-admin-focus.md`](decisions-admin-focus.md)); Chromium does not
  scroll a focused `position: sticky` box into view — `lib/revealInScroller` ([`gotchas-frontend-rendering.md`](gotchas-frontend-rendering.md)).
