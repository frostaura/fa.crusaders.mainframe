---
name: crusaders-mainframe-gotchas-frontend-e2e
description: "Browser-harness traps: only the repo's Chromium registers a worker, worktrees serve no webfonts, an async wait predicate is truthy at once, offline emulation leaves onLine true, a stale install fakes a broken build, act() warnings."
type: gotcha
last_verified: 2026-11-20
---

# Gotchas — Playwright, the dev server and the frontend toolchain

React/vitest traps are [`gotchas-frontend.md`](gotchas-frontend.md); real-stack walk traps
[`gotchas-real-stack.md`](gotchas-real-stack.md); CI job traps [`gotchas-ci-jobs.md`](gotchas-ci-jobs.md).

- **The in-app browser cannot register a service worker; the repo's own Chromium can.** A fixer recorded "cannot be
  registered in this repo's automation" in four places as the reason for dropping offline support; a refuter registered
  one on the first attempt through Playwright's `executablePath` and reproduced a **cross-member cache leak** — one
  member's wallet served to another. `PLAYWRIGHT_CHROMIUM_PATH` is read by `playwright.config.ts:40-41`; without it
  `npx playwright test` cannot launch on this Mac (the cached revision and the one Playwright wants differ, and it refuses
  a revision it did not pin; unset, the key is a no-op). In a cloud container: `/opt/pw-browsers/chromium`.
- **In a git worktree the dev server serves NO webfonts, so layout tests measure the wrong typeface.** Fonts are
  self-hosted from `node_modules`; a worktree symlinks that outside the worktree root, so Vite's allow-list 403s every
  `.woff2` with one log line that reads like noise ("is outside of Vite serving allow list"). The page renders in the
  fallback face with different metrics — a 2 px badge overflow passed here every run and failed on CI.
  `server.fs.allow` in `vite.config.ts:245` names the resolved path; **do not "simplify" it away.**
- **No e2e wait takes an async predicate** (R15 X15-1): `waitForFunction(async …)` returns a Promise, truthy on the first
  poll — the R14 offline flake. `await navigator.serviceWorker.ready` in an evaluate, then a SYNC wait on
  `controller?.state === "activated"`. Guard: `src/e2e-waits.test.ts`.
- **Chromium's offline emulation leaves `navigator.onLine` TRUE on the next document** (measured): a spec that goes offline
  and then navigates must pin it false (init script), or the app reads "can't reach the club" for a phone with no signal.
  And under `context.setOffline(true)` wording keyed on `onLine` alone said "Couldn't refresh" — offline is judged from
  the failed read too ([`decisions-frontend-offline-data-words.md`](decisions-frontend-offline-data-words.md)).
- **A stale install reads as a catastrophically broken build** (FM-12): `node_modules` older than `package-lock.json`
  gave 228 tsc errors, a vite build that could not find a font and 355 failed vitest files; the main checkout sat like
  that for two months and every lane that ran a gate there reported false regressions. `vite.config.ts` now stops every
  gate (build, vitest, dev server) over a stale DIRECT dependency with the one sentence that fixes it
  (`src/depsFreshness.ts`). The installs themselves are not this file's to run.
- **`act()` warnings** (FM-7): 1,492 in a dot-reporter full run before pass 2, which fixed the largest sources (the chart
  theme — unmount the animating chart — AdminDoorsLog, AdminLedger and nine more: `vi.waitFor` never leaves act, RTL
  `waitFor` does; `settledIt` for files whose providers land after the last line) and the Node webstorage / jsdom canvas
  noise. **Not zero:** Inbox, BookSheet.players, AdminDoors, admin-members-notification and ~25 small files update
  mid-test and need per-test awaits, so a hard fail-on-warning gate would be flaky while they remain. The default
  reporter hides them; run `--reporter=dot` to see them.
- **A fetch stub that matches routes by first-declared prefix is a trap**: an admin collection path is a prefix of its own
  sub-resource, so a test stubbing both got whichever was declared first. Both the vitest harness and the Playwright
  fixture sort by longest prefix — keep it that way (and among EQUAL prefixes the first declared answers).
- **Measure a tap run, not a text box**: the `sm` button's 44px is its `after:` box and the share toggle's target is its
  row (stretched `::after`, R16 X16-5 refuted by measurement) — `getBoundingClientRect` on the label lies.
- **Many rapid opens of `/my-code` hit the `auth` limiter** on `POST /me/code/enrol` (10/min): the reviewer's 15.1 s /
  6.4 s opens were not reproduced and were most likely the harness opening it ~50 times per viewport.
- **Under load (≥40) lazy-route e2e tests time out on "Opening the page…"** — rerun alone first; an e2e waits for a lazy
  part before counting ([`gotchas-frontend.md`](gotchas-frontend.md)).
- **Bookings-screen harness traps** (R4–R5): a sticky box sticks only inside its PARENT (the whole picker, child of the grid's column, is what sticks);
  under a modal sheet the grid is aria-hidden (RTL needs `{ hidden: true }`); `test-results/` is shared between lanes
  (`--output=<own dir>`); the harness's `respond` cannot be async (wrap `globalThis.fetch` after `stubFetch`, gate POSTs on
  a promise); the Wallet ledger at 390/200 % scrolls sideways inside its ScrollArea by design.
