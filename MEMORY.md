# MEMORY — crusaders.mainframe

_Last verified: 2026-07-24 by the tree-audit pass — `git log`, remote config, tracked-file list, `.gitignore`, migrations, `ci.yml`, `package.json` and the ledger-unit code paths inspected directly. Verify before trusting anything dated older than ~60 days._

## Current state

**Substantially built, now versioned, never pushed.** The repo was created on 2026-07-24 and holds two commits — `8ca3d45` (initial, 214 tracked files) and `335d218` (Foundation triage note). Working tree clean. Remote `git@github.com:frostaura/fa.crusaders.mainframe.git` is configured but **the GitHub repo does not exist yet and nothing has been pushed** — there is no `origin/main` ref. Until the founder creates the repo and pushes, this money-handling product still exists on exactly one iCloud-synced disk, now with local history but no off-machine backup.

Code: 63 backend `.cs` files under a single flat `Crusaders.Mainframe.Api` project, 39 frontend source files, 7 xUnit test classes (`AuthFlowTests`, `BookingTests`, `LedgerTests`, `TenantIsolationTests`, `UrlTemplateTests`, `Phase8Tests`, `HealthEndpointTests`) plus `TestHost`. `.github/workflows/ci.yml` (431 lines) carries the full chain — backend `dotnet test`, frontend `vitest`, multi-arch Docker Hub push, `deploy-portainer` — and **has still never run**, so the plan's own operating principle ("CI green is the gate, not 'it built locally'") remains unenforced for the life of the project.

Last real code activity clusters **2026-05-06 → 2026-05-18**; everything since is context and packaging. Effectively ~2 months dormant.

### Phase 8 is largely BUILT — the plan says otherwise and the plan is wrong

`docs/development-plan.md` marks Phase 8 "Specified". Verified in code: 8.1 member classes (**done** — `MemberClass` in `AdminMemberEndpoints.cs`, `TopUpEndpoints.cs`, `MainframeDbContext.cs`, `Seeder.cs`), 8.3 charge-on-lights-on (**done**, `BiometricService.cs`), 8.4 per-day cap + peak hours (**done**, `BookingService.cs` / `TenantSettingsAccessor.cs`), 8.5 payer override (**done**, `Domain/Booking.cs`), 8.6 PIN + QR (**done**, `Endpoints/PinEndpoints.cs`, `Endpoints/QrEndpoints.cs`), 8.8 retention (**done**, `Workers/RetentionWorker.cs`). Only **8.2 credits rename is partial and broken** — see the money bug. An agent following the plan literally would rebuild finished work.

## Live decisions

Blueprint **Rev 2** (received 2026-05-09 from the Crusaders committee, filed at `docs/specs/client-blueprints/Crusaders-Blueprint-2026-05-Rev2.md` in both `.md` and `.xlsx`) is the current economics and supersedes anything older.

- **Credits, not rand, are the unit of account.** R100 → **160 credits (Regular)** / **240 credits (League or 65+)**. The club wanted class-based value without class-based pricing on the court.
- **Two member classes:** `Regular` and `LeagueOrSenior`, assigned by an admin at approval time.
- **Charge on lights-on, not on booking.** Booking creates a hold only; the lights-on event posts the debit — cancellation before lights-on then needs no refund at all, removing an entire class of ledger complexity and dispute.
- **15-minute slices** (Crusaders default changed 30 → 15). **2-week booking horizon. 1 hour per member per day**, relaxed same-day if courts are free.
- **Top-ups in R100 blocks, max R1000 per member**; admin credit unlimited.
- **Peak-hours league exclusivity 16:00–19:00** — Regular members take a peak slot only inside the last hour before start, and only if still empty. Admins bypass.
- **At-court payer override** — a different identified player can press "I'll pay"; the booking records `booked_by_user_id` and `paid_by_user_id`, both audit-logged and emailed.
- **Identification triple-stack:** biometric + PIN + QR (60s signed token, courtside webcam scan). Face recognition deferred. Stated goal: "do away with cards."
- **Unfunded accounts cannot book** — 402 InsufficientBalance.
- **2-year retention** of usage history via a nightly anonymisation worker.
- **POPI compliance is deliberately out of scope.** Founder direction, 2026-05-06: "forget about legislation for now." A decision, not an oversight — but revisit before any club other than Crusaders onboards.
- **Biometrics are soft on the critical path.** Booking, top-up and cancellation all work without them; v1.0 can fall back to a manual admin "mark as no-show". The physical install is off the SaaS launch critical path.
- **New repos are private by default** (founder, 2026-07-24) — this was the first under that rule.
- **The Foundation squash program was killed 2026-07-24.** The standing rationale survives: commercial club software and any future philanthropic squash program stay decoupled unless root decides otherwise. Kill record in `Foundation/projects/MEMORY.md`.

## Gotchas

- **MONEY BUG — the 8.2 credits rename is half-done and currently dishonest.** Re-verified 2026-07-24. The column is still `AmountZar numeric(10,2)` (`Migrations/20260506000000_InitialCreate.cs` lines 119, 208), yet `AdminMemberEndpoints.cs` lines 143–148 sum that same field into `top_ups_credits`, `spent_credits`, `refunds_credits`, `penalties_credits` and `adjustments_credits`, while line 35 exposes it as `balance_zar`. **The same field is labelled ZAR in one endpoint and credits in another.** `SlicePriceCredits` does not exist anywhere — the migration still declares `SlicePriceZar`. Fix the unit, then write the migration.
- **Only one migration exists** — `20260506000000_InitialCreate`. No Phase-8 schema change (MemberClass, BookedByUserId/PaidByUserId, credits) has a migration. **Any deployed database is stuck** and cannot be migrated forward. `CLAUDE.md`'s "schema changes need an EF migration" invariant is currently violated by the repo itself.
- **`.env` holds real SMTP credentials.** It is now correctly gitignored (`.gitignore` lines 54–58) and is not tracked — verified. It is still unencrypted and unbacked-up.
- **This repo carries a vendored Gaia toolkit** — `.claude/skills/` (9 skills + `references/`), `.claude/agents/` (6), `.claude/gaia-instructions.md`, and a `.github/` mirror. The `.claude/skills/` tree is **byte-identical to `fa.lifeos`'s** and **differs from the current upstream plugin in all seven engineering skills** (upstream renamed `gaia-*` → `fa-*`). `gaia-default-tech-stack` and `gaia-ui-engineering` are both present and were both ignored — see the frontend deviation.
- **`docs/phases/` does not exist** despite the plan mandating a `phase-<n>.md` execution log per phase. There is no record of *why* any implementation choice was made — only what the specs said should happen.
- Docs use "Arduino" and "ESP32" interchangeably for the same lights controller.
- **Docker device passthrough is undocumented in `docker-compose.yml`**, pending the biometric SDK choice.
- iCloud has fabricated `* 2.dll` / `* 2.pdb` duplicates under `src/backend/.../bin` and `obj`. Build output only, gitignored, harmless — do not treat them as source.

## Open questions

- **Which biometric vendor SDK?** The abstraction is complete; the driver decision is the blocker and no evaluation doc exists. Owner: Dean.
- **Arduino fail-safe on network loss.** Parking-lot decision #1; default A+C (maintain-on plus a physical override pad) is assumed but never confirmed. Owner: Crusaders committee.
- **SaaS pricing for tenant #2 onwards.** Free for Crusaders; everything else TBD. Owner: Dean.
- **Crusaders' existing member-data migration.** TBD with the committee.
- **Crusaders go-live:** does the club go live this quarter, or is the project formally parked with a date? This is the division's leading cash-engine candidate, so the answer is portfolio-relevant. Owner: Dean.
- Deferred by decision, listed so they are not rediscovered as questions: recurring bookings (out of scope v1) · multi-sport (`court_type` column exists, UI is squash-only) · partner/2-player booking (v1.1) · walk-ins and guest passes (admin books under `guests@<tenant>.local`) · PWA push (deferred; email carries the load) · native wrapper (PWA only) · mandatory backup fingers (1 primary + 1 recommended, not enforced) · per-tenant custom domain (schema supports it, UI v1.1) · Docker Hub namespace (assumed `frostaura/crusaders-mainframe-{backend,frontend}`).

## Watch list

**Ordered by risk.**

1. **Create the GitHub repo and push.** History exists locally but has no off-machine copy; a disk loss still loses everything. Then get the first green CI run — the deploy chain is written and completely unexercised.
2. **Finish the credits rename** and add migrations for every Phase-8 schema change. These are the two defects that make the ledger unsafe to deploy.
3. **Rewrite `docs/development-plan.md`'s status snapshot** (still dated 2026-05-06 — three days *before* the Rev 2 blueprint that reshaped the economics). A per-sub-deliverable 8.1–8.8 implemented/partial/missing table is the highest-value doc fix.
4. **Frontend stack deviation is unwaivered.** Tailwind 3.4 + cva + clsx + tailwind-merge + lucide are installed — shadcn's whole toolchain — but there is **no `components.json`, no `@radix-ui/*` and no `components/ui/`**; ten primitives are hand-rolled in `src/frontend/src/components/`. There is also **no Redux Toolkit** (React context only). Adopt or record a rationale; do not describe the current state as compliant.
5. **No architecture doc exists.** Specs describe features; nothing describes system shape, module boundaries, or the booking → lights-on → ledger event flow.
6. Fixed 2026-07-24: `docs/specs/biometric-abstraction.md` pointed at `../client-blueprints/…` (a directory that does not exist); the blueprint was always filed correctly at `./client-blueprints/` and the link now resolves. The orphaned `modal-fixed.png` was moved into `docs/screenshots/`.

## Success metrics (working set)

100% of bookings through the system within 60 days of launch (no parallel WhatsApp/paper) · ≥95% of lights-on events match a valid booking, <2% disputed penalties · ≥70% of active members hold positive credit · a second club onboarded end-to-end in <2 hours of operator time · ≥99.5% uptime in club hours with graceful biometric degradation. Phase 7 acceptance is social, not technical: *"Crusaders Squash Club's committee says 'this is now how we run the courts.'"*
