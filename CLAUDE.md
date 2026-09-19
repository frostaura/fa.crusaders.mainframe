# Crusaders Mainframe (`crusaders.mainframe`)

## What this is

A mobile-first, multi-tenant SaaS for racquet-sport clubs that runs **court-light scheduling on a credit-based booking model**. Players top up in ZAR via **PayFast**, the top-up converts to **credits** at a member-class-specific rate, and they reserve court time slices. At the court a physical peripheral — biometric, PIN or QR — identifies the player, and the box decides locally: it switches the lights on through its own relay bank — via online activation or its cached roster — and the attendance event posts to the API.

First customer is **Crusaders Squash Club**, the namesake. Multi-tenancy is structural from day one, not a later port.

## Architecture

- **`src/backend/Crusaders.Mainframe.Api`** — .NET 10 Minimal APIs, EF Core, PostgreSQL 16. Folder-layered (`Endpoints/ Domain/ Services/ Persistence/ Security/ Webhooks/ Biometric/ Multitenancy/ Payments/ Email/ Lights/ Workers/ Migrations/`) inside a **single flat project**. Auth is JWT HS256 + WebAuthn passkeys (Fido2). The email invariant below is implemented in `Email/`, not in `Services/` — look there first.
- **`src/backend/Crusaders.Mainframe.Tests`** — xUnit, in-process `TestHost`. Cross-tenant injection tests are part of the suite and are non-negotiable.
- **`src/frontend`** — React 19 + TypeScript + Vite 7 + Tailwind, mobile-first PWA. **Figtree** font, Monday.com-style soft palette. State is React context (`lib/auth.tsx`, `lib/profile.tsx`, `lib/balance.tsx`).
- **`src/iot`** — PlatformIO project for the court-control hardware: a WeMos Mega 2560 + onboard ESP8266.
  The **Mega is a thin I/O layer** (buttons, scanner, relays, LCD, plus an *independent* auto-off timer) and
  **all volatile logic lives on the ESP8266**, because the ATmega cannot be flashed over WiFi — its ESP sits
  on Serial3, not the Serial0 bootloader port, and no GPIO reaches RESET. Everything under `lib/` except
  `arduino_hal/` and `posix_hal/` is free of Arduino headers so it compiles for the host test runner.
  **PlatformIO is the tested build; the Arduino IDE is the deployment route.** `src/iot/arduino/` holds
  two generated sketch folders and is never hand-edited — `make arduino-export` writes it from `lib/`,
  `src/` and the `-D` flags in `platformio.ini`, and `make arduino-check` regenerates and fails on a diff.
  A consequence binds the sources: the Arduino AVR core hard-codes `-std=gnu++11` and the IDE cannot
  override it, so **anything `court_mega` links must be valid C++11 as well as C++17.**
- **`src/contracts/device-protocol`** — the wire-protocol fixture corpus, consumed by *both* the C++ and the
  .NET tests. Neutral ground: neither side may drift from the other without a test going red.

Repository: `https://github.com/frostaura/fa.crusaders.mainframe.git` (private).

### Known deviations from the FrostAura mandate

State these honestly rather than repeating the aspiration:

- **No shadcn/ui, no Radix.** There is no `components.json` and no `@radix-ui/*` dependency. Every primitive (`Button`, `Card`, `Modal`, `Toast`, `DataTable`, `Carousel`, `ConfirmButton`, `LedgerTable`, `Charts`) is hand-rolled. This is drift, not a reasoned decision — either adopt shadcn or record a rationale, but do not describe the current state as compliant.
- **Not iDesign / hexagonal.** Folder layering inside one assembly does not enforce dependency direction. Compare `fa.lifeos`, which has genuine project separation.
- **No Redux Toolkit.** State is React context only (`lib/auth.tsx`, `lib/profile.tsx`, `lib/balance.tsx`). Like the shadcn gap this is an undeclared deviation from the parent mandate, not a granted waiver — it is tracked as an open item on `MEMORY.md`'s watch list. The stack call itself is parent-controlled and is held at division level, not here.
- **Docs do not use the division's numbered taxonomy.** There is no `docs/use-cases/UC-NNN-*.md`, no `docs/architecture/ARCH-NNN-*.md`, no `docs/testing/TEST-NNN-*.md` and no `-000-template.md`. This repo's documentation convention is `docs/specs/` plus the checklists and blueprint reconciliation listed under *Where docs live*. Declared here rather than silently ignored; the absence of any backend architecture document is a separate debt on `MEMORY.md`'s watch list.

## Invariants — violating any of these is a defect, not a style choice

- **Money is ledger-only.** Balance is the sum of immutable ledger entries and is never a stored field. Every movement carries actor, subject, reason and external reference. Disputes are resolved by replaying the ledger.
- **Credits are the unit of account, not rand.** ZAR is captured on the `PendingTopup` row for reconciliation; the ledger entry and all court pricing are credit-denominated. A field that mixes the two units is a money-correctness bug.
- **Charge at booking, refund on cancellation, nothing back once the lights have been on.** `CreateAsync` reserves the slot and posts the `BookingCharge` debit in the same unit of work — the booking row and the ledger row flush together, so a lost slot race cannot leave a member paying for a court they did not get. Cancelling refunds in full, less the late-cancellation penalty inside the penalty window; both movements are posted as separate rows rather than netted, because a single net row cannot answer "how much penalty did I pay?". Once someone has checked in there is no refund at all — and **attendance means `CheckedInAt`, never the clock and never `ChargedAt`**, which under this model is set on every row. This **contradicts client blueprint A.9**, which debits on lights-on; the deviation is the founder's decision, is recorded in `docs/specs/client-blueprint-deltas.md`, and **needs committee sign-off before go-live**.
- **Tenant isolation is structural.** Every persisted entity carries `tenant_id`; every endpoint resolves tenant first. Cross-tenant leakage is a **P0 security incident**, not polish.
- **The at-court identification event is the source of truth for attendance.** A no-show is the *absence* of a successful match within the grace window — never inferred from booking metadata.
- **Hardware abstractions ship before drivers.** `IBiometricDevice` + `NullBiometricDevice` + a mock simulator are first-class, and **CI must pass without touching real hardware**.
- **Every player-affecting event sends an email.** Webhooks are a programmatic *mirror* of the same event stream, never a substitute for player comms.
- **Admins act on behalf of users.** Every action must be representable as `{actor: admin_user_id, subject: end_user_id}` in the audit trail.
- **Every "configurable" number is `tenant_settings.<key>`.** Never hardcode one.
- **The booking grid shows photo + name only.** No email, phone or membership number visible to other players — this is *why* photo upload is mandatory at registration.
- **Schema changes need an EF migration.** `EnsureCreated` is not a migration strategy for a money-handling system.

## Conventions and non-obvious rules

- **Free-tier-first external dependencies.** No paid data feeds, no proprietary geocoders, no premium validation services. The timezone source is the IANA tzdb through `TimeZoneInfo`, and **SMTP and PayFast are the only paid third parties**, both tenant-controlled. Money is formatted with `CultureInfo.InvariantCulture`, never the club's own `en-ZA`, whose comma decimal PayFast rejects. `docs/development-plan.md` names further free-tier choices (libphonenumber, a Gravatar avatar fallback, MX-based email validation) that are **not built** — treat them as plan, not convention.
- **SSRF guard with a deliberate carve-out:** production rejects RFC1918 webhook destinations *unless* the endpoint is on an internal-LAN allow-list. That carve-out exists for legitimate LAN consumers a club points a webhook at — the court box itself is pull-only and never a webhook destination — do not close it.
- **Webhook delivery:** HMAC-SHA256 in `X-Crusaders-Signature`, timestamp in `X-Crusaders-Timestamp`, per-endpoint queue, backoff 1m/5m/30m/2h/12h/24h, auto-disable after 6 failures plus an email to the owner. A missing template variable is a **config error, not a retryable failure**.
- **Docker device passthrough:** the .NET service runs in a container but must reach a USB/serial biometric device on the host — needs `--device` passthrough or `privileged: true` with the specific device path.
- Deploy follows the standard FrostAura pattern and this repo's own `.github/workflows/ci.yml` carries the full chain (multi-arch → Docker Hub → `deploy-portainer`); it is the reference to keep in sync, not `fa.startup`'s.

## Build / test / run

```bash
make install        # restore backend + frontend
make lint           # dotnet format + eslint/tsc
make build          # lint, then build both
make test           # unit
make test-integration
make arduino-export # regenerate src/iot/arduino/ from the PlatformIO sources
make arduino-check  # regenerate and fail if the committed sketches are stale
make up / make down / make down-reset / make clean
```

MailHog serves local mail on `:8025`. There is no `scripts/` directory — the `Makefile` is the entry point.

## Where docs live

- `docs/specs/` — `feature-spec.md` · `settlement-model.md` (the authority on how the ledger settles) · `multi-tenancy.md` · `biometric-abstraction.md` · `device-serial-protocol.md` · `lights-controller.md` · `payments-payfast.md` (`payments-peachpayments.md` is superseded) · `webhooks.md` · `design-system.md` · `reporting.md` · `deployment.md`.
- `docs/specs/client-blueprints/` — the verbatim client artifact plus its `.md` transcription. **The blueprint is the customer's word and outranks internal specs on economics.**
- `docs/specs/client-blueprint-deltas.md` — line-by-line reconciliation of blueprint requirements against the build. The most reliable economics reference in the repo.
- `docs/development-plan.md` — phased build sequence and parking-lot decisions. **Its status column understates reality; trust code over the plan** — see `MEMORY.md`.
- `docs/go-live-checklist.md` — everything between the code and a lit court at Crusaders, ordered by what stops go-live first, each item carrying the consequence of skipping it. None of it is code.
- `docs/court-lights-flows.html` — "Every path from a booking to a lit court": the founder-facing walkthrough of the lighting flows, from booking to commissioning to what the LCD is saying. It and the blueprint below are the two founder-facing pages and are kept true as a pair — regenerate both when a spec or decision changes.
- `docs/system-blueprint.html` — a self-contained interactive one-page design of the whole system (topology, wiring and DIP modes, firmware split, serial protocol with a live frame builder, the device API, backend invariants, ERD, deploy chain). Regenerate it when specs or decisions change and republish to the same hosted artifact URL so the link stays stable — the URL itself is recorded in `MEMORY.md`'s state topic.
- `docs/reviews/adversarial-e2e-review.md` — the one adversarial review kept as evidence. Its finding ids are the dictionary `test/e2e-device/` and the go-live checklist decode against. **`docs/reviews/` is not an archive**: a review's durable content is promoted into `MEMORY.md`'s topic store and the report deleted.
- `docs/charter.md` — project charter.

## Never do this

- **Never treat `docs/development-plan.md`'s phase statuses as ground truth.** Grep the code before building anything it calls unbuilt.
- **Never introduce a stored balance field**, however tempting for query performance.
- **Never merge a change touching a tenant-scoped table without a cross-tenant injection test.**
- **Never commit `.env`, and never paste a value out of it into a context file, a report or a commit message.** It holds live credentials of several kinds; the inventory — variable names only — is on `MEMORY.md`'s watch list.
- **Never add a ledger field whose name implies one unit while the column holds another.** That bug has been shipped here once and cost a rename across the schema, every wire key and the UI. A field mixing credits and rand is a money-correctness defect, not a naming preference.

## Dependencies on other FrostAura projects

**None.** No shared identity service, no internal API call leaving this repo, no upstream data feed, and no FrostAura package in either manifest. Two deliberate non-dependencies that look like one:

- **The JWT + WebAuthn auth pattern was lifted from `fa.startup`** — a lineage, not a link. This repo pins the **base `Fido2` package, not `Fido2.AspNet`**, which is what makes controller code non-portable in either direction; the division rule to check both pins before lifting identity code applies. Do not refactor the similarity into a shared library.
- **The court-box hardware lives here in `src/iot`, not in `Industries/`.** Nothing about it is sourced from another division.

External paid third parties are SMTP and PayFast, both tenant-controlled; Cloudflared runs on the host, outside the compose stack, by design.

## Skills

From the installed Gaia plugins this repo draws the mandated-stack baseline it deviates from (e.g. `fa-engineering-default-tech-stack`) — read it before arguing the deviations are fine; the UI-engineering capability for the hand-rolled primitive set (e.g. `fa-engineering-ui`); the formal-testing capability for the money, tenancy and device layers (e.g. `fa-engineering-testing`); the implementation capability for delivery (e.g. `fa-engineering-implementation`); and the **deploy-chain activation** capability for the secrets-then-stack ordering this repo's release chain depends on (e.g. `fa-engineering-deploy-chain`).

This repo carries **no local `.claude/skills/`** and must not reacquire one. A procedure that would be equally correct in an unrelated repository belongs upstream in a plugin, never here; the reasoning, and what the last such set cost, are in `MEMORY.md`.

## Upkeep
Three artifacts are kept current **as changes land**, not in a later pass: this `CLAUDE.md`, [`MEMORY.md`](MEMORY.md) with its `memory/` topic store, and the skills layer above (empty by decision). `MEMORY.md` is required here exactly as `CLAUDE.md` is, and cascades downward identically; a `CLAUDE.md` with no `MEMORY.md` beside it is a defect.

Update the memory store at the end of any session that shipped, decided, discovered or abandoned something, and restamp `last_verified:` only for what you actually inspected. **Edit the topic files under `memory/`, never `MEMORY.md` itself** — the index is derived from their frontmatter, and a hand-cut entry is silently discarded by the next regeneration. Regenerate it from the tree root with `python3 .claude/scripts/audit-tree.py --no-git --fix-index --scope Technologies/projects/crusaders.mainframe`; the `--scope` flag is what stops a fan-out agent rewriting a sibling's index mid-flight. This file changes only when a rule changes — a status belongs in `MEMORY.md`. A stale plugin procedure is fixed upstream and reinstalled, never forked back in here. The standard is [`/docs/operating/context-cascade.md`](../../../docs/operating/context-cascade.md).
