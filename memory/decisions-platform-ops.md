---
name: technologies-crusaders-squash-control-system-decisions-platform-ops
description: "Health, errors, logs, webhooks, SSRF, biometric: /healthz liveness vs /readyz readiness, a bad body is a coded 400 never a 500, capped logs, a redacted gateway log, webhook rows before attempts, the simulator gated to Development."
type: decision
last_verified: 2026-11-20
---

# Live decisions — health, errors, logs, webhooks and the biometric seam

Spec: `docs/specs/deployment.md` "Health, logs and knowing what runs", `webhooks.md`, `biometric-abstraction.md`.
Mostly the 2026-11-13 backend-platform pass. Capacity and 503s: [`decisions-backend-capacity.md`](decisions-backend-capacity.md).

- **`/healthz` stays liveness, `/readyz` touches the database** (SELECT 1, 2 s; `Endpoints/HealthEndpoints.cs:44,53`).
  *Why two:* restarting a live API because Postgres blinked adds an outage. Both compose files' backend healthchecks
  use `/readyz` (truthful in Portainer; Docker does not restart on unhealthy). The external uptime monitor that would
  make the ≥99.5 % launch-bar number real is an ops step nothing in the repo can be ([`launch-bar.md`](launch-bar.md)).
- **`revision` comes from `ARG BUILD_SHA` → `SourceRevisionId`**, CI passes `github.sha`; images before 2026-11-13 have
  none ([`gotchas-ops.md`](gotchas-ops.md)).
- **A caller's bad body is a coded 400 on every route** (R15 D15-3): `UseStableInternalErrors` sets
  `RouteHandlerOptions.ThrowOnBadRequest = true` in every environment and answers `BadHttpRequestException` / a body
  `JsonException` — device routes `malformed_body`, others `invalid_body`, `bad_request` for a route/query value; 413
  `body_too_large`, 415 `unsupported_media_type`. *Why:* Development threw (500) while the rest answered an empty 400.
- **A value PostgreSQL cannot store is the caller's, never a 500** (R16 D16-1): `Security/StorableText.
  RefuseUnstorableText()` on the auth, admin-device and webhook groups refuses a NUL (400 `invalid_body`;
  `bad_request` for a route/query string); columns are checked by name where a route writes them (`url_too_long`,
  `event_filter_too_long`, `description_too_long`, `email_too_long`, `membership_number_too_long`, each with
  `max_length`); the stable-error handler maps SQLSTATE 22001/22021 anywhere in the chain to 400 (`malformed_body` on
  a device route). *Why:* a NUL in a login email 500'd from the lookup's parameter alone. Device bodies stay lenient
  ([`decisions-device-bodies.md`](decisions-device-bodies.md)).
- **Logs**: EF and request lines at Warning in the base file (Production ran at Information, ~50 MB/day idle; request
  lines too, because their query strings carried stream tickets, BM-22); every compose service logs through a capped
  json-file anchor (10m × 5; named `x-capped-log` in `docker-compose.yml`, `x-logging` in `docker-compose.prod.yml:51`).
- **Gateway access log is `crusaders_redacted`** (`nginx/nginx.conf:42,65`): two maps blank `?ticket=` and the token
  segment of the one-time-link and invite paths; no referrer. The document CSP gained `img-src 'self' data: blob:` (old
  rows with outside photo URLs stay dark).
- **Webhooks: rows before attempts.** Deliveries are saved `pending` with a 2-minute grace for the retry sweep, then
  attempted concurrently, four events in flight. *Why not a full outbox at emit time:* every `EmitAsync` caller would
  have to join its business transaction; the residual window (channel → first save) is milliseconds. Backoff
  1m/5m/30m/2h/12h/24h, auto-disable at 6 failures (`WebhookSender.cs:42-46,98`); a CLUB endpoint's disable stages
  `webhook.auto_disabled` to its admins in the same save (`StageDisabledNotice`, `:131-134`).
- **Member-owned webhooks are retired** (BP-08): no route creates one (`Domain/Webhook.cs:6`; only
  `/api/v1/admin/webhooks` remains), delivery filters to tenant endpoints (`WebhookDeliveryWorker.cs:96`), the table
  still has `OwnerKind`/`OwnerUserId`. The member-owned exclusion from the LAN carve-out (`webhooks-member` client,
  `honourAllowList: false`) is now dormant. Stale product comments still describe member webhooks (`Program.cs:582-583`)
  and the carve-out as "for the lights controller / court box" (`OutboundAddressGuard.cs:11,70-73`) — the box is
  pull-only; CLAUDE.md's rationale (club LAN consumers) is the true one.
- **SSRF**: `Webhooks:AllowPrivateNetworks` is true in `appsettings.Development.json` only (base `false`; the code
  default `env.IsDevelopment()` was otherwise dead; `R13WebhookPrivateNetworkConfigTests` reads the shipped files); the
  LAN carve-out is `Webhooks:PrivateNetworkAllowList`. NAT64, 6to4 and IPv4-compatible IPv6 are judged as their embedded
  IPv4; Teredo and 64:ff9b:1::/48 are refused outright.
- **The courtside PIN/QR match routes stay** (correct identity, the desk's fallback); only the biometric simulator was
  dangerous: `Biometric:Driver=Null` is honoured in Development/Testing only (`NoBiometricDevice.cs:57`); everything
  else is `NoBiometricDevice` (base appsettings `None`; tests `UseSetting` Null).
- **Unique violations are `503 conflict_retry`** ([`decisions-booking-races.md`](decisions-booking-races.md)); BP-16's
  real case — a duplicate passkey — is refused by the ceremony's own check, so its retry cannot loop.
