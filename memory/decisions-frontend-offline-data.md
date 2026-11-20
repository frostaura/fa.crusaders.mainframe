---
name: technologies-crusaders-squash-control-system-decisions-frontend-offline-data
description: "Member reads kept per member in IndexedDB (never the worker cache), wiped on any ending or switch; drawn at once, refreshed behind; offline-capable routes; offline writes refused, never queued."
type: decision
last_verified: 2026-11-20
---

# Live decisions — offline & instant member data (R4 wave B, lane D)

Extends the privacy rule in [`decisions-frontend-offline-shell.md`](decisions-frontend-offline-shell.md): the worker
still caches NO member data. Code: `src/frontend/src/lib/offline/`. How offline and unreachable are WORDED, and a
failed refresh that never blanks: [`decisions-frontend-offline-data-words.md`](decisions-frontend-offline-data-words.md).

- **One app-level store, keyed by member** (`queryCache` in memory + `memberStore`, IndexedDB
  `crusaders-member-data`). **Why not the worker:** the Cache API keys on the URL, ignores the token and belongs to
  the browser profile — a shared desk tablet served one member's wallet to another.
- **Wiped on sign-out, "sign out everywhere", a lapse, and a different member confirmed** (`lib/auth`: `endLocally`,
  `endTakenAway`, `rememberIdentity`). The lapse wipes too (unlike the code's key): kept reads open no door, and a
  signed-out phone must not show a wallet. A read landing after a wipe/switch is dropped (generation); a write to the
  phone needs the guard (token + confirmed identity in storage, read at write time — another tab's sign-out stops it).
  14-day ceiling.
- **Stale-while-revalidate** (`useCachedRead`): a revisit or warm start draws the kept answer at once with its "as
  of", the club is asked behind it, and a read in flight is joined (one request per key — StrictMode's second mount
  joins too, so tests counting first reads changed).
- **Kept since R5 (M5-6):** the open invites (`useKeptInvites`, the `useMyInvites` shape) and Wallet activity per
  range (`memberReads.walletActivity` + `useKeptReport`). NOT in `readsFor`: lane B's `earlyInvites` starts that read
  at the press — one request, not two. Rendering offline also needs the route on `RequireAuth`'s list (integrator).
- **Offline-capable routes** (`RequireAuth.tsx:28-45` `OFFLINE_CAPABLE`): /my-code, /bookings, /bookings/:id (which
  also matches /bookings/invites), /wallet, /wallet/activity, /wallet/buy (never /wallet/buy/:id), /profile, /inbox —
  offline or while `whoami` is out, for the member this phone confirmed. Only My Code renders signed out. The tab bar
  stays for that member (`AppShell` via `useDataOwner`). `/profile/results` is NOT offline-capable: nothing of it is
  kept.
- **Writes offline are refused before sending** (`OfflineError`, "needs a connection … Nothing was sent"; also when
  the page says "You're offline" but `onLine` lies — Inbox Mark all read, R5 M5-5). **Nothing is queued** — a booking
  sent when signal returns could charge for a court taken meanwhile. A grid kept because the club was unreachable
  books nothing (toast); one kept through a 429/5xx still books (the club answers).
- **Reads start with the code (P4-5):** `routeIntent` on a nav link's press/hover/focus; the opened page's reads
  beside `whoami` on a direct load (none for My Code); the result read beside the detail when the phone has the
  booking (a cold deep link with no copy still waits — F2.15 pins "a cancelled booking asks no result"). Admin member
  tabs (/play, bookings) start beside the detail, memory only (`adminEarlyReads`). The profile provider waits for the
  check (`whileChecking: false`).
- **Kept reads come back key by key** (`loadKept`, first subscriber), never the whole store at boot (cost a cold My
  Code ~110 ms). Stale records are deleted once the app settles (15 s, then idle).

## Traps met
- **A page's optimistic write dies with the page; the cached read does not.** Back within `JOIN_MS` the stale list is
  REUSED unread (inbox: tapped notice unread again). Hold such marks at module scope (`inbox/heldMarks`).
