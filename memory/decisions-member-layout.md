---
name: crusaders-mainframe-decisions-member-layout
description: "R4 form factor (L1): the layout primitives (SplitView, WithAside, AutoGrid, ContextBar) decide by their own box; member screens use the width; one verb docked in thumb reach; traps found on the way."
type: decision
last_verified: 2026-10-03
---

# Live decisions — the layout system and the member screens (review round 4, form factor, lane L1)

Rules: `docs/specs/design-system.md` (Widths, Page shell, "Use the width"). Admin: `decisions-admin-layout`.

- **Every layout decision is a container query on the box it lays out** (`@tailwindcss/container-queries`
  0.1.1, pinned; every PageShell is `@container/page`) — *why:* beside the admin rail and at 200 %
  text a viewport breakpoint lies; rem thresholds also make large text fall back to one column.
- **`narrow` is for single-task forms only** (My results left it in R6). **`wide` takes the 120rem
  frame from 3xl by default** (`fullFrom3xl={false}` opts out; `content` pages opt IN — booking
  detail, How it works, R7 L7-12) and the member app bar is 120rem at 3xl on EVERY page (R6 L6-10)
  — *why:* the bar jumped 320px at 1920, and an 80rem column left a third of the window empty.
- **Large text steps DOWN by rem container queries** (R7): the PageHeader h1 below 16/12rem of
  header (L7-13), the injury pause stacks below 20rem (L7-5); a capped sheet header shows a fade +
  caret while it has more below (L7-14). Inline glyphs are rem-sized (`size="1rem"`, L6-16).
- **One control, one place:** a verb that is docked on a phone (bottom ContextBar: Top up, Invite a
  player, the one invite's Decline · Accept — then its card carries none, R6 L6-13) and inline on a desktop is chosen by `useMediaQuery(lg)`, never drawn
  twice and hidden by CSS — *why:* jsdom sees both (getByRole "multiple elements"), and so does a
  screen reader's element list. Same for the Bookings quota pill: beside the week strip only.
- **A docked bar reserves its own room:** it publishes `--context-bar-height`; `<main>`'s padding,
  the toasts and the booking grid's height budget subtract it. The page's own 64px selection
  padding is gone (it double-counted and pushed the court headers off at the page end).
- **Bookings rail is WithAside `first`:** DOM-first so a phone gets the games strip above the week,
  drawn in the right column from a 72rem page. Game lists step by the RAIL's box (strip → 2 → 3 →
  vertical list); a viewport `md:` lost to the container variants in the cascade.
- **Inbox opens a notice's target in place** (`?n=`; Invites `?seat=`; Profile's tab `?tab=`).
  **R5 X5-3: "in place or go to the page" is the SplitView's OWN measure** (`useSplitLayout`: its box
  against `splitAt` in rem, passed as `layout`), never `useMediaQuery(lg)` — at 200 % text the two
  disagreed and a pick hid the list with no way back. Stacked, rows take the phone's flow; a pick
  still open shows under a back control, focus on its heading; a pick from the bare list is PUSHED,
  switching replaces (`usePickParam`). Picks are announced. Only the picked Inbox row names a
  border class: forced colours (`index.css`) frame every link whose class says "border".
- **An invitee's answer is docked too** (R5 F5): Review your share + Decline, a bottom ContextBar below lg.
- **A no-show and a late cancel show the ledger's own rows** (R5 M5-3/M5-7): charge, refund, penalty,
  shares, cost (optional `money.refunded_credits`/`penalty_credits`, else refund = price and
  penalty = owed when nobody checked in). A no-show's title ends at `sold_ends_at`. Figures never
  wrap mid-value (`dd` nowrap, `keepAmounts` NBSP). A 404 with `?seat=` says "You were taken off".
- **Offline with nothing kept says offline** (R7 X7-3, `shell/nothingKept`): Invites, booking detail, My game — only when the phone reports no network; a dropped connection keeps its retry.
- **Not built:** rail selection dock; docked Record result; bell preselects first unread. Wallet: `decisions-ledger-layout`.

## Traps found
- **Shared grid rows pad each column to the other** (My game's grid areas: 196px blank bands, R6
  L6-18): columns of unequal parts are two flex columns, the DOM following `useSplitLayout`'s measure.
- **The container-queries plugin emits NOTHING for `@[56rem]/name:` before an arbitrary property**
  (`[grid-area:x]`): use `[@container_name_(min-width:56rem)]:[grid-area:x]`. Standard utilities work.
- **`<main>` is the scroller under the app bar:** sticky `top` is from main's edge — `top-0`/`top-6`,
  never the bar's 56px; full-height panes subtract `--app-chrome-height`.
- **`container-type: inline-size` does not trap `position: fixed` children** (Chromium, measured).
- **A skeleton bar with a rem width beside a switch** (`w-48` = 384px at 200 %) pushed a 390 phone
  179px sideways while the switches were read: `min-w-0` on the column, `max-w-full` on the bar.
- **lizard's .tsx lexer runs a function to EOF on a generic it reads as a tag**: `<Columns min=…>`
  (put an attribute before `min`), and `type X = React.ComponentProps<typeof …> & {` after a
  function (dialog.tsx R7: types above every function). Check `python3 -m lizard <file>`'s list.
- **Under load (≥40) lazy-route e2e tests time out on "Opening the page…"**: rerun alone first.
