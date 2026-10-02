---
name: crusaders-mainframe-decisions-frontend-session
description: "Identity keys every per-person read; a 401 trades the refresh cookie once, single-flight; only a refresh 401 ends a session; a lapse keeps the member code's key (only sign-out wipes it); every chunk precached; the chip shows spendable."
type: decision
last_verified: 2026-10-02
---

# Live decisions — the PWA's session and balance feedback

Found in the 2026-09-29 headed walk of P7 + P11 against the real local stack. Each had green
unit tests; each was wrong in the running app.

- **Identity, not "signed in or not", keys every per-person read.** Profile, live balance and
  its stream, unread count and the onboarding gate re-read when the signed-in *user* changes
  (password, passkey, magic link, account switch). A failed profile read is its own `failed`
  state, never "no profile". **Why:** a leftover token for a user that no longer existed made
  `/me/profile` 404 once; the provider never re-read after the real sign-in, so the avatar fell
  back to "YA" ("Your account") and the first-run wizard never fired.
- **The minutes chip never shows a zero while loading** (a skeleton). **Why:** a red "0 min" says broke.
- **How the last session ended lives in `AuthProvider`, read once by `/login`, not in router
  state.** **Why:** "Sign out everywhere" navigated to `/login` with a notice in router state;
  `RequireAuth`'s own redirect won the race and the notice never showed — its unit test (a
  stubbed route) passed. A return-to page survives only an expiry followed by the *same*
  member signing back in; a sign-out clears it, so the next person never lands on the last
  person's page. Tested through the real `AuthProvider` + `AppRoutes` in StrictMode.
- **Money-moving requests mark themselves in the API client, and the live balance treats any
  movement during one (or within 3 s after) as the member's own.** Movements they did not
  cause are worded by their ledger reason ("Sam paid you 20 min for their share of Court
  1"); "the club" is said only for the club's own movements. **Why:** booking or accepting an
  invite produced "The club took 20 credits off your wallet" (pre-P13 wording) — wrong twice when the money
  went to a partner.
- **A 401 trades the refresh cookie once (R1 F4.1, contract §1; server half in
  [`decisions-sessions.md`](decisions-sessions.md)).** `lib/api` answers a 401 on a request that
  CARRIED a token with one `POST /auth/refresh` (`credentials: "include"`, no bearer), then repeats
  the request once. Single-flight in the tab and behind a Web Lock across tabs, and an exchange that
  finds the stored token already replaced spends nothing. **Why:** the cookie rotates and a second
  spend of one link revokes the family — five screens 401-ing on wake would sign the member out
  everywhere. Never for `/auth/refresh` or `/auth/logout` (the loop), never token-less (a sign-out
  made offline leaves a live cookie; an anonymous 401 must not resurrect it). The bootstrap
  `whoami` gets the same one rescue. The proactive timer still uses the bearer path.
- **Only a 401 from `/auth/refresh` ends a session (R2 C2); a late reply never resurrects one (C1).**
  5xx/429/408/timeout/no answer = transient: token kept, the request fails as unreachable, retried
  next request/tab-visible, 1 s→30 s backoff (501 = ended: no route). Every sign-out moves a session
  generation (memory + `localStorage`); a reply landing after it is discarded, and an old session's
  401 never clears a newer token. **Why:** a redeploy's 503 signed everyone out; another tab's sign-out
  was undone by this tab's in-flight exchange. Tests needing an ended session must stub refresh 401.
- **A lapse is not a sign-out (F4.1, the P7 decision).** An ending nobody pressed drops the token
  and caches (never the offline shell — R5 M5-1) but KEEPS the confirmed identity, the member code's key and the last-known door
  facts; `/my-code` renders signed out from the key, asking the club nothing. Only the sign-out
  buttons (and a different member signing in) wipe them. **Why:** the D3 wipe-on-expiry turned
  "signed out after a while" into "locked out at the door"; with a 30-day cookie a lapse is rare.
- **Every chunk is on the phone (F4.3)** — install caches `precache.json`'s `first` (member pages,
  4 lanes); the desk's follow after claim (2 lanes; a sign-out stops them). A slow install is no
  offline. A failed chunk: own boundary + Retry; online, one reload per 5 min (looped).
- **The first-run wizard is offered only on a landing a sign-in delivered (F4.8)** — router state
  `{ signedIn: true }` from Login. `/my-code` is the app's start URL and the door. **No court-box
  fingerprint step** (slot `enabled: false`): the box doesn't read fingerprints yet (Dean, 2026-10-01); passkeys are app sign-in only. The buy step is id `buy`; a stored `topup` resume point maps to it (`lib/onboarding.canonicalStep`).
- **The minutes chip (`components/shell/MinutesChip.tsx`, `data-minutes-chip`) shows SPENDABLE (F1.11)**, naming the whole and the held/owed parts —
  supersedes D11 §3a's "the figure stays the whole balance" (550 shown, a 520 booking refused). Its flyout (R3 M-1) is the NET change of that figure over a burst of frames under 1 s apart — a split cancel's last frame read −33 while the chip rose 100.

