# `src/iot` — court-control firmware

Firmware for the Crusaders court box: a **WeMos Mega 2560 + onboard ESP8266**
driving four court-light relays, a 20×4 LCD (2004A, driven as 16×2), an
eight-button panel and a QR scanner.

**The wiring is fixed and cannot change.** Every pin, serial port, baud rate and
DIP position below reflects hardware that is already built and working. Firmware
adapts to the hardware, never the reverse.

## Why the logic lives on the ESP8266

The ATmega2560 cannot be flashed over WiFi. Its ESP8266 sits on **Serial3**, not
the Serial0 bootloader port, and no GPIO reaches the Mega's RESET pin — and
adding one would be a wiring change.

So the split is deliberate:

| | ATmega2560 | ESP8266 |
|---|---|---|
| **Role** | thin I/O, near-static | all the brains |
| **Owns** | buttons, scanner framing, relay drive, LCD, **independent auto-off timer** | protocol, state machine, device auth, heartbeat, roster cache, event queue, OTA |
| **Updated by** | USB, rarely | **over the air** |

Behaviour changes ship as ESP8266 OTA updates. The Mega's firmware is designed
to almost never need reflashing, which is what makes USB-only acceptable for it.

The Mega's auto-off timer is independent on purpose: if the ESP hangs, the WiFi
drops and the backend dies, **the lights still go off**. In the system this
replaces, the off command was scheduled inside an Excel macro on a Windows PC —
close the workbook mid-session and a court burned until somebody noticed.

Two things stand behind that timer on the Mega itself:

- **A hardware watchdog (2 s).** Enabled at the end of `setup()`, kicked once per
  pass of `loop()` and nowhere else. Anything that stops `loop()` returning —
  which used to include a wedged I²C bus under the LCD — ends in a reset that
  re-runs `ArduinoRelay::begin()`, which drives every relay pin to the released
  level *before* configuring it as an output. A watchdog reset therefore lands
  with all four contacts open, exactly like a power-on. An `.init3` hook clears
  `MCUSR` and disables the WDT before `main()`, so the firmware side can never
  contribute to a WDT boot loop; whether the club's Mega2560 **bootloader**
  survives a WDT reset is a bench check (older stk500v2 bootloaders loop) and is
  on the go-live checklist.
- **An I²C bus timeout on the LCD.** The pinned AVR core ships with `Wire`'s
  timeout *disabled*, so one corrupted PCF8574 transaction spun forever inside a
  paint. `LcdDisplay::begin()` now arms `Wire.setWireTimeout(25 ms, reset)`;
  a timeout abandons the rest of that write, skips the next 20 writes
  (`courtlogic::DisplayHoldoff`, host-tested), then tries the panel again. A dead
  display costs one bounded stall per holdoff; the relay timer never waits on
  the glass.

## Wiring

| Function | Connection |
|---|---|
| Court relays A–D | Mega pins **2, 3, 4, 5** — **active LOW** |
| Court buttons A–D (green) | Mega pins **22, 24, 26, 28**, `INPUT_PULLUP` |
| Duration buttons 15/30/45/60m (black) | Mega pins **30, 32, 34, 36**, `INPUT_PULLUP` |
| Status LED | Mega pin **13** |
| LCD | I²C **0x27**, SDA **20** / SCL **21** |
| QR scanner | **Serial2** — RX 17 / TX 16 @ 9600 |
| ESP8266 bridge | **Serial3** — TX 14 / RX 15 @ 9600 |
| Power | Mean Well PSU → 2× fused LM2596 → 5V and 9V rails |

### About the display

The physical panel is a **2004A (20×4)**, but the firmware drives it as **16×2**
by decision — safety over screen real estate, and it works on either panel. The
geometry is a compile-time constant (`LCD_COLS` / `LCD_ROWS`), so widening it
later is a one-line change plus a corpus update, not a rewrite.

### Relays — an open safety question

The relay module is rated **10A at 250VAC**. That is plausible for one modern
LED court bank and inadequate for older metal-halide. Standard practice is for
relays like these to switch a **contactor coil**, with the contactor carrying
the lighting load.

**This has not been confirmed on the installed hardware.** If the relays switch
court lighting directly, that needs a qualified electrician before anything
ships. No software decision changes this.

## DIP switches

From the project wiring sheet:

| Mode | Setting |
|---|---|
| Mega ↔ ESP8266 internal serial (Serial3) | **1 ON, 2 ON** |
| Upload to Mega over USB | 1 OFF, 2 OFF, **3 ON, 4 ON**, 5–8 OFF |
| Run (normal operation) | **1 ON, 2 ON, 3 ON, 4 ON**, 5–8 OFF |
| Upload to ESP8266 over USB (first flash) | 1 OFF, 2 OFF, 3 OFF, 4 OFF, **5 ON, 6 ON, 7 ON**, 8 OFF |
| ESP run/monitor over USB | **5 ON, 6 ON**, 7 OFF, others OFF |

The sheet documents the ESP-upload position directly: it differs from ESP
run/monitor only in **DIP 7**, which is the flash-mode line. No external serial
adapter, no soldering and no pad access is ever needed — the first flash is a
DIP change like every other mode.

## Layout

```
lib/           shared modules — PURE, no Arduino headers, host-compilable
  timebase/    rollover-safe millis() primitives   ← read this first
  hal/         port interfaces + null implementations
  hal_fakes/   recording test doubles
  courtlogic/  the Mega's behaviour: auto-off timer, debounce, scan framing,
               auth window, frame dispatch — everything main.cpp does NOT do
  protocol/    Mega <-> ESP serial codec
  discovery/   UDP beacon, claim commitment, announce schedule
  devcrypto/   SHA-256 / HMAC / HKDF / request signer
  roster/      who may open which court, cached and age-limited
  eventq/      what the box DID, queued until the API can hear about it
  court/       what a scan means; the button map; the walk-up pad
  bridgelogic/ the ESP's decisions: roster sync from the heartbeat, the
               online-then-roster scan flow, walk-up request + nonce,
               `!STATE` reconciliation — everything court_bridge/main.cpp
               does NOT do
  devapi/      signed requests, response policy, and a heapless JSON scanner
  otacore/     whether to take an update, and surviving one that does not work
  fwversion/   the FW_VERSION_* string, alone so either half can carry it
  arduino_hal/ real drivers (AVR / ESP)   ← the ONLY place Arduino headers live
  posix_hal/   host drivers, for the simulator
src/
  court_mega/    ATmega2560 firmware — composition root only
  court_bridge/  ESP8266 firmware — composition root only
  simulator/     native device simulator — the same lib/ over posix_hal
test/          Unity tests, run on the host
tools/         strict compile gate, size budgets
```

Everything under `lib/` except `arduino_hal/` and `posix_hal/` is free of
Arduino headers, so the same code compiles for AVR, Xtensa **and** the host test
runner. That is what lets the whole logic layer be proven with no board
attached. CI enforces the rule with a grep gate.

### The legacy serial dialect is off on a real box

`proto::Decoder` still speaks Carl's original one-character dialect (a bare
`A` is "relay A on", `<line1>|<line2>` is an LCD prompt that also arms the
buttons), tested against the shared corpus — but the **production Mega is built
with `proto::LegacyDialect::Refuse`**, the `CourtBox` default. Any line on the
downlink that does not start with `!` is answered `!EVT,BADFRAME,RX` and moves
no relay. The legacy `A` was the one path by which a relay closed without a
checksum, on a UART that receives the ESP8266's 74880-baud boot banner at every
ESP reset, beside four relay coils. The simulator opts in with
`LegacyDialect::Accept` explicitly, because it is the bench.

`main.cpp` is the **only** composition root in each of the three targets: it
chooses implementations and wires them, and it holds no behaviour. That is not a
style preference — `pio test -e native` sets `build_src_filter = -<*>`, so
anything written in `src/` is unreachable from the host suite, and the relay
auto-off timer is not allowed to live where no test can drive it.

### Running the simulator

```bash
pio run -e simulator
.pio/build/simulator/program --port 0 --start-ms 4294963200
```

It prints the bound port on its first line, then speaks the real downlink
protocol on that socket. It binds **loopback only** unless `--bind-all` is passed,
which exists for the container case and nothing else — a simulated relay controller
answering on every interface is one anything on the network can switch a court on
with. `--start-ms 4294963200` puts the 49.7-day `millis()`
rollover four seconds after launch, which is how a test reaches the wrap without
waiting seven weeks. Console commands: `scan <code>`, `btn <A-D|1-4>`, `quit`.

## Working on it

```bash
make install        # creates src/iot/.venv with pio, lizard, gcovr
make test-iot       # Unity tests on the host — no board needed
make test-iot-asan  # the same suite under ASAN + UBSAN
make lint-iot       # clang-format, strict compile, purity + rollover gates
make build-iot      # compile for every target board
make complexity     # cyclomatic complexity, all three languages
```

### The rollover rule

`millis()` wraps every ~49.7 days, and a box in a cupboard is normally up that
long. **Never compare times directly.** Use `tb::reached(now, deadline)` or
`tb::Deadline`, both in `lib/timebase`.

The firmware this replaces got it wrong in both directions on adjacent lines —
using `0` as a "disarmed" sentinel (0 is a legal `millis()` value) and comparing
with `now >= expiresAt` (false for 49.7 days after the wrap, so the relay was
never released). `make lint-iot` greps for raw comparisons against any
`*deadline` / `*expires` / `*AtMs` identifier outside `lib/timebase`.

The same rule reaches the API clock. `devapi::DeviceClient` holds a Unix
*offset* and adds the box's uptime to it, and it takes that uptime as the
64-bit `tb::Uptime64` value the composition root keeps — a `uint32_t` there
was the wrap re-entering through the clock path at day 49.7 (every signed
timestamp jumped back 49.7 days, and a healthy box "corrected" a clock that
was never wrong).

## The button window: who may press what

The Mega only forwards a button press while its authorisation window is armed,
and only the ESP arms it (`!AUTH,<seconds>`; `!AUTH,0` closes it). The rule for
*when* is `lib/bridgelogic/AuthPolicy`, and it is deliberately not "on every
scan":

- **The window opens only for a scan somebody recognised** — the API answered
  with a verdict about a known member (activated, or refused for any reason except
  `not_recognised`: a known member with no booking is exactly who buys a
  walk-up), or the roster matched an entry (allowed, too early, too late, wrong
  court). An unknown token and a stale roster arm nothing and close whatever was
  open. Before this, any barcode bought thirty seconds of buttons, and with an
  admin-mapped OFF button that was a lit court going dark from a stranger's
  receipt. On the walk-up path the bit comes from the response body's `error`,
  never from the status: `insufficient_balance`, `court_in_use`,
  `no_time_available` and `purchase_ended` are verdicts about a member the API
  identified; `not_recognised`, `court_not_on_device`, an unknown error and a
  bare 402/409 arm nothing.
- **A grant does not close the window; it binds it.** The court that just lit is
  remembered, the window stays armed for the same TTL, and an OFF press is
  honoured for **that court only** — so the member who lit court B can switch B
  off, and nobody at the panel can switch off A, C or D. Any other court's OFF
  paints `NOT YOUR COURT`. A walk-up purchase binds the window to the court it
  bought. The scan itself is spent by a grant (no walk-up on a lit member's
  token), so the bound window is release-only.
- **A lapse closes it**, on both ends, as before.

## The court works when the network does not

A scan on a box that can reach the API **asks the API first**
(`POST /api/v1/device/activate`), because only the API knows about a booking made
thirty seconds ago, a walk-up member with no booking, or a balance too low to admit.
Its answer — a grant or a refusal — is final; the roster is never asked for a
second opinion. When the API cannot be asked (no link, no clock, **no court list
yet**, the circuit breaker open, a transport failure, a 5xx, a malformed 200) the
scan is decided **on the box**, from the roster cache the heartbeat fills, in
microseconds — so a router reboot is a slower scan, not a dark court. The flow is
`lib/bridgelogic/ScanFlow`.

Three details of that flow that were each a review finding:

- **The first heartbeat goes out the moment the WiFi link comes up** (and again
  the moment a signed OFFER seeds the clock on a box with no court list), not
  30 s after boot. Until it has answered, `court_numbers` is empty and the box is
  *not* online: a scan is refused locally from the roster rather than recorded as
  attendance server-side and then refused at the box because the granted court
  maps to nothing.
- **A circuit breaker** (`lib/bridgelogic/ApiBreaker`) sits in front of every
  signed call. Two consecutive transport failures — the request never completed,
  or a 5xx — and the API is judged down for a backoff window of 15 s, doubling to
  a cap of 120 s while it stays down. While open, scans go straight to the roster
  and the event drain waits; the heartbeat keeps its cadence and is the probe.
  Any completed answer, 401 and 429 included, closes it. Without this, a host that
  was off with the AP up cost every scan two 4 s connect timeouts.
- **`granted_seconds: 0` is a refusal** (`SLOT ENDED`), not a one-second relay
  pulse: a rescan inside the post-slot grace window answers `activated:true` with
  nothing left to grant. The API now says so itself — `activated:false,
  reason:"ended"` — and that is the same `SLOT ENDED`: a decision, not a
  fallback, because the roster still holds the booking and would light it.

The tenant's **`heartbeat_seconds`** is adopted from every accepted heartbeat,
bounded to 15–300 s (`lib/bridgelogic/Cadence`); the compiled-in 30 s is only
where a box starts.

### A booking longer than the relay cap

One `!ON` buys at most ninety minutes — the Mega clamps every duration, on
purpose, so a bridge that *dies* cannot leave a court burning. A two-hour
booking used to go dark at minute ninety with no cue. The bridge knows how long
the booking really has (the roster's `closes_in`, the activate response's
`granted_seconds`, the walk-up's `granted_minutes`, all carried uncapped), so
`lib/bridgelogic/Relight` keeps a per-court deadline and sends
`!EXT,<court>,<seconds>` sixty seconds before each cap expiry, for
`min(cap, what is left)`, while the booking is still live. The Mega clamps every
`!EXT` to its own cap too: a bridge that dies mid-booking still fails open at the
next cap. A release, by `!EVT` or `!STATE`, forgets the court.

### An `!ON` the Mega did not take

A frame whose checksum dies on the wire comes back as `!ERR,BADCRC` (or, for a
line that overran, `!EVT,OVERRUN,RX`). The bridge keeps the last `!ON` and, on a
receive error inside 1.5 s of it, sends it **once** more
(`lib/bridgelogic/OnRetry`). Once, not until acknowledged: a second failure is a
cable. If the retry cannot be sent either, the court is marked dark in the
bridge's books and the screen says `TRY AGAIN`, so the next `!STATE` does not
synthesise a Release for a session that never started.

On the roster path the box records what it did and the API hears about it when it
can; an activation the API itself granted is not queued, because the queue is the
record of what the API did **not** hear. Three consequences worth knowing before
changing any of it:

- **A queued activation is not a charge.** Under charge-at-booking the member has
  already been debited. The event is the evidence that stops the no-show sweep
  reversing it — a court lit and never reported looks exactly like a member who
  stayed home.
- **A stale roster refuses rather than guesses.** Past `ROSTER_MAX_AGE_MS` the box
  will not admit anybody, because a cancelled booking lingering in a cache lights a
  court nobody is charged for. Note this is the **opposite** direction to the relay
  timer, where failing closed would leave lights burning all night. Both live in
  this box and they point different ways on purpose.
- **Walk-ups need the network.** A walk-up is truncated at the next booking and
  charged pro rata, and the box knows neither the tariff nor the next booking. That
  is the right way round: refusing to sell new time is a member at the desk, where
  refusing a booking they already paid for is a member in the dark. A replayed
  nonce is granted what is *left* of the purchase (`granted_minutes` is the
  remainder, and the court is lit for that), and one whose window is over is
  `409 purchase_ended` — `PURCHASE ENDED / SCAN TO START`.

### What the event queue does not survive

**A power cut.** The ring is in RAM. It survives the WiFi going away, a router
reboot, a two-day outage — the box stays powered throughout — and it does not
survive the breaker, because `hal::IStore` holds 32-byte values and an event is
larger. Persisting them needs a block-oriented port.

The cost when it happens: a court lit during an outage that ended in a power cut is
never reported, so the sweep treats it as a no-show and refunds it less a penalty
the member did not earn. Visible in the ledger, reversible by an admin, and in the
go-live checklist. The **sequence number** does persist, in blocks of 64 — that is
what the API's deduplication rests on, and reusing one loses a real event.

## Over-the-air updates

Signed with **RSA-2048/SHA-256** through the ESP8266 core's `Updater`, against a
public key compiled into the image. The plan called for Ed25519 on the correct
reasoning that an HMAC keyed with the device key would let one compromised box
forge firmware for the fleet; BearSSL — already linked in for TLS — has no
Ed25519, and vendoring a curve implementation into a court-lighting controller is
the worse trade. **The property that mattered is unchanged**: the signing key is
asymmetric and lives only where releases are built.

**The image carries no WiFi credential, and must not.** CI builds and signs the
release on a runner where `secrets.h` cannot exist, so an image that needed the
header would have put an empty SSID on every box in the club at the first
over-the-air release. See *WiFi credentials* below.

**There is no rollback.** A 4M part carrying a 1 MB sketch and 2 MB of LittleFS has
no second OTA slot, and the filesystem is not optional because it holds the device
credential. What `ota::BootGuard` does instead is make sure a bad build is never
installed **twice** — which is the failure that takes out a club, since every box
heartbeats against the same manifest and would otherwise reflash in a loop, all at
once. A box that will not boot at all still needs a USB cable.

The guard clears on **evidence**: an API call the server accepted. "It booted" is
not "it works" — a firmware that comes up and cannot authenticate looks alive and
does nothing. Three boots are allowed before a build is condemned, because a
brownout when four relay coils energise at once is a real thing on this hardware.
The condemned version is reported on the heartbeat and shown on the Devices screen.

## The discovery OFFER and the clock

A provisioned box adopts the API's clock from a *signed* discovery OFFER — that
is how a power-cycled board recovers its clock without a call. But the OFFER is
bound to a per-**boot** nonce, so one captured today verifies all week, and a
replayed one used to set the clock *back* to the capture instant; two 401s
later the box read its own rewound clock as a dead credential. The rule is now
`devapi::DeviceClient::adoptOfferTime`: an OFFER **seeds** a box with no clock,
**moves a known clock forward** by up to the skew window (90 s), and is
**ignored and counted** when its time is behind the clock or further ahead than
that. OFFERs never touch the two-strike reprovision counter; that counter is
evidence about the credential, gathered from signed 401s only.

## WiFi credentials

The SSID and password live in the box's LittleFS store, beside the device key
(`lib/bridgelogic/CredentialStore`), under an integrity trailer so a torn write
reads as *absent* rather than as half a passphrase. Three ways in, one rule:

| Path | What happens |
|---|---|
| **Bench / first flash** — `secrets.h` present at build | The compiled-in credential is used to join. The first time it actually joins, it is written to the store (only when it differs from what is stored, so a working box does not wear a flash cell every morning). |
| **OTA / CI image** — no `secrets.h` | The stored credential is read at boot and used to join. Every box provisioned once at the bench works on every release after. |
| **USB, no `secrets.h` at all** — DIP 5, 6 ON, monitor at 9600 | Type `!WIFI,<ssid>,<password>` (optionally with the v2 `*CC` XOR trailer; escape `,` `*` `%` as `%2C` `%2A` `%25`). The box stores it, paints `WIFI SAVED / JOINING...` and joins. A box with no credential anywhere shows `NO WIFI SET / !WIFI,SSID,PASS` instead of a claim code. |

The `!WIFI` line rides the same UART as the Mega link; that is safe because the
Mega only ever emits frames from its fixed verb table, none of which is `WIFI`.
A compiled-in credential wins over a stored one, which is how a rotated
password reaches the store: reflash once with the new `secrets.h`, or type the
line.

The API base URL moved to the same checked-record scheme (`api_base`, up to 120
characters — the OTA URL bound). The old `api_url` record was silently capped at
32, which is why a DNS-named advertised base used to fail discovery with nothing
on the glass. A box that only holds the old record still boots off it; a URL
that will not fit paints `API URL TOO LONG` instead of being truncated.

## Flashing

**Mega** — DIP 1,2 OFF; 3,4 ON, then `pio run -e court_mega -t upload`.

**ESP8266** — normally OTA. For a first flash, set the ESP-upload DIP row above
(5, 6, 7 ON, others OFF), then restore the run positions.

For the first flash of a box, either copy `src/common/secrets.h.example` to
`secrets.h` and fill in the WiFi credential before building — it is persisted to
the store on the first join, and no later image needs it — or flash the plain CI
image and type the `!WIFI` line over USB. `secrets.h` is gitignored; it was
committable until this project closed that gap. The `DEVICE_*` and `API_BASE_URL`
lines in the example are not read by this firmware: the device key and the URL
come from provisioning and discovery.
