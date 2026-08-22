---
name: crusaders-mainframe-state
description: "Backend 230/230 and firmware 85/85 green; Phases 0-4 done bar PayFast; device identity, SSRF guard and webhook retry built; PR #1 open as draft on the court-hardware branch"
type: state
last_verified: 2026-08-22
---

# Current state

_Last verified: 2026-08-22 — every claim below was executed, not read. A .NET 10 SDK and PlatformIO were installed into this environment (neither was present), a real Postgres 16 was started locally, the full suite was run, the migration was applied to a fresh database, and each quality gate was deliberately broken to confirm it fails. Verify before trusting anything dated older than ~60 days._

**Backend 230/230 green** (39 need Postgres and skip cleanly without it), **firmware 85/85 green** under both native and ASAN/UBSAN with no board attached. The backend was 24/30 at the start of 2026-08-22. The working tree is clean and `main` is at `6ed1fea`; all work sits on `claude/squash-booking-system-design-dt7ja6`, pushed, with **PR #1 open as a draft** carrying a phase checklist. The delivery shape is one branch, one PR — agreed with the founder, so do not split it.

### What changed on 2026-08-22

- **The credits rename is done** and the money bug is closed — see gotchas, which now records it as fixed rather than open. `AmountZar → AmountCredits`, `AmountChargedZar → AmountChargedCredits`, `SlicePriceZar → SlicePriceCredits`, plus every wire key. Genuinely-rand fields (`PendingTopup.AmountZar`, `ZarPaid`, `ConversionRate`, `top_ups_zar`, the `topup_*` and `credits_per_zar_*` settings) were deliberately left alone, so both units now carry honest names.
- **The schema is deployable.** Confirmed empirically that a production boot against a fresh Postgres previously threw `PendingModelChangesWarning` and died. The migration is regenerated from the model (a real 26KB `InitialCreate` and a real 27KB snapshot, replacing hand-written SQL and a 52-line stub), the raw DDL block is gone from `Seeder.cs`, and all eight previously-orphaned columns plus `webauthn_credentials` are now migrated.
- **The Mega <-> ESP serial protocol codec is built** — `src/iot/lib/protocol` (v2 `!VERB,args*CC\n` plus both-ways legacy compatibility), 22 Unity tests, and a 108-case shared corpus at `src/contracts/device-protocol/serial/`. The "no `ON` without a duration" rule is a static_assert and a required constructor argument, not a comment: weakening ON's row in `kVerbSpecs` fails the build. Confirmed by mutation — accepting a bad checksum and dropping the escaping each turn four tests red.
- **`src/iot/` exists** — a PlatformIO project with `native`, `native_asan`, `native_cov`, `court_mega`, `court_bridge` and `simulator` environments, pinned platform versions, and `lib/timebase` (rollover-safe time, 10 tests at four clock bases). `src/firmware/lights-controller/` is deleted.
- **Four CI defects fixed**, three of which were gates that could not fail: `backend-integration`'s `|| exit 0`; the coverage gate's `exit 0` on a missing report; and Security Scan, unreachable behind a permanently red backend. The fourth was `setup-python` lacking a dependency file.
- **10 frontend advisories resolved** (9 undici, 2 vite; 3 low, 7 high) — surfaced only because the security gate became reachable. Lockfile-only, all semver-compatible.
- **`NoShowWorker` no longer pays members for not showing up** — it refunded uncharged bookings, netting +70% of the booking value per no-show.
- **`ExtractHostSubdomain` no longer reads `192.168.68.10` as the tenant slug `"192"`**, which would have broken every device call from the club LAN while staying invisible through the tunnel.

### Environment notes worth keeping

Neither `dotnet` nor `pio` is present in a fresh remote session — install both before assuming a test run means anything. A local Postgres can be started from `/usr/lib/postgresql/16/bin` without Docker. The IoT toolchain is pinned in `src/iot/requirements.txt`, including `clang-format`, because formatter output varies by version and an unpinned one lets CI reject correctly-formatted code.

### Also landed on 2026-08-22 (later in the session)

- **Phase 3 — device identity.** A `Device` entity, admin registry, and a second auth scheme signing an HMAC over a canonical request string. No per-device secret is stored: the key is HKDF-derived from a master KEK, so rotation is a version bump. The verifier sets the tenant context itself — without that line every query filter downstream evaluates against `Guid.Empty`, which is what the three courtside endpoints still do today.
- **The tenant-isolation tests were vacuous and are not any more.** They gave each tenant its own database, so tenant B saw nothing because it was a different store; they passed with every global query filter deleted. Both tenants now share one store, verified by deleting each filter in turn and watching the matching test go red. A meta-test asserts the sharing itself.
- **The QR token was a bearer token for the whole API.** `qr_ident` is signed with the same key, issuer and audience as an access token, and a member's phone displays it to a camera at the court. Bearer tokens now require `purpose=access`; reverting the check, a `qr_ident` token reaches the admin device registry.
- **Rate limiting exists.** There was none of any kind. Three policies, registered before authentication.
- **The SSRF guard now exists.** It never did — `ValidateUrl` checked the scheme and `allowLan: true` was hardcoded at both call sites, so any authenticated *member* could point a webhook at any address the server could reach and read 512 bytes back through the deliveries endpoint. The decision now happens in the socket's `ConnectCallback`, against the address about to be dialled, because a host resolved at registration can point elsewhere by delivery time. Redirects are not followed; `169.254.0.0/16` is blocked; the LAN carve-out is a CIDR allow-list so a `/32` admits one board.
- **Webhook retry now exists.** `FinalState="pending"` and `NextRetryAt` had been written since the pipeline was authored and read by nothing, so a receiver down for thirty seconds lost the event permanently.
- **`MapUploadEndpoints()` had never been mounted** — photo upload is mandatory at registration and returned 404.
- **Phase 4 firmware modules**: `lib/hal` + `lib/hal_fakes` (seven ports, fakes that model the hardware rather than the calls), `lib/devcrypto` (clean-room SHA-256/HMAC/HKDF/signer), `lib/protocol`. The `http/` corpus agrees across three independent implementations — Python, C#, C++ — on all 31 vectors.
- **A fifth CI-shaped defect**: `strict_compile.sh` excluded `lib/hal_fakes/` and reported success when it found nothing to compile.

### Still red or unbuilt

The six Docker/Portainer Actions secrets remain unset, so the release chain still cannot run.

**`make build` fails at `build-iot`** — the `court_mega`, `court_bridge` and `simulator` source directories do not exist yet, and the pinned `johnrickman/LiquidCrystal_I2C@1.1.4` does not resolve from the PlatformIO registry. CI does not currently run the firmware *build*, only its tests, so this is not visible there.

Not started: **PayFast** (the rest of Phase 2), **Phase 5** court firmware, **Phase 6** lights as a purchasable good, **Phase 7** charge-at-booking, **Phase 8** OTA, **Phase 9** admin UI. Gates are parked by decision — the hardware is undecided.
