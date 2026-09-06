---
name: crusaders-mainframe-state
description: "The 2026-08-24 review's 30 defects are closed and the device contract was simplified to one club API key (no OTA, signing, discovery, claim codes or device clock). Five headed-browser rounds since have found and fixed 82 + 64 defects. Branch claude/e2e-fix-programme, PR #2 (draft): 898 backend and 400 frontend tests green locally. NOT yet proven on real hardware, and CI has been red on jobs the founder machine cannot reproduce"
type: state
last_verified: 2026-09-06
---

# Current state

## 2026-09-06 — the fix programme and five headed-browser rounds

**The 2026-08-24 review is closed.** All seven criticals are fixed and each maps to an assertion in
`make test-e2e-device`. On the founder's decision the device contract was then **simplified to
hobby grade**: OTA, image signing, the runtime credential store, HMAC device auth, discovery, claim
codes, per-device keys and the device clock are all gone. A box now carries one per-tenant API key
in `secrets.h` and registers itself on its first heartbeat. Flashing is the **Arduino IDE** from the
generated `src/iot/arduino/` sketches; PlatformIO remains the tested build.

**Five rounds of headed-browser review have run since** — agents driving the real product in real
browsers, told to refute that it works, each fixer followed by an independent refuter that mutates
the fix to prove the test pins it. Round 1: 82 findings (2 critical, 21 high). Round 2: 64 (0
critical, 9 high), five of the nine highs being regressions the round-1 fixes introduced. Rounds 3-5
closed what survived refutation. Full record: `docs/reviews/headed-e2e-round-2026-09-05.md`.

**Where it stands:** 898 backend and 400 frontend tests green locally, zero skipped, against real
Postgres; complexity, lint, firmware host suite, ASAN/UBSAN, corpus and Arduino compile checks all
green. Branch `claude/e2e-fix-programme` is pushed; PR #2 is open as a draft.

**What the rounds proved about method, and this is the durable part:**

- **A green suite on the founder's Mac is not a green suite.** Four CI jobs were red while
  everything passed locally — including one test that CANNOT fail on macOS by construction (a
  sub-microsecond tick truncation that only survives on Linux), and an e2e spec that had been
  testing the discovery-and-claim flow for weeks after that flow was deleted.
- **Refuters earn their cost.** They reproduced a service-worker privacy leak in a real browser (one
  member's wallet served to another), disproved six sentences fixers had written into specs claiming
  something was impossible or absent, and found a live money rule whose only test had stopped
  discriminating it — by varying a fixture, not the code.
- **Parallel fixers on overlapping screens cost the work twice.** Two rounds redesigned the admin
  members table independently and shipped contradictory tests about the same element. Scope lanes by
  FILE, not by theme.


_Last verified: 2026-08-23 for everything firmware — the three board/simulator builds, the host
suites under both native and ASAN/UBSAN, every lint gate, and a deliberate mutation of the relay
auto-off timer were all executed in that session. **The backend and frontend claims still carry
their 2026-08-22 verification**: `dotnet` is absent from a fresh remote session and was not
installed on 2026-08-23, so nothing here re-ran them._

_2026-08-22 — every claim below was executed, not read. A .NET 10 SDK and PlatformIO were installed into this environment (neither was present), a real Postgres 16 was started locally, the full suite was run, the migration was applied to a fresh database, and each quality gate was deliberately broken to confirm it fails. Verify before trusting anything dated older than ~60 days._

**Backend 284/284 green** (46 need Postgres and skip cleanly without it), **firmware 85/85 green** under both native and ASAN/UBSAN with no board attached. The backend was 24/30 at the start of 2026-08-22. **PR #1 is merged** (`0176d44`); `main` also carries `eacb20a` (the review record). The fix programme runs on `claude/e2e-fix-programme`. The delivery shape is one branch, one PR — agreed with the founder, so do not split it.

### The adversarial E2E review, round 2 (2026-08-24) — the system is not end-to-end

A two-round, 55-agent adversarial review was run against the **fixed wiring** as the immutable
contract: inputs were the canonical `Light Project Wiring.xlsx` (both sheets), the old
proven-working sketches from Dean.zip (`Squash_Court_System_FINAL_WORKING_2026-07-14`), five
photos of the actual build, and this repo. Every finding was independently verified by refuters;
**30 confirmed (7 critical, 7 high, 12 medium, 4 low), 1 refuted, 7 physical-verification
items**. Full evidence, file-and-line: [`docs/reviews/e2e-adversarial-review-2026-08-24.md`](../docs/reviews/e2e-adversarial-review-2026-08-24.md).

**The wiring layer is sound** — `Pins.h` matches the schematic and old sketches exactly; not
one finding is electrical. But the headline flow — book online, scan at the box, lights on —
**does not exist in the shipped code and cannot succeed by any path**. The seven criticals:
(1) clock-seed deadlock — provision never sends `server_unix`, so a real board can never make
its first signed API call; (2) nothing ever populates the roster, so every member scan is
refused; (3) no device-reachable activation endpoint exists and a member's walk-up fallback is
blocked by their own booking; (4) one box serves four courts but the device model is per-court
and `gCourtNumber` is never adopted; (5) walk-up charges `device.CourtNumber` while the box
lights the pressed button's court; (6) activation events never become attendance — **shipping
the roster fix alone converts every attended check-in into a refund plus penalty**; (7) no QR
token both fits the 24-byte scanner pipeline and passes backend JWT validation. Highs include:
the bridge never sends `!AUTH` (button panel dead), walk-up purchase not idempotent, the
biometric path still carries the wrong-row bug fixed elsewhere, a settled no-show holds the
slot to EndsAt, OTA is unsignable (private key unlocatable, no CI release job). All fail on
real hardware while the suites stay green, because tests inject exactly the data no production
path supplies — the same lesson as 2026-08-23, one layer up.

This round also falsified several claims earlier in this file and in the watch list (corrected
in place, marked ⟨corrected 2026-08-24⟩): the closing "Still red or unbuilt" list, the "no MAC
column" and "claim flow stops at returning the key" notes, the "repo-default OTA key" story and
the "first-ESP-flash DIP undocumented" claim — the wiring sheet documents it (Upload DIP
5+6+7 ON); the README dropped that exact row.

### The adversarial audit round (2026-08-23, later)

Three agents were pointed at the money paths, the tenancy boundary and the firmware, each told
to **refute** the claim that the branch was sound rather than confirm it, and to report nothing
rather than invent a finding. Between them they found sixteen real defects in code that had 495
passing tests, and this is the durable lesson: **a green suite is evidence about the tests, not
about the code.**

Fixed and pushed, every one pinned by a test that was watched to fail without its fix
(18 mutations run; one survivor reported rather than papered over):

- **Any member could cancel any other member's booking.** The member route passed the caller's
  own id as the actor and the service read "not the owner" as an admin acting on their behalf.
  Booking ids come free from `GET /api/v1/schedule`. The victim was also charged the
  late-cancellation penalty, and the audit row named the attacker as an administrator.
- **Registration wrote rows outside every tenant.** `/api/v1/auth/` skipped tenant resolution,
  so users, memberships and audit rows landed on `Guid.Empty` — invisible to the admin screen
  and to the duplicate-email check, which made it possible to register an address that already
  belonged to a real member.
- **Every platform admin sat inside every tenant** via the one query filter in the model with a
  disjunction; **a QR token was never checked against the tenant that minted it**; and **the
  payer override took a bare guid** with no second identification.
- **The front panel lit the wrong court.** `!BTN` carries a key character (`A`-`D`, `1`-`4`) and
  the bridge parsed it as a decimal index, so court buttons were dropped and duration buttons
  selected courts. It lived in `main.cpp`, which `pio test` and `strict_compile` both skip.
- **Four money races**: double-cancel refunded twice; the no-show sweep committed the money
  before the status that makes it idempotent; payer reassignment was three independent commits
  and not idempotent on retry; and two bookings by one member could both spend the same credits.
- **`RetentionWorker` could stop the no-show sweep permanently** — it anonymises a booking to a
  sentinel user id with no `users` row, and the sweep looked the subject up with `First()`.

### The court-hardware programme, phases A–J (2026-08-23)

**Everything below was executed in this session, not read.** Backend 495/495 with a real
Postgres attached (no skips), firmware 232/232 under both native and ASAN/UBSAN, frontend 28
vitest + 8 Playwright across a mobile and a desktop project, all three PlatformIO targets
building, every lint and complexity gate green.

**The money model changed.** The debit now happens **at booking**, not at lights-on. That
contradicts client blueprint A.9 — the customer's own words — so it is recorded as deviation
**D-1** in `docs/specs/client-blueprint-deltas.md` and **needs committee sign-off before
go-live**. `CLAUDE.md`'s third invariant was rewritten in the same commit. Cancelling refunds
in full less the penalty; nothing comes back once somebody has checked in; attendance is
`CheckedInAt` and never the clock, because `ChargedAt` is now set on every row.

**Live money defects found and fixed**, each mutation-proven:

- PIN and QR charged **nothing** — a member identifying that way got a free game *and* looked
  like a no-show, because nothing set `CheckedInAt`. Only biometric ever charged.
- Insufficient balance **lit the court anyway**: the charge failure was a `LogWarning` and
  `CheckedInAt` was stamped regardless, which disqualified the booking from the no-show sweep.
- `/api/v1/court/` **bypassed tenant resolution**, so all three courtside endpoints had never
  worked — they resolved `TenantId == Guid.Empty` and 404'd forever.
- Three disagreeing grace windows (5 from an app-config key absent from `appsettings.json`,
  30 hardcoded twice, and the tenant setting) reconciled onto `grace_window_minutes`.
- The admin settings GET invented its own defaults — 30 minutes and 50 credits where the engine
  used 15 and 8 — so **opening the settings page and pressing save doubled every slice and
  repriced every court**, silently.
- Credits were rendered with a **rand sign in six places**. At 1.6–2.4 credits per rand that
  overstates a balance by 60–140%. One call site was named `priceZar` while holding credits.
- A GiST exclusion constraint now makes overlapping bookings unrepresentable. The check-then-
  insert race was survivable when a booking took no money; under charge-at-booking both members
  are debited before the collision is visible.

**The ESP8266 half is built and connected.** `lib/eventq`, `lib/roster`, `lib/court`,
`lib/devapi`, `lib/otacore`, plus four device endpoints — heartbeat, provision, events and
walk-up. A board collects its own key with the claim code shown on its LCD, uploads what it
did, and buys court time at the pad.

Two things fell out of connecting it, both constraints rather than choices:

- **A PIN cannot identify a walk-up.** A PIN is checked against the handful of members with a
  booking on that court, which is what makes four digits usable. A walk-up has no booking, so
  the same check against the whole roll is a 10,000-space oracle over a club with far fewer
  than 10,000 members. Only QR identifies globally, and there is a test on the rule itself.
- **The roster is still never pushed, and that is a security trade nobody has taken.** A QR
  token is a 60-second signed JWT and cannot be pre-cached by construction. An offline roster
  therefore needs a *stable* identifier, and a token a box can compare against a typed PIN is
  one a stolen box can brute-force. ⟨corrected 2026-08-24⟩ The review falsified the claim
  that the online path was what ran — no online scan path existed either. The decision is now
  taken: the fix programme implements **online-first activation plus a roster fallback of
  per-booking, expiring access codes**, so a stolen box caches only booking-scoped codes.
  `lib/roster` is built and tested. Item 10 on the go-live checklist.

**Buttons are remappable from the admin panel**, and both implementations of the token grammar
read `src/contracts/device-protocol/buttonmap/cases.json` — which caught a real drift on its
first run (C# trims both ends, the firmware only trimmed the leading space).

**OTA exists**, signed RSA-2048/SHA-256 through the ESP8266 core's `Updater`. Two honest limits,
both recorded as **D-2**: it is not Ed25519 (BearSSL has none, and vendoring a curve into a
court-lighting controller is the worse trade — the asymmetric property the plan wanted is
unchanged), and there is **no rollback**, because a 4M part with 1 MB sketch and 2 MB LittleFS
has no second slot. What `BootGuard` buys is that a bad build is never installed twice, which is
the failure that takes a club out. ⟨corrected 2026-08-24⟩ The signing pipeline *code* exists, but
the private key is unlocatable and no release job signs or hosts an image — OTA is unsignable
until the key is minted (watch item 5, review A2-2/A2-3).

**Two accessibility defects** were found by tests written against existing components:
`ConfirmButton`'s accessible name was every copy of its label concatenated, and `AdminSettings`'
`Field` rendered a label with no `htmlFor`, so every input on that page was unlabelled.

**Known limit, accepted knowingly:** queued events are in RAM. They survive the WiFi going away
and a two-day outage; they do not survive a power cut, because `hal::IStore` caps a value at 32
bytes. Consequence and mitigation are in the go-live checklist.

### What changed on 2026-08-23

- **`make build` passes its firmware leg for the first time.** See "Still red or unbuilt" below for the three
  separate causes; the short version is a library owner prefix that never existed in the PlatformIO registry,
  three empty source directories, and a `-std` flag that the Arduino builder had been silently overriding.
- **`lib/arduino_hal` and `lib/posix_hal` are real.** Both were empty directories that `README.md` and
  `lib/README.md` described as existing. All seven ports now have a driver on each side, and `pio run`
  compiles all 16 of those source files — which is what `tools/strict_compile.sh` has always claimed when it
  excludes those two directories, and was not true until now. Note the excluded set is compiled with
  `-Wall -Wextra` only, not the strict gate's `-Werror -Wconversion -Wold-style-cast` set.
- **`lib/courtlogic` is new** and holds everything the Mega does; the three `main.cpp` files hold only wiring.
- **CI gained an `iot-build` job** that runs `pio run` for all three targets and starts the simulator to check
  it binds. It gates the four Docker build jobs, so a broken firmware build now blocks a release.

### What changed on 2026-08-22

- **The credits rename is done** and the money bug is closed — see gotchas, which now records it as fixed rather than open. `AmountZar → AmountCredits`, `AmountChargedZar → AmountChargedCredits`, `SlicePriceZar → SlicePriceCredits`, plus every wire key. Genuinely-rand fields (`PendingTopup.AmountZar`, `ZarPaid`, `ConversionRate`, `top_ups_zar`, the `topup_*` and `credits_per_zar_*` settings) were deliberately left alone, so both units now carry honest names.
- **The schema is deployable.** Confirmed empirically that a production boot against a fresh Postgres previously threw `PendingModelChangesWarning` and died. The migration is regenerated from the model (a real 26KB `InitialCreate` and a real 27KB snapshot, replacing hand-written SQL and a 52-line stub), the raw DDL block is gone from `Seeder.cs`, and all eight previously-orphaned columns plus `webauthn_credentials` are now migrated.
- **The Mega <-> ESP serial protocol codec is built** — `src/iot/lib/protocol` (v2 `!VERB,args*CC\n` plus both-ways legacy compatibility), 22 Unity tests, and a 108-case shared corpus at `src/contracts/device-protocol/serial/`. The "no `ON` without a duration" rule is a static_assert and a required constructor argument, not a comment: weakening ON's row in `kVerbSpecs` fails the build. Confirmed by mutation — accepting a bad checksum and dropping the escaping each turn four tests red.
- **`src/iot/` exists** — a PlatformIO project with `native`, `native_asan`, `native_cov`, `court_mega`, `court_bridge` and `simulator` environments, pinned platform versions, and `lib/timebase` (rollover-safe time, 10 tests at four clock bases). `src/firmware/lights-controller/` is deleted.
- **The firmware itself is built and all three targets compile (2026-08-23).** `lib/courtlogic` holds the Mega's whole behaviour — the independent relay auto-off timer with its 90-minute hard cap, the 80 ms button debounce, scanner line assembly, the expiring authorisation window and the frame dispatcher — with 41 host tests run at four clock bases including the `millis()` wrap. `lib/arduino_hal` and `lib/posix_hal` now exist (they were empty directories the READMEs described): real drivers for relay, buttons, LCD, both UARTs, EEPROM and LittleFS, and host drivers behind a loopback TCP transport for the simulator. The three `main.cpp` files are composition roots and hold no behaviour, because `pio test -e native` filters `src/` out entirely. Confirmed by mutation — swapping `tb::Deadline::expired()` for the deleted sketch's `now >= expiresAt` turns two tests red, both of them wrap cases.
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
- **The device-discovery firmware module is built** — `src/iot/lib/discovery` (beacon codec, canonical form + HMAC, claim code/commitment, announce state machine), 21 Unity tests, and a 24-case shared corpus at `src/contracts/device-protocol/discovery/` read by both this and the .NET listener. Two rules are types rather than comments: a claimed box cannot be asked to accept an unsigned OFFER (`ClaimedBox` takes the key as a required constructor argument and `accept()` has no verification-skipping overload), and the claim code cannot be encoded into an ANNOUNCE (`Packet` has no public field setter and `announceUnclaimed()` takes a `ClaimCommitment`). Confirmed by mutation — disabling checksum verification, the canonical sort, and the commitment's `:` separator turns 2, 5 and 3 tests red respectively.

### The mainframe half of device discovery (2026-08-22, later still)

The server side of `docs/specs/device-discovery.md` is built and the shared corpus is now
read by both implementations: `Security/Discovery/` (beacon codec, bounded announcer store,
`DiscoveryListener` hosted service, DB-backed device resolver), `Services/DeviceDiscoveryService`
for the claim decision, and three admin endpoints under `/api/v1/admin/devices` —
`GET /discovered`, `POST /claim`, `GET /discovery-status`. 54 new tests; all 24 corpus cases
execute on the .NET side (5 encode, 16 decode, 3 claim). Confirmed by mutation: disabling
checksum verification, the canonical sort, and the duplicate-commitment refusal turns 2, 3
and 3 tests red respectively.

Three things worth knowing before touching it:

- **`docker-compose.onprem.yml` is new and is not optional at the club.** On the base compose
  file the backend is on a bridge, so the listener receives nothing, ever. The status endpoint
  reports that state rather than letting it look like a firmware fault.
- ⟨corrected 2026-08-24⟩ **The claim flow no longer stops at returning the key** —
  `POST /api/v1/device/provision` exists (`DeviceEndpoints.cs:119`) and the board fetches its
  own key. But the provision response omits `server_unix`, which is critical finding C1 of the
  2026-08-24 review: the board can never seed its clock and never signs a request.
- ⟨corrected 2026-08-24⟩ **`Device` has a MAC column** — migration
  `20260822235151_AddDeviceMacAddress`, `Domain/Device.cs:86`, with tests.

### Still red or unbuilt

The seven Actions secrets remain unset (`DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `PORTAINER_URL`,
`PORTAINER_TOKEN`, `PORTAINER_STACK_ID`, `PORTAINER_ENDPOINT_ID`, `OTA_PRIVATE_KEY`), so the
release chain still cannot run.

~~**`make build` fails at `build-iot`**~~ — **FIXED 2026-08-23.** Both causes are gone: the library coordinate is now `marcoschwartz/LiquidCrystal_I2C@1.1.4` (same API, same version, the owner prefix was simply wrong — johnrickman's exists only in the Arduino Library Manager index, never in the PlatformIO registry), and all three source directories are populated. `pio run -e court_mega -e court_bridge -e simulator` succeeds; `court_mega` uses 23.7% of SRAM and 6.1% of flash. A third cause surfaced once the first was fixed: the Arduino AVR builder appends `-std=gnu++11` after `build_flags`, so `[common]`'s `-std=gnu++17` had never applied and lib/'s `inline constexpr` variables could not compile for the board — `build_unflags = -std=gnu++11` fixes it. A new `iot-build` CI job now runs `pio run` for all three targets and gates the four Docker jobs, so this cannot go quiet again.

⟨corrected 2026-08-24⟩ The "Not started" list that closed this file was falsified by this
file's own earlier sections and by inspection (`Payments/PayFast/` exists, three firmware
targets compile, signed OTA is built): PayFast, court firmware, charge-at-booking and OTA are
all built. What is genuinely not working end to end is catalogued, with evidence, in
[`docs/reviews/e2e-adversarial-review-2026-08-24.md`](../docs/reviews/e2e-adversarial-review-2026-08-24.md).
Gates remain parked by decision — the hardware is undecided.
