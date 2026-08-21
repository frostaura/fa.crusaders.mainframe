---
name: crusaders-mainframe-state
description: "Substantially built; private GitHub repo created and pushed 2026-08-21 (main tracks origin, 0/0); CI Docker/Portainer secrets still unset; Phase 8 largely BUILT though the plan says Specified"
type: state
last_verified: 2026-08-21
---

# Current state

_Last verified: 2026-08-21 — `git status`, `git branch -vv`, `rev-list --left-right --count`, `gh repo view`, `gh secret list` and the first CI run inspected directly; git state re-confirmed later the same day by the division audit. Verify before trusting anything dated older than ~60 days._

**Substantially built, versioned, and now pushed off-machine.** Private repo `frostaura/fa.crusaders.mainframe` was created 2026-08-21 via `gh` and `main` pushed with upstream tracking — `origin/main...main` sat at **0 ahead / 0 behind** on **6 commits**, head `9264eb2` (the two most recent being the CI-runnability fixes and the state record written that day). The division audit later that day added a seventh, context-only commit, so the branch now reads **1 ahead / 0 behind** — the *product* is off-machine, one context commit is not. Remote was switched from SSH to `https://github.com/frostaura/fa.crusaders.mainframe.git` to match the sibling repos and the `gh` https git protocol. Working tree clean at push time. Tracked files verified secret-free before push: real `.env` is gitignored and never committed; only `.env.example` templates (placeholder values inspected) are in history.

Code: 63 backend `.cs` files under a single flat `Crusaders.Mainframe.Api` project, 39 frontend source files, 7 xUnit test classes (`AuthFlowTests`, `BookingTests`, `LedgerTests`, `TenantIsolationTests`, `UrlTemplateTests`, `Phase8Tests`, `HealthEndpointTests`) plus `TestHost`. `.github/workflows/ci.yml` (431 lines) carries the full chain — backend `dotnet test`, frontend `vitest`, multi-arch Docker Hub push, `deploy-portainer` — and **now runs**: as of 2026-08-21 (run 32465795076) the **Frontend job is green** (lint 0 errors, vitest, build) and the **Backend job is red with exactly 24/30 passing** — the 6 failures (5 `BookingTests` + `HealthEndpointTests`) are the known credits-rename/missing-migrations money bug, identical locally and in CI. Docker/Portainer jobs are gated behind those tests and additionally need the repo's 6 Actions secrets, none of which are set (see the watch list).

Last real code activity before this was **2026-05-06 → 2026-05-18**; 2026-08-21 added build-infrastructure fixes only (`coverlet.runsettings`, frontend lint/test-env fixes, `TestHost` `BalanceBroadcaster` registration) — no product behavior changed.

### Phase 8 is largely BUILT — the plan says otherwise and the plan is wrong

`docs/development-plan.md` marks Phase 8 "Specified". Verified in code: 8.1 member classes (**done** — `MemberClass` in `AdminMemberEndpoints.cs`, `TopUpEndpoints.cs`, `MainframeDbContext.cs`, `Seeder.cs`), 8.3 charge-on-lights-on (**done**, `BiometricService.cs`), 8.4 per-day cap + peak hours (**done**, `BookingService.cs` / `TenantSettingsAccessor.cs`), 8.5 payer override (**done**, `Domain/Booking.cs`), 8.6 PIN + QR (**done**, `Endpoints/PinEndpoints.cs`, `Endpoints/QrEndpoints.cs`), 8.8 retention (**done**, `Workers/RetentionWorker.cs`). Only **8.2 credits rename is partial and broken** — see the money bug. An agent following the plan literally would rebuild finished work.
