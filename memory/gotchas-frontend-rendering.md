---
name: crusaders-mainframe-gotchas-frontend-rendering
description: "Rendering traps the unit suite cannot see: forced-colours backplates, unscrolled sticky focus, unread fixture fields, inheriting <body> changes, px glyphs and mx-auto at 200 % text."
type: gotcha
last_verified: 2026-10-03
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
  ("Overvie/w"). Let a count WRAP under its label rather than stand beside it as a column; a
  pixel box goes in an inline `style` — `theme-vocabulary` bans `p-[8px]`-style classes outside ui/.
- **Anything a modal sets on `<body>` that INHERITS restyles the whole page** — measured
  2026-09-30 (perf lane) at 56 ms per change at 4x CPU on the Bookings grid, twice per sheet:
  react-remove-scroll-bar's `--removed-body-scroll-bar-size` (a custom property; `index.css`
  registers it `inherits: false` with `@property`) and Radix's `pointer-events: none` (the grid
  declares its own value while a sheet is up). Find these with a trace (`UpdateLayoutTree`
  elementCount ≈ the whole DOM), not by reading code; content-visibility did not help.
- **A Phosphor `size={16}` is a 16px `width` attribute, blind to the reader's text size** (R10 FA10):
  at 200 % the combobox caret, field-error mark, calendar chevrons, time clock and info "i" stayed
  14–20px beside 32px words. In `components/ui/` glyphs are `size="1rem"`/`SCALING_ICON`, menu rows
  size a caller's icon `[&>svg]:size-4`; `scaling-glyphs.test` bans numeric sizes (Avatar exempt).
  A **mixed px/rem control** breaks the same way: the Switch's `w-11` track (88px at 200 %) left its
  px thumb a quarter along when on — all px now. **`mx-auto` floors at 0**: a px-wide child of a
  narrower rem-guttered column hangs off its right side (the pass card, L10-3) — centre it with
  `ml-[calc((100%-W)/2)]`, which may go negative. A row's no-shrink figure + avatar at 200 % squeezed
  combobox names to nothing AND pushed the page sideways: query the row (avatar under 12rem), wrap.
