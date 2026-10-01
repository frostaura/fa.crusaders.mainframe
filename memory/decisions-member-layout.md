---
name: crusaders-mainframe-decisions-member-layout
description: "R4 form factor (L1): the layout primitives (SplitView, WithAside, AutoGrid, ContextBar) decide by their own box; member screens use the width; one verb docked in thumb reach; traps found on the way."
type: decision
last_verified: 2026-10-01
---

# Live decisions — the layout system and the member screens (review round 4, form factor, lane L1)

Spec: the round's `SPEC.md` §2/§3/§4; the rules are in `docs/specs/design-system.md` (Widths,
Page shell, "Use the width"). Admin screens: `decisions-admin-layout`.

- **Every layout decision is a container query on the box it lays out** (`@tailwindcss/container-queries`
  0.1.1, pinned; every PageShell is `@container/page`) — *why:* beside the admin rail and at 200 %
  text a viewport breakpoint lies; rem thresholds also make large text fall back to one column.
- **`narrow` is for single-task pages only.** My Code, Inbox, Invites and Profile left it: at 1280
  they used 40 % of the screen; now 75–95 %. Member screens cap at `wide` (80rem); only Bookings
  widens to `page` from 3xl (`fullFrom3xl`) — a booking or a ledger stretched to 1824px reads worse.
- **One control, one place:** a verb that is docked on a phone (bottom ContextBar: Top up, Invite a
  player, Answer this invite) and inline on a desktop is chosen by `useMediaQuery(lg)`, never drawn
  twice and hidden by CSS — *why:* jsdom sees both (getByRole "multiple elements"), and so does a
  screen reader's element list. Same for the Bookings quota pill: beside the week strip only.
- **A docked bar reserves its own room:** it publishes `--context-bar-height`; `<main>`'s padding,
  the toasts and the booking grid's height budget subtract it. The page's own 64px selection
  padding is gone (it double-counted and pushed the court headers off at the page end).
- **Bookings rail is WithAside `first`:** DOM-first so a phone gets the games strip above the week,
  drawn in the right column from a 72rem page. Game lists step by the RAIL's box (strip → 2 → 3 →
  vertical list); a viewport `md:` lost to the container variants in the cascade.
- **Inbox opens a notice's target in place** (`?n=`): a booking via `BookingDetailPanel` (the page's
  body under an h2, its own `@container/page`), an invite via `InviteDetail` (the sheet's flow,
  body and actions). Invites keep the pick in `?seat=`; Profile's tab in `?tab=` (a fragment other
  than `#my-game` opens Account, so My Code's `/profile#door-history` still lands).
- **Not built:** the selection list docked in the Bookings rail; Accept / Record result as the
  docked verb on booking detail; Wallet's 30-day mini totals (a new read); preselecting the
  first unread from the bell; How it works' sticky index; Top up's info aside.

## Traps found
- **The container-queries plugin emits NOTHING for `@[56rem]/name:` before an arbitrary property**
  (`[grid-area:x]`): use `[@container_name_(min-width:56rem)]:[grid-area:x]`. Standard utilities work.
- **`<main>` is the scroller under the app bar:** sticky `top` is from main's edge — `top-0`/`top-6`,
  never the bar's 56px; full-height panes subtract `--app-chrome-height`.
- **`container-type: inline-size` does not trap `position: fixed` children** in Chromium (measured),
  so a docked bar inside a PageShell still docks to the viewport.
- **A skeleton bar with a rem width beside a switch** (`w-48` = 384px at 200 %) pushed a 390 phone
  179px sideways while the switches were read: `min-w-0` on the column, `max-w-full` on the bar.
- **Under load (≥40) Playwright lazy-route tests time out on "Opening the page…"** and look like
  defects; rerun alone before believing one.
