# End-to-end proof of the court-light system, without hardware

```bash
make test-e2e-device
```

One command, one Python file (`scenario.py`, stdlib only), one verdict. It stands up the
real stack, plays every part the missing hardware would, asserts each review finding the
fix programme closed, prints a `finding-id -> assertion` table and exits non-zero on any
failure. A passing run leaves nothing behind — the per-run database is dropped and
`.tmp/e2e-device/` is emptied; a failing run keeps both and prints the failing HTTP
exchanges plus the API log tail.

## What is real and what is played

| Component | Real or played | How |
|---|---|---|
| API | **real**, from source | `dotnet build` then the DLL, `ASPNETCORE_ENVIRONMENT=Development` so the Seeder creates the pilot tenant, admin, four courts and five sample members |
| Postgres | **real** | whatever answers on `E2E_PG_HOST:E2E_PG_PORT` (default `localhost:5439`, the throwaway `crusaders-fixprog-pg` container; `docker start`/`docker run` if nothing is listening — in CI the `e2e-device` job points these at its Postgres service container, so no docker is needed there). A fresh `e2e_device_<stamp>` database per run — EF's `Migrate` creates it — so re-runs never see each other |
| Mega half of the court box | **real firmware** | `src/iot/.pio/build/simulator/program`: the same `courtlogic::CourtBox`, `lib/protocol` codec and relay auto-off timer the ATmega runs, behind `posix_hal` and a TCP socket. Built by the target with `pio run -e simulator` |
| PayFast | **imposter** | mountebank with `test/virtualization/payfast/imposter.json` — the same file `make virt-up` and `docker-compose.test.yml` use. Reused if one is already up on `:4545` |
| ESP8266 bridge | **played** by the script | the club's device API key as a bearer header and the box's MAC in every body (both self-tested against `src/contracts/device-protocol/http/cases.json` before anything else), heartbeat, `/activate`, `/events`, `/walkup`, and the serial `!VERB,arg*CC` codec towards the simulated Mega |
| Member's phone | **played** | admin password reset → member login → `POST /me/qr/generate` |
| Admin | **played** | settings, court prices, credits, bookings on behalf, ledger reads |
| PayFast's ITN | **played** | a `COMPLETE` notification signed with PHP-`urlencode` + MD5 in posted order, the seeded passphrase, then replayed and then tampered |

### Why the simulator is only the Mega, and why that is enough

`src/iot/src/simulator/main.cpp` says it outright: *"This is a MEGA simulator: it speaks the
downlink side of the serial protocol and expects a bridge — or a test — on the socket."* It
runs `courtlogic::CourtBox` (relays, LCD, buttons, scanner, auth window, auto-off timer) over
`posix_hal` and listens on loopback TCP for one peer. It does **not** run `bridgelogic` or
`devapi`; it has no WiFi, no HTTP client, and it cannot speak to the API.
Its console (stdin) accepts `scan <code>`, `btn <A-D|1-4>` and `quit`; its stdout prints
relay transitions (`[relay] court C ON`).

So the script is the bridge. It drives the device API directly with a key-bearing HTTP client and,
separately, drives the simulator's serial protocol to prove the Mega half — and it chains the
two where the real bridge would: the scan code is fed to the simulated scanner, taken off the
wire as `!SCAN,<code>`, sent to `POST /api/v1/device/activate`, and the grant is sent back
down as `!ON,C,<granted_seconds>`, whose `!STATE` mask and remaining seconds are then read
back. The ESP's own decision logic (`lib/bridgelogic`) is covered by the host test suite
(`make test-iot`), not here.

## The steps and what each pins

The finding ids are those of `docs/reviews/adversarial-e2e-review.md`. `R<n>` ids came from the
2026-09-04 closing re-review, whose report is no longer kept — every finding it raised was closed
or superseded by the device-contract simplification, so those ids name the assertion below and
nothing else.

| Step | Finding | Assertion, in one line |
|---|---|---|
| Preflight | C1 | this script's device request shape matches the shared corpus: an `Authorization: Bearer` header, and a `mac` that is already twelve lowercase hex (a vector pinning `5C:CF:...` would be a firmware that registers a second row for a board that already has one) |
| Seed | setup | settings tuned over the admin API (slice 15, grace 1, cue 10, roster 120, forward 240, walk-up cap 90, QR lifetime 900); **the club opened `00:00-23:59` on every weekday**, because the seeded hours are a real club's (`06:00-22:00`, `07:00-20:00` at the weekend) and outside them the walk-up leg cannot buy court time at all; courts priced at 8; member M logged in via admin reset; credits via admin adjustment; every seeded booking overlapping the windows this run books over is admin-cancelled **with its mandatory waiver reason**, and the windows are re-read to confirm they are actually clear |
| 1 | **C1 / C4** | `GET /admin/devices/api-key` mints and returns the club's key with a `regenerated_at`, and a second read returns the **same** key (readable, not shown-once — it has to be pasteable into a `secrets.h` weeks later); a heartbeat with no key at all is 401; one with an unrecognised key is 401 with an **empty** body (no reason, no clock); the first heartbeat from an unknown MAC **registers the box itself**, named `box-<last six of the mac>` and driving `[1,2,3,4]`, with no `server_unix` and no `ota` anywhere in the response; the admin Devices list shows it flagged `auto_registered`; a second heartbeat from the same MAC does not create a second row; a `mac` that is not twelve hex characters is `400 mac_required` rather than a 404 that would read as "unknown board" |
| 2 | **C2 / C4 / H2 / R17** | `court_numbers == [1,2,3,4]`; the heartbeat carries no `server_unix`; every roster entry matches `TOKEN\|relay\|opens_in\|closes_in`; M's bookings appear on relays 0 and 2 with signed relative seconds measured from the response instant (cue already open, `closes_in − opens_in = 45 min + cue`); the booking three hours out is absent at `roster_window 120`, present at 240, absent again at 120; tokens are 12-char access codes; the QR screen shows the same code the roster carries on relay 2; the admin device list shows the box's courts, `last_seen_at`, `running_version` and `button_map: null` (no per-box override), and the heartbeat carried the club's eight-entry map |
| 3 | **C3 / C4** | `!SCAN` from the simulated scanner → `/activate` → `activated`, `court_number 3`, the booking's id, `granted_seconds ≤ 5400` and equal to the slot remainder; `!ON,C,<granted>` closes relay C on the simulator (`!STATE` mask + remaining, `[relay] court C ON`); a repeat scan is idempotent with fewer seconds; the ledger holds only the booking-time charge; `!OFF,C` reports `!EVT,OFF,C` and clears the mask |
| 4 | **C6** | an uploaded activation event (relay 0, the booking's code, uptime arithmetic) is `accepted_through 1, recorded 1`; the booking STAYS on the roster while live (checked in and re-lightable offline — a slot longer than the 90-minute relay cap needs its second half re-lit from the roster); a scan now answers as a live session; replaying the seq is acknowledged and not re-recorded; a relay/court mismatch is receipted, not refused |
| 5 | **C5 / H3 / M1 / R19** | walk-up on court 2 (named, on the box) for 60 min → 32 credits, `replayed:false`, balance after == before − 32; the identical nonce → `replayed:true`, same `booking_id`, the REMAINDER of the grant (59–60 seconds later; a replay never re-grants the original length), wallet unchanged, one `LightsPurchase` row; the walk-up is a real booking on the schedule; court 5 → `400 court_not_on_device`; no nonce → `400 nonce_required`; B3's booking code as the buyer → `400 not_recognised` with the wallet untouched (a roster code is not a wallet); 240 min → `400 minutes_out_of_range` with `max_minutes 90` |
| 6 | **A2-15** (early scan) | a booking three hours out → `activated:false, too_early, granted 0, court_number 2, starts_in_seconds ≈ 3 h`; a second scan is still `too_early` (nothing was stamped — a live session is never too early); its only ledger row is the booking charge |
| 7 | **Money** | `POST /credit/topup` registers R100 and points at PayFast's process URL; the imposter answers the checkout POST with a 302; a signed `COMPLETE` ITN credits 160 (R100 × 1.6) once; the top-up reads `Completed`; the same ITN replayed is `idempotent:true` and credits nothing; an ITN altered after signing is 401; exactly one `TopUp` row |
| 8 | **Mega** | `!PING`→`!PONG`; a button press with no `!AUTH` produces no `!BTN`; after `!AUTH,30` it does; `!AUTH,1` lapses into one `!EVT,AUTHEXPIRED` and presses are dropped again; `!ON,B,1` auto-offs by the Mega's own timer (`!EVT,AUTOOFF,B`, mask cleared); `!ON,D,99999` is clamped to 5400; a wrong checksum → `!ERR,BADCRC` and no relay moves; court E → `!ERR,NOCOURT`; `!EXT` on an open relay → `!ERR,BADARG`; `!RST` → mask 0 |
| 9 | **H5 / C6 / C3** | an unscanned booking is swept to `noshow` within ~30 s of its 1-minute grace lapsing; its `EndsAt` is truncated to the sweep time; the ledger holds `BookingCharge −24`, `CancellationRefund +24`, `NoShowPenalty −7.20` as separate rows; the member's balance equals the sum of their ledger rows; the freed slot is immediately bookable again; the two attended bookings are still `booked` with no refund and no penalty |

The whole run takes three to four minutes; most of it is waiting for the no-show grace window
and the 30-second sweep, which the script waits for rather than short-circuits — the
`BackgroundService` timer is part of what is being proved.

## What it deliberately does not prove

- **The ESP8266's own logic.** `bridgelogic` (roster sync, scan flow, walk-up nonce, `!STATE`
  reconciliation) is host-tested in `src/iot/test/`. This script re-implements the bridge's
  *wire* behaviour to drive the API; it does not execute the firmware's decisions.
- **That the integration works against PayFast.** The imposter proves the API's handling of a
  callback; the signature algorithm is pinned by `src/contracts/payfast`. The first live
  transaction remains a real milestone.
- **`CheckedInAt` directly.** No endpoint exposes it, so attendance is asserted through its
  observable consequences: a re-scan answers as a live session (remaining seconds, no cue
  check), and the no-show sweep leaves it alone. An admin-facing attendance field is a
  reasonable follow-up.
- **The tenant's PayFast credentials.** There is no admin API for `tenant_settings.payfast`
  yet, so the ITN is signed with the Development seeder's placeholder passphrase
  (`Seeder.cs`). If that seed changes, `SEEDED_PAYFAST_PASSPHRASE` at the top of the script
  is the one place to follow it.

## Two ways this harness lied to itself (2026-09-06)

Both were found by CI going red at 16:09 UTC on a run that was green on the founder's
machine at 19:57 SAST four hours later, and both are the same shape: **a step that asked the
API for something, did not check the answer, and carried on.**

- **`ensure_free` had been a no-op for as long as the waiver reason has been mandatory.**
  §8's admin cancel is *"penalty waiveable with reason"* and the endpoint enforces it —
  `{"waivePenalty": true}` with no `waiveReason` is `400 waive_reason_required` — and this
  step sent exactly that, then **printed** the status instead of asserting it. Whether that
  mattered depended on the hour: the seeder plants demo bookings at fixed local times, so at
  19:57 SAST the seeded 19:00 slot on court 2 is in the past and nothing collides, while at
  18:09 SAST it is fifty minutes out and survives. It then poses as this run's own fixtures —
  the member-ident QR comes back as *that* booking's activation code, the roster carries it on
  relay 1 where B6 should be, the walk-up correctly refuses it as a wallet, and the too-early
  scan reports the time to the wrong slot. Five checks fail and none of them names the cause.
  The cancel now carries its reason, every refusal is fatal, and the window is re-read
  afterwards: *"I asked"* is not *"it is clear"*.
- **The walk-up leg cannot run while the club is shut.** With the first bug fixed, a run after
  20:00 on a Sunday failed `walk_up_refused` instead — correctly, because there is no court
  time left to sell. The run now opens the club for the whole local day. That does not bypass
  the closing-time rule: `walk_up_expectation` still derives what to expect from whatever the
  schedule says the club's hours are, so a truncated grant is still asserted as truncated. It
  moves the close somewhere the run is not standing on, and a club with nothing left to sell
  now fails with a sentence saying so rather than an opaque wire error.

The general lesson is the one `memory/gotchas.md` already carries in three other forms: **a
test that books relative to `UtcNow` inherits the wall clock as a hidden input.** The
mechanical tell in both cases was a step whose result was printed rather than asserted.

## Observations from the first passing runs (2026-09-04)

Not defects in the fix programme, but worth knowing before reading the output:

- **The API never talks to the imposter.** `PayFastProvider.RegisterCheckoutAsync` makes no
  network call and `redirect_url` is the real sandbox URL; the imposter only ever stands in for
  the *browser* leg (`/eng/process`). `test/virtualization/README.md`'s "what the API is pointed
  at instead of PayFast" overstates it. The ITN leg is the API's real code path either way.
- **The imposter's happy-path `Location` is a literal template.** mountebank does not expand
  `{{request.body.m_payment_id}}` inside an `is` response without a behaviour, so the redirect
  reads `/wallet/topup/{{request.body.m_payment_id}}?status=ok`. Harmless to this script (it
  asserts the 302), misleading to anyone driving a browser at it.
- **Admin bookings answer 200, not 201.** The freed-slot assertion accepts any 2xx.
- **A checkout under a dot-directory on macOS** (`.claude/worktrees/...`) carries the BSD
  `hidden` flag on every file, which .NET's `PhysicalFileProvider` excludes — the API boots with
  no `appsettings.json` at all. That is why the harness gives it a scratch content root. See
  `memory/gotchas.md`.

## Knobs

| Variable | Default | Meaning |
|---|---|---|
| `E2E_PG_HOST` / `E2E_PG_PORT` | `localhost` / `5439` | the Postgres to create the per-run database on |
| `E2E_PG_USER` / `E2E_PG_PASSWORD` | `crusaders` / `crusaders_test_pw` | must be allowed to `CREATE DATABASE` |
| `E2E_PG_CONTAINER` / `E2E_PG_IMAGE` | `crusaders-fixprog-pg` / `postgres:16-alpine` | started with docker only when nothing answers on the port |
| `E2E_MB_PORT` / `E2E_MB_ADMIN_PORT` | `4545` / `2525` | the imposter, as in `imposter.json`; an already-running one is reused |
| `E2E_SMTP_PORT` | unset | point at MailHog (`:1025` or `:11025` under compose) to see the emails; unset, sends fail fast and are logged, as the API is designed to tolerate |
| `E2E_KEEP_DB=1` | | keep the database after a passing run |
| `E2E_SKIP_BUILD=1` | | reuse the existing `bin/Debug` DLL |
| `DOTNET`, `PIO`, `PY` | `dotnet`, `src/iot/.venv/bin/pio`, `src/iot/.venv/bin/python` | toolchain overrides, as elsewhere in the Makefile |
| `--no-simulator`, `--no-money` | | script flags to skip the Mega or PayFast legs |

The API is started on an ephemeral port, so two runs on one host cannot collide, and rate
limits are raised far above a club's traffic so the scenario's burst of auth calls is not
mistaken for password guessing.

## Why not `make virt-up`

`virt-up` depends on `build-iot`, which compiles the AVR and Xtensa targets too, binds the
simulator to a fixed `:5555`, and keeps pidfiles in `/tmp`. This target needs only the
simulator, wants a kernel-chosen port so two runs cannot collide, and must clean up after
itself. It reads the same `imposter.json` and runs the same simulator binary, so nothing here
is a second copy of the virtualization setup — only a different process manager for it.

## CI wiring

Wired. `.github/workflows/ci.yml` carries an `e2e-device` job (`needs: [backend, iot-build]`)
with its own `postgres:16-alpine` service on 5432, the pinned pio toolchain and `npx`, and
all six image builds gate on it. `E2E_PG_HOST`/`E2E_PG_PORT` point the script at the service
container, so nothing reaches for docker, and `.tmp/e2e-device/` is uploaded as an artifact
on failure.

This section used to say "Not added to ci.yml yet" and describe the job as a commented-out
sketch. It was added in the same wave that wrote that sentence and the sentence was never
deleted — read the workflow, not this paragraph, if the two ever disagree again.
