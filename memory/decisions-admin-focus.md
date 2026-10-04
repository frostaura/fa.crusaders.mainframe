---
name: crusaders-mainframe-decisions-admin-focus
description: "R8-R12 admin console: editors, Show more (one usePagedFocus hook) and dismissed dialogs hand focus on, never to body; rows step down by rem containers; desk sale states its price."
type: decision
last_verified: 2026-10-03
---

# Live decisions — admin focus and large-text rows (review round 8, lane FC)

Tests: `e2e/admin-r8-fc.spec.ts` (geometry at 200 % text and focus, both measured in Chromium).

- **An inline editor owns focus like a dialog does** (X8-3, `components/admin/useInlineEditorFocus`):
  opening moves focus to its first field unless it already focused itself (the schedule editor's
  heading); closing (Cancel or Save) returns it to the control that opened it, found AFTER the
  re-render by `data-opens-editor` — the opener is usually a fresh element by then. It acts only
  when focus fell to `<body>`, so a save that moved focus on purpose is left alone. Used by Boards'
  two editors, the Packages rail (a phone's sheet does both itself) and Repeating bookings.
- **"Show more" that reveals rows focuses the first revealed row** (X8-4): Members' list or picker
  (its name link) and the Night (`[data-night-row]`, `tabIndex -1`) — `flushSync`, then focus. *Why:*
  the last page takes the button away and focus fell to `<body>`; the next Tab hit the skip link.
- **Retiring a package is a `ConfirmDialog`** (J8-5), not the inline armed confirm: in the rail
  layout's ~100px Actions column its sentence ran eight lines. Focus floors on the page heading.
- **A `DataTable` wider than its box says so** (L8-13): a fade on the side with more plus an sr-only
  sentence, only while columns are out of view. Every Reports table uses `wrapHeaders`, so a sort
  caret sits UNDER its label everywhere on the page (L6-14 / L7-17).
- **Rows wrap by their text, not the viewport** (L8-1): a member's booking row uses real flex bases
  (`flex-[1_1_18rem]`, text `9rem`) instead of `sm:flex-row` + `flex-1`; a Night card is a grid
  (time column + text column) that stacks the time above the text under an 18rem container.
- **A figure in a totals tile binds its units** (L8-7): `KeptMinutes signed`; nowrap buttons that can
  meet a 320 phone at 200 % carry `max-w-full whitespace-normal` (L8-6, L8-10).
- **Trap:** lizard ran a helper placed straight after `useMemberNight` to EOF (CCN 45) with no
  generic or literal to blame; moved to the module's end it scored 3. Check `-w` after every move.

## R9 (lane FB9) — `e2e/admin-r9-fb.spec.ts`, unit tests named per item
- **A list-owned dialog stays mounted while it closes** (X9-1): Retire keeps `{pkg, open}`; unmounting
  on close skipped Radix's close-time focus (focus fell to `<main>`). Dismiss → the row's ⋯ by
  `[data-package-row] button[aria-haspopup=menu]`; success still floors on the heading.
- **Load more / Show more movements** focus the first revealed row (X9-2): `flushSync`, then the
  change record's `li[data-change-row]` (tabIndex −1) / the ledger row's details button, in drawn order.
- **Step down by the row's own rem width** (L9-3, L9-6): door log row grid from `@[30rem]`; stat and
  totals labels keep capitals+tracking only from a `@[7rem]` label box, else sentence case; totals cells
  `px-2` under a 16rem list. Trap: `typography({variant:"overline"})`'s `tracking-overline` outranks a
  later `tracking-normal` (twMerge doesn't know the custom name) — spell the classes out.
- **Packages table beside the editor** (L9-5): Actions never wraps; figure columns `px-2`; "Per hour"
  header wraps by words — 608/608px at 1024/1280.
- **The Night never groups money** (E9-3): wallet strand, ledger source or any amount → own row. A
  device-actor row says "with <subject>'s code, at the board" or "reported by the court's board" (E9-5).
- **A desk sale states its price** (J9-1): `quotedPriceZar` + `zarReceived` always (0 for a gift);
  409 `package_price_changed` patches the item, names old/new price in a standing notice, re-confirm.
  A free package is "Give"/"given" (J9-3). Share legs name whose wallet; a note says shares net to 0 (J9-7).

## R12 (lane FD12) — one paged-list rule; the Night names a reversal's collision
- **Every "Show more"/"Load more" uses `lib/usePagedFocus(rowSelector, run)`** (X12-2): count rows at
  the press, focus row `before` after the page's update commits (a settle tick queued after it); a
  page that added nothing and took the button → last row. Row target: itself if focusable, else its
  direct-child link (inbox), else tabindex −1. Inbox, member Bookings/Doors, Match results, Night,
  Change record. *Why:* fixed list by list in R8/R9 and four lists still dropped to `<body>`.
- **A reversal that collided says so** (E12-4, contract C3): `detail.collision_booking_ids` +
  `collision_from` → "This session overlapped another member's booking on the same court from 18:30,
  so both paid for that time." with a link to `/bookings/<id>`, never the other member's name.
