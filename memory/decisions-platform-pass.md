---
name: crusaders-mainframe-decisions-platform-pass
description: "Backend-platform pass 2026-11-13: club status enforced, per-club link addresses, operator CLI instead of a platform account, approval waits for a confirmed address, one answer to every application."
type: decision
last_verified: 2026-11-13
---

# Live decisions — tenancy, onboarding and accounts (backend-platform pass)

Branch `fix/backend-platform`. Specs: `docs/specs/multi-tenancy.md`, `feature-spec.md` §1–3.
Tests: `PlatformPassHttpTests` (+Tenancy +Links +Registration +Uploads +Credentials +Operator),
`PlatformPassUnitTests`. Migration `PlatformTenantOnboarding`.

- **Onboarding is a CLI, never an HTTP surface** (`Persistence/TenantCli.cs`, `tenant create|list|
  suspend|activate|set-url`). Why: an account above every club is worth more than any club's admin
  and would sit on the internet; the container is reachable only by whoever already runs the host.
  The `platform_admin` role and `users.IsPlatformAdmin` were minted and never checked — removed, not
  wired. The first admin gets **no password**: a 72 h reset link sets one and proves the address.
- **PayFast credentials are not the CLI's**: the money lane owns that surface (BM-4); an earlier
  draft of this lane wrote a credentials endpoint and it was removed to avoid two writers.
- **`Tenant.Status` fails closed.** Unknown values are suspended; `onboarding` is served like `active`.
  The status rides the 5-minute slug cache, so a CLI change lands within 5 min (restart: at once).
  The device surface does not pass this middleware — closing a suspended club's boxes is owed by
  the device lane (key resolver).
- **A club's address = the resolution rule run backwards** (`Services/TenantLinks.cs`): slug into
  the first host label of `App:PublicBaseUrl`; `tenants.PublicBaseUrl` overrides, accepted only if
  its host resolves back to the club. Why not "the request's host": workers and the CLI have no
  request, and a forged Host header must never pick where a reset link goes.
- **Approval waits for a confirmed address** (BP-02, reverses the old "review is not gated" rule).
  Why: the password is chosen by whoever typed the address; approving first let a stranger keep a
  working password on the real owner's account after the welcome link. Defence in depth: a welcome
  link used on an unconfirmed account nulls its password; a reset link confirms the address.
- **Every well-formed application answers the same 200**, and the mailbox is told the truth (verify
  link / "you already have an account" / "number already registered"). Why: the 409s were an account
  and membership-number oracle while forgot-password was careful not to be. Cost: the screen cannot
  say "that number is taken" — the applicant reads it in their inbox. Unknown-address sign-in pays a
  decoy PBKDF2 hash.
- **A photo is mandatory at the API** and must be one this club's upload issued, on disk, nobody
  else's. The upload sniffs bytes, sits under the auth limit (so a registration costs two of the 10
  a minute per address), caps a club's 2-hour intake (`Uploads:RecentBytesPerClub`, deployment
  config like the rate limits, not `tenant_settings`: it protects the shared disk) and
  `PhotoOrphanSweepWorker` deletes unreferenced files after `Uploads:OrphanAfterMinutes`.
- **Passkeys** are under the sign-in limit, their challenges in a bounded store that refuses new
  ceremonies and never evicts live ones (`CompactionPercentage = 0`), and add/remove mails the member.
- **One-time tokens travel in bodies** (`POST /auth/verify-email|magic-link {token}`); path forms
  kept for older pages. A session token in `?ticket=` is refused.

## Gotchas

- `TestPhotos.RegisterAsync` is how a test registers now; a test posting `photoUrl: null` passes
  any duplicate-handling assertion on `400 photo_required` for the wrong reason (one did).
- In tests `App:PublicBaseUrl` is `http://localhost:8088`, so a non-default club's links are
  `http://<slug>.localhost:8088/…`; a probe for a bare `/crusaders` matches `//crusaders.localhost`.
