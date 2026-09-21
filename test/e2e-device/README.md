# End-to-end proof of the device chain, without hardware

```bash
make test-e2e-device
```

One command, **two** Python files (stdlib only), one verdict each. Both stand up the real
stack, play every part the missing hardware would, assert each review finding the fix
programme closed, print a `finding-id -> assertion` table and exit non-zero on any failure.
A passing run leaves nothing behind — the per-run database is dropped and
`.tmp/e2e-device/` is emptied; a failing run keeps both and prints the failing HTTP
exchanges plus the API log tail.

| File | Proves |
|---|---|
| `scenario.py` | the **court box**: the club key, auto-registration, the roster, `/activate`, `/events`, `/walkup`, the money leg, the Mega simulator over serial, the no-show sweep |
| `door_evening.py` | the **door**: one board's whole evening — and it reads every device response *the way the board does*, over a raw socket. See [Why the door reads its own sockets](#why-the-door-reads-its-own-sockets) |
| `wire.py` | not a scenario: the board-grade HTTP reader `door_evening.py` uses |
| `gate_sim.py` | not a scenario either: the **compiled door firmware**, driven as a process. Step `DSIM`. See [The door's own firmware](#dsim--the-doors-own-firmware-in-the-chain) |

The court box runs first because it is the shorter of the two and a shorter failure is the
cheaper signal. The rest of this file is `scenario.py`'s unless a heading says otherwise.

## What is real and what is played

| Component | Real or played | How |
|---|---|---|
| API | **real**, from source | `dotnet build` then the DLL, `ASPNETCORE_ENVIRONMENT=Development` so the Seeder creates the pilot tenant, admin, four courts and five sample members |
| Postgres | **real** | whatever answers on `E2E_PG_HOST:E2E_PG_PORT` (default `localhost:5439`, the throwaway `crusaders-fixprog-pg` container; `docker start`/`docker run` if nothing is listening — in CI the `e2e-device` job points these at its Postgres service container, so no docker is needed there). A fresh `e2e_device_<stamp>` database per run — EF's `Migrate` creates it — so re-runs never see each other |
| Mega half of the court box | **real firmware** | `src/iot/court-box/.pio/build/simulator/program`: the same `courtlogic::CourtBox`, `court-box/lib/protocol` codec and relay auto-off timer the ATmega runs, behind `posix_hal` and a TCP socket. Built by the target with `pio run -e simulator` |
| **The door gate board** | **real firmware** | `src/iot/door-gate/.pio/build/simulator/program`: the same `gatelogic::GateApp` loop, `GateApi`, `GateFlow` status table, `ResponseBody` de-chunker, `UnlockTimer`, `LockDriver`, `ScanAssembler`, `ScanDebounce` and `LedPattern` the ESP32 runs, behind `posix_gate_hal`/`posix_hal` and a **real socket** to the run's own API. Driven by `gate_sim.py` at step `DSIM`; built by the target with `pio run -d src/iot/door-gate -e simulator`. What is **still played**: the WiFi radio (the link is told, not sensed), the GM-series scanner's UART (a console line, delivered a byte at a time), the physical relay and lock (there is no coil and no readback — and none on the real board either) |
| PayFast | **imposter** | mountebank with `test/virtualization/payfast/imposter.json` — the same file `make virt-up` and `docker-compose.test.yml` use. Reused if one is already up on `:4545` |
| ESP8266 bridge | **played** by the script | the club's device API key as a bearer header and the box's MAC in every body (both self-tested against `src/contracts/device-protocol/http/cases.json` before anything else), heartbeat, `/activate`, `/events`, `/walkup`, and the serial `!VERB,arg*CC` codec towards the simulated Mega |
| Member's phone | **played** | admin password reset → member login → `POST /me/qr/generate` |
| Admin | **played** | settings, court prices, credits, bookings on behalf, ledger reads |
| PayFast's ITN | **played** | a `COMPLETE` notification signed with PHP-`urlencode` + MD5 in posted order, the seeded passphrase, then replayed and then tampered |

### Why the simulator is only the Mega, and why that is enough

`src/iot/court-box/src/simulator/main.cpp` says it outright: *"This is a MEGA simulator: it speaks the
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
  reconciliation) is host-tested in `src/iot/court-box/test/` and `src/iot/shared/test/`. This script re-implements the bridge's
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

### A third time (2026-09-21), in `door_evening.py`'s own wipe

`D3` opens by cancelling the seeder's demo bookings, for exactly the reason above, and
it cancelled only the ones with `Status = Booked`. **The real `NoShowWorker` and
`LightsCueWorker` have been running since the API booted**, so a seeded booking whose
hour has just passed is already `NoShow` or `Completed` by the time that line executes —
and `GateAccess.HoldsALiveBookingAsync` counts all three statuses, because both of those
still open a door. A survivor therefore grants M the **relief** the door gives a member
whose other court is running, and M's deliberately-too-early code answers `ok`.

A run starting at 19:15 local inherited the seeder's 19:00 booking, already swept: five
assertions went red across `D5`, `EDGE`, `POL`, `D10` and `D11` — `too_early` answering
`ok`, then `slot_taken` and an exclusion-constraint violation from the slot the survivor
was still holding — and **not one of them named the cause**. The same run an hour earlier
was green. The wipe now cancels every booking that is not already cancelled, which at
that point in the run is exactly the seeder's set and is what was meant all along.

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

---

# `door_evening.py` — one door's whole evening

```bash
test/e2e-device/door_evening.py          # or as the second half of make test-e2e-device
```

Same bootstrap — the real API built from source, the Development seeder, a per-run
database — and then a door: plugged in, named, handed a roster, scanned at under both
access policies and at both edges of a booking's own door window, refused for every reason
it has a word for, taken out of service and put back, uploading what it decided while the
link was down, and finally read back through the trail an admin sees.

It needs **`psql`** on `PATH` and says so by name if it is missing. Where a booking has to
be at an hour the admin API will not create it at, it is moved with a direct `UPDATE` —
the booking and its minted access code together, which is exactly equivalent to the booking
always having been at that hour. Every such write is announced with a `[db]` prefix. What
the clock is doing is fixture; every *decision* is still the door's, taken over HTTP.

## Why the door reads its own sockets

`scenario.py` talks to the API through `urllib`. The backend suite talks to it through
`HttpClient`. Every firmware HTTP fixture is a string a fake hands over. All three frame,
de-chunk and close on your behalf — **so the one thing none of them could see was the
framing**, and round G3 found what that hid:

> The real API answers `Transfer-Encoding: chunked` on a keep-alive connection for **every**
> device route. The firmware's reader asked only `getSize()`, got `-1`, and waited for a
> close that never came — so every call spent its whole budget and returned a transport
> failure. The roster never loaded and the door refused everyone. Nothing went red, because
> there was nothing that could.

So `wire.py` is a deliberately stupid HTTP client over a raw socket that makes the same
three decisions `src/iot/door-gate/lib/gatelogic` makes — framing is an **input** and never
a guess (`Content-Length` wins, else chunked, else until-close); three phases with three
budgets, the body's **sampled after the headers return**; and anything but a whole body is
**status 0**, not the status the peer sent. Its de-chunker is a byte-at-a-time state machine
mirroring `ResponseBody.cpp` state for state, because a chunk, a size line and the final
`0\r\n\r\n` all arrive split across reads on a real board.

The evening runs over **HTTP/1.0 with `Connection: close`**, which is what the shipped
firmware asks for (`Esp32Hal` calls `useHTTP10(true)` + `setReuse(false)`). Step `DW` then
runs the belt-and-braces half: **HTTP/1.1 on a kept-open socket, de-chunked by hand** — the
socket is deliberately *not* reopened per call, because a connection that closes gives you
the end of the body for free and proves nothing. Both again through a real **nginx** when
one is on `PATH`, carrying `nginx/nginx.conf`'s own `/api/` directives read out of that file
rather than restated: the boards do not talk to the application, they talk to the gateway,
and `proxy_http_version 1.1` + `proxy_buffering off` is what re-chunks to a 1.1 client.

`E2E_REQUIRE_GATEWAY=1` turns "no nginx on PATH" from a printed note into a failed
assertion. **CI sets it**, because a gate that never runs is indistinguishable from one that
always passes and this repository has shipped three of those.

## The steps and what each pins

`D<n>` ids are this scenario's own; `B<n>` and `E1` are round G3's decision-record ids and
`POL` / `EDGE` name the two window drives.

| Step | Finding | Assertion, in one line |
|---|---|---|
| D1 | **D1** | no key and a wrong key are both 401 with an empty body; a `kind: "gate"` heartbeat from an unknown MAC registers itself as `gate-<six hex>` with `gate_key` present-and-null, no `court_numbers` / `config` / `button_map`, no `server_unix`, no `ota`, and `gate.unlock_seconds` clamped; an **unnamed** gate is pushed `roster: []`; the Devices page shows it `Gate`, `auto_registered`, unnamed; a malformed MAC is `400 mac_required` |
| D2 | **D2 / B7** | `court_numbers` on a gate is `400 court_fields_on_a_gate`; 65 characters is `gate_key_too_long`; **a camelCase `gateKey` now BINDS** (it used to answer 200 and silently change nothing); snake_case wins where both arrive, trimmed; `""` clears and `null` leaves alone |
| D3 | **B6** | a booking beyond the phone's horizon falls through to an ident code — under `active_member` `H` *is* the screen's own horizon, so the screen and the door open at one instant; an ident code is told `doors` and `null` for both window fields |
| D4 | **D4 / E1** | `server_time` moves; naming the door started the fallback; the booking's own code is on the roster on relay 0 with a **signed** `opens_in` to `StartsAt − early_entry` and a `closes_in` to `EndsAt`; the sixty-second ident code is not cacheable and is absent; the body is under the 4096-byte ceiling |
| D5 | **D5 / EDGE** | `too_early` for a booking outside its own window; an ident QR opens under `active_member`; unknown, wrong-length and empty tokens are all `not_recognised`; `method=pin` is `method_not_supported` **before** the code table; `method=code` identifies too. `unlock_seconds` is asserted on **every** scan — a refusal carrying a release is a door that opens for a firmware reading the seconds first |
| D6 | **EDGE / POL / B6** | both sides of the instant the member's own screen states, under **both** policies: refused 45 s before `door_opens_at`, opened 45 s after it, with nothing changed but the clock; `door_opens_at` is `StartsAt − H` and `door_closes_at` is the **code's** expiry, later than `EndsAt` by the grace window; switching to `booking_window` narrows `H` and shuts the door on a code that opened it a second earlier; an ident QR opens for a member whose booking is open, is `no_booking` for one with nothing booked, and **a club admin passes with nothing booked** |
| D7 | **D7** | a door open stamps no `CheckedInAt`; the court box still activates that booking afterwards and **the box is what stamps attendance**; the door wrote no ledger row |
| D8 | **B1** | the real `LightsCueWorker` promotes the attended booking to `Completed`, and a `Completed` booking's code **still opens the door** — but has left the offline roster, which closes at `EndsAt` |
| D9 | **D9** | the real `NoShowWorker` sweeps an unscanned booking, whose code still opens the door — while the **offline** roster has dropped them, the one place offline is stricter |
| D10 | **D10** | the upper edge is the code's own liveness: open while running, open 45 s before expiry with the slot already over, `not_recognised` after it — indistinguishable from a code that never existed |
| D11 | **D11** | a code outside its own window opens for a member whose *other* court is running, and — the fixture probe — is `too_early` again the moment that other booking is cancelled; a cancelled booking's own live code opens nothing; a suspended member is `member_not_active` on both code kinds and is off the offline roster on real Postgres; lifting the suspension restores both |
| D12 | **D12** | a `gate_open` is receipted, names the member the code resolved to **at the scan**, and fingerprints the token instead of logging it; replaying the seq is acknowledged, `recorded: 0`, and leaves no second audit row; two scans of one code fingerprint the same; an `unknown_scan` names nobody and is fingerprinted too; nothing settles |
| D13 | **D13 / B7 / B2** | missing, empty and 200-character kinds are receipted as `malformed` and the queue drains past them; `no_push` and `events_lost` are accepted at 0, negative, `2^31` and `int64` max, change nothing and never take the door out of service; `" gate_open "`, `"GATE_OPEN"` and `"  GaTe_OpEn  "` are **normalised once** into `device.gate_open` with a fingerprinted subject; an unheard-of kind is recorded as normalised and fingerprinted |
| D14 | **D14** | another club's live code is `not_recognised` here |
| D15 | **D15** | all five `/device/*` routes are `403` out of service and the heartbeat hands back **no roster** — which is what a board commits an empty one on; the one documented exception is `400 kind_unknown`, checked before the MAC; re-enabling restores service and the roster |
| D16 | **D16 / B2** | a gate cannot activate a court or sell a walk-up, refused **by name**; a court box at `/device/gate` is `200 not_a_gate`; a `gate_open` from a court box is receipted as `not_a_gate` and **names nobody**; respelling the kind does not step around it |
| DA | **B5** | `GET /admin/devices/{id}/activity` returns the board's rows newest-first, carrying both halves of its day plus the registration and the admin's edits; `offline` is keyed on `seq`; an open names the member, a refusal carries its reason, an offline open carries a validated 8-hex fingerprint; **no `DetailsJson`, no device id, no gate key and no twelve-character token** reaches the console; `limit` defaults to 50 and is clamped to 1–200; another club's board is 404 |
| DSIM | **DSIM** | the **compiled firmware**, as a process: its own heartbeat auto-registers a Gate row carrying the MAC it was given and the version its image reports; an allowed scan energises the relay and releases after the club's configured 3 s, **measured on the board's own clock**; every refusal reason this image can reach (`not_recognised`, `too_early`, `member_not_active`, `no_booking`) leaves the relay unmoved; with the radio gone the cached list allows a rostered booking and refuses everything else, and both decisions are uploaded on reconnect and appear server-side **exactly once**; an admin shutting the door is a `403` the board hears on the next scan and answers by committing an EMPTY roster; and the watchdog was never left unkicked for its own period. Plus `DS8`: the release-overrun bound, measured — see [the worst case](#the-worst-case-measured-rather-than-derived) |
| DW | **E1** | HTTP/1.0 is not chunked; HTTP/1.1 **is**, with no `Content-Length` and the socket held open, and hand de-chunking recovers a whole document inside the body's own budget with no framing byte reaching the parser; a second call on the same kept-open socket reads correctly; the body is under 4096; and all of it again through real nginx, which must close-delimit to a 1.0 client and re-chunk to a 1.1 one |
| D17 | **D17** | every decision left one row, refusals included; no `gate.*` row carries a live token; the rows name the door by its `gate_key`; and **every refusal reason with a corpus vector was provoked at the live door in this run** — derived from `src/contracts/device-protocol/gate/cases.json`, so a reason nothing here reaches is a screen the firmware has for a refusal this harness has never seen |

## `DSIM` — the door's own firmware, in the chain

`gate_sim.py` drives `src/iot/door-gate/.pio/build/simulator/program`, which is this
firmware: the same `GateApp` loop, the same `GateApi`, the same `GateFlow` status
table, the same `ResponseBody` framing and de-chunker, the same `UnlockTimer` and
`LockDriver` — over a POSIX HAL, making **real HTTP calls over a real socket** to the
run's own API, bounded by the same three budgets whose sum is `kWorstBlockingCallMs`.
The harness types at a console and reads a transcript; it answers nothing on the
board's behalf.

**This does not replace `wire.py` and does not touch its assertions.** `DW` remains
the strict judge of the API's *bytes* — framing is still asserted by a deliberately
stupid reader that makes the firmware's three framing decisions by hand — and `DSIM`
is the judge of the *firmware's behaviour*. A framing regression still fails at `DW`;
a decision regression now fails at `DSIM`.

**Four of the corpus's six refusal reasons are reachable from this image, and that is
a fact about the firmware.** `renderScanBody` hard-codes `"method":"qr"`, so
`method_not_supported` is a screen this image can never be shown; and `not_a_gate` is
what a *court box* is told at `/device/gate`, which this image cannot become, because
the server keys a board's kind on its MAC's existing row and not on the `kind` hint.
Both are still provoked over the wire by `D5` and `D16`, which is why `D17`'s
"every corpus reason was provoked" assertion still holds.

**One firmware change was needed for any of this.** `gatelogic::IDecisionLog` is an
observer offered every decision after it has been applied. A refusal *reason* reaches
no surface on the hardware — the relay and the one lamp between them cannot tell six
reasons apart — so without it a harness watching a relay could prove that a door did
not open and nothing about why. It is `nullptr` on every board, it returns void, it is
called last on every decision path, and `GateApp` is host-tested on exactly that null
path because it is the one that ships.

### The worst case, measured rather than derived

`gatelogic/GateApp.h` and `src/iot/door-gate/README.md` both state the release bound in
words: the release *deadline* is bounded by the 30 s hard cap, but what the deadline
does not bound is when the loop gets back to look at it, so

    physical release <= granted window + kWorstBlockingCallMs + kIdleDelayMs

— 42 010 ms with this image's numbers. That sentence had never been measured; it was
derived from three timeout constants. `DS8` measures it against a peer the real API
cannot be made into (`gate_sim.HostileApi`, which answers *chunked with no
Content-Length* so the measurement runs against the framing the firmware actually
meets): a hung API, a dropped connection, and a black hole for the connect budget.
The numbers land in the run's `notes:` block, and on one run they were:

| | Derived | Measured |
|---|---|---|
| one blocking call | 12 000 ms | 4 000 ms |
| release overrun | 12 010 ms | 3 916 ms |
| physical release on a 30 s grant | 42 010 ms | 33 916 ms |
| the connect budget, against TEST-NET-1 | 4 000 ms | 4 019 ms |
| longest interval with the watchdog unkicked | — | 4 001 ms, against a 15 000 ms period |

**The bound holds and is conservative**, because the three phases are not all
reachable in one call: a connect that times out is followed by no header phase and
no body phase, and a peer that answers the connect promptly spends nothing on it. The
full 12 000 ms needs a connect that is *slow but successful*, which is a real network
state and so a correct upper bound — just not what a hung or absent host produces.
`src/iot/door-gate/README.md` carries the same table beside the sentence it measures.

## What `door_evening.py` deliberately does not prove

- **The scanner module, the radio and the lock.** `DSIM` runs the firmware, not the
  hardware: WiFi up and down is *said* through the console rather than sensed, scanner
  bytes come from a console line rather than from a GM-series module on GPIO 4 at 9600
  baud, and there is no coil, no contact and no readback — there is none on the real
  board either, which is a hardware fact rather than a harness gap.
- **Anything physical.** Which lock the club fits, what the relay does before `setup()`
  runs, and that egress is mechanical are `docs/go-live-checklist.md`'s, where a person
  signs them off. See `docs/specs/door-gate.md` §11.
- **The `esp32_hal` drivers.** `Esp32HttpPort`, `Esp32Scanner`'s overrun callback and
  `Esp32Watchdog`'s TWDT reconfiguration are the one layer the simulator replaces
  rather than runs. `posix_gate_hal` is written to be as thin as they are and to use
  the same budgets and the same `frameFromHeaders` / `readBody`, but it is not them.

## Knobs

| Variable | Default | Meaning |
|---|---|---|
| `E2E_REQUIRE_GATEWAY=1` | unset | `door_evening.py` only: a missing `nginx` is a FAILED assertion rather than a note. CI sets it |
| `--no-gateway` | | `door_evening.py` only: skip the nginx pass even where one is installed |
| `E2E_PG_HOST` / `E2E_PG_PORT` | `localhost` / `5439` | the Postgres to create the per-run database on |
| `E2E_PG_USER` / `E2E_PG_PASSWORD` | `crusaders` / `crusaders_test_pw` | must be allowed to `CREATE DATABASE` |
| `E2E_PG_CONTAINER` / `E2E_PG_IMAGE` | `crusaders-fixprog-pg` / `postgres:16-alpine` | started with docker only when nothing answers on the port |
| `E2E_MB_PORT` / `E2E_MB_ADMIN_PORT` | `4545` / `2525` | the imposter, as in `imposter.json`; an already-running one is reused |
| `E2E_SMTP_PORT` | unset | point at MailHog (`:1025` or `:11025` under compose) to see the emails; unset, sends fail fast and are logged, as the API is designed to tolerate |
| `E2E_KEEP_DB=1` | | keep the database after a passing run |
| `E2E_SKIP_BUILD=1` | | reuse the existing `bin/Debug` DLL |
| `DOTNET`, `PIO`, `PY` | `dotnet`, `src/iot/.venv/bin/pio`, `src/iot/.venv/bin/python` | toolchain overrides, as elsewhere in the Makefile |
| `--no-simulator`, `--no-money` | | `scenario.py` only: skip the Mega or PayFast legs |

The API is started on an ephemeral port, so two runs on one host cannot collide, and rate
limits are raised far above a club's traffic so the scenario's burst of auth calls is not
mistaken for password guessing. `door_evening.py` takes its own ephemeral port and its own
database, and puts its scratch in a `…-door` sibling of `scenario.py`'s run directory, so
the two never share anything but the source they are built from.

`gate_sim.py` needs the door simulator built. `make test-e2e-device` builds it before
running this script, and `make build-iot` builds it too; running `door_evening.py` on
its own, it builds it with `PIO` if it is missing and **fails by name** if it cannot.
It is never skipped: "no binary, no assertions" is exactly the shape of gate this
repository has already shipped three of.

## Why not `make virt-up`

`virt-up` depends on `build-iot`, which compiles the AVR and Xtensa targets too, binds the
simulator to a fixed `:5555`, and keeps pidfiles in `/tmp`. This target needs only the
simulator, wants a kernel-chosen port so two runs cannot collide, and must clean up after
itself. It reads the same `imposter.json` and runs the same simulator binary, so nothing here
is a second copy of the virtualization setup — only a different process manager for it.

## CI wiring

Wired, and it runs **both** scenarios. `.github/workflows/ci.yml` carries an `e2e-device`
job (`needs: [backend, iot-build]`) with its own `postgres:16-alpine` service on 5432, the
pinned pio toolchain, `npx`, and — for the door — `nginx-light` and `postgresql-client`
installed by name rather than inherited from whatever the runner image ships this month.
All six image builds gate on it. `E2E_PG_HOST`/`E2E_PG_PORT` point the scripts at the
service container, so nothing reaches for docker; `E2E_REQUIRE_GATEWAY=1` makes a missing
nginx a failure rather than a note; and `.tmp/e2e-device/` is uploaded as an artifact on
failure. The job's timeout is 40 minutes: two scenarios, both of which wait on the real
`NoShowWorker` and `LightsCueWorker` rather than short-circuiting them, because the
`BackgroundService` timers are part of what is being proved.

This section used to say "Not added to ci.yml yet" and describe the job as a commented-out
sketch. It was added in the same wave that wrote that sentence and the sentence was never
deleted — read the workflow, not this paragraph, if the two ever disagree again.
