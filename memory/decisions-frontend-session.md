---
name: technologies-crusaders-squash-control-system-decisions-frontend-session
description: "The PWA's session: identity keys every per-person read; a 401 trades the refresh cookie once, single-flight; a refresh ends it on any 4xx but 408/429 or a superseded 401; a lapse keeps the code's key."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the PWA's session

The server half is [`decisions-sessions.md`](decisions-sessions.md). Most of these were found in the 2026-09-29 headed walk
of P7 + P11 against the real local stack; each had green unit tests and was wrong in the running app.

- **Identity, not "signed in or not", keys every per-person read.** Profile, live balance and its stream, unread count
  and the onboarding gate re-read when the signed-in *user* changes (password, passkey, magic link, account switch). A
  failed profile read is its own `failed` state, never "no profile". *Why:* a leftover token for a user that no longer
  existed made `/me/profile` 404 once; the provider never re-read after the real sign-in, so the avatar fell back to "YA"
  and the first-run wizard never fired.
- **How the last session ended lives in `AuthProvider`, read once by `/login`, not in router state.** *Why:* "Sign out
  everywhere" navigated to `/login` with a notice in router state; `RequireAuth`'s own redirect won the race and the
  notice never showed — its unit test (a stubbed route) passed. A return-to page survives only an expiry followed by the
  *same* member signing back in; a sign-out clears it, so the next person never lands on the last person's page. Tested
  through the real `AuthProvider` + `AppRoutes` in StrictMode.
- **A 401 trades the refresh cookie once** (R1 F4.1): `lib/api` answers a 401 on a request that CARRIED a token with one
  `POST /auth/refresh` (`credentials: "include"`, no bearer), then repeats the request once. Single-flight in the tab and
  behind a Web Lock across tabs; an exchange that finds the stored token already replaced spends nothing. *Why:* the
  cookie rotates and a second spend of one link revokes the family — five screens 401-ing on wake would sign the member
  out everywhere. Never for `/auth/refresh` or `/auth/logout` (the loop), never token-less (a sign-out made offline leaves
  a live cookie; an anonymous 401 must not resurrect it). The bootstrap `whoami` gets the same one rescue; the proactive
  timer still uses the bearer path.
- **What a refresh answer means** (`lib/api.ts:378-382` `refusalOutcome`): a 401 `refresh_superseded` (another tab won
  the rotation) keeps the session; 5xx (except 501), 429, 408, a timeout or no answer are transient — token kept, the
  request fails as unreachable, retried next request / tab-visible with a 1 s → 30 s backoff; **every other answer ends
  the session** — any other 401, every other 4xx, and 501 (no route). *Why:* a redeploy's 503 had signed everyone out.
  *Corrected 2026-11-20:* this topic said "only a 401 from `/auth/refresh` ends a session". Every sign-out moves a session
  generation (memory + `localStorage`); a reply landing after it is discarded and an old session's 401 never clears a
  newer token (another tab's sign-out was undone by this tab's in-flight exchange). Tests needing an ended session stub
  refresh 401.
- **A lapse is not a sign-out** (F4.1, the P7 decision): an ending nobody pressed drops the token and caches (never the
  offline shell) but KEEPS the confirmed identity, the member code's key and the last-known door facts; `/my-code`
  renders signed out from the key, asking the club nothing. Only the sign-out buttons (and a different member signing
  in) wipe them; kept member READS are wiped on a lapse too ([`decisions-frontend-offline-data.md`](decisions-frontend-offline-data.md)).
  *Why:* the D3 wipe-on-expiry turned "signed out after a while" into "locked out at the door"; with a 30-day cookie a
  lapse is rare.
- **The first-run wizard is offered only on a landing a sign-in delivered** (F4.8, router state `{ signedIn: true }` from
  Login). `/my-code` is the app's start URL and the door. The buy step is id `buy`; a stored `topup` resume point maps to
  it (`lib/onboarding.canonicalStep`).
- **The member's own password change adopts the token in the answer** (minted under the new epoch), or the PWA is signed
  out ([`decisions-member-code-rotation.md`](decisions-member-code-rotation.md)).
- **Money-moving requests mark themselves in the API client** so the live balance can tell the member's own movements
  from the club's — narrowed in R18 to "a write in flight makes its reason"
  ([`decisions-frontend-wallet-live.md`](decisions-frontend-wallet-live.md)).
