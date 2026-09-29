---
name: crusaders-mainframe-decisions-frontend-bundle
description: "P10: what loads first and why — shell, landing, sign-in and My Code in the entry, every other page lazy, the doors-store readers eager; first load 557 → 304 kB gzip. No compat shims or thumbs setting may return."
type: decision
last_verified: 2026-09-29
---

# Live decisions — the frontend bundle and what P10 retired

Measured 2026-09-29 with `vite build`, gzip sizes. Before: one 1,896.6 kB entry
(556.98 kB gzip). After: a 774.8 kB entry (230.2 kB gzip) + a React/router chunk
(74.2 kB gzip) = **304 kB first load**; the rest is per-route chunks.

- **My Code stays in the entry chunk.** **Why:** `public/sw.js` precaches only the assets
  `index.html` names; a lazy chunk is cached only once fetched, so an offline /my-code that
  waited on one would break for the member at a dark door. `e2e/my-code-offline` (production
  build) is the proof.
- **The admin frame, Overview and the two doors pages stay eager.** **Why:** they read the
  shared doors store, which dedupes only while a read is in flight; a reader that mounts after a
  Suspense boundary fires a second GET (E-L6, counted in `e2e/admin-doors`). Every other page
  is `React.lazy` behind `RouteSkeleton`.
- **Only React + the router are grouped by hand** (`manualChunks` → `react`). **Why:** a hand-made
  group pulls modules only lazy routes use into the first load; React changes less often than
  the app, so a deploy no longer re-downloads it.
- **The date picker's calendar is its own chunk** (react-day-picker, date-fns, TZDate ≈ 21 kB
  gzip), prefetched on pointer/focus intent. The trigger label is plain arithmetic
  (`ui/date-picker-day`).
- **What is left in the entry is mostly real:** react-dom, Phosphor (every weight of each icon
  used on eager screens, ~73 kB gzip across the set) and the copy modules. The next cut would be
  the doors-store coupling above, not more lazy routes.
- **Retired in P10 and not to return:** the P1 compat shims (`components/Button|Card|Modal|
  StateBlock`, `components/Layout`) — import `ui/*` and `shell/AppShell` directly; `lucide-react`
  (ESLint bans it); the `action_glyphs` "Yes and no icons" setting and the ClubUi context (the
  provider only sets the money symbol now); D1's booking-code copy branches (`CodeOnScreen` is
  `{ kind: "member" }`). **Why:** each was a second path to one thing, kept only for migration.
