---
name: crusaders-mainframe-decisions-frontend-bundle
description: "What loads first and why: shell and My Code in the entry, the admin frame one lazy chunk, 4 icon weights, our own Archivo/JetBrains cuts; first load 557 → 304 (P10) → 255 kB, then 271 → 263 KiB gzip (R7)."
type: decision
last_verified: 2026-10-03
---

# Live decisions — the frontend bundle

Measured with `vite build` into a scratch dir, gzip of what `index.html` names. P10: one 557 kB
entry → 304 kB. Perf lane 2026-09-30: 328 → 255 kB. R7 (FD2), gzip -9 KiB on one snapshot:
270.7 → 262.8 (entry 174.3 → 169.2, CSS 24.2 → 21.4, React 72.3).

- **My Code stays in the entry chunk.** **Why:** an offline /my-code at a dark door must not
  wait on a chunk; `e2e/my-code-offline` (production build) is the proof.
- **The admin frame, Overview and the two doors pages are ONE lazy chunk (`src/adminFrame.ts`).**
  They read the shared doors store; a reader mounting after a Suspense boundary fired a second
  `GET /admin/doors` (E-L6). Kept one read by: `App.tsx`'s `named()` returns a synchronously
  resolved thenable once its module arrived (frame + page mount in one commit); the chunk is
  fetched at boot on an /admin path; the doors store takes a read < 2 s old
  (`DOORS_JOIN_FRESH_MS`). Do not reintroduce a per-page `<Lazy>` under the frame for these four.
- **Only the Phosphor weights the product draws are built (`ui/iconWeights.ts`).** A build-only
  plugin in `vite.config.ts` strips the rest (219 kB raw). **Trap:** a weight used but not shipped
  renders an EMPTY svg in production only — `icons.test` scans every `weight=`. The watermark is a
  CSS mask (`ui/watermark.css`), so `light` is not shipped.
- **Copy a shell module needs lives beside it, not in a feature's copy file.** The bell's words are
  `lib/bellCopy` (29 kB of `playersCopy` in the entry once); R7: the admin badge's disputes
  sentence moved from `playCopy` into `lib/adminAttention` (−5 KiB first load).
  `src/entryGraph.test.ts` walks `main.tsx`'s static value imports and fails if `playCopy` re-enters.
  Still in the entry by the same mistake (asked of FB/FD1, R7): `walletCopy` → `firstName`
  (PLAYERS_COPY) and `PendingInviteNote` → `INVITES_COPY` — measured −12.4 KiB together.
- **The display and code faces are our own Latin cuts (R7, `src/assets/fonts/`, recipe in
  `index.css`).** Archivo instanced to wght 600–800 / wdth 100–112 % (90 → 37.5 kB), JetBrains Mono
  to wght 400–700 without `calt` ligatures (40 → 14.4 kB); latin-ext/vietnamese stay Fontsource's.
  **Why:** both arrived in the same 1.6 Mbps window as My Code's and Bookings' code. A/B slow
  profile n=9: first Bookings p50 1625 → 1454 ms, p95 1809 → 1522; code paint not regressed.
  **Traps:** every face of a family declares ONE weight/stretch range (Chrome matches one
  capability group — a narrower latin face could drop Latin to the fallback); a new `font-display`
  weight outside 600–800 or stretch outside 100–112 % needs a new cut (`fontFaces.test` scans).
- **Only React + the router are grouped by hand** (`manualChunks` → `react`). **Why:** a hand-made
  group pulls its dependencies — and what the entry shares with them — into the first load (R4:
  a `ui/` group +48 kB; an `app` closure +40 kB through the barrels). R7 measured again:
  Rollup 4.60's `onlyExplicitManualChunks` stops the pull, but the icon barrel (`ui/icons.ts`, in
  the entry) re-exports every icon, so a group holding ANY icon is imported by the entry (+38 kB);
  a barrel-safe "Schedule's shared modules" group took Schedule 27 → 19 files and put +35–48 kB
  on Wallet, TopUp, GetStarted and Invites. Declined: production is HTTP/2+ through Cloudflare,
  where file count costs little; the six-socket rounds are the local stack's.
- **`experimentalMinChunkSize: 2_500`:** 110 → 92 files, +1.2 kB gzip; 8 kB put lazy code in the entry (+12).
- **Member pages' loaders live in `src/routeChunks.ts`**: the opened page's code starts once
  `whoami` is SENT; **Bookings' once the page's reads have settled** (`whenApiQuiet`, 300 ms idle)
  — **or, on My Code, once the code's enrol read has LEFT** (`noteCodeAsked`, R6 X6-3: gap 0 p50
  2180 → 1794 ms). **Why not beside `whoami`:** the code paints 1.0 s later (R4/R5). Tab-bar
  prefetch waits for quiet before EVERY page. Hints only: failures swallowed, not offline, not
  under Save-Data.
- **A member's install set (`precache.json` `first`) leaves out chart chunks and the desk's
  frame** (R4, P4-6: 666 → 514 kB gzip); precached after control, still every chunk on the phone.
- **Lazy rare parts:** the date picker's calendar (prefetched on intent), CancelSheet, SplitStep,
  the celebration dialog, and `/wallet/activity`'s charts (121 kB gz) — no member route statically
  depends on the chart library.
- **Retired in P10, not to return:** P1 compat shims, `lucide-react`, `action_glyphs`/ClubUi, D1's booking-code branches (each a second path).
