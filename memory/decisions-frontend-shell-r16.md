---
name: crusaders-mainframe-decisions-frontend-shell-r16
description: "R16 FE16s: only a lazy edge leaves a file out of the member install set; the old build is purged only once the new one is whole; clipping boxes inset rings; time order."
type: decision
last_verified: 2026-10-05
---

# Live decisions — shell, worker, layout and bookings sheets (review round 16, lane FE16s)

- **A member's install set (`precache.json` `first`) holds every STATIC import of a chunk in it**
  (X16-1, `vite.config.ts` `memberFirst`). Only a LAZY edge may leave a file for later — the desk's
  pages and the chart code (`Charts.tsx`, recharts). *Why:* the old rule dropped any chunk holding a
  `components/reports/` module, and `reports/range.ts` + `ReportParts.tsx` are static imports of
  the wallet's pages: /wallet and /wallet/activity did not open offline after an install. The build
  throws on a gap (`memberSetGaps`); `src/precache-member-set.test.ts` checks a real build's manifest.
- **The offline chunk screen never claims the phone "hasn't opened this page before"** — it cannot
  tell that from an unfinished install. It says the page isn't on the phone yet.
- **The worker purges the earlier build only when `precacheRest` read the list AND every listed file
  is cached** (X16-2). Otherwise the earlier build stays (offline pages open from it) and `restRun`
  is cleared so the next navigation retries. `src/serviceWorker.r16.test.ts`.
- **Any box that clips or scrolls insets the rings inside it** (L16-1):
  `[&_:focus-visible]:-outline-offset-2`, or `p-1`+ room all round. `overflow-clip` and
  `overflow-x-auto` clip too (x-auto makes y auto). `clipped-focus-scan` scans tags AND loose class
  strings; other lanes' boxes sit in its shrink-only `NOT_YET_INSET` ratchet. A sticky head at the
  page scroller's top edge (`<main>`) is cut the same way — inset at the card around it.
- **A refused reason takes the keyboard to the reason** (X16-3, CancelSheet + LiftHoldSheet): a
  refusal counter → effect → `focusFirstComplaint` after the commit that marks the field invalid.
- **Several slots read in ONE order: start time, then the day's court order** (J16-12,
  `components/bookings/slotOrder.ts`). The page orders what it hands the sheets; bulk result rows
  are put back in the order sent, whatever order the answer came in.
- **In a content-sized strip `max-w-full` caps nothing** (L16-5): cap with `100cqw` (WithAside's root
  is the container) — rail cards `w-[min(16rem,100cqw)]`.
- **`break-words` does not shrink an `auto` grid track** (L16-4): a long name sizes it. Text grids
  that hold names get `grid-cols-[minmax(0,1fr)]`; skeleton columns `min-w-0` (L16-3).
- **The docked pay bar puts the price beside the verb and describes it** (L16-2,
  `aria-describedby`): one large "Continue to PayFast · R120.00" was 308px of a 320 / 200 % screen.
- **`malformed_body` has two kinds** (D16-5): read-anyway (invalid UTF-8, detail ends
  "invalid UTF-8 read as U+FFFD") gets its own title and words; dropped (not JSON, too large) says
  so. The detail line names what the board was sending; no U+FFFD/UTF-8/JSON on the page.
- Proof: `e2e/layout-r16-fe16s.spec.ts` (42 green, mobile + desktop; `FE16S_SWEEP=1` adds every
  route's loading state at 320 / 200 %, 26/31 clean — the rest are other lanes' files, asked).
