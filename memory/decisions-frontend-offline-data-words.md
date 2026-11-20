---
name: technologies-crusaders-squash-control-system-decisions-frontend-offline-data-words
description: "How a member screen words offline: You're offline only when onLine is false, else Can't reach the club; a failed refresh never blanks; nothing kept and offline is said as offline, judged from the failed read."
type: decision
last_verified: 2026-11-20
---

# Live decisions — how kept member data words offline and unreachable

Split from [`decisions-frontend-offline-data.md`](decisions-frontend-offline-data.md), which holds the store, the
kept reads and the offline-capable routes.

- **"You're offline" only when `navigator.onLine === false`** (R14 X14-3 / R15 X15-3 — Wi-Fi without internet leaves it
  true; this REVERSED R8's "offline whatever onLine says" wording, not its notice, still never red). A club that cannot
  be reached from a phone with a network is "Can't reach the club — showing what we had at …" (stale notice, in club
  time: R18 X18-3 `asOfLabel` = `clubRowTime` in the kept club zone, for the clock AND for whether it is today), "Can't
  reach the club — your code still works" (pass badge); a nothing-kept line's "once you're back online" tail becomes
  "Try again in a moment" (`unreachableNothingKept`, every line pinned to match `backOnlineTail`); `writeCause` is
  neutral. Swept as a class: the chip's no-figure label, My Code's first visit ("needs the club" vs "needs signal"; an
  offline enrol's `OfflineError` is "needs signal", not "failed") and the grid's book refusal follow it; NOT_SENT /
  `OfflineError` / hold-lift / chunk / ConnectionLost were already gated on `onLine`.
- **A failed refresh never blanks** — offline, 5xx or 429 alike (form-factor review: one 429 swapped a whole screen
  for "The club is busy"). `StaleNotice` says "You're offline" ONLY when the club was never reached — no network, or
  the read/session check got no answer (`DataOwner.unreachable`: whoami's cause is a NetworkError) — and "Couldn't
  refresh" when it answered with a failure. **Why (R5 V5-2):** keyed on `auth.status === "offline"` alone, a whoami
  503 read "You're offline" on Booking detail/Inbox/Profile while Bookings/Wallet said "Couldn't refresh" for the same
  outage.
- **Nothing kept + offline is said as offline (R6 X6-4)**: `OfflineNothingKept` on Inbox, Wallet activity, /wallet/buy,
  /wallet, Invites, a booking's detail, My game, Profile and Bookings, never red "couldn't be reached" — judged from the read
  (owner unreachable / NetworkError) and worded by `onLine` as above. No `online` event comes on Wi-Fi without internet, so FD1b's pages keep the retry beside the notice
  (`bookings/OfflineNothingKeptRetry`); /wallet also re-reads on `online`.

## Traps met
- **Under Playwright's `context.setOffline(true)` the offline Wallet said "Couldn't refresh"** when the wording keyed
  on `navigator.onLine` alone (production-build spec, observed). Offline is now judged from the failed read too
  (`NetworkError`/`OfflineError`), never from `onLine` alone.
