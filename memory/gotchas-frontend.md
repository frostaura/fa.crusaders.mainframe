---
name: crusaders-mainframe-gotchas-frontend
description: "React and harness traps: renderPage(<StrictMode>…) is INERT, user-event typing hangs under jsdom 28, only the repo's Chromium registers a SW, worktrees serve no webfonts, lazy chunks race tests, Select.Value drops className."
type: gotcha
last_verified: 2026-09-29
---

# Gotchas — frontend, vitest and the browser harness

- **`renderPage(<StrictMode>…</StrictMode>)` double-invokes NOTHING**, and two lanes wrote tests
  that way believing they were guarded. Testing Library places its `wrapper` *outside* the `ui`, so
  a `<StrictMode>` element passed as `ui` lands inside the harness's providers and is inert there.
  Measured with a probe: bare `render(<StrictMode><Probe/></StrictMode>)` logs mount → cleanup →
  mount; the wrapped form logs only "mount". **The working form is the render OPTION:**
  `renderPage(ui, { reactStrictMode: true })`, which RTL applies outside its wrapper.
- **StrictMode's mount → cleanup → mount has produced two real defects unit tests could not see**:
  a `mounted` ref written only on cleanup is false before the first click — a confirm stuck on
  "Working…" after a booking, and an outage screen's retry dead for the life of the tab.
- **`@testing-library/user-event`'s keyboard and typing paths never settle under jsdom 28 +
  vitest 4 here.** `user.type()` / `user.keyboard()` hang to the test timeout and read as a
  component ignoring input. `user.click` is fine. Use `fireEvent.change` / `fireEvent.keyDown`
  — the events dispatched are the ones a browser sends. user-event plus fake timers deadlocks.
- **A fetch stub that matches routes by first-declared prefix is a trap.** An admin collection path
  is a prefix of its own sub-resource, so a test stubbing both got whichever was declared first and
  failed with an empty screen and no hint why. Both the vitest harness and the Playwright fixture
  sort by longest prefix — keep it that way.
- **The in-app browser cannot register a service worker; the repo's own Chromium can.** A fixer
  recorded "cannot be registered in this repo's automation" in four places as the reason for
  dropping offline support; a refuter registered one on the first attempt through Playwright's
  `executablePath` and reproduced a **cross-member cache leak** — one member's wallet served to
  another. `PLAYWRIGHT_CHROMIUM_PATH` is read by `playwright.config.ts`; without it
  `npx playwright test` cannot launch on this Mac, because the cached revision and the one
  Playwright wants differ.
- **Playwright refuses a browser revision it did not pin**; the same `executablePath` key lets a CI
  runner use the Chromium it ships (a no-op when unset).
- **vitest has no `localStorage` under Node ≥25 + jsdom 28** — jsdom defers to Node's flag-gated
  built-in, which is undefined without the flag. An in-memory `Storage` polyfill in the frontend
  test setup file covers it; **keep it if that file is ever rewritten**, or the app test fails on
  `localStorage.clear()`.
- **In a git worktree the dev server serves NO webfonts, so layout tests measure the wrong
  typeface.** Figtree is self-hosted from `node_modules`; a worktree symlinks that outside the
  worktree root, so Vite's allow-list 403s every `.woff2` with one log line that reads like
  noise: *"is outside of Vite serving allow list"*. Nothing looks broken — the page renders in
  the fallback face — but a fallback has different metrics, so a test asserting text fits its
  box is measuring a font the product does not ship. A 2 px badge overflow passed here every
  run and failed on CI. `server.fs.allow` in `vite.config.ts` names the resolved path;
  **do not "simplify" it away.**
- **Text directly inside a flex container cannot be made to shrink.** It becomes an ANONYMOUS
  flex item floored at min-content; `min-w-0` on the parent does not help. Wrap the children in
  a real element with `min-w-0 break-words` — `ui/badge.tsx` carries the working shape.
- **Radix `Select.Value` silently drops `className` and `style`**, and a parent rule like
  `[&>span]:line-clamp-1` hits ANY child span: it turned TimeSelect's clock + value row into a
  `-webkit-box` and stacked the clock above the time (P10). `ui/select`'s `SelectValue` wraps the
  Radix value in its own clamped span; clamp there, never on the trigger's children.
- **A lazily loaded chunk races every test that opens it** (P10: routes, the date picker's
  calendar). `findBy` waits 1 s and a cold import under a loaded runner (load 45) took longer
  than the 5 s test timeout — so a suite that opens a lazy part imports that module at the top
  (the module cache makes the lazy load instant); an e2e waits for the part before counting.
  Guards that read `App.tsx` as text must accept `<Lazy><Page /></Lazy>` and `lazy(`/`named(`.
