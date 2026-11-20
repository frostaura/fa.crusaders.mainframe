---
name: technologies-crusaders-squash-control-system-gotchas-frontend-layout-container-queries
description: "Container-query traps at 200 % text: measure the component in rem not the viewport, one rule per width range, classes written whole, the plugin's @[…] emitted before sm:, a rem max-width query is a large-text query."
type: gotcha
last_verified: 2026-11-20
---

# Gotchas — container queries are text-size queries (R4–R7)

The other layout traps: [`gotchas-frontend-layout.md`](gotchas-frontend-layout.md); the decisions built on these:
[`decisions-frontend-large-text.md`](decisions-frontend-large-text.md).

- **For 200 % text, measure the COMPONENT in rem, not the viewport** (R4, lane F2):
  `[container-type:inline-size]` on a wrapper and `[@container(min-width:17rem)]:…` variants follow
  the text size, where `sm:` (640 CSS px) never does. Inbox rows, Profile stats and badges use it.
  Give each width range ONE rule (`_and_(max-width:…)`): two container variants that set the same
  property compete by stylesheet order. Write every class whole — `${WIDE}:col-span-1` built
  from parts is never seen by Tailwind's scanner and emits nothing. R7: `@[16rem]/x:` (plugin) is emitted BEFORE `sm:`, so it never beats a viewport rule — write base-small + `@[…]:` grow and leave `sm:` alone; gutters that must not grow with text are `min(rem,px)` constants in `ui/layout.ts`.
- **A rem `max-width` container query is a large-text query** (R4, lane F3): `[@container(max-width:18rem)]`
  is 288 px at normal text and 576 px at 200 %, so a tile hides (or an avatar stacks) only when the
  TEXT is large for the box — the switcher, the Overview's links, the member header and the app bar
  (R5 `@container/appbar`: tabs inline from 44rem). A query container does NOT trap a fixed child.
