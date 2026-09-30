---
name: crusaders-mainframe-gotchas-frontend-rendering
description: "Browser rendering traps the unit suite cannot see: forced colours backplate a HighlightText label into invisibility, Chromium won't scroll a sticky header into view on focus, and a fixture field nobody reads."
type: gotcha
last_verified: 2026-09-30
---

# Gotchas — what only a real browser shows (review round 3, lane F4)

- **Forced colours draw a Canvas backplate behind text, so `Highlight` + `HighlightText` on a
  chosen control with `forced-color-adjust: auto` is a BLANK block** — HighlightText on Canvas is
  white on white (black on black in a dark palette). F4-5's fix "passed" because its test compared
  computed styles, which cannot see a backplate. Any chosen state restated as Highlight/HighlightText
  also needs `forced-color-adjust: none` on the element (the week strip and grid cells had it; the
  toggle, tabs, WalletNav and the global `role=tab/option` rule did not). Prove it in pixels:
  `e2e/forced-colors-r3.spec.ts` screenshots the label's text box and reads its luminance range
  back through a canvas (no PNG library in the repo). Under the opt-out, index.css's global rule
  needs an `html` prefix to outrank `data-[state=…]:bg-…` utilities, which would otherwise paint.
- **Chromium does not scroll a `position: sticky` box into view when it takes focus** — a DataTable
  sort header reached by Tab stayed 100 px past the table's edge at 390. Use
  `lib/revealInScroller` (`revealOnFocus`) on anything focusable inside a sticky cell or a chip row.
- **An e2e fixture can feed a field the screen never reads, and the assertion behind an
  `if (await x.count())` then passes on nothing.** `large-text-r2`'s Admin-badge test served
  `monitoring/summary.open.pending_applications`; the badge counts `open` critical + error +
  warning (pending comes from `/admin/members?status=PendingApproval`), so no badge ever rendered.
  Assert the thing is visible before measuring it.
- **200 % text is a 32 px root, and every rem gap, pad and min-width doubles with it.** On a 390
  phone a row of rem gutters around a word leaves the word no room and `break-words` splits it
  ("Overvie/w"). Phone chrome gutters and gaps are pixels; let a count WRAP under its label rather
  than stand beside it as a column.
