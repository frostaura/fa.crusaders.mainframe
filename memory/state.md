---
name: crusaders-mainframe-state
description: "Substantially built, versioned 2026-07-24, never pushed (GitHub repo doesn't exist); Phase 8 largely BUILT though the plan says Specified; ~2 months dormant"
type: state
last_verified: 2026-07-24
---

# Current state

_Last verified: 2026-07-24 by the tree-audit pass — `git log`, remote config, tracked-file list, `.gitignore`, migrations, `ci.yml`, `package.json` and the ledger-unit code paths inspected directly. Verify before trusting anything dated older than ~60 days._

**Substantially built, now versioned, never pushed.** The repo was created on 2026-07-24 and holds two commits — `8ca3d45` (initial, 214 tracked files) and `335d218` (Foundation triage note). Working tree clean. Remote `git@github.com:frostaura/fa.crusaders.mainframe.git` is configured but **the GitHub repo does not exist yet and nothing has been pushed** — there is no `origin/main` ref. Until the founder creates the repo and pushes, this money-handling product still exists on exactly one iCloud-synced disk, now with local history but no off-machine backup.

Code: 63 backend `.cs` files under a single flat `Crusaders.Mainframe.Api` project, 39 frontend source files, 7 xUnit test classes (`AuthFlowTests`, `BookingTests`, `LedgerTests`, `TenantIsolationTests`, `UrlTemplateTests`, `Phase8Tests`, `HealthEndpointTests`) plus `TestHost`. `.github/workflows/ci.yml` (431 lines) carries the full chain — backend `dotnet test`, frontend `vitest`, multi-arch Docker Hub push, `deploy-portainer` — and **has still never run**, so the plan's own operating principle ("CI green is the gate, not 'it built locally'") remains unenforced for the life of the project.

Last real code activity clusters **2026-05-06 → 2026-05-18**; everything since is context and packaging. Effectively ~2 months dormant.

### Phase 8 is largely BUILT — the plan says otherwise and the plan is wrong

`docs/development-plan.md` marks Phase 8 "Specified". Verified in code: 8.1 member classes (**done** — `MemberClass` in `AdminMemberEndpoints.cs`, `TopUpEndpoints.cs`, `MainframeDbContext.cs`, `Seeder.cs`), 8.3 charge-on-lights-on (**done**, `BiometricService.cs`), 8.4 per-day cap + peak hours (**done**, `BookingService.cs` / `TenantSettingsAccessor.cs`), 8.5 payer override (**done**, `Domain/Booking.cs`), 8.6 PIN + QR (**done**, `Endpoints/PinEndpoints.cs`, `Endpoints/QrEndpoints.cs`), 8.8 retention (**done**, `Workers/RetentionWorker.cs`). Only **8.2 credits rename is partial and broken** — see the money bug. An agent following the plan literally would rebuild finished work.
