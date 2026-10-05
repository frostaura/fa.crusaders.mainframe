---
name: crusaders-mainframe-decisions-frontend-shell-r16b
description: "R16 FE16s2: clipping boxes inset rings only where no filled control can sit; elsewhere they give the ring room; the clipped-focus ratchet is empty; every route's skeleton fits 320/200%."
type: decision
last_verified: 2026-10-05
---

# Live decisions — focus rings in clipping boxes, skeleton sweep (review round 16, lane FE16s2)

- **Inset a ring (`[&_:focus-visible]:-outline-offset-2`) only in a box that holds no filled
  control.** In light mode `primary` IS `accent-strong` (navy 700): a ring drawn over a primary
  button's edge vanishes. So the chart carousel, the admin rail, a court tile's event list and
  the table frame inset; the boxes that can hold a primary button give the outward ring ROOM
  instead — split-view / with-aside panes (`p-1 -m-1 scroll-p-1`), the menu panel
  (`p-1 scroll-py-1`), the sheet's header and body (16px gutter, `py-2`, `scroll-py-2`).
  *Why:* measured — the wallet aside's "Buy minutes" keeps a visible outward ring.
- **Room needs scroll padding too.** Padding is part of the scrolled content: a control Tab
  scrolls into view lands flush with the scrollport edge unless `scroll-p*` keeps it clear.
- **Write the room in the same class string as the overflow it answers** (STICKY records,
  the menu's PANEL). `clipped-focus-scan` reads each string on its own; room in a sibling
  string reads as no room.
- **ScrollArea insets every ring inside it EXCEPT a control that draws its own outline**
  (`[&_:focus-visible:not(.outline)]`). WeekPainter's roving cell sets `outline outline-offset-1`;
  inset, its ring sat on the allowed cell's own inset ring and a focused cell looked like any
  other (seen in a screenshot, fixed). ScrollArea's and Table's own region ring is now the house
  outline inset (`focus-visible:-outline-offset-2`), not `outline-none` + `ring-2` — the shadow ring
  was cut by the members card round it, and primitives never add `outline-none` (index.css).
- **`MEASURED_UNCUT` replaces the ratchet.** `NOT_YET_INSET` is empty and gone. Two boxes the scan
  flags keep the outward ring, each measured 0 cut in `e2e/layout-r16-fe16s.spec.ts` ("L16-1
  measured"): AppShell `<main>` (what sticks at its top carries `py-2`/`pt-1`) and `ui/dialog`.
  An entry whose file stops offending fails the guard, so it cannot go stale.
- **A loading skeleton row:** `min-w-0` on the flexible column, `shrink-0` on the fixed avatar,
  `max-w-full` on any fixed-width bar, `grid-cols-[minmax(0,1fr)]` on a skeleton grid. The L16-3
  sweep (all 31 routes at 320 / 200 %) now runs every time; its failure names the elements past
  the edge, not only skeletons.
- **A sort button in a clipped head gets `-mx-1 px-1`**: the inset ring otherwise touches the
  label's first letter.
