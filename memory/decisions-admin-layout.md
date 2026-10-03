---
name: crusaders-mainframe-decisions-admin-layout
description: "R4-R5 form factor: full frame; Members beside the record; admin role in row, header and Access tab (one dialog); Transactions totals in view; rails; R5 phone density for Overview, Faults, Boards, schedules."
type: decision
last_verified: 2026-10-03
---

# Live decisions — how the admin console uses the screen (review round 4, form factor, lane L2)

Spec: round 4 `SPEC.md` §3/§4. `components/ui` primitives decide by their own BOX in rem, never the viewport.

- **The frame is `max-w-page` (120rem) and every admin page is a `full` PageShell.** At 1920 the
  80rem frame left ~225px dead on each side beside a full-bleed app bar (73 % used → 94 %).
- **Members: the record is a CHILD route of the list** (`App.tsx`), so the list stays mounted —
  filters, page and scroll kept. With a member picked, a `SplitView` from a 64rem box (dense list
  28rem, rows ↑/↓ + Enter, `aria-current`); with none, the TABLE, full width — *why:* the table
  carries sort, groups and row actions the dense list cannot. Below 64rem the record alone, as
  before. The URL is the filter on the list; beside a record it is state (`useMembersFilters`), and
  the record's back link returns to the list as it was left (`membersSplit` context).
- **The list draws 50 rows a page ("Show N more")**; every row is still READ (chip counts, search
  and sort are the club's — paging on demand waits on F: `status_counts` + server `q`/`sort`).
  **R5 §4.3: a phone card is a 3-column grid, ~72px**: who · balance over status · 44px ⋯ (Top up in it
  below 48rem); applications keep Approve/Reject on a third line. **R7 L7-1: a box under 20rem (320, any
  phone at 200 %) is NARROW** — who on its own line (avatar over name under 13rem), balance, badges, ⋯ beside; cards pair from 41rem.
- **R5 P5: an open record reads no groups, no enrolments** (`enabled`): only the table draws them;
  a deep link read every group's list for nothing. Attention counts: `lib/adminAttention` (arrival =
  the 30 s fresh window; the members loader's pending count is adopted, not re-asked).
- **An application's decision is on the record's header** (Approve/Reject; Approve for a turned-down
  one), not in the ⋯ — the queue is cleared with ↓, Enter, Approve (`MemberDecision`, same confirm).
- **R5 G: the admin role is in THREE places, ONE act** (`AdminRoleDialog`, rule `adminRoleOffer`):
  row ⋯, record header ⋯, Access tab switch — *why:* Dean never found the switch. Locked items (config
  admin; grant to non-active) stay, disabled, reason shown, muted by ink not opacity; none without
  `is_admin`. Redraw from the server's answer only. "Admins" chip filters by ROLE. `e2e/admin-role-r5`.
- **V-14:** the address gets its own column only where the table's box is 76rem (2xl beside the
  rail); below it, under the name. Optional cells are `hidden` at 48rem AND at base — CELL makes
  every cell a table-cell from 48rem, and a cell drawn under a hidden header shifted the balance.
  R5: **no Groups column when nobody on the page is in a group** (9rem of "No groups" beside
  wrapping addresses). §3.8's placeholder pane is NOT built: it would trade the table (sort,
  groups, row actions) for the dense list at xl — a call for Dean, not a lane.
- **Transactions:** filters and the four totals are one sticky `ContextBar` (by room, R5); on a phone
  the filters fold behind one "Filters · range · type" button. From a 72rem box an opened row
  fills a side panel (`WithAside` sheet; `useBoxAtLeast` decides modal sheet vs panel, in rem) and
  ↑/↓ walk the rows in the table's order. LedgerTable's folds and pins: `decisions-ledger-layout`.
- **Rails, from a 64rem box:** Overview's alerts, Settings' index, Webhooks' catalogue; Packages'
  editor from 56rem/20rem (R6 L6-7: 64 was ~1440 px; a 960 box is 1024-1280). Grids by the box: control-board
  tiles 1/2/4 for four courts, never 3 + 1; groups, schedules, boards, doors, courts as AutoGrid.
- **A failed refresh keeps what is on screen** (integrator ask, D's `StaleNotice`): Members (a
  re-read publishes only a WHOLE club), Transactions (same filters only — new filters that fail
  drop the rows, R12), Courts, Webhooks, Settings (and its draft), Schedules (same list only).
- **Not built:** Overview occupancy strip, board live-event rail, Groups/Schedules/Boards split views, Settings' help column.
- **R10 FD10 (200 % text, box in rem, never `sm:`):** ChangeDiff stacks <24rem; door-log filters 3-up ≥34rem; button map `@container/bmap` 20/28rem (model `lib/buttonMap.ts`); GroupCard ⋯ own row <14rem; Night lights name `code_holder`. `e2e/admin-r10-fd`. **R11 FD11:** a board card's and its map panel's insets step down by `@container/boardslot` (<16rem); the map's frame/row inset only from 12rem `bmap`; minutes input `w-16 shrink-0`; door-log bar/triggers use `FILTER_*_INSET`, type steps down <20rem. `e2e/admin-r11-fd` (caret/broken-word probe).
- **R5 (lane E2) — phones and large text.** Overview: 5 alerts, then "See all N" opens the rest IN
  PLACE (there is no alerts page), focus on the first revealed; the Console folds under a 48rem box
  (*why:* it repeats the section switcher; 5,790 → ~2,000px at 390). Faults: text takes the row,
  "Mark resolved" under it; resolving REQUIRES "What did you do?" (`note`, the record's reason).
  Boards: the activity toggle joins the action strip (234 → 186px). Groups `fill="fit"`; archived
  cards muted by surface, never `opacity` (badge fell to 3.24:1). The switcher WRAPS rather than
  break a word; its total wears the header tab's danger fill. Schedules state the rule IN FORCE and
  "From <date> it holds …, instead." per later rule; End counts each date's own weekday; "from this
  date on" can change the days. Tests: `e2e/admin-r5.spec.ts`.
