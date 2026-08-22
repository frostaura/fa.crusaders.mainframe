---
name: crusaders-mainframe-state
description: "Backend suite green for the first time (68/68, coverage 81.1%); credits rename DONE; schema now deployable; src/iot scaffolded with host-testable firmware; PR #1 open as draft on the court-hardware branch"
type: state
last_verified: 2026-08-22
---

# Current state

_Last verified: 2026-08-22 — every claim below was executed, not read. A .NET 10 SDK and PlatformIO were installed into this environment (neither was present), a real Postgres 16 was started locally, the full suite was run, the migration was applied to a fresh database, and each quality gate was deliberately broken to confirm it fails. Verify before trusting anything dated older than ~60 days._

**The backend suite is green for the first time: 68/68, line coverage 81.1%.** It was 24/30 at the start of 2026-08-22. The working tree is clean and `main` is at `6ed1fea`; all work sits on `claude/squash-booking-system-design-dt7ja6`, pushed, with **PR #1 open as a draft** carrying a phase checklist. The delivery shape is one branch, one PR — agreed with the founder, so do not split it.

### What changed on 2026-08-22

- **The credits rename is done** and the money bug is closed — see gotchas, which now records it as fixed rather than open. `AmountZar → AmountCredits`, `AmountChargedZar → AmountChargedCredits`, `SlicePriceZar → SlicePriceCredits`, plus every wire key. Genuinely-rand fields (`PendingTopup.AmountZar`, `ZarPaid`, `ConversionRate`, `top_ups_zar`, the `topup_*` and `credits_per_zar_*` settings) were deliberately left alone, so both units now carry honest names.
- **The schema is deployable.** Confirmed empirically that a production boot against a fresh Postgres previously threw `PendingModelChangesWarning` and died. The migration is regenerated from the model (a real 26KB `InitialCreate` and a real 27KB snapshot, replacing hand-written SQL and a 52-line stub), the raw DDL block is gone from `Seeder.cs`, and all eight previously-orphaned columns plus `webauthn_credentials` are now migrated.
- **`src/iot/` exists** — a PlatformIO project with `native`, `native_asan`, `native_cov`, `court_mega`, `court_bridge` and `simulator` environments, pinned platform versions, and `lib/timebase` (rollover-safe time, 10 tests at four clock bases). `src/firmware/lights-controller/` is deleted.
- **Four CI defects fixed**, three of which were gates that could not fail: `backend-integration`'s `|| exit 0`; the coverage gate's `exit 0` on a missing report; and Security Scan, unreachable behind a permanently red backend. The fourth was `setup-python` lacking a dependency file.
- **10 frontend advisories resolved** (9 undici, 2 vite; 3 low, 7 high) — surfaced only because the security gate became reachable. Lockfile-only, all semver-compatible.
- **`NoShowWorker` no longer pays members for not showing up** — it refunded uncharged bookings, netting +70% of the booking value per no-show.
- **`ExtractHostSubdomain` no longer reads `192.168.68.10` as the tenant slug `"192"`**, which would have broken every device call from the club LAN while staying invisible through the tunnel.

### Environment notes worth keeping

Neither `dotnet` nor `pio` is present in a fresh remote session — install both before assuming a test run means anything. A local Postgres can be started from `/usr/lib/postgresql/16/bin` without Docker. The IoT toolchain is pinned in `src/iot/requirements.txt`, including `clang-format`, because formatter output varies by version and an unpinned one lets CI reject correctly-formatted code.

### Still red or unbuilt

The six Docker/Portainer Actions secrets remain unset, so the release chain still cannot run. Phases 3 onward of the court-hardware plan (device identity and auth, the HAL and protocol codec, court firmware, lights as a purchasable good, charge-at-booking, OTA, admin UI) are not started. Gates are parked by decision — the hardware is undecided.
