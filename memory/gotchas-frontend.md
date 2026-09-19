---
name: crusaders-mainframe-gotchas-frontend
description: "React and browser-harness traps: renderPage(<StrictMode>…) is INERT so lanes wrote tests they believed were guarded, user-event's keyboard path hangs under jsdom 28, and only the repo's own Chromium can register a service worker."
type: gotcha
last_verified: 2026-09-11
---

# Gotchas — frontend, vitest and the browser harness

- **`renderPage(<StrictMode>…</StrictMode>)` double-invokes NOTHING**, and two lanes wrote tests
  that way believing they were guarded. Testing Library places its `wrapper` *outside* the `ui`, so
  a `<StrictMode>` element passed as `ui` lands inside the harness's providers and is inert there.
  Measured with a probe: bare `render(<StrictMode><Probe/></StrictMode>)` logs mount → cleanup →
  mount; the wrapped form logs only "mount". **The working form is the render OPTION:**
  `renderPage(ui, { reactStrictMode: true })`, which RTL applies outside its wrapper.
- **StrictMode's mount → cleanup → mount has produced two real defects here that unit tests could
  not see** — a `mounted` ref written only on cleanup is already false before the first click, which
  left a confirm button stuck on "Working…" after a successful booking (the founder reported it)
  and, later, an outage screen's retry button dead for the life of the tab. A test that renders the
  component without StrictMode cannot reproduce either.
- **`@testing-library/user-event`'s keyboard and typing paths never settle under jsdom 28 +
  vitest 4 here.** A `user.type()` or `user.keyboard()` hangs to the test timeout and the failure
  reads as a component ignoring input. `user.click` is fine. Use `fireEvent.change` /
  `fireEvent.keyDown` instead — the events dispatched are the ones a browser sends. Mixing
  user-event with fake timers deadlocks outright.
- **A fetch stub that matches routes by first-declared prefix is a trap.** An admin collection path
  is a prefix of its own sub-resource, so a test stubbing both got whichever was declared first and
  failed with an empty screen and no hint why. Both the vitest harness and the Playwright fixture
  sort by longest prefix — keep it that way.
- **The in-app browser cannot register a service worker; the repo's own Chromium can.** A fixer
  recorded "cannot be registered in this repo's automation" in four places as the reason for
  dropping offline support; a refuter registered one on the first attempt through Playwright's
  `executablePath` and reproduced a **cross-member cache leak** — one member's wallet served to
  another — with it. `PLAYWRIGHT_CHROMIUM_PATH` is read by `playwright.config.ts`; without it
  `npx playwright test` cannot launch on this Mac at all, because the cached revision and the one
  Playwright wants differ.
- **Playwright refuses a browser revision it did not pin**, so a CI runner that already ships
  Chromium is unusable unless `executablePath` points at it — otherwise every run re-downloads
  hundreds of megabytes to get a build differing by a revision number. The same config key handles
  it and is a no-op when unset.
- **vitest has no `localStorage` under Node ≥25 + jsdom 28** — jsdom defers to Node's flag-gated
  built-in, which is undefined without the flag. An in-memory `Storage` polyfill in the frontend
  test setup file covers it; **keep it if that file is ever rewritten**, or the app test fails on
  `localStorage.clear()`.
- **Accessibility defects hide in hand-rolled primitives.** Tests written against existing
  components found a confirm button whose accessible name was every copy of its label concatenated,
  and a settings `Field` rendering a label with no `htmlFor`, leaving every input on that page
  unlabelled. The primitives are hand-rolled here by omission, not by design — see
  [`watch.md`](watch.md).
