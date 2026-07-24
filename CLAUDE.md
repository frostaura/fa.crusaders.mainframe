# Crusaders Mainframe (`crusaders.mainframe`)

## What this is

A mobile-first, multi-tenant SaaS for racquet-sport clubs that runs **court-light scheduling on a credit-based booking model**. Players top up in ZAR via PeachPayments, the top-up converts to **credits** at a member-class-specific rate, and they reserve court time slices. At the court a physical peripheral — biometric, PIN or QR — identifies the player, which turns the lights on via a relay webhook and posts the ledger debit.

First customer is **Crusaders Squash Club**, the namesake. Multi-tenancy is structural from day one, not a later port.

## Architecture

- **`src/backend/Crusaders.Mainframe.Api`** — .NET 10 Minimal APIs, EF Core, PostgreSQL 16. Folder-layered (`Endpoints/ Domain/ Services/ Persistence/ Security/ Webhooks/ Biometric/ Multitenancy/ Payments/ Workers/`) inside a **single flat project**. Auth is JWT HS256 + WebAuthn passkeys (Fido2).
- **`src/backend/Crusaders.Mainframe.Tests`** — xUnit, in-process `TestHost`. Cross-tenant injection tests are part of the suite and are non-negotiable.
- **`src/frontend`** — React 19 + TypeScript + Vite 7 + Tailwind, mobile-first PWA. **Figtree** font, Monday.com-style soft palette. State is React context (`lib/auth.tsx`, `lib/profile.tsx`, `lib/balance.tsx`).
- **`src/firmware/lights-controller`** — ESP32 sketch driving the relay board. Off the SaaS critical path.

### Known deviations from the FrostAura mandate

State these honestly rather than repeating the aspiration:

- **No shadcn/ui, no Radix.** There is no `components.json` and no `@radix-ui/*` dependency. Every primitive (`Button`, `Card`, `Modal`, `Toast`, `DataTable`, `Carousel`, `ConfirmButton`, `LedgerTable`, `Charts`) is hand-rolled. This is drift, not a reasoned decision — either adopt shadcn or record a rationale, but do not describe the current state as compliant.
- **Not iDesign / hexagonal.** Folder layering inside one assembly does not enforce dependency direction. Compare `fa.lifeos`, which has genuine project separation.
- **No Redux Toolkit.** State is React context only (`lib/auth.tsx`, `lib/profile.tsx`, `lib/balance.tsx`). Like the shadcn gap this is an undeclared deviation from the parent mandate, not a granted waiver — it is tracked as an open decision with an owner in `MEMORY.md`.

## Invariants — violating any of these is a defect, not a style choice

- **Money is ledger-only.** Balance is the sum of immutable ledger entries and is never a stored field. Every movement carries actor, subject, reason and external reference. Disputes are resolved by replaying the ledger.
- **Credits are the unit of account, not rand.** ZAR is captured on the `PendingTopup` row for reconciliation; the ledger entry and all court pricing are credit-denominated. A field that mixes the two units is a money-correctness bug.
- **Charge on lights-on, not on booking.** A booking creates a *hold* — balance verified, slot reserved, **no ledger entry**. The lights-on event posts the debit. Cancellation before lights-on therefore needs no refund at all. This is what keeps the ledger simple; do not "fix" it by debiting at booking time.
- **Tenant isolation is structural.** Every persisted entity carries `tenant_id`; every endpoint resolves tenant first. Cross-tenant leakage is a **P0 security incident**, not polish.
- **The at-court identification event is the source of truth for attendance.** A no-show is the *absence* of a successful match within the grace window — never inferred from booking metadata.
- **Hardware abstractions ship before drivers.** `IBiometricDevice` + `NullBiometricDevice` + a mock simulator are first-class, and **CI must pass without touching real hardware**.
- **Every player-affecting event sends an email.** Webhooks are a programmatic *mirror* of the same event stream, never a substitute for player comms.
- **Admins act on behalf of users.** Every action must be representable as `{actor: admin_user_id, subject: end_user_id}` in the audit trail.
- **Every "configurable" number is `tenant_settings.<key>`.** Never hardcode one.
- **The booking grid shows photo + name only.** No email, phone or membership number visible to other players — this is *why* photo upload is mandatory at registration.
- **Schema changes need an EF migration.** `EnsureCreated` is not a migration strategy for a money-handling system.

## Conventions and non-obvious rules

- **Free-tier-first external dependencies.** IANA tzdb, libphonenumber, the Gravatar public URL pattern for avatar fallback, `CultureInfo("en-ZA")`, regex + DNS MX for email validation. **SMTP and PeachPayments are the only paid third parties**, and both are tenant-controlled.
- **SSRF guard with a deliberate carve-out:** production rejects RFC1918 webhook destinations *unless* the endpoint is on an internal-LAN allow-list. That carve-out exists specifically for the lights controller — do not close it.
- **Webhook delivery:** HMAC-SHA256 in `X-Crusaders-Signature`, timestamp in `X-Crusaders-Timestamp`, per-endpoint queue, backoff 1m/5m/30m/2h/12h/24h, auto-disable after 6 failures plus an email to the owner. A missing template variable is a **config error, not a retryable failure**.
- **Docker device passthrough:** the .NET service runs in a container but must reach a USB/serial biometric device on the host — needs `--device` passthrough or `privileged: true` with the specific device path.
- Deploy follows the standard FrostAura pattern and this repo's own `.github/workflows/ci.yml` now carries the full chain (multi-arch → Docker Hub → `deploy-portainer`); it is the reference to keep in sync, not `fa.startup`'s. The JWT + WebAuthn auth pattern was lifted from `fa.startup` — note that repo pins `Fido2.AspNet` 4.x while this one uses the base `Fido2` 3.0.1 package, so controller code is not portable either way.

## Build / test / run

```bash
make install        # restore backend + frontend
make lint           # dotnet format + eslint/tsc
make build          # lint, then build both
make test           # unit
make test-integration
make up / make down / make down-reset / make clean
```

MailHog serves local mail on `:8025`. There is no `scripts/` directory — the `Makefile` is the entry point.

## Where docs live

- `docs/specs/` — `feature-spec.md` · `multi-tenancy.md` · `biometric-abstraction.md` · `lights-controller.md` · `payments-peachpayments.md` · `webhooks.md` · `design-system.md` · `reporting.md` · `deployment.md`.
- `docs/specs/client-blueprints/` — the verbatim client artifact plus its `.md` transcription. **The blueprint is the customer's word and outranks internal specs on economics.**
- `docs/specs/client-blueprint-deltas.md` — line-by-line reconciliation of blueprint requirements against the build. The most reliable economics reference in the repo.
- `docs/development-plan.md` — phased build sequence and parking-lot decisions. **Its status column understates reality; trust code over the plan** — see `MEMORY.md`.
- `docs/charter.md` — project charter.

## Never do this

- **Never treat `docs/development-plan.md`'s phase statuses as ground truth.** Grep the code before building anything it calls unbuilt.
- **Never introduce a stored balance field**, however tempting for query performance.
- **Never merge a change touching a tenant-scoped table without a cross-tenant injection test.**
- **Never commit `.env`.** It holds live SMTP credentials.
- **Never add a ledger field whose name implies one unit while the column holds another.** That bug already exists once; do not add a second.

## Upkeep
This repo's `CLAUDE.md`, `MEMORY.md` and any `.claude/skills/` are kept current as changes land — treat them as part of the change, not as follow-up. Update `MEMORY.md` at the end of any session that shipped, decided, discovered or abandoned something, and refresh `_Last verified_` only when you actually inspected. A skill that no longer matches how work is really done here is fixed or deleted, not left to rot. The standard is [`/docs/operating/context-cascade.md`](../../../docs/operating/context-cascade.md).
