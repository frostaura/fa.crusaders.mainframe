---
name: crusaders-mainframe-gotchas-frontend-layout
description: "Layout traps measured in Chromium (R3, R4): cn keeps h-touch beside h-auto, text overflow is invisible to rects, a zero flex basis never wraps, 200 % text needs rem container queries."
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
- **For 200 % text, measure the COMPONENT in rem, not the viewport** (R4, lane F2):
  `[container-type:inline-size]` on a wrapper and `[@container(min-width:17rem)]:…` variants follow
  the text size, where `sm:` (640 CSS px) never does. Inbox rows, Profile stats and badges use it.
  Give each width range ONE rule (`_and_(max-width:…)`): two container variants that set the same
  property compete by stylesheet order. Write every class whole — `${WIDE}:col-span-1` built
  from parts is never seen by Tailwind's scanner and emits nothing.
- **A rem-sized badge dot on a px glyph hides it at 200 %** (a 24px dot over a 20px icon).
- **A figure beside a name wraps UNDER it, not squeezes it**: `flex flex-wrap justify-between`
  with `ml-auto` on the figure; a `shrink-0` figure broke names mid-word ("Bon/gani").
