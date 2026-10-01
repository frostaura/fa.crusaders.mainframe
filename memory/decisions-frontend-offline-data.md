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
  whole screen for "The club is busy"). `StaleNotice` says "You're offline" ONLY when the club was
  never reached — no network, or the read/session check got no answer (`DataOwner.unreachable`:
  whoami's cause is a NetworkError) — and "Couldn't refresh" when it answered with a failure. **Why
  (R5 V5-2):** keyed on `auth.status === "offline"` alone, a whoami 503 read "You're offline" on
  Booking detail/Inbox/Profile while Bookings/Wallet said "Couldn't refresh" for the same outage.
- **Kept since R5 (M5-6):** the open invites (`useKeptInvites`, the `useMyInvites` shape) and Wallet
  activity per range (`memberReads.walletActivity` + `useKeptReport`). NOT in `readsFor`: lane B's
  `earlyInvites` starts that read at the press — one request, not two. Rendering offline also needs
  the route on `RequireAuth`'s list (integrator).
- **Offline-capable routes** (`RequireAuth`): /my-code, /bookings, /bookings/:id, /wallet, /profile,
  /inbox — offline or while `whoami` is out, for the member this phone confirmed. Only My Code
  renders signed out. The tab bar stays for that member (`AppShell` via `useDataOwner`).
- **Writes offline are refused before sending** (`OfflineError`, "needs a connection … Nothing was
  sent"; also when the page says "You're offline" but `onLine` lies — Inbox Mark all read, R5 M5-5).
  **Nothing is queued** — a booking sent when signal returns could charge for a court taken meanwhile. A grid kept because the club was
  unreachable books nothing (toast); one kept through a 429/5xx still books (the club answers).
- **Reads start with the code (P4-5):** `routeIntent` on a nav link's press/hover/focus; the opened
  page's reads beside `whoami` on a direct load (none for My Code); the result read beside the
  detail when the phone has the booking (a cold deep link with no copy still waits — F2.15 pins
  "a cancelled booking asks no result"). Admin member tabs (/play, bookings) start beside the
  detail, memory only (`adminEarlyReads`). The profile provider waits for the check (`whileChecking: false`).
- **Kept reads come back key by key** (`loadKept`, first subscriber), never the whole store at boot
  (cost a cold My Code ~110 ms). Stale records are deleted once the app settles (15 s, then idle).
- **Measured** (390, slow 4G, 4x CPU, A/B, load 15–40): revisit Bookings 625 → 441 ms; first tap
  Bookings 967 → 786; offline pages 0/4 → 4/4 drawn. Warm My Code +~100 ms — re-measure quietly.

## Traps met

- **`git commit --amend` in a shared tree amends whoever committed last.** Another lane's commit
  landed between this lane's commit and its amend, which took that commit's tree and replaced
  its message. Repaired by amending back to the identical tree and message. Never amend here.
- **Under Playwright's `context.setOffline(true)` the offline Wallet said "Couldn't refresh"**
  when the wording keyed on `navigator.onLine` alone (production-build spec, observed). Offline is
  now judged from the failed read too (`NetworkError`/`OfflineError`), never from `onLine` alone.
- **A page's optimistic write dies with the page; the cached read does not.** Back within `JOIN_MS` the
  stale list is REUSED unread (inbox: tapped notice unread again). Hold such marks at module scope (`inbox/heldMarks`).
