---
name: crusaders-mainframe-decisions-admin-focus
description: "R8 admin console: inline editors and Show-more hand focus on, never to body; Retire asks in a dialog; wide DataTables cue sideways scroll; one caret placement on Reports; rows wrap by their text."
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
