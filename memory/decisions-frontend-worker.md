---
name: technologies-crusaders-squash-control-system-decisions-frontend-worker
description: "The service worker: one per build with caches named for it, activate ends at claim and finishes the install in a self-posted message, a member's install set holds every static import, the old build is purged only once the new one is whole."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the service worker across deploys

The worker caches NO member data (member reads are IndexedDB — [`decisions-frontend-offline-data.md`](decisions-frontend-offline-data.md));
what the shell does in the field is [`decisions-frontend-offline-shell.md`](decisions-frontend-offline-shell.md). Code
`public/sw.js`, `src/swBuild.ts`, `vite.config.ts`.

- **Each build ships its own worker.** `vite.config.ts` stamps a build id (SHA-256 of every emitted file name and every
  public file's bytes, 16 hex) into the shipped `sw.js` (placeholder exactly once) and into `precache.json`. *Why:*
  `VERSION = "v3"` never changed and a browser installs a worker only when its bytes change — no deploy ever installed
  one, new chunks were never precached, `crusaders-assets-v3` grew for ever. Same sources → same id, so a rebuild does not
  make every phone reinstall.
- **Caches are named per build**; activate drops the last build's shell and the leaking `crusaders-api-v1` at once.
  Install takes a hashed file the last build already cached from that cache (a deploy downloads what changed). An old
  tab's lazy chunk then 404s and `lib/chunkLoad` reloads it once — accepted.
- **Activate ends at `clients.claim()` + the purge of earlier shells** (R15 X15-2). *Why:* the browser HOLDS every fetch
  of a controlled page until activate's `waitUntil` settles; with ~40 desk chunks fetched inside it a reload waited 2.3 s
  at 100 ms/request, 6.9 s at 300 ms. The rest (`finishInstall`: `precacheRest`, then the purge of the earlier build's
  assets) runs in a message the worker posts ITSELF (`registration.active.postMessage({type:"FINISH_INSTALL"})`, works
  in Chromium, no page code) and behind the first navigation of a later lifetime (single flight). Measured after: reload
  during activation 136 ms @100, 329 ms @300; every chunk still cached. `swHarness` models it (`sw.background()`).
- **The earlier build is purged only when `precacheRest` read the list AND every listed file is cached** (R16 X16-2);
  otherwise it stays (offline pages open from it) and `restRun` is cleared so the next navigation retries
  (`src/serviceWorker.r16.test.ts`).
- **Every chunk is on the phone** (F4.3): install caches `precache.json`'s `first` (the member's set); the desk's chunks
  follow after claim. **A member's install set holds every STATIC import of a chunk in it** (R16 X16-1,
  `vite.config.ts` `memberFirst`, `:110`): only a LAZY edge may leave a file for later — the desk's pages and the chart
  code (`Charts.tsx`, recharts). *Why:* the old rule dropped any chunk holding a `components/reports/` module, and
  `reports/range.ts` + `ReportParts.tsx` are static imports of the wallet's pages, so /wallet and /wallet/activity did
  not open offline after an install. The build throws on a gap (`memberSetGaps`, `:135`); `src/precache-member-set.test.ts`
  checks a real build's manifest. (R4 P4-6 first cut the set 666 → 514 kB gzip by leaving the charts and the desk frame out.)
- **A session ending no longer stops the desk's post-claim precache** (`sw.js:269-272`): since R5 M5-1 an ending does not
  delete the shell/asset caches, so the precache keeps going; it stops only if the asset cache itself is gone.
  `CLEAR_CACHES` purges only the non-kept prefixes. *Corrected 2026-11-20:* the session topic said sign-out stopped it.
- **A failed chunk** gets its own boundary + Retry; online, one reload per 5 min (looped). The offline chunk screen never
  claims the phone "hasn't opened this page before" — it cannot tell that from an unfinished install — it says the page
  isn't on the phone yet.
- **Proof method for a worker change:** `e2e/sw-update.spec.ts` — two real builds (a copy with one file changed), switch
  the origin, `registration.update()`; assert caches, reuse, no member data. A precache lane once fetched `undefined`
  (queue emptied under its await) — keep the guard. Only the repo's own Chromium registers a worker
  ([`gotchas-frontend-e2e.md`](gotchas-frontend-e2e.md)).
