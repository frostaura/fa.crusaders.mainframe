---
name: crusaders-mainframe-decisions-admin-layout
description: "R4 form factor (L2): the admin console uses the full frame; Members is a list beside the record; Transactions keeps filters and totals in view with the movement beside the book; rails for alerts, settings, catalogue."
type: decision
last_verified: 2026-10-01
---

# Live decisions — how the admin console uses the screen (review round 4, form factor, lane L2)

Spec: the round's `SPEC.md` §3/§4. Primitives: `components/ui` (`SplitView`, `WithAside`,
`AutoGrid`, `ContextBar`), all decided by their own BOX in rem, never the viewport.

- **The frame is `max-w-page` (120rem) and every admin page is a `full` PageShell.** At 1920 the
  80rem frame left ~225px dead on each side beside a full-bleed app bar (73 % used → 94 %).
- **Members: the record is a CHILD route of the list** (`App.tsx`), so the list stays mounted —
  filters, page and scroll kept. With a member picked, a `SplitView` from a 64rem box (dense list
  28rem, rows ↑/↓ + Enter, `aria-current`); with none, the TABLE, full width — *why:* the table
  carries sort, groups and row actions the dense list cannot. Below 64rem the record alone, as
  before. The URL is the filter on the list; beside a record it is state (`useMembersFilters`), and
  the record's back link returns to the list as it was left (`membersSplit` context).
- **The list draws 50 rows a page ("Show N more")**; every row is still READ (counts are the
  club's). Phone cards are compact (~126px, was 250): 282 members went 72,402px → 6,932px at 390.
- **An application's decision is on the record's header** (Approve/Reject; Approve for a turned-
  down one), not in the ⋯ — the queue is cleared with ↓, Enter, Approve. Same confirm, same
  lost-reply read-back (`MemberActions` `MemberDecision`).
- **V-14:** the address gets its own column only where the table's box is 76rem (2xl beside the
  rail); below it, under the name. Optional cells are `hidden` at 48rem AND at base — CELL makes
  every cell a table-cell from 48rem, and a cell drawn under a hidden header shifted the balance.
- **Transactions:** filters and the four totals are one sticky `ContextBar` (from lg); on a phone
  the filters fold behind one "Filters · range · type" button. From a 72rem box an opened row
  fills a side panel (`WithAside` sheet; `useBoxAtLeast` decides modal sheet vs panel, in rem) and
  ↑/↓ walk the rows in the table's order. LedgerTable's wide-only column is folded from `sm` to a
  64rem TABLE box — never `hidden` on a phone (it hid the movement cell: SPEC §4.1).
- **Rails, from a 64rem box:** Overview's recent alerts, Settings' section index (scroll-spy,
  unsaved dot), Webhooks' variable catalogue (folded below it). Grids by the box: control-board
  tiles 1/2/4 for four courts, never 3 + 1; groups, schedules, boards, doors, courts as AutoGrid.
- **Not built (no data or another lane's file):** the Overview's court-occupancy strip and the
  board's live-event rail; split views for Groups/Schedules/Boards (cards instead); Settings'
  third help column; "show 5 alerts" (`components/notifications`).
