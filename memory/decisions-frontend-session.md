---
name: crusaders-mainframe-decisions-frontend-session
description: "Who is signed in drives every identity-scoped read; a session's ending is held by AuthProvider, not router state; money-moving requests mark balance movements as the member's own. From the 2026-09-29 walk."
type: decision
last_verified: 2026-09-29
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
- **The credits chip never shows a zero while loading** — a neutral skeleton, never the danger
  tone. **Why:** a red "0.00 cr" right after sign-in tells a member they are broke.
- **How the last session ended lives in `AuthProvider`, read once by `/login`, not in router
  state.** **Why:** "Sign out everywhere" navigated to `/login` with a notice in router state;
  `RequireAuth`'s own redirect won the race and the notice never showed — its unit test (a
  stubbed route) passed. A return-to page survives only an expiry followed by the *same*
  member signing back in; a sign-out clears it, so the next person never lands on the last
  person's page. Tested through the real `AuthProvider` + `AppRoutes` in StrictMode.
- **Money-moving requests mark themselves in the API client, and the live balance treats any
  movement during one (or within 3 s after) as the member's own.** Movements they did not
  cause are worded by their ledger reason ("Sam paid you 20.00 cr for their share of Court
  1"); "the club" is said only for the club's own movements. **Why:** booking or accepting an
  invite produced "The club took 20.00 credits off your wallet" — wrong twice when the money
  went to a partner.
- **Server side of the same walk:** a token naming no user row, or a user in another club, is
  401 everywhere — see [`decisions-member-code-rotation.md`](decisions-member-code-rotation.md).
