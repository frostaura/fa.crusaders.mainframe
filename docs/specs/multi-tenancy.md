# Multi-tenancy Specification

The system is multi-tenant from day one. Every persisted entity carries a `tenant_id`. Cross-tenant data leakage is treated as a P0 security incident.

## Identity model
- `Tenant` — the club. Has a unique slug, display name, brand assets (logo, accent color), `peach_payments_account_id`, `cloudflared_hostname`, status.
- `Tenant.Status` — `active`, `onboarding` or `suspended` (`TenantStatus`). `TenantResolutionMiddleware` serves `active` and `onboarding` alike and answers every tenant-scoped request to a `suspended` club — member, admin or anonymous — `403 club_suspended`; **any other value is closed too** (fail closed). Only the operator CLI changes it. The slug cache carries it, so a change applies within five minutes (`SlugCacheFor`), at once after a restart.
- `Tenant.PublicBaseUrl` — the club's own address when it is not the derived one (below). Null for almost every club.
- `User` — a person. **Belongs to exactly one tenant, always.** A person who is a member of two clubs has two `User` rows, one per tenant. Email may be the same across rows; `(tenant_id, email)` is unique. There is no platform-wide account: the `is_platform_admin` flag and the `platform_admin` role were minted for years and checked by nothing, and were removed (BP-13, migration `PlatformTenantOnboarding`).
- **Inherent admins are deployment-wide (BP-21).** `Admins:Emails` (appsettings, deployment-owned) makes an address a club admin, at sign-in, in **every** club where that address holds an approved, verified account. It never creates an account in a club and never skips the club's approval. It is deliberate — one operator runs the deployment — and a second club's committee must be told before it goes live: whoever controls a listed mailbox can become an admin of their club by joining it.
- `Membership` — the player profile fields specific to that tenant (membership number, photo URL, status, joined-at).

## Routing
- A request's club is, in order: the one its token names; else the first label of its `Host` (`kestrel.frostaura.net` → `kestrel`; `www`, `admin`, IP literals and single-label hosts carry none); else — only on the anonymous auth, upload and invite routes — `Tenancy:DefaultTenantSlug`. A token naming one club and a host naming another is `403 tenant_mismatch`. There is no header-based resolution.
- **A club's address is that rule run backwards (BP-03, `Services/TenantLinks.cs`).** Every link the product writes — verify, reset, welcome, admin notices, PayFast's return and cancel — goes to the deployment's `App:PublicBaseUrl` with the club's slug as the first host label (`https://crusaders.frostaura.net` → `https://kestrel.frostaura.net`; `http://localhost:8088` → `http://kestrel.localhost:8088`); the default club keeps the deployment's own address. A club reached elsewhere carries `Tenant.PublicBaseUrl`, which the CLI accepts only when its host resolves back to that club. Before this every club's links went to the first club's host, where the second club's one-time tokens do not exist — nobody at club #2 could confirm an address, reset a password or take the welcome link.
- Every club's host must route to the stack (DNS and the Cloudflare tunnel's public hostnames); that is an operator step at onboarding, not code.

## Data isolation
- **Every query goes through a tenant-scoped DbContext.** EF Core global query filters enforce `tenant_id == current_tenant_id` on every entity. Bypass requires an explicit `IgnoreQueryFilters()` call, reserved for work above any one club: workers sweeping every club, startup, and the operator CLI.
- **Every API endpoint resolves the tenant first** — from the JWT (which embeds `tenant_id` as a claim) and the `Host` header, asserting they agree. Mismatch = 403.
- **Storage:** uploaded files (player photos, receipts) live in a per-tenant prefix (`uploads/<tenant_slug>/<entity>/<id>`). Signed URLs expire and are scoped to the tenant.
- **Per-tenant secrets:** PeachPayments credentials, webhook signing keys, branding assets, SMTP-from-name. Stored in a `tenant_secrets` table encrypted at rest with a per-tenant data-encryption key wrapped by a master key in env.

## Tenant settings (configurable by tenant admin)
All "configurable" knobs from the brief live here. Default values are the Crusaders working assumptions.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `court_count` | int | 4 | Each court has its own row in `courts`; this is informational. |
| `slice_minutes` | int (15/30/60) | **15** | Crusaders default per blueprint B.4. Configurable per tenant. |
| `slice_price_credits` | int per court | 8 | Per-court pricing in credits (whole credits, not ZAR — see blueprint A.8/A.9). |
| `credits_per_zar_regular` | decimal(8,4) | 1.6000 | R100 → 160 credits (blueprint A.8) — the rate for a member none of whose groups sets one. |
| ~~`credits_per_zar_league`~~ | — | — | **Removed (D2).** The league rate is the league group's `credits_per_zar` (`member_groups."CreditsPerZar"`, default 2.4 for a new club); migration `GroupsReplaceClass` moved it there and the settings PUT refuses the key with `credits_per_zar_league_moved_to_groups`. |
| `topup_block_zar` | decimal(10,2) | 100.00 | Top-ups must be a multiple of this (blueprint A.3). |
| `topup_max_zar_per_member` | decimal(10,2) | 1000.00 | Per-top-up cap for non-admin users (blueprint A.3). |
| `member_per_day_max_minutes` | int | 60 | Per-member-per-day booking cap (blueprint A.4 / B.3). Same-day relaxation. |
| `peak_hours` | string | `16:00-19:00` | Peak window reserved for members with peak priority — granted by groups since D2 (blueprint A.12). |
| `peak_advance_hours_for_regular` | int | 1 | Inside this many hours of a peak slot, regular members can also book if free. |
| `retention_years` | int | 2 | Auto-anonymise usage history older than this (blueprint D.1). |
| `penalty_pct` | decimal(5,2) | 30.00 | Applied to slice price on no-show / late cancel. |
| `grace_window_minutes` | int | 5 | Time after slice start before no-show is finalized. |
| `penalty_window_minutes` | int | 15 | Time before slice start during which cancellations incur penalty. |
| `advance_booking_days` | int | 14 | How far ahead players can book. |
| `operating_hours` | json | `{mon-sun: 06:00-22:00}` | Per-weekday open/close. |
| `brand_logo_url` | string | tenant default | Used in app + emails + receipts. |
| `brand_accent_hex` | string | `#00498D` (Crusaders crest blue) | **Not currently read by anything.** Intended to drive the accent tokens, but nothing in the frontend fetches it — see the accent note in `design-system.md`. The previous default `#7AB07A` measures 2.52:1 on white and is unusable for text or focus rings. |
| `peach_account_id` | string | — | Required before top-ups can be enabled. |
| `webhook_signing_secret` | string | auto-generated | Rotatable. |

## The club's identity in the member app (go-live FM-8)

The app's own chrome names the club an address serves, from tenant data, never a literal:

- **`GET /api/v1/auth/club`** → `{ "slug", "name" }`. Anonymous and tenant-scoped (the `/api/v1/auth/` prefix: JWT, then the host's subdomain, then `Tenancy:DefaultTenantSlug`); a token naming one club on another club's host is the middleware's 403. `name` is `Tenant.DisplayName` through `ClubIdentityResolver` — the source the club's emails use — and `"the club"` for a nameless row. Nothing from the settings, no contact detail.
- **The frontend** (`lib/clubIdentity.ts`) reads it once per page load and keeps it in `localStorage` (per origin, so per club). The crest link, the sign-in band and brand panel, the pass band and the tab title carry it; while unknown they carry **no** name (the crest is "Home", the tab is the page alone), never another club's. A failed read keeps what the phone knew.
- **Club content is per slug** until the API serves a profile: the sign-in panel's place line and facts (`lib/clubProfiles.ts`) and the public landing (`clubs/<slug>/`, chosen in `pages/Home.tsx`). A club with neither gets facts true at any club and the generic landing under its own name.
- **Not yet per club** (declared): the static shell served before any script — `index.html`'s title/meta/OG/JSON-LD, `public/manifest.webmanifest`, `SITE_ORIGIN` — is the first club's (`APP_NAME`, held by `seo-posture.test`); serving it per host is a gateway/nginx job. The crest mark is drawn, not `brand_logo_url`.

## Onboarding a new tenant (BP-07)

There is no HTTP surface for it, by decision: an account above every club would be worth more than any one club's admin and reachable from the internet. The operator runs the CLI inside the backend container, where only somebody who can already run commands on the host can reach it:

```bash
docker compose exec backend dotnet Crusaders.Mainframe.Api.dll tenant create \
  --slug kestrel --name "Kestrel Squash" --admin-email chair@kestrel.example [--courts 4] \
  [--timezone Africa/Johannesburg] [--public-base-url https://kestrel.example.net] [--print-link]
```

1. `create` makes the `Tenant` (`active`), its opening settings (the bootstrap's document in the club's zone), its courts, its two groups and its opening minute packages, and the first admin — **with no password**. The admin is mailed a set-your-password link (a password-reset token, 72 h) on the club's own address; using it proves the address. Nobody is ever handed a password; `--print-link` prints the link too, for a deployment whose mail is not working yet (it is a credential).
2. The operator points the club's host at the stack (DNS, the tunnel's public hostname).
3. The admin signs in and sets the club up in the console: hours, packages and groups, courts, the PayFast account (the club's own, set by its admins), webhooks.

Other commands: `tenant list`, `tenant suspend --slug`, `tenant activate --slug`, `tenant set-url --slug (--public-base-url <url> | --clear)`. Each is idempotent where it can be and refuses rather than guesses where it cannot (an existing slug, a slug that cannot be a host label, an address that would not resolve back to the club). Source: `Persistence/TenantCli.cs`.

Target operator-time: <2 hours from `tenant create` to "first member can register and book." This is a measurable success criterion.

## Suspension

`tenant suspend` closes the club to everybody in it on every tenant-scoped route (`403 club_suspended`), within five minutes on a running API. Nothing is deleted: balances, bookings and the ledger are untouched, and `tenant activate` reopens it as it was. The device surface authenticates by device key, not by this middleware — closing a suspended club's boxes is owed by the device lane (see `memory/decisions-platform-pass.md`).

## Test posture
- **Cross-tenant injection tests are non-optional.** For every endpoint, a test exists that authenticates as Tenant A and attempts to mutate / read Tenant B's data. Expected outcome: 403 or empty result, never partial leakage.
- **Migration safety:** any schema change touching a tenant-scoped table must include the `tenant_id` column in indexes used by query filters; a migration test verifies this.
