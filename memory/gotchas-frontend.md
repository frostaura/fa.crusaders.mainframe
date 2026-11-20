---
name: crusaders-mainframe-gotchas-frontend
description: "React and vitest traps: renderPage(<StrictMode>…) is INERT, a mounted ref is set in a layout effect, user-event typing hangs under jsdom 28, no localStorage under Node 25, lazy chunks race tests, Select.Value drops className."
type: gotcha
last_verified: 2026-11-20
---

# Gotchas — React, vitest and jsdom

Browser-harness and toolchain traps: [`gotchas-frontend-e2e.md`](gotchas-frontend-e2e.md).

- **`renderPage(<StrictMode>…</StrictMode>)` double-invokes NOTHING**, and two lanes wrote tests
  that way believing they were guarded. Testing Library places its `wrapper` *outside* the `ui`, so
  a `<StrictMode>` element passed as `ui` lands inside the harness's providers and is inert there.
  Measured with a probe: bare `render(<StrictMode><Probe/></StrictMode>)` logs mount → cleanup →
  mount; the wrapped form logs only "mount". **The working form is the render OPTION:**
  `renderPage(ui, { reactStrictMode: true })`, which RTL applies outside its wrapper.
- **A `mounted` ref is set in a LAYOUT effect, never a passive one.** Written only on cleanup it was
  false before the first click (a confirm stuck on "Working…", a dead outage retry); set in a
  passive `useEffect` it was false for a press landing between commit and effect flush, and the
  pending state was dropped (outage-ux flaked 2 in 6 full runs, 2026-09-30; `useAsyncAction`).
- **`@testing-library/user-event`'s keyboard and typing paths never settle under jsdom 28 +
  vitest 4 here.** `user.type()` / `user.keyboard()` hang to the test timeout and read as a
  component ignoring input. `user.click` is fine. Use `fireEvent.change` / `fireEvent.keyDown`
  — the events dispatched are the ones a browser sends. user-event plus fake timers deadlocks.
- **The app shell scrolls `<main>`, not the document**: `scroll-padding` on `<html>` did nothing
  (R1 F3.23's save-bar fix never applied; R2 F3-14 pads `#main-content`). Probe the scroller first.
- **vitest has no `localStorage` under Node ≥25 + jsdom 28** — jsdom defers to Node's flag-gated
  built-in, which is undefined without the flag. An in-memory `Storage` polyfill in the frontend
  test setup file covers it; **keep it if that file is ever rewritten**, or the app test fails on
  `localStorage.clear()`.
- **Text directly inside a flex container cannot be made to shrink.** It becomes an ANONYMOUS
  flex item floored at min-content; `min-w-0` on the parent does not help. Wrap the children in
  a real element with `min-w-0` (and a wrap rule) of their own. *Corrected 2026-11-20:* `ui/badge.tsx` no longer
  carries that shape — R9 made badge words never break (`[overflow-wrap:normal]` span, `cd47988b`; a badge floors at its
  longest word and the caller's row wraps).
- **Radix `Select.Value` silently drops `className` and `style`**, and a parent rule like
  `[&>span]:line-clamp-1` hits ANY child span: it turned TimeSelect's clock + value row into a
  `-webkit-box` and stacked the clock above the time (P10). `ui/select`'s `SelectValue` wraps the
  Radix value in its own clamped span; clamp there, never on the trigger's children.
- **A lazily loaded chunk races every test that opens it** (P10: routes, the date picker's
  calendar). `findBy` waits 1 s and a cold import under a loaded runner (load 45) took longer
  than the 5 s test timeout — so a suite that opens a lazy part imports that module at the top
  (the module cache makes the lazy load instant); an e2e waits for the part before counting.
  Guards that read `App.tsx` as text must accept `<Lazy><Page /></Lazy>` and `lazy(`/`named(`.
