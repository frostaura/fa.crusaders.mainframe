---
name: crusaders-mainframe-decisions-frontend-offline-shell
description: "The shell in the field: document and precache.json no-cache, a stalled navigation served the cached shell at 2 s, My Code and the header kept while whoami is out, a session ending keeps the shell, the member code works on plain http."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the offline shell on a phone with one bar of signal

The worker's own lifecycle (per-build caches, install set, purge) is [`decisions-frontend-worker.md`](decisions-frontend-worker.md);
kept member reads are [`decisions-frontend-offline-data.md`](decisions-frontend-offline-data.md). The worker caches NO member
data (`public/sw.js` header, `offline-shell` and `sw-update` specs).

- **The document and `precache.json` are `Cache-Control: no-cache`** (`src/frontend/nginx.conf:68,78,90`, each block
  repeating the four framing headers; also `sw.js`, `theme-boot.js`, the manifest), and the worker fetches the shell and
  every navigation with `{ cache: "no-cache" }`. *Why:* with no header an `index.html` was cached heuristically (~17 h
  for a week-old build) and named deleted chunks. `nginx-posture.test`.
- **A navigation races the network against 2 s (`NAV_WAIT_MS`), then serves the cached shell** (R5 P5-1); a late answer
  still refreshes it (`waitUntil`); no shell cached = wait as before. *Why:* one bar of signal STALLS a request rather
  than failing it — My Code was blank 20 s+.
- **My Code renders while `whoami` is out** when the device holds a token AND a confirmed identity (`RequireAuth`
  loading branch; `useMemberCode` paints the key, asks the club only once the check answers). *Why:* at one bar of signal
  the splash stood for up to 20 s at the door. **My Code stays in the entry chunk** for the same reason
  ([`decisions-frontend-bundle.md`](decisions-frontend-bundle.md)).
- **The header's bell, chip and account menu render for the member this phone confirmed while `whoami` is out** (R5
  P5-6, `useDataOwner` like the tab bar); the chip draws the kept wallet read ("Last known at HH:MM"), never re-asked
  while the check is out. *Why:* Sign out was unreachable. **R8:** a session the club could not confirm right now keeps
  the chrome even unconfirmed (status `offline` + a token — a 429 on a fresh phone kept only the crest); no Admin tab
  unconfirmed; the chip with nothing kept and the check answered says "unavailable" (+ "You're offline" when
  unreachable), never "loading" for ever (`chipBalance` `none`).
- **A session ending deletes every `crusaders-` cache EXCEPT `crusaders-shell-*` / `crusaders-assets-*`** (`lib/pwa`
  page half + the worker's `CLEAR_CACHES`; R5 M5-1). *Why:* they hold no member data, and purging them meant a lapsed
  phone could not open at all offline — My Code included — though the lapse screen promises the code works. The leaking
  `crusaders-api-v1` still goes. Proof: `e2e/offline-shell` lapse case.
- **The member code works on plain http** (2026-10-11): `crypto.subtle` exists only on https or localhost, so the club
  LAN (`http://<server IP>`) showed no code. Without WebCrypto the key is a `SoftHmacKey` signed by `sha256.ts`, pinned to
  WebCrypto by vectors and an equality sweep. The bytes are then readable by the page — accepted, because production is
  https and never takes that path. The LAN browser origin is opt-in through `CORS_ALLOWED_ORIGIN_LAN` in `.env`
  (`Cors__AllowedOrigins__2`). Over plain http Safari drops `Secure` cookies, so those sessions fall back to the
  15-minute bearer ([`decisions-sessions.md`](decisions-sessions.md)).
