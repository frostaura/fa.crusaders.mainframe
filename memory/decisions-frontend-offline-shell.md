---
name: crusaders-mainframe-decisions-frontend-offline-shell
description: "Worker per build (stamped id, caches named for it, last build pruned), document no-cache, a stalled navigation served the shell at 2 s, endings keep the shell, header kept while whoami is out."
type: decision
last_verified: 2026-10-03
---

# Live decisions — the offline shell across deploys (review round 4, lane F4)

The worker still caches NO member data (`public/sw.js` header, `offline-shell` and
`sw-update` specs). These are about a deploy reaching a phone that already has the app.

- **Each build ships its own worker.** `vite.config.ts` stamps a build id (SHA-256 of every
  emitted file name and every public file's bytes, 16 hex) into the shipped `sw.js`
  (`src/swBuild.ts`, placeholder exactly once) and into `precache.json`. **Why:** `VERSION = "v3"`
  never changed, and a browser installs a worker only when its bytes change — no deploy ever
  installed one, the new chunks were never precached, `crusaders-assets-v3` grew for ever.
  Same sources → same id, so a rebuild does not make every phone reinstall.
- **Caches are named per build; activate drops the last build's shell and the leaking
  `crusaders-api-v1` at once, and its assets after `precacheRest`.** Install takes a hashed file
  the last build already cached from that cache (a deploy downloads what changed). An old tab's
  lazy chunk then 404s and `lib/chunkLoad` reloads it once — accepted.
- **The document and `precache.json` are `Cache-Control: no-cache`** (`src/frontend/nginx.conf`,
  each block repeating the four framing headers), and the worker fetches the shell and every
  navigation with `{ cache: "no-cache" }`. **Why:** with no header an `index.html` was cached
  heuristically (~17 h for a week-old build) and named deleted chunks. `nginx-posture.test`.
- **My Code renders while `whoami` is out** when the device holds a token AND a confirmed identity
  (`RequireAuth` loading branch; `useMemberCode` paints the key, asks the club only once the check
  answers). **Why:** at one bar of signal the splash stood for up to 20 s at the door.
- **The credits chip reads `/wallet?limit=1`** — balance and held parts are top-level on any page
  (735 bytes vs 55 kB, checked on the stack). A page read in flight for more rows still answers it.
- **Proof method for a worker change:** `e2e/sw-update.spec.ts` — two real builds (a copy with one
  file changed), switch the origin, `registration.update()`; assert caches, reuse, no member data.
  A precache lane once fetched `undefined` (queue emptied under its await) — keep the guard.

## Review round 5 (lane B)

- **A session ending deletes every `crusaders-` cache EXCEPT `crusaders-shell-*` / `crusaders-assets-*`**
  (`lib/pwa` page half + the worker's `CLEAR_CACHES`; M5-1). **Why:** they hold no member data
  (member reads are IndexedDB, wiped by `wipeMemberData`), and purging them meant a lapsed phone
  could not open at all offline — My Code included — though the lapse screen promises the code
  works. The leaking `crusaders-api-v1` still goes. Proof: `e2e/offline-shell` lapse case.
- **A navigation races the network against 2 s (`NAV_WAIT_MS`), then serves the cached shell**
  (P5-1); a late answer still refreshes it (`waitUntil`); no shell cached = wait as before.
  **Why:** one bar of signal STALLS a request rather than failing it — My Code was blank 20 s+.
- **The header's bell, chip and account menu render for the member this phone confirmed while
  `whoami` is out** (P5-6, `useDataOwner` like the tab bar); the chip draws the kept wallet read
  ("Last known at HH:MM"), never re-asked while the check is out. **Why:** Sign out was unreachable.
- **R8: a session the club could not confirm right now keeps the chrome even unconfirmed** (status
  `offline` + a token: busy 429 on a fresh phone kept only the crest); no Admin tab unconfirmed. The
  chip with nothing kept and the check answered says "unavailable" (+ "You're offline" when
  unreachable), never "loading" for ever (X8-2, `chipBalance` `none`).

