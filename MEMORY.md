# MEMORY — crusaders.mainframe

_Last verified: 2026-07-20 by direct inspection (git log/branch/remote/status, manifests, CI files). Verify before trusting anything dated older than ~60 days._

## Current state

**Substantially built, and completely unprotected.** 68 backend `.cs` files, 39 frontend source files, 7+ xUnit test files (`AuthFlowTests`, `BookingTests`, `LedgerTests`, `TenantIsolationTests`, `UrlTemplateTests`, `Phase8Tests`, `HealthEndpointTests`). Working today: register/verify/login/forgot/reset/magic-link, WebAuthn passkeys, admin approve/reject, immutable ledger, schedule grid with atomic booking, cancellation penalty math, `IEventBus` + `WebhookDeliveryWorker` (URL templating, HMAC, retry), `LightsCueWorker`, `NoShowWorker`, `IBiometricDevice`/`NullBiometricDevice`/`BiometricService`, reporting + CSV export, PeachPayments hosted checkout, photo upload, admin pages (Members, Ledger, Settings, Webhooks, Biometric), ESP32 firmware sketch.

**There is no git repository.** No `.git` directory exists; `git log` fails. Every source file, the specs, and a `.env` holding live SMTP credentials exist only on local disk and iCloud — **zero history, zero backup**. `.github/workflows/ci.yml` is written and **has never run**, so the development plan's own operating principle ("CI green is the gate, not 'it built locally'") has been unenforceable for the entire life of the project.

Last real activity clusters **2026-05-06 → 2026-05-18**; the 2026-07-05 mtime on `src/` is an iCloud materialisation, not a code change. Effectively **~2 months dormant**.

### Phase 8 is largely BUILT — the plan says otherwise and the plan is wrong

`docs/development-plan.md` marks Phase 8 "Specified" and the old CLAUDE.md called it "the next major chunk of work". Verified in code:

| Sub-deliverable | Actual |
| --- | --- |
| 8.1 Member classes | **Done** — `MemberClass` in `AdminMemberEndpoints.cs`, `TopUpEndpoints.cs`, `MainframeDbContext.cs`, `Seeder.cs` |
| 8.2 Credits rename | **Partial and broken** — see the money bug below |
| 8.3 Charge on lights-on | **Done** — `AmountCredits` posted from `BiometricService.cs` |
| 8.4 Per-day cap + peak hours | **Done** — `per_day_max` in `BookingService.cs`, `peak_hours` in `TenantSettingsAccessor.cs` |
| 8.5 Payer override | **Done** — `BookedByUserId` / `PaidByUserId` on `Domain/Booking.cs`, `BookingService.cs`, `BiometricService.cs` |
| 8.6 PIN + QR | **Done** — `Endpoints/PinEndpoints.cs`, `Endpoints/QrEndpoints.cs` |
| 8.8 Retention | **Done** — `Workers/RetentionWorker.cs`, `retention_years` in `Program.cs` |

An agent following the plan literally would rebuild finished work.

## Live decisions

Blueprint **Rev 2** (received 2026-05-09 from the Crusaders committee) is the current economics. It supersedes anything older, including the stale defaults that were in CLAUDE.md.

- **Credits, not rand, are the unit of account.** R100 → **160 credits (Regular)** / **240 credits (League or 65+)**. Why: the club wanted class-based value without class-based pricing on the court.
- **Two member classes:** `Regular` and `LeagueOrSenior` (league players and 65+), assigned by an admin at approval time.
- **Charge on lights-on, not on booking.** Booking creates a hold only; the lights-on event posts the debit. Why: cancellation before lights-on then requires no refund at all, which removes an entire class of ledger complexity and dispute.
- **15-minute slices** (Crusaders seed default changes from 30 → 15). **2-week booking horizon. 1 hour per member per day**, relaxed same-day if courts are free.
- **Top-ups in R100 blocks, max R1000 per member**; admin credit is unlimited.
- **Peak-hours league exclusivity 16:00–19:00** — Regular members can only take a peak slot inside the last hour before start, and only if still empty. Admins bypass.
- **At-court payer override** — a different identified player can press "I'll pay"; the booking records both `booked_by_user_id` and `paid_by_user_id`, both audit-logged and emailed.
- **Identification triple-stack:** biometric + PIN + QR (60s signed short-lived token, courtside webcam scan). Face recognition deferred. The stated goal is "do away with cards."
- **Unfunded accounts cannot book** — 402 InsufficientBalance.
- **2-year retention** of usage history via a nightly anonymisation worker.
- **POPI compliance is deliberately out of scope.** Founder direction, 2026-05-06: "forget about legislation for now." This is a decision, not an oversight — but it is a decision to revisit before any club other than Crusaders onboards.
- **Biometrics are soft on the critical path.** Booking, top-up and cancellation all work without them; v1.0 can fall back to a manual admin "mark as no-show" button. The physical install is likewise off the SaaS launch critical path.
- **Do not couple this to `Foundation/projects/fa.sports.squash-command-center`.** A standing root decision keeps the commercial racquet-club SaaS and the philanthropic squash program separate — the rationale is commercial/philanthropic separation, and the two look obviously mergeable to anyone who sees only the domain overlap. The Foundation side records this in full; this line exists so an agent entering from the Technologies side gets the same signal.

## Gotchas

- **MONEY BUG — the 8.2 credits rename is half-done and currently dishonest.** The column is still `AmountZar numeric(10,2)` (`Migrations/20260506000000_InitialCreate.cs` lines 119, 208), yet `AdminMemberEndpoints.cs` lines 143–146 sum that same field into `top_ups_credits`, `spent_credits` and `refunds_credits`, while line 35 exposes it as `balance_zar`. **The same field is labelled ZAR in one endpoint and credits in another.** Additionally `SlicePriceCredits` (the rename of `Court.SlicePriceZar`) **does not exist anywhere** — that half was never done. Fix the unit, then write the migration.
- **Only one migration exists** — `20260506000000_InitialCreate`. No Phase-8 schema change (MemberClass, BookedByUserId/PaidByUserId, credits) has a migration. **Any deployed database is stuck** and cannot be migrated forward.
- **`.env` (2.2 KB) holds real SMTP credentials**, unversioned, unencrypted, unbacked-up, and with no `.gitignore` protecting it because there is no repo. Create the repo *and* the ignore rule in the same act.
- **This repo carries a vendored Gaia toolkit** — `.claude/skills/` (9 skills, byte-identical to `fa.lifeos`'s set), `.claude/agents/` (6 agents) and `.claude/gaia-instructions.md`. `gaia-default-tech-stack` and `gaia-ui-engineering` are both present and were both ignored; see the shadcn item on the watch list.
- **`docs/phases/` does not exist** despite the plan mandating a `phase-<n>.md` execution log per phase. There is no record of *why* any implementation choice was made — only what the specs said should happen.
- Docs use "Arduino" and "ESP32" interchangeably for the same lights controller.
- **Docker device passthrough is undocumented in `docker-compose.yml`**, pending the biometric SDK choice.

## Open questions

- **Which biometric vendor SDK?** The abstraction is complete; the driver decision is the blocker and no evaluation doc exists. Owner: Dean.
- **Arduino fail-safe on network loss.** Parking-lot decision #1; default A+C (maintain-on plus a physical override pad) is assumed but was never confirmed. Owner: Crusaders committee.
- **SaaS pricing for tenant #2 onwards.** Free for Crusaders; everything else TBD. Owner: Dean.
- **Crusaders' existing member-data migration.** TBD with the committee.
- Deferred by decision, listed so they are not rediscovered as questions: recurring bookings (out of scope v1) · multi-sport (`court_type` column exists, UI is squash-only) · partner/2-player booking (v1.1) · walk-ins and guest passes (admin books under `guests@<tenant>.local`) · PWA push (deferred; email carries the load) · native wrapper (PWA only) · mandatory backup fingers (1 primary + 1 recommended, not enforced) · per-tenant custom domain (schema supports it, UI v1.1) · Docker Hub namespace (assumed `frostaura/crusaders-mainframe-{backend,frontend}`).

## Watch list

**Ordered by risk. The first item outranks all product work.**

1. **`git init`, first commit, GitHub repo (`github.com/frostaura/crusaders.mainframe`), first green CI run.** Two months of a money-handling product with no version control and no backup is the single highest risk in the Technologies portfolio.
2. **Finish the credits rename** and add the migrations for every Phase-8 schema change.
3. **Rewrite `docs/development-plan.md`'s status snapshot** (still dated 2026-05-06 — three days *before* the Rev 2 blueprint that reshaped the economics). A per-sub-deliverable 8.1–8.8 implemented/partial/missing table is the highest-value doc fix.
4. **Resolve the shadcn/ui claim** — adopt it or record the hand-rolled decision with a rationale.
5. **No architecture doc exists.** Specs describe features; nothing describes system shape, module boundaries, or the booking → lights-on → ledger event flow.
6. Cleanup: orphaned `modal-fixed.png` (root, 2026-05-08, still there), frontend `tsbuildinfo`/`dist`, backend `bin`/`obj`. The `.playwright-mcp/` sprawl noted on 2026-07-19 is gone — the directory no longer exists.

## Success metrics (working set)

100% of bookings through the system within 60 days of launch (no parallel WhatsApp/paper) · ≥95% of lights-on events match a valid booking, <2% disputed penalties · ≥70% of active members hold positive credit · a second club onboarded end-to-end in <2 hours of operator time · ≥99.5% uptime in club hours with graceful biometric degradation. Phase 7 acceptance is social, not technical: *"Crusaders Squash Club's committee says 'this is now how we run the courts.'"*
