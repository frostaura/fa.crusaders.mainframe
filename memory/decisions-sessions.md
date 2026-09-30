---
name: crusaders-mainframe-decisions-sessions
description: "Sessions outlive the 15-minute access token via a rotating, hashed refresh cookie (B1); every token names its family (rfid, C1); sign-in and the global backstop limit per account, not per club address."
type: decision
last_verified: 2026-09-30
---

# Live decisions — sessions and sign-in limits (review round 1, lane B)

Spec: `docs/specs/feature-spec.md` "A session outlives the access token". Code:
`Security/RefreshSessions.cs`, `Endpoints/SessionCookies.cs`, `Security/SignInAttempts.cs`.
Tests: `RefreshCookieHttpTests`, `SignInRateLimitHttpTests`. Epoch rules: `decisions-member-code-rotation.md`.

- **A session is an httpOnly cookie `crusaders_rt` + a 15-minute bearer.** Set on every sign-in
  (password, passkey, magic link, dev admin) and the member's own password change; `SameSite=Strict`,
  `Secure` outside Development, `Path=/api/v1/auth`, 30 days sliding (`Jwt:RefreshTokenLifetimeDays`,
  1–90 — deployment config like the access TTL, not a tenant setting). *Why:* refresh needed a
  still-valid bearer, so a phone idle 15 minutes — at the door — was signed out.
- **Stored as SHA-256 only, single use, one family per sign-in.** Spending is a conditional UPDATE
  (`UsedAt IS NULL AND RevokedAt IS NULL`), so concurrent presentations mint once. A SPENT token
  presented again revokes the family (replay) — **except within 10 s of being spent**, answered
  `401 refresh_superseded` with nothing revoked and **no Set-Cookie**. *Why the grace:* two tabs of
  one PWA waking together must not sign the member out; *why no clear:* clearing would delete the
  cookie the winning tab just set. It mints nothing, so a thief inside 10 s gains nothing.
- **Epoch-bound, twice over.** Each link stores the `SessionEpoch` it was issued under and the
  exchange refuses one below the account's; every epoch raise ALSO stamps the account's families
  revoked (`MemberCodeService.RaiseSessionEpochAsync`). The stamp is for the record; the epoch
  check is the guarantee (a mutant dropping the stamp survives by design).
- **Tenant-scoped:** a link is looked up by hash, then refused as unknown if its club is not the
  resolved one — the other club's family is not touched. Passkey sign-in issues in the passkey's club.
- **CSRF argument:** the cookie is read only by `POST /auth/refresh` (mints a token into the
  response body — no cross-site reader) and `POST /auth/logout` (can only end the session). Both
  routes are anonymous-capable: logout with an expired bearer must still end the cookie's family.
- **A bearer refresh with no cookie starts a family** — sessions from before B1 upgrade silently.
- **Proxies:** nginx and the Vite proxy forward `Set-Cookie` untouched (no `Domain` attribute). Over
  plain http on a LAN IP, Safari drops `Secure` cookies: those sessions fall back to 15 minutes.
- **Sign-in is limited per ACCOUNT** (`SignInAttempts`: `AuthPerMinute`, 10, per club + address
  typed, per purpose — login and reset separately); the per-address bucket on the `sign-in` policy
  is a ceiling (`AuthPerIpPerMinute`, 60). *Why:* the whole club shares one Wi-Fi address; guessing
  is against an account. An unknown address is limited like a known one — no oracle.
- **Every access token names its refresh family — claim `rfid` (review round 2, C1).** Bound at
  every hand-out (sign-ins, passkey, password change, both refresh paths) by re-signing the minted
  token. A bearer refresh whose family is ended is `401 session_ended`, **no Set-Cookie** (the jar
  may hold a newer family). *Why:* tab B's live bearer refreshed after tab A signed out, found no
  cookie and STARTED a family — the session came back. Live = no link revoked AND one unexpired —
  never "an unspent link exists", which is false for a moment mid-rotation. Sign-out revokes the
  cookie's family and the bearer's. Mutation-checked (7 mutants, `RefreshCookieHttpTests`).
  **And refused on EVERY route** (`RefreshFamilies`, in `OnTokenValidated` beside the epoch):
  ended = any link revoked or no such family; cached 15 s per family, evicted by every revoke
  after it commits. *Why:* tab B's bearer, and the token a refresh racing the sign-out minted,
  kept /wallet open 15 minutes. No `rfid` (pre-C1 token) = untouched. 4 more mutants killed.
- **The global backstop is per MEMBER** (B-10): `GlobalPerMinute` (600) per signed-in user;
  anonymous requests per address at `GlobalPerIpPerMinute` (6000). 429 = `rate_limited` +
  `retry_after_seconds`. *Why:* 600 per address 429'd a whole club behind one router.
