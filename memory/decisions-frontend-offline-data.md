---
name: crusaders-mainframe-decisions-frontend-offline-data
description: "Member reads kept per member in IndexedDB (never the worker cache), wiped on any ending or switch; drawn at once, refreshed behind; a failed refresh never blanks; offline writes refused, never queued."
type: decision
last_verified: 2026-10-01
---

# Live decisions — offline & instant member data (R4 wave B, lane D)

Extends the privacy rule in [`decisions-frontend-offline-shell.md`](decisions-frontend-offline-shell.md):
the worker still caches NO member data. Code: `src/frontend/src/lib/offline/`.

- **One app-level store, keyed by member** (`queryCache` in memory + `memberStore`, IndexedDB
  `crusaders-member-data`). **Why not the worker:** the Cache API keys on the URL, ignores the token
  and belongs to the browser profile — a shared desk tablet served one member's wallet to another.
- **Wiped on sign-out, "sign out everywhere", a lapse, and a different member confirmed**
  (`lib/auth`: `endLocally`, `endTakenAway`, `rememberIdentity`). The lapse wipes too (unlike the
  code's key): kept reads open no door, and a signed-out phone must not show a wallet. A read
  landing after a wipe/switch is dropped (generation); a write to the phone needs the guard (token
  + confirmed identity in storage, read at write time — another tab's sign-out stops it). 14-day ceiling.
- **Stale-while-revalidate** (`useCachedRead`): a revisit or warm start draws the kept answer at
  once with its "as of", the club is asked behind it, and a read in flight is joined (one request
  per key — StrictMode's second mount joins too, so tests counting first reads changed).
- **A failed refresh never blanks** — offline, 5xx or 429 alike (form-factor review: one 429 swapped a
  whole screen for "The club is busy"). `StaleNotice` says "You're offline" when the club was never
  reached, "Couldn't refresh" when it answered with a failure, each with the time.
- **Offline-capable routes** (`RequireAuth`): /my-code, /bookings, /bookings/:id, /wallet, /profile,
  /inbox — offline or while `whoami` is out, for the member this phone confirmed. Only My Code
  renders signed out. The tab bar stays for that member (`AppShell` via `useDataOwner`).
- **Writes offline are refused before sending** (`OfflineError`, "needs a connection … Nothing was
  sent"), known not to have landed (no read-back). **Nothing is queued** — a booking sent when
  signal returns could charge for a court taken meanwhile. A grid kept because the club was
  unreachable books nothing (toast); one kept through a 429/5xx still books (the club answers).
- **Reads start with the code (P4-5):** `routeIntent` on a nav link's press/hover/focus; the opened
  page's reads beside `whoami` on a direct load (none for My Code); the result read beside the
  detail when the phone has the booking (a cold deep link with no copy still waits — F2.15 pins
  "a cancelled booking asks no result"). Admin member tabs (/play, bookings) start beside the
  detail, memory only (`adminEarlyReads`). The profile provider waits for the check (`whileChecking: false`).
- **Kept reads come back key by key** (`loadKept`, on the first subscriber), never the whole
  store at boot: reading it all back cost a cold My Code ~110 ms (structured clone at 4x CPU,
  A/B 1074 → 960 ms median). Stale records are deleted once the app settles (15 s, then idle).
- **Measured** (390, slow 4G, 4x CPU, worker on; A/B interleaved against the pre-lane build at the
  same moment — load 15–40, four orphaned `yes` processes held four cores all morning): revisit
  Bookings 625 → 441 ms, Wallet 444 → 396; first tap Bookings 967 → 786, Wallet 562 → 507 (its
  read now starts at the press, 10 ms vs 411); warm /bookings unchanged (~1.9 s, code-bound);
  offline Bookings/Wallet/Inbox/Profile 0/4 → 4/4 drawn, tab bar 0/5 → 5/5. Warm My Code paint
  +~100 ms with DCL +110 ms from first-load growth (offline lib ~8 kB raw, the layout lane's CSS
  +10 kB) — not resolvable at that load; re-measure on a quiet machine.

## Traps met

- **`git commit --amend` in a shared tree amends whoever committed last.** Another lane's commit
  landed between this lane's commit and its amend, which took that commit's tree and replaced
  its message. Repaired by amending back to the identical tree and message. Never amend here.
- **Under Playwright's `context.setOffline(true)` the offline Wallet said "Couldn't refresh"**
  when the wording keyed on `navigator.onLine` alone (production-build spec, observed). Offline is
  now judged from the failed read too (`NetworkError`/`OfflineError`), never from `onLine` alone.
- **A page's optimistic write dies with the page; the cached read does not.** Back within `JOIN_MS` the
  stale list is REUSED unread (inbox: tapped notice unread again). Hold such marks at module scope (`inbox/heldMarks`).
