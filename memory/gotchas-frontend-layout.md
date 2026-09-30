---
name: crusaders-mainframe-gotchas-frontend-layout
description: "Layout traps measured in Chromium in review round 3: cn keeps h-touch beside h-auto, text overflow is invisible to element rects, a zero flex basis never wraps, an implicit grid column is floored at its longest word."
type: gotcha
last_verified: 2026-09-30
---

# Gotchas — layout, measured in a real browser (review round 3, lane F3)

- **`cn` (tailwind-merge, unconfigured) does not know `h-touch`**, so `className="h-auto …"` on a
  `md` Button leaves BOTH classes and `h-touch` wins by stylesheet order: wrapped text spilled out
  of a fixed 44px box ("Create a / repeating / booking" over a one-line fill). Use `!h-auto` at the
  call site; the durable fix is teaching `cn` the custom height/size keys (ui lane).
- **Text overflowing its own box is invisible to `getBoundingClientRect` on elements.** A mono
  event name ("booking.late_cancellation") ran 150px past a phone's edge from inside a span that
  measured in bounds, and `<main>` scrolled sideways with no element to blame. Probe TEXT nodes with
  a `Range`, and skip anything under an `overflow-x` ancestor.
- **`flex-1` is a ZERO basis, so the item never wraps to its own line** — it squeezes to a word per
  line beside its sibling (the Night export note at 320). Give it a real basis (`flex-1 basis-60`).
- **An implicit grid column is floored at its longest word**; `grid-cols-1` (minmax(0, 1fr)) is not.
  The Overview's quick-link cards overflowed a phone at 200 % text with only `grid gap-3`.
- **200 % text in e2e is `html { font-size: 32px }`** after navigation; rem floors (`min-w-48`),
  rem bases and fixed two-column grids are what break there — Tailwind's `sm` is still 640 CSS px.
- **A save-bar "covers the field" test must put the field where the bar grows over it**: a filtered,
  short settings page cannot scroll there, so shorten the viewport instead (a resize is also what
  makes the bar re-measure). Seen green on the broken code until it did.
