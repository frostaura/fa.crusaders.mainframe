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
| Postgres | **real** | whatever answers on `E2E_PG_HOST:E2E_PG_PORT` (default `localhost:5439`, the throwaway `crusaders-fixprog-pg` container; `docker start`/`docker run` if nothing is listening). A fresh `e2e_device_<stamp>` database per run — EF's `Migrate` creates it — so re-runs never see each other |
| Mega half of the court box | **real firmware** | `src/iot/.pio/build/simulator/program`: the same `courtlogic::CourtBox`, `lib/protocol` codec and relay auto-off timer the ATmega runs, behind `posix_hal` and a TCP socket. Built by the target with `pio run -e simulator` |
| PayFast | **imposter** | mountebank with `test/virtualization/payfast/imposter.json` — the same file `make virt-up` and `docker-compose.test.yml` use. Reused if one is already up on `:4545` |
| ESP8266 bridge | **played** by the script | UDP `ANNOUNCE`/`OFFER`, the claim commitment, `POST /provision`, base64url HKDF key, the canonical-string HMAC signer (self-tested against `src/contracts/device-protocol/http/cases.json` before anything else), heartbeat, `/activate`, `/events`, `/walkup`, and the serial `!VERB,arg*CC` codec towards the simulated Mega |
| Member's phone | **played** | admin password reset → member login → `POST /me/qr/generate` |
| Admin | **played** | settings, court prices, credits, bookings on behalf, ledger reads |
| PayFast's ITN | **played** | a `COMPLETE` notification signed with PHP-`urlencode` + MD5 in posted order, the seeded passphrase, then replayed and then tampered |

### Why the simulator is only the Mega, and why that is enough

`src/iot/src/simulator/main.cpp` says it outright: *"This is a MEGA simulator: it speaks the
downlink side of the serial protocol and expects a bridge — or a test — on the socket."* It
runs `courtlogic::CourtBox` (relays, LCD, buttons, scanner, auth window, auto-off timer) over
`posix_hal` and listens on loopback TCP for one peer. It does **not** run `bridgelogic` or
`devapi`; it has no WiFi, no UDP discovery, no HTTP client, and it cannot speak to the API.
Its console (stdin) accepts `scan <code>`, `btn <A-D|1-4>` and `quit`; its stdout prints
relay transitions (`[relay] court C ON`).

So the script is the bridge. It drives the device API directly with a signed HTTP client and,
separately, drives the simulator's serial protocol to prove the Mega half — and it chains the
two where the real bridge would: the scan code is fed to the simulated scanner, taken off the
wire as `!SCAN,<code>`, sent to `POST /api/v1/device/activate`, and the grant is sent back
down as `!ON,C,<granted_seconds>`, whose `!STATE` mask and remaining seconds are then read
back. The ESP's own decision logic (`lib/bridgelogic`) is covered by the host test suite
(`make test-iot`), not here.

## The steps and what each pins

The finding ids are those of `docs/reviews/e2e-adversarial-review-2026-08-24.md`.

| Step | Finding | Assertion, in one line |
|---|---|---|
| Preflight | C1 | the local signer reproduces every request signature in the shared corpus |
| Seed | setup | settings tuned over the admin API (slice 15, grace 1, cue 10, roster 120, forward 240, walk-up cap 90, QR lifetime 900); courts priced at 8; member M logged in via admin reset; credits via admin adjustment |
| 1 | **C1** | UDP `ANNOUNCE` → `OFFER` echoes the nonce and carries the API URL; board visible as claimable; claim registers a four-court box; a wrong claim code is a uniform 404 **and burns the grant** (the right code is refused afterwards); provision returns `server_unix` within 5 s of wall clock and the same key the admin was shown; the grant is single-use; a heartbeat signed with `unix_seconds=0` is a 401 whose body is exactly `{"server_unix"}` with `WWW-Authenticate: Device`; a wrong-key signature gets the same body and no reason; a correctly signed heartbeat is 200 |
| 2 | **C2 / C4 / H2** | `court_numbers == [1,2,3,4]`; every roster entry matches `TOKEN\|relay\|opens_in\|closes_in`; M's bookings appear on relays 0 and 2 with signed relative seconds measured from the response instant (cue already open, `closes_in − opens_in = 45 min + cue`); the booking three hours out is absent at `roster_window 120`, present at 240, absent again at 120; tokens are 12-char access codes; the QR screen shows the same code the roster carries on relay 2; the admin device list shows the box's courts, `last_seen_at` and `running_version` |
| 3 | **C3 / C4** | `!SCAN` from the simulated scanner → `/activate` → `activated`, `court_number 3`, the booking's id, `granted_seconds ≤ 5400` and equal to the slot remainder; `!ON,C,<granted>` closes relay C on the simulator (`!STATE` mask + remaining, `[relay] court C ON`); a repeat scan is idempotent with fewer seconds; the checked-in booking leaves the roster; the ledger holds only the booking-time charge; `!OFF,C` reports `!EVT,OFF,C` and clears the mask |
| 4 | **C6** | an uploaded activation event (relay 0, the booking's code, uptime arithmetic) is `accepted_through 1, recorded 1`; the booking leaves the roster (attendance stamped); a scan now answers as a live session; replaying the seq is acknowledged and not re-recorded; a relay/court mismatch is receipted, not refused |
| 5 | **C5 / H3 / M1** | walk-up on court 2 (named, on the box) for 60 min → 32 credits, `replayed:false`, balance after == before − 32; the identical nonce → `replayed:true`, same `booking_id`, wallet unchanged, one `LightsPurchase` row; the walk-up is a real booking on the schedule; court 5 → `400 court_not_on_device`; no nonce → `400 nonce_required`; 240 min → `400 minutes_out_of_range` with `max_minutes 90` |
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
  observable consequences: the booking leaves the heartbeat roster, a re-scan answers as a
  live session, and the no-show sweep leaves it alone. An admin-facing attendance field is a
  reasonable follow-up.
- **The tenant's PayFast credentials.** There is no admin API for `tenant_settings.payfast`
  yet, so the ITN is signed with the Development seeder's placeholder passphrase
  (`Seeder.cs`). If that seed changes, `SEEDED_PAYFAST_PASSPHRASE` at the top of the script
  is the one place to follow it.

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

The API is started on an ephemeral port with its discovery listener on an ephemeral UDP port
bound to loopback — not 48653 — so another API on the same host cannot swallow the beacons,
and rate limits are raised far above a club's traffic so the scenario's burst of auth calls is
not mistaken for password guessing.

## Why not `make virt-up`

`virt-up` depends on `build-iot`, which compiles the AVR and Xtensa targets too, binds the
simulator to a fixed `:5555`, and keeps pidfiles in `/tmp`. This target needs only the
simulator, wants a kernel-chosen port so two runs cannot collide, and must clean up after
itself. It reads the same `imposter.json` and runs the same simulator binary, so nothing here
is a second copy of the virtualization setup — only a different process manager for it.

## CI wiring — a sketch, not wired

Not added to `ci.yml` yet; the target needs a Postgres service, the pinned pio toolchain and
`npx`, which are spread across three existing jobs today. The shape it would take:

```yaml
  # e2e-device:
  #   name: End-to-end (device, no hardware)
  #   runs-on: ubuntu-latest
  #   timeout-minutes: 20
  #   needs: [backend, iot-build]
  #   services:
  #     postgres:
  #       image: postgres:16-alpine
  #       env: { POSTGRES_USER: crusaders, POSTGRES_PASSWORD: crusaders_test_pw, POSTGRES_DB: crusaders_mainframe_test }
  #       ports: ["5439:5432"]
  #       options: >-
  #         --health-cmd "pg_isready -U crusaders" --health-interval 5s --health-timeout 5s --health-retries 10
  #   steps:
  #     - uses: actions/checkout@v5
  #     - uses: actions/setup-dotnet@v4
  #       with: { dotnet-version: "10.0.x" }
  #     - uses: actions/setup-node@v4
  #       with: { node-version: "22" }
  #     - uses: actions/setup-python@v5
  #       with: { python-version: "3.12", cache: pip, cache-dependency-path: src/iot/requirements.txt }
  #     - uses: actions/cache@v4
  #       with: { path: ~/.platformio, key: "pio-boards-${{ runner.os }}-${{ hashFiles('src/iot/platformio.ini') }}" }
  #     - run: pip install -r src/iot/requirements.txt
  #     - run: make test-e2e-device PIO=pio PY=python3
  #       env: { E2E_PG_HOST: localhost, E2E_PG_PORT: "5439" }
  #     - if: failure()
  #       uses: actions/upload-artifact@v4
  #       with: { name: e2e-device-scratch, path: .tmp/e2e-device/, retention-days: 7 }
```
