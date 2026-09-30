---
name: crusaders-mainframe-decisions-frontend-bundle
description: "What loads first and why: shell, landing, sign-in and My Code in the entry; the admin frame one lazy chunk that never re-suspends; 4 icon weights shipped; first load 557 → 304 (P10) → 255 kB gzip (perf, 2026-09-30)."
type: decision
last_verified: 2026-09-30
---

# Live decisions — the frontend bundle

Measured with `vite build` into a scratch dir, gzip of what `index.html` names. P10: one 557 kB
entry → 304 kB. Perf lane 2026-09-30: 328 → **255 kB** (entry 166 + React 74 + CSS 21).

- **My Code stays in the entry chunk.** **Why:** an offline /my-code at a dark door must not
  wait on a chunk; `e2e/my-code-offline` (production build) is the proof.
- **The admin frame, Overview and the two doors pages are ONE lazy chunk (`src/adminFrame.ts`)**
  — they were eager (~97 kB raw of every member's first load, pulling Radix select/radio,
  doorsCopy, gateCopy). **Why they were eager, and why that still holds:** they read the shared
  doors store, and a reader mounting after a Suspense boundary resolved fired a second
  `GET /admin/doors` (E-L6, counted in `e2e/admin-doors`). Kept one read by three things:
  `App.tsx`'s `named()` returns a synchronously-resolved thenable once its module has arrived,
  so React.lazy does not suspend and frame + page mount in one commit; the chunk is fetched at
  boot on an /admin path; and the doors store takes a read that landed < 2 s before
  (`DOORS_JOIN_FRESH_MS`) instead of reading again. Do not reintroduce a per-page `<Lazy>` under
  the frame for these four.
- **Only the Phosphor weights the product draws are built (`ui/iconWeights.ts`: regular, bold,
  fill, duotone).** A build-only plugin in `vite.config.ts` strips the rest from each icon's
  defs. **Why:** the weight is picked at render time, so nothing tree-shakes it (219 kB raw of
  path data). **Trap:** a weight used but not shipped renders an EMPTY svg in production only —
  `icons.test` scans every `weight=` against the list; add the weight there in the same change.
- **The watermark is a CSS mask, not an icon** (`ui/watermark.css`, pinned to Phosphor's light
  FingerprintSimple by `watermark.test`) — so `light` is not shipped.
- **Copy a shell component needs lives beside it, not in a feature's copy file.** The bell's
  words are `lib/bellCopy` (re-exported by playersCopy); importing two functions from
  `playersCopy` put 29 kB in the entry. The celebration dialog is a lazy chunk loaded only when
  there is a moment (a failed load draws nothing).
- **Only React + the router are grouped by hand** (`manualChunks` → `react`). **Why:** a hand-made
  group pulls its non-leaf dependencies — and what the entry shares with them — into the first
  load. Measured again 2026-09-30: a `ui/` group dragged react-day-picker and ~48 kB gzip in.
- **`experimentalMinChunkSize: 2_500`.** Merges micro-chunks where Rollup can do so without
  changing what runs when: 110 → 92 files for +1.2 kB gzip. **Why not higher:** 8 kB merged real
  lazy code into the entry (+12 kB gzip).
- **Member pages' loaders live in `src/routeChunks.ts`** (shared with `App.tsx`'s `lazy()`), so
  the opened page's code starts once `whoami` is SENT (`auth.whenSessionCheckSent` — queued
  before it, ~30 files held `whoami` for a second on HTTP/1.1) and the tab bar's pages are
  fetched at idle once signed in (`NavPrefetch`). Hints only: failures swallowed, not offline,
  not under Save-Data.
- **The date picker's calendar is its own chunk**, prefetched on pointer/focus intent.
- **Retired in P10 and not to return:** the P1 compat shims (`components/Button|Card|Modal|
  StateBlock`, `components/Layout`); `lucide-react`; the `action_glyphs` setting and ClubUi
  context; D1's booking-code copy branches. **Why:** each was a second path to one thing.
- **Still big and known:** Schedule 28 kB gzip with CancelSheet (9) and the split preview (8)
  eager inside it; ReportParts (charts) 124 kB, lazy and admin/activity-only.
