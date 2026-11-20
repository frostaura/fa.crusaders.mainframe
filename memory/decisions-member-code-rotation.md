---
name: crusaders-mainframe-decisions-member-code-rotation
description: "Every rotation ends every open session by a per-user epoch (not a time), raised before and after the save; the desk's reset drops passkeys, sign-out-everywhere does not; a token naming no account in its club is refused."
type: decision
last_verified: 2026-09-29
---

# Live decisions — rotating a member's secret, and the sessions it ends

Oracle `docs/specs/member-code.md` §10, §13. The server's code decisions are
[`decisions-member-code-backend.md`](decisions-member-code-backend.md); the rollout phases and the cut-over are
[`decisions-member-code-rollout.md`](decisions-member-code-rollout.md); the refresh-cookie side is
[`decisions-sessions.md`](decisions-sessions.md).

- **Any rotation — admin code reset, password change or reset, admin temp password, suspension, sign out everywhere —
  ends every open session by raising `users.SessionEpoch`** (`UPDATE … +1`, committed at once, before the new
  generation); tokens carry `sep`, none = 0. *Why:* the reset is the desk's "I lost my phone" button, and the phone's
  open PWA could re-enrol for the NEW secret. *Why an epoch, not a time:* the first cut-off INSTANT let a refresh inside
  the rotation read no cut-off and mint a token dated after it, which survived and enrolled (refuted 2026-09-28).
  Refresh refuses a presented epoch below the row and mints with the value it read.
- **The epoch is raised TWICE: before the caller's save and again after it commits** (`CompleteRotationsAsync`, called
  by every rotating route). *Why:* until the save commits the old password and the lost phone's passkey still work,
  and a sign-in in that gap was minted under the first raise and survived (refute round 2). Own new token is minted
  from the second value.
- **Checked in the bearer handler, cached 15 s like `LiveAdminRole`, evicted by the increment; refresh reads the row;
  enrolment reads the epoch `FOR SHARE` in the code row's transaction.** *Why:* the increment then waits for an
  enrolment in flight, so an old session gets the old secret or a 401, never the new one. Open SSE streams re-ask per
  frame and close.
- **A token naming no account in its club is refused (401) by the same check** — row missing, or the user id lives
  under another tenant; cached 15 s like any answer; no subject/tenant claim is refused too; a rejected `?ticket=`
  counts as a rejected bearer (401, not 400). *Why:* the lookup's miss read as epoch 0, so after a local DB wipe an old
  token passed — `/me/profile` 404, `/me/door` 200 (headed walk 2026-09-29) — and a cross-club token was a member
  session. Nothing deletes a user row or reuses an id, so there is no eviction to add; **a future delete/erase path
  must call `SessionEpochs.Invalidate` after its commit.**
- **The desk's reset removes passkeys by default; sign-out-everywhere does not** (`revoke_passkeys` overrides both;
  answers say). *Why:* a lost phone's passkey signs back in under the new epoch; a member signing out a stray tablet
  should keep the passkey on the phone in hand. The desk's reset requires a reason, is on the change record and mails
  the member ([`decisions-change-record.md`](decisions-change-record.md)).
- **The member's own password change keeps its session**: the answer carries `access_token` minted under the new
  epoch. *Why:* signing a member out for changing their password punishes the responsible act. The PWA must adopt the
  token or it is signed out.
- **A demo crossing back is epoch-bound too**: the way back from a demo club works only while the real account's
  `SessionEpoch` equals the one stamped at entry ([`decisions-demo-mode.md`](decisions-demo-mode.md)).
