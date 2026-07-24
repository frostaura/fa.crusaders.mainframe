# Development Plan — Crusaders Mainframe

The phased build plan from "scaffold on disk" (where we are) to "Crusaders Squash Club uses this in production" (where we're going). Specs in [`./specs/`](./specs/) are the contract; this document is the sequence and acceptance criteria.

This plan is **dependency-ordered, not calendar-bound**. FrostAura cadence is real-time AI-driven (see root `docs/operating/cadence.md`). Sizes are relative (S / M / L / XL); the critical path is called out explicitly.

---

## Operating principles

These hold across every phase:

1. **Spec-driven.** Every behaviour change has a spec change. If a spec describes a feature, it must exist in code. If code changes behaviour, the spec must update in the same commit. Drift is blocking.
2. **Tenant isolation is structural.** Every persisted entity carries `tenant_id`. Every API endpoint resolves the tenant first. Cross-tenant injection tests are mandatory before any merge that touches a tenant-scoped table.
3. **Money is ledger-only.** Balance is the sum of immutable ledger entries — never a stored field. Every credit movement has `actor`, `subject`, `reason`, `external_reference`. Disputes are resolved by replaying the ledger.
4. **Email is the contractual comms channel.** Every player-affecting event sends an email. Webhooks mirror the same event stream programmatically — they never replace email.
5. **Public + free defaults for external data.** No paid data feeds, no proprietary geocoders, no premium phone-validation services. We use IANA tzdb (built-in), libphonenumber (OSS), Gravatar's public URL pattern for avatar fallback, public IP-based locale detection only if free-tier suffices. SMTP and PeachPayments are the only third-party paid dependencies; both are tenant-controlled (per-tenant accounts).
6. **Hardware abstractions ship before drivers.** `IBiometricDevice` and the lights webhook contract exist before any vendor SDK is integrated. `NullBiometricDevice` and `MockSimulatorBiometricDevice` are first-class implementations — CI must pass without touching real hardware.
7. **CI green is the gate, not "it built locally."** No phase advances until CI is green on `main`.
8. **Pilot-first.** Crusaders Squash Club is the first real tenant. Every decision asks "does this serve the pilot?" before "does this serve future tenants?". Multi-tenancy is structural so onboarding tenant 2 is a config exercise, not a rewrite.

---

## External dependencies & data sources

Per principle 5, all external dependencies are either tenant-controlled paid services or free public APIs / OSS libraries. No proprietary data feeds.

| Concern | Choice | Why |
| --- | --- | --- |
| Email delivery | Reuse FrostAura GoDaddy SMTP (`smtpout.secureserver.net`, creds in `.env`, mirrored from `fa.startup/.env`) for dev/staging; per-tenant SMTP for production. | Already paid for; keeps cost zero for dev. Per-tenant production gives clubs control over deliverability and from-address branding. |
| Payment processing | PeachPayments Hosted Checkout (per-tenant merchant entity). | South African processor, ZAR-native, hosted checkout keeps PCI scope minimal. |
| Phone validation | `libphonenumber` (Google's OSS port — `PhoneNumbers` NuGet package). | Free, accurate, offline. |
| Avatar fallback (when player photo missing or fails to load) | Gravatar public URL pattern (`https://www.gravatar.com/avatar/<md5(email)>?d=identicon`). No API key required. | Free, public, predictable. Players can opt out by setting `?d=blank`. |
| Time zones | IANA tzdb (built into .NET 10 / Linux). | Free, authoritative. |
| Currency formatting | `CultureInfo("en-ZA")` for ZAR. | Built-in. |
| Email validation | Regex + DNS MX lookup (`System.Net.NameResolution`). | Built-in; no third-party validator. |
| Map / location | Out of scope for v1. If ever needed, OpenStreetMap tile servers + Nominatim (with caching + attribution). | Free; no Google Maps bills. |
| SMS / WhatsApp alerts | Out of scope for v1. If added later, Twilio (paid, but per-tenant choice). | Email is sufficient for v1. |

Anything that becomes load-bearing later goes through this same test before adoption: free-tier first, tenant-controlled second, FrostAura-platform-paid only as last resort.

---

## Status snapshot (2026-05-06)

| Phase | State |
| --- | --- |
| 0 — Foundation | **Implemented (slice)** — `EnsureCreated` in place; real `dotnet ef migrations add Initial` deferred to first host build |
| 1 — Members & Auth | **Implemented (slice)** — register/verify/login/forgot/reset/magic-link, admin approve/reject, real SMTP verified |
| 2 — Credit Ledger | **Partial** — ledger + admin manual adjustment landed; PeachPayments hosted-checkout + webhook callback deferred |
| 3 — Schedule & Booking | **Implemented (slice)** — atomic create with ledger debit, cancellation with penalty math, schedule grid |
| 4 — Webhooks & Lights | **Implemented (slice)** — `IEventBus` + `WebhookDeliveryWorker` with URL-templating + HMAC sig + retry, `LightsCueWorker` emits `booking.lights_on/off` at slice boundaries, `NoShowWorker` applies grace-window penalty, ESP32 firmware sketch under `src/firmware/lights-controller/` |
| 5 — Biometric | **Implemented (slice)** — `IBiometricDevice` + `NullBiometricDevice` + `BiometricService.MatchAtCourtAsync` resolves candidate set from current bookings, admin enrollment endpoint, audit-logged. Vendor SDK swap-in is the only remaining work |
| 6 — Reporting | **Implemented (slice)** — wallet/revenue/utilisation/no-show/peripheral-health endpoints, CSV export. XLSX + PDF deferred |
| 7 — Pilot launch hardening | **Open** — first-host build, structured-log upgrade (Serilog → JSON), more cross-tenant tests, real Crusaders cutover |
| 8 — **Client deltas** (blueprint 2026-05-09 Rev 2) | **Specified** — credits unit, member classes, charge-on-lights-on, per-day cap, peak-hours rule, payer override at court, PIN/QR identification, monthly reports preset, 2-year retention. See [`./specs/client-blueprint-deltas.md`](./specs/client-blueprint-deltas.md) |

## Phase 0 — Foundation **(in progress, mostly done)**

Repo skeleton. The runnable shell.

**Done:**
- Project directory + `CLAUDE.md` (Technologies project schema)
- All specs in `docs/specs/*`
- Root files: `.gitignore`, `.dockerignore`, `.editorconfig`, `LICENSE`, `README.md`, `Makefile`, `.env`/`.env.example`, `docker-compose.yml`, `nginx/nginx.conf`
- `.github/workflows/ci.yml` mirroring fa.startup's pipeline (lint/build/test/security/multi-arch image build/Portainer redeploy)
- `src/backend/` — solution, `Crusaders.Mainframe.Api` (minimal API + EF Core/Npgsql + JWT + tenant resolution middleware + auto-migrate), `Crusaders.Mainframe.Tests` (xUnit + WebApplicationFactory smoke test), Dockerfile
- `src/frontend/` — React 19 + Vite + Tailwind (soft-palette tokens) + Figtree + vitest, App shell with API health probe, Dockerfile + nginx SPA config
- Gaia agents/skills bootstrapped under `.claude/` and `.github/`
- `.env` populated with FrostAura SMTP creds for working email out of the box

**Remaining (close out before Phase 1):**

| Deliverable | Size | Acceptance |
| --- | --- | --- |
| Initial EF migration creating `tenants` + `tenant_settings` tables | S | `dotnet ef migrations add Initial_TenantsAndSettings` produces a clean migration; `make up` boots and the schema exists |
| Seed script: insert Crusaders tenant + default settings | S | `make seed` is callable; running it creates the `crusaders` tenant + default `tenant_settings` row |
| First Playwright e2e test asserting `/healthz` returns ok via the gateway | S | `make test-e2e` passes locally and in CI |
| First cross-tenant injection test (placeholder asserting `MainframeDbContext` filters by `_tenant.TenantId`) | S | Test exists and passes; sets the pattern for every subsequent tenant-scoped table |
| GitHub repo created, CI green on first push to `main`, Docker Hub repos created (`frostaura/crusaders-mainframe-{backend,frontend}`), Portainer stack created | S | First green run, first published images, manual portainer-deploy verified |

**Critical-path:** yes. Phase 1 starts with auth, which depends on the DB being migratable and seedable.

---

## Phase 1 — Members & Auth (M)

The flow that lets any human exist in the system. Spec: [`feature-spec.md`](./specs/feature-spec.md) §1–3, [`multi-tenancy.md`](./specs/multi-tenancy.md).

**Schema additions:**
- `users` (`tenant_id`, `email`, `password_hash`, `status`, `is_admin`, `is_platform_admin`)
- `memberships` (`tenant_id`, `user_id`, `full_name`, `membership_number`, `photo_url`, `status` ∈ `pending_approval | active | rejected | suspended`, `approval_reason`, `approved_by`, `approved_at`)
- `user_authenticators` — passkeys (Fido2 credential records)
- `email_verification_tokens`, `magic_link_tokens`, `password_reset_tokens`
- `audit_log` (start of the audit-log infrastructure that every later phase appends to)

**Backend deliverables:**
- `IEmailService` + `SmtpEmailService` + per-tenant `from_name` resolution
- Email template engine (Razor or simple Mustache-style — pick the simpler) with snapshot tests
- Templates: email verification, pending review, approved + magic-link, rejected + reason, password reset, admin-issued temp password
- Endpoints: `POST /api/v1/auth/register`, `POST /api/v1/auth/verify-email`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/reset-password`, `POST /api/v1/auth/magic-link/{token}`, passkey enrol/auth endpoints (Fido2)
- Admin endpoints: `GET /api/v1/admin/members?status=pending`, `POST /api/v1/admin/members/{id}/approve`, `POST /api/v1/admin/members/{id}/reject` (reason required), `POST /api/v1/admin/members/{id}/temp-password`
- Photo upload to local volume (`/app/media/<tenant>/photos/<userid>.jpg`); served via signed URL; image validation (max size, format, square aspect via re-encode using `ImageSharp` OSS)
- Audit log on every admin action

**Frontend deliverables:**
- `/register` — full name, email, membership number, photo upload (camera or file)
- `/verify-email/{token}` — landing page
- `/login` — email + password OR passkey (browser-supported)
- `/forgot-password`, `/reset-password/{token}`, `/welcome/{magic-link}`
- `/admin/members` — pending queue, approve/reject UI
- Toast notifications styled per design system

**Tests:**
- xUnit: registration, email-verification, approval, rejection, password reset, magic-link single-use enforcement
- xUnit: cross-tenant injection on `users` and `memberships`
- Playwright e2e: register → email arrives in MailHog (compose env) → click verification → admin approves → welcome email → magic-link login → balance shows R0

**Acceptance:** a human can self-register on the live PWA, receive emails (real outbound via GoDaddy SMTP), be approved by an admin, sign in with password, and be present in the system. Cross-tenant tests pass.

**Critical-path:** yes. Everything else needs users to exist.

---

## Phase 2 — Credit Ledger & PeachPayments (M)

Money. Spec: [`feature-spec.md`](./specs/feature-spec.md) §4 + [`payments-peachpayments.md`](./specs/payments-peachpayments.md).

**Schema additions:**
- `ledger_entries` (immutable; the hard rule) — `id`, `tenant_id`, `user_id`, `type` ∈ enum, `amount_zar` decimal(10,2), `related_booking_id` (nullable), `actor_user_id`, `reason`, `external_reference`, `created_at`
- `pending_topups` — `id`, `tenant_id`, `user_id`, `amount_zar`, `status`, `peach_checkout_id`, `idempotency_key`, `created_at`, `completed_at`
- `tenant_secrets` (encrypted-at-rest) — adds `peach_entity_id`, `peach_access_token`, `peach_webhook_secret`, `peach_environment`
- View / function: `current_balance(tenant_id, user_id)` — sum of ledger entries

**Backend deliverables:**
- `ILedgerService` — `Post(LedgerEntry)`, `GetBalance(userId)`, `GetEntries(filters)` — never exposes a balance setter
- `IPaymentProvider` (with `PeachPaymentsProvider` implementation): `RegisterCheckout(tenantId, userId, amountZar, idempotencyKey)`, `VerifyCallback(rawBody, signature)`, `RefundExternal(externalReference, amountZar)`
- Endpoints: `POST /api/v1/credit/topup` → returns hosted-checkout URL; `POST /api/v1/credit/topup/callback` → PeachPayments webhook receiver; `GET /api/v1/credit/ledger`; admin: `POST /api/v1/admin/credit/{userId}/adjust`
- Email templates: top-up confirmation, top-up failure, refund / credit adjustment
- Idempotency on the callback (`external_reference` is unique on `ledger_entries`)
- Webhook signature verification using `peach_webhook_secret` from `tenant_secrets`

**Frontend deliverables:**
- `/wallet` — balance card, ledger timeline, "Top up" button
- Top-up modal with preset amounts + custom + min/max (R50 / R5000)
- PeachPayments redirect → return URL → status polling (because webhook may arrive out-of-band)
- Admin: `/admin/members/{id}/wallet` — view ledger, issue manual adjustment with reason

**Tests:**
- xUnit: ledger property tests (balance == sum, every type round-trips, idempotency on duplicate `external_reference`)
- xUnit: PeachPayments callback signature verification (good + tampered)
- xUnit: cross-tenant injection on `ledger_entries`, `pending_topups`, `tenant_secrets`
- Replay test — captured webhook payload runs end-to-end and produces expected ledger row + email send + outbound webhook event

**Acceptance:** a member can top up via a real PeachPayments sandbox transaction, see their balance update, and pull a ledger view. Admin can issue a manual adjustment with reason. Test card → live ledger row + email arrives.

**Critical-path:** yes. Bookings need credit to debit.

---

## Phase 3 — Schedule & Booking (L)

The booking grid. Spec: [`feature-spec.md`](./specs/feature-spec.md) §5, §7.

**Schema additions:**
- `courts` — `id`, `tenant_id`, `court_number` (unique within tenant), `name`, `court_type` ∈ enum (squash/padel/tennis/badminton — cheap-to-add forward-compat), `slice_price_zar` decimal, `is_active`
- `bookings` — `id`, `tenant_id`, `court_id`, `user_id`, `actor_user_id` (admin if booking on behalf), `starts_at`, `ends_at`, `slice_count`, `slice_minutes`, `amount_charged_zar`, `status` ∈ `booked | cancelled | no_show | completed | admin_block`, `block_label` (for admin blocks), `cancelled_at`, `cancellation_reason`
- `tenant_settings` JSON keys formalized: `slice_minutes`, `slice_price_zar` (per-court override allowed), `penalty_pct`, `grace_window_minutes`, `penalty_window_minutes`, `advance_booking_days`, `operating_hours` (per-weekday open/close), `timezone`
- Unique constraint preventing overlapping bookings on the same `(tenant_id, court_id, time-range)`

**Backend deliverables:**
- `IBookingService.Create(...)` — atomic: validate slot is free + player has balance + within operating hours and advance horizon → write `ledger_entries.booking_charge` + `bookings` row → fire `booking.created` event
- `IBookingService.Cancel(bookingId, actor)` — compute penalty if inside `penalty_window_minutes`, write refund + optional penalty ledger rows, mark booking, fire `booking.cancelled` or `booking.late_cancellation` event
- Endpoints: `GET /api/v1/schedule?date=YYYY-MM-DD` (returns court grid for the day), `POST /api/v1/bookings`, `POST /api/v1/bookings/{id}/cancel`, admin: `POST /api/v1/admin/bookings` (book on behalf), `POST /api/v1/admin/bookings/{id}/cancel-waive-penalty`, `POST /api/v1/admin/courts/{id}/block` (admin-block a slot range)
- Multi-slice bookings = N consecutive `bookings` rows tied by an optional `parent_booking_id` for clean cancellation

**Frontend deliverables:**
- `/schedule` — date picker, court switcher (mobile pill scroll, tablet/desktop multi-column per `design-system.md` §"Booking grid"), slice cells coloured per state
- Booking confirmation modal: court, time, duration, cost, current balance, balance after; insufficient-balance prompts top-up
- Cancellation modal with penalty disclosure (warning-soft when inside penalty window)
- Admin overlay: block-slot UI, book-on-behalf member picker

**Tests:**
- xUnit: overlap-prevention property tests (concurrent booking attempts on the same slot — exactly one wins)
- xUnit: cancellation penalty math at the window boundary (off-by-one)
- xUnit: cross-tenant injection on `courts` and `bookings`
- Playwright e2e: register → top up → book → cancel-with-penalty → see ledger reflect both the debit and the partial refund

**Acceptance:** a member can navigate the grid, book a slot, see their balance debit, and cancel with the correct penalty applied. Admin can book on behalf and block court slots for events.

**Critical-path:** yes.

---

## Phase 4 — Webhooks & Lights (M)

The outbound event stream + the Arduino lights integration. Specs: [`webhooks.md`](./specs/webhooks.md), [`lights-controller.md`](./specs/lights-controller.md).

**Schema additions:**
- `webhook_endpoints` — `id`, `tenant_id`, `owner_user_id` (nullable for tenant-wide), `url_template`, `event_filter` (string[]), `secret`, `enabled`, `description`
- `webhook_deliveries` — `id`, `endpoint_id`, `event_id`, `event_type`, `request_body`, `response_status`, `response_body_excerpt`, `latency_ms`, `attempt`, `next_retry_at`, `final_state`

**Backend deliverables:**
- `IEventBus` — every domain action (booking.created / cancelled / lights_on / lights_off / no_show / member.* / credit.*) emits an event
- `WebhookDeliveryService` background worker:
  - URL templating engine (`{var}` substitution; URL-encoded values; missing-variable = config error, not retryable)
  - HMAC-SHA256 signing → `X-Crusaders-Signature` header; timestamp → `X-Crusaders-Timestamp`
  - Per-endpoint queue, exponential backoff (1m / 5m / 30m / 2h / 12h / 24h), auto-disable after 6 failures + email owner
  - SSRF guard: production rejects RFC1918 destinations *unless* the endpoint is registered against an internal-LAN allow-list (the lights-controller use case)
- Endpoints: `GET/POST/PUT/DELETE /api/v1/webhooks` (player-scoped), `GET/POST/PUT/DELETE /api/v1/admin/webhooks` (tenant-wide), `POST /api/v1/webhooks/{id}/test` (sends `webhook.test`), `GET /api/v1/webhooks/{id}/deliveries`
- Lights flow: `BookingService` emits `booking.lights_on` with `duration_seconds` derived from the booking → standard webhook delivery hits the Arduino URL
- `peripheral.unhealthy` event from the Arduino health-poll worker

**Frontend deliverables:**
- `/settings/webhooks` (player) — list, create with URL-template hints, view delivery log, "Send test" button
- `/admin/webhooks` (tenant admin) — same plus tenant-wide endpoints; pre-filled "Lights on" and "Lights off" templates pointing at `arduino.local/court/{court_number}/turn/{action}`
- Delivery log row: status, attempt count, latency, peek-at-payload modal

**Arduino firmware (`src/firmware/lights-controller/`):**
- ESP32 sketch (PlatformIO project, `platformio.ini` checked in)
- Endpoints exactly as specced: `POST /court/{n}/turn/on`, `POST /court/{n}/turn/off`, `GET /court/{n}/status`, `GET /health`
- Local timer per channel; auto-off when timer expires; extend-timer on duplicate `on`
- Shared-secret-in-body validation; HMAC validation if compute permits
- Fail-safe: **A + C** baseline (maintain on disconnect, with optional per-court physical override-button input on a spare GPIO). Note: `lights-controller.md` flags this as decision-pending — assuming A+C unless overridden
- README with wiring diagram, flash instructions, network setup

**Tests:**
- xUnit: URL-templating engine (substitution, URL-encoding, missing-var, literal `{}` escape, per-event variable validation at save-time)
- xUnit: signature generation matches expected HMAC output
- Integration: mock HTTP server on a test port; assert delivery payload + signature + retry-on-500
- Hardware test (manual, deferred until first ESP32): end-to-end `booking.lights_on` → relay clicks audibly

**Acceptance:** a player books, the system fires the templated webhook to a dummy receiver, the dummy receiver sees a signed payload with the right court number. With an actual ESP32 + relay board on the LAN, the lights physically come on. Failing endpoints retry per the spec and auto-disable + email the owner.

**Critical-path:** yes for the *webhook system* (the lights ride on it). The physical Arduino install is **off the critical path** of the SaaS launch — soft-launch with a `make on/off` admin override button is acceptable v1; hardware integration finishes v1.1.

---

## Phase 5 — Biometric (M)

Spec: [`biometric-abstraction.md`](./specs/biometric-abstraction.md), [`feature-spec.md`](./specs/feature-spec.md) §6.

**Schema additions:**
- `enrolled_templates` — `id`, `tenant_id`, `user_id`, `template_id` (opaque, points at local file), `finger_label`, `enrolled_by_admin_id`, `consent_receipt_hash`, `consent_version`, `created_at`, `superseded_at`
- `biometric_match_events` — `id`, `tenant_id`, `court_id`, `attempted_at`, `matched_user_id` (nullable), `confidence`, `liveness_score`, `latency_ms`, `outcome` ∈ `match | no_match | low_quality | error`
- `consent_receipts` — `id`, `version`, `body_hash`, `body_text`, `effective_from`

**Backend deliverables:**
- `IBiometricDevice` interface as specced; `NullBiometricDevice` (always succeeds for a configured user list); `MockSimulatorBiometricDevice` (console / web prompt)
- `IEnrolledTemplateStore` — local file system implementation (`/app/biometric/templates/{template_id}.bin`, encrypted with per-machine key)
- `IBiometricMatchPolicy` — pulls thresholds from `tenant_settings`
- Enrollment endpoints (admin only): `POST /api/v1/admin/biometric/enroll/start`, `POST /api/v1/admin/biometric/enroll/sample`, `POST /api/v1/admin/biometric/enroll/finalize`, `DELETE /api/v1/admin/biometric/templates/{id}`
- Court-side match endpoint: `POST /api/v1/court/{courtNumber}/biometric/match` — captures via `IBiometricDevice`, identifies against the candidate set (users with active booking on this court within the grace window), on success emits `booking.lights_on` and updates booking
- No-show worker: scheduled job runs every 30s; for each booking past `starts_at + grace_window_minutes` with no `LightsOn` event, mark `no_show` + write `no_show_penalty` ledger entry + send email + emit event
- Peripheral failure auto-credit: if device `Faulted` during a booking window, auto-issue a `cancellation_refund` and email the player

**Frontend deliverables:**
- Admin enrollment flow UI matching the state machine in the spec (consent → capture → quality feedback → repeat → finalize)
- Court-side terminal page (`/court/{n}` — kiosk-mode UX: large "Place finger" prompt, success/failure feedback, lights-on confirmation)
- Member profile widget: "Biometric: 2 fingers enrolled" + "Re-enroll" / "Delete" buttons (admin-only edit)

**Tests:**
- xUnit: candidate-set computation (only members with current bookings; no false positives)
- xUnit: no-show worker math at the boundary (exactly `grace_window_minutes` past = no_show; one second before = still pending)
- xUnit: cross-tenant — admin in tenant A cannot enroll for or match against tenant B
- Playwright e2e (against `MockSimulatorBiometricDevice`): book → "tap" simulated finger → lights-on event fires → booking is `completed` after slice ends

**Acceptance:** end-to-end works against `NullBiometricDevice` and `MockSimulatorBiometricDevice` without any hardware. Vendor SDK is a drop-in replacement; deferred until hardware purchase.

**Critical-path:** **soft.** Booking, top-up, and cancellation all work without biometrics — no-show detection in v1.0 can fall back to a manual admin "mark as no-show" button. Adding the biometric path turns no-show detection mechanical instead of social. Reasonable to launch the pilot without it and integrate when hardware arrives.

---

## Phase 6 — Reporting (M)

Spec: [`reporting.md`](./specs/reporting.md).

**Backend deliverables:**
- Aggregation endpoints, all filter-aware: `GET /api/v1/reports/wallet`, `/reports/bookings`, `/reports/utilisation` (admin), `/reports/revenue` (admin), `/reports/no-shows` (admin), `/reports/peripheral-health` (admin)
- Pre-aggregated bucketed responses (no client-side aggregation over large datasets)
- `ExportService` — CSV (server-streamed), XLSX (`ClosedXML` OSS), PDF (Puppeteer container — `ghcr.io/puppeteer/puppeteer`); >10k rows = async with email delivery
- Per-tenant cache (60s) for common reports

**Frontend deliverables:**
- `/reports/me` (player) and `/admin/reports` (admin) — shared report-renderer component, just different filters/scope
- KPI cards on top, then charts (Recharts), then drill-down table
- URL-state filters so reports are shareable
- Export button with format picker

**Tests:**
- xUnit: aggregation correctness (hand-compute on a known dataset; computed = expected)
- xUnit: tenant-scoping on every report endpoint (no leakage)
- Playwright: filter + export round-trip; downloaded CSV row count matches displayed count

**Acceptance:** a player can pull "money spent in the last 30 days" with a chart and a CSV export. An admin can pull "court utilisation by hour-of-day" as a heatmap and an XLSX. Both views update automatically as new bookings happen.

**Critical-path:** no — reports can land in v1.1. But many usability problems show up first in reports, so don't defer indefinitely.

---

## Phase 7 — Pilot launch (S–M of polish, mostly checklist)

The "ready to put real money through it" pass. No new product surface; everything in this phase is hardening.

**Hardening checklist:**
- [ ] Cross-tenant injection test exists for *every* tenant-scoped table (audit pass)
- [ ] All emails snapshot-tested; previewable in admin tooling
- [ ] Receipt PDF generation in production (Puppeteer container deployed)
- [ ] Observability — structured logs (`Serilog` → JSON to stdout), metrics (`prometheus-net`), `/healthz` rich enough to drive uptime checks
- [ ] Backup job — `pg_dump` nightly to encrypted offsite (Backblaze B2 or similar)
- [ ] Restore drill — documented and run once; recovery time recorded
- [ ] SSRF and webhook abuse tests
- [ ] Load test of booking grid at peak (Tuesday 6pm thundering-herd simulation via k6)
- [ ] Real GoDaddy SMTP swapped for per-tenant production SMTP — deliverability checks (SPF/DKIM/DMARC)
- [ ] PeachPayments swapped from sandbox to live for Crusaders tenant; first real R50 transaction roundtrips
- [ ] Cloudflared tunnel set up on the Crusaders machine; domain points at it
- [ ] Crusaders members invited en masse via an admin batch-invite tool
- [ ] First weekend of pilot use; daily review of issues; hot-fix capacity
- [ ] Decommission of the existing booking system / WhatsApp groups (whatever exists today at Crusaders)

**Acceptance:** Crusaders Squash Club's committee says "this is now how we run the courts."

---

## Open decisions (parking lot)

Decisions still pending. Unblock these as they become load-bearing.

| # | Decision | Default if not addressed | Where it surfaces |
| --- | --- | --- | --- |
| 1 | Arduino fail-safe behavior on network loss | A + C (maintain + override pad) | `lights-controller.md` § Fail-safe |
| 2 | SaaS pricing for tenants 2+ | Free for Crusaders, TBD for tenant 2 | `multi-tenancy.md`, `payments-peachpayments.md` |
| 3 | Recurring bookings | Out of scope v1 — re-evaluate after first month of pilot data | `feature-spec.md` §5 |
| 4 | Multi-sport (padel/tennis) | `court_type` column in `courts` from day one; UI is squash-only until a non-squash tenant signs up | `feature-spec.md`, schema |
| 5 | Partner / 2-player booking | v1 books one player; v1.1 adds "play with..." after the cancel-with-partner-notification flow | `feature-spec.md` §5 |
| 6 | Walk-ins / guest passes | Out of scope v1 — admin can manually book a guest under a `guests@<tenant>.local` placeholder | `feature-spec.md` §8 |
| 7 | Push notifications (PWA) | Defer; emails carry the load | `feature-spec.md` §12 |
| 8 | Native iOS/Android wrapper | Defer; PWA only for v1 | `feature-spec.md` §12 |
| 9 | Number of mandatory backup biometric fingers | 1 primary + 1 strongly-recommended backup; not enforced | `biometric-abstraction.md` § Admin-led enrollment |
| 10 | Crusaders existing data migration plan | TBD with the committee | Phase 7 |
| 11 | Custom domain support per tenant | Schema supports it; UI lands in v1.1 | `multi-tenancy.md` |
| 12 | Docker Hub namespace confirmation | Assumed `frostaura/crusaders-mainframe-{backend,frontend}` | `.github/workflows/ci.yml`, `deployment.md` |

---

## How to track progress

- This document updates whenever a phase completes or a decision lands. The same commit updates `CLAUDE.md`'s "Current phase" line.
- Each phase, when started, gets a `docs/phases/phase-<n>.md` execution log capturing branch names, PRs, deviations, and lessons. Lessons feed back into specs.
- The Gaia agents under `.claude/agents/` are invoked at phase boundaries — `gaia-intake-orchestrator` for scope framing, `gaia-solutions-architect` for design pass, `gaia-implementation-planner` for branch-tree, `gaia-software-engineer` for the work, `gaia-tester` for verification, `gaia-release-engineer` for the final gate.
- Open decisions in the parking lot above are revisited at every phase boundary; defaults take effect if not addressed.

## Phase 8 — Client deltas (blueprint Rev 2, 2026-05-09) (XL)

The client returned a written blueprint that introduces a credits-as-unit-of-account model, member classes, and a "charge on lights-on" timing rule that changes the ledger flow. Full reconciliation in [`./specs/client-blueprint-deltas.md`](./specs/client-blueprint-deltas.md).

**Sub-deliverables (mergeable independently, suggested order):**

1. **8.1 — Member classes.** `Membership.MemberClass` enum (`Regular` / `LeagueOrSenior`), admin assigns at approval time and via member edit. Audit-logged on change. Tests on cross-tenant + role-gated assignment.
2. **8.2 — Credits unit of account.** Rename `LedgerEntry.AmountZar` → `AmountCredits`; add nullable `ZarPaid` + `ConversionRate`. Rename `Court.SlicePriceZar` → `SlicePriceCredits` (int). Tenant settings: `credits_per_zar_regular`, `credits_per_zar_league`, `topup_block_zar`, `topup_max_zar_per_member`. Top-up flow converts ZAR → credits at member-class rate; admin manual adjustments are credit-denominated. Wallet UI shows credits as the primary balance with ZAR only on top-up screens.
3. **8.3 — Charge on lights-on.** Booking creation no longer posts a ledger entry. Lights-on event posts the `booking_charge`. New `BookingStatus.Active`. Cancellation logic simplified: free outside grace, late-cancel penalty inside grace, mid-session refund only after lights-on (rare). No-show worker logic still posts the no-show penalty. Tests: state-machine boundary cases, refund-not-applicable-when-never-charged.
4. **8.4 — Per-day cap + peak-hours rule.** `member_per_day_max_minutes` enforced at booking-create with same-day relaxation. `peak_hours` + `peak_advance_hours_for_regular` enforced for `Regular` members. Admins bypass. Tests on the boundary minutes.
5. **8.5 — At-court payer override.** New booking columns `booked_by_user_id`, `paid_by_user_id`. Courtside terminal accepts a second identification and "I'll pay" press. Both players audit-logged. Both get email confirmations. Tests for ledger-debit-against-payer.
6. **8.6 — Identification PIN + QR.** PIN: digit code on the courtside keypad, set in profile. QR: PWA-displayed signed short-lived token (60s), courtside webcam scan. Face-recognition deferred. Tests for PIN candidate-set match + QR token signature.
7. **8.7 — Reports — monthly preset + per-member spend drill-down.** UI-only enhancements; backend already filters by `from`/`to`.
8. **8.8 — 2-year retention worker.** Nightly background job that anonymises `bookings`, `audit_log`, `biometric_match_events` older than `retention_years` (default 2) — replaces `user_id` with a sentinel "former-member" UUID, keeps aggregate counts. Tests for boundary days + anonymisation idempotency.

**Acceptance:** Crusaders committee signs off on the same end-to-end pilot flow with the new economics: register → admin approves and assigns class → top up R200 (member sees 320 credits if Regular / 480 if LeagueOrSenior) → book a 15-min slot → walk to court → identify (PIN or biometric) → lights come on, 8 credits debited → finish session → receipt email. Cross-tenant tests still green.

**Rough sizing:** 8.1 + 8.2 + 8.3 are the critical-path tightly-coupled trio (~1 week of focused dev each). 8.4–8.8 are independent and parallelisable.

## Critical path summary

```
Phase 0 (foundation close-out)
    ↓
Phase 1 (members + auth)
    ↓
Phase 2 (credit ledger + payments)
    ↓
Phase 3 (schedule + booking)
    ↓
Phase 4 (webhooks + lights)              ── soft for hardware install
    ↓
Phase 5 (biometric)                      ── soft; manual no-show fallback works
    ↓
Phase 7 (pilot launch hardening)
        Phase 6 (reporting)              ── parallel with 4–7
```
