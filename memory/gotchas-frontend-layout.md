---
name: crusaders-mainframe-gotchas-frontend-layout
description: "Layout traps measured in Chromium (R3-R4): text overflow is invisible to element rects, a zero flex basis never wraps, implicit grid columns and min-widths beat max-widths at 200 %, ui heights are floors."
type: gotcha
last_verified: 2026-10-01
---

# Gotchas — layout, measured in a real browser (review round 3, lane F3)

- **`cn` (tailwind-merge, unconfigured) does not know `h-touch`**, so `h-auto` beside it left both
  and `h-touch` won ("Create a / repeating / booking" spilled out of 44px). Since R4 Button, Input
  and SelectTrigger carry `min-h-touch`, not `h-touch`; any other `h-touch` still needs `!h-auto`.
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
- **A `min-width` beats a `max-width`** (R4, X4-2): `min-w-48` is 384 px at 200 % text and ran
  the account menu off a 375 phone despite `max-w-[calc(100vw-1rem)]`. Floors on popovers are
  `min(12rem, 100vw-1rem)`; height caps are Radix's `--radix-*-content-available-height` + scroll.
- **Heights are floors in `ui/`** (R4, V4-1): Input, SelectTrigger and Button are `min-h-*` +
  padding (a fixed 44 px box around a 48 px line cut the text). Only a `block` Button wraps; others
  stay `nowrap` (a `shrink-0` + wrap attempt broke callers that opt in with `whitespace-normal`).
  A `Field` is `grid-cols-1` — its implicit column let a password wrapper push the field 36 px out.
- **Never let a chrome BOX grow with the text** (`app-chrome` B12, +45 px max): padding the bell
  for its badge grew the top bar 99 px; cap the badge (`min(1.25rem, 28px)`) instead.
- **A negative margin that grows a target must use `lh`, not rem**: `-my-3` pulled the field
  24 px under "Forgot password?" at 200 %; `min(0px, calc((1lh - 44px) / 2))` is ~0 there.
- **Measure "clipped label" on the `button-label` layer**, not scrollWidth: the hidden pending
  spinner overflows every icon button by a few px and is never seen.
- **A rem `max-width` container query is a large-text query** (R4, lane F3): `[@container(max-width:18rem)]`
  is 288 px at normal text and 576 px at 200 %, so a tile hides (or an avatar stacks) only when the
  TEXT is large for the box — the switcher, the Overview's links, the member header and the app bar
  (R5 `@container/appbar`: tabs inline from 44rem). A query container does NOT trap a fixed child.
- **`auto-fit` cannot collapse a track that a `col-span-full` item spans**: the armed confirm's
  sentence kept three tracks open and the pair took two of three (R4 A-15). Give the pair its own grid.
- **A utility's `display` beats the `hidden` ATTRIBUTE** (R4, L2): preflight's `[hidden]` and `.flex`
  tie on specificity and utilities come later, so `<div hidden className="flex">` shows. Toggle a class.
- **A hidden `CardAction` still leaves the header's second grid column** (R4, L2): the description
  auto-placed into it and squeezed the title to a letter a line. Put a conditional control in its own row.
- **`overflow: auto`/`hidden` on ANY ancestor captures `position: sticky`** (R5 V5-6): be a scroller
  only while wider (`ScrollArea onlyWhenWider`), clip with `overflow-clip`; a sticky `top` inside a
  box that never scrolls vertically pushes the element DOWN over the rows (`[[data-scrolls]_&]:!top-0`).
