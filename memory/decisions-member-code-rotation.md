---
name: crusaders-mainframe-decisions-member-code-rotation
description: "Every member-code rotation ends every open session (SessionsValidAfter, 15 s cache, refresh/enrol read the row); a manual rollback holds the rollout; only acknowledged boards vote; master key policy."
type: decision
last_verified: 2026-09-28
---

# Live decisions — rotation, sessions and the rollout (P7 backend review fixes)

Oracle `docs/specs/member-code.md` §10, §13; code decisions beside this are
`decisions-member-code-backend.md`.

- **Any rotation — admin code reset, password change or reset, admin temp password, suspension,
  sign out everywhere — ends every session minted before it** (`users.SessionsValidAfter`,
  whole ms; tokens carry `iat_ms`). *Why:* the reset is the desk's "I lost my phone" button, and
  the phone's open PWA could simply re-enrol and be handed the NEW secret (proved by review
  2026-09-28). A member without a code row is still cut: a password change must end sessions
  whether or not a phone ever enrolled.
- **Checked in the bearer handler, cached 15 s per account like `LiveAdminRole`, evicted by the
  rotation's own save; refresh and enrolment read the row.** *Why:* every request paying a DB
  read was rejected, but those two routes outliving a stale cache would mint a token that passes
  for ever or hand out the secret — the whole point of the rotation.
- **The member's own password change keeps its session**: the answer carries a fresh
  `access_token` and the presented one is dead. *Why:* signing a member out for changing their
  password punishes the responsible act. The PWA must adopt the token or it is signed out.
- **`POST /api/v1/me/sessions/revoke-all`** is sign-out-everywhere: a rotation, caller included.
- **A manual BACKWARD phase move sets `member_code_manual_hold` (+ by, at); the heartbeat never
  moves forward while it is set**, and only a forward move by hand (or clearing it) lifts it.
  Back to `v1` restamps the cut-over and clears the cut-off. *Why:* every board still speaks
  `codes:m1` after a rollback, so the next heartbeat undid it within a minute — and an old
  cut-over date re-fired the cut-off at once.
- **Only ACKNOWLEDGED enabled boards vote on the cut-over** (court box acknowledged by an admin,
  door with a `gate_key` — the same test that decides who gets keys). *Why:* auto-registration
  admits any MAC holding the club's device key: counted, a bench spare on old firmware blocked
  the club for ever, and a stranger flashing `codes:m1` could cast the deciding vote.
- **Master key: lenient only in Development**; everything else refuses published keys (dev,
  the test host's old constant, the corpus fixture key — pinned to `derivation.json` by a test)
  and keys with fewer than 16 distinct bytes. The test host injects a random key per process.
  *Why:* each published key passes every length rule, and a rule the test host is exempt from is
  a rule no test proves.
