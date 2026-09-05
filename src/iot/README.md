# `src/iot` — court-control firmware

Firmware for the Crusaders court box: a **WeMos Mega 2560 + onboard ESP8266**
driving four court-light relays, a 20×4 LCD (2004A, driven as 16×2), an
eight-button panel and a QR scanner.

**The wiring is fixed and cannot change.** Every pin, serial port, baud rate and
DIP position below reflects hardware that is already built and working. Firmware
adapts to the hardware, never the reverse.

## Flashing — the whole procedure

Both halves are flashed over USB. There is no over-the-air path: one club, one
box, and the person holding the screwdriver is the person who knows the WiFi
password. A password change is a reflash, and a reflash is the four commands
below.

**Prerequisites, once per machine**

```bash
brew install uv          # the toolchain installer make install-iot uses
make install-iot         # creates src/iot/.venv (Python 3.12) with pio, lizard, gcovr
```

No USB-serial driver is needed on current macOS — the CH340 on this board is
handled by the system. Only if **no** `/dev/cu.*` port ever appears:
`brew install --cask wch-ch34x-usb-serial-driver`, then replug.

**Prerequisites, once per checkout**

```bash
cp src/iot/src/common/secrets.h.example src/iot/src/common/secrets.h
```

Fill in `WIFI_SSID` and `WIFI_PASSWORD`. It is gitignored, and the bridge
**refuses to compile without it** — an image that joins an empty SSID looks
identical to a working one until it is screwed to a wall.

**Flash**

```bash
make flash-mega          # the ATmega2560
make flash-bridge        # the ESP8266, then drops into the serial monitor
```

Each target prints the DIP positions it needs, waits for the USB port to
appear, uploads, and reminds you what to set the switches back to. Pass
`UPLOAD_PORT=/dev/cu.usbserial-XXXX` to name the port yourself.

**The DIP block, in order** — the same rows as the table under *DIP switches*
below, which is the wiring sheet's and is hardware truth:

| Step | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| `make flash-mega` | OFF | OFF | **ON** | **ON** | OFF | OFF | OFF | OFF |
| `make flash-bridge` (upload) | OFF | OFF | OFF | OFF | **ON** | **ON** | **ON** | OFF |
| `make monitor-bridge` (watch it boot) | OFF | OFF | OFF | OFF | **ON** | **ON** | OFF | OFF |
| **Run** — restore these before the box goes back on the wall | **ON** | **ON** | **ON** | **ON** | OFF | OFF | OFF | OFF |

**What the LCD shows, step by step**

| When | Glass |
|---|---|
| After `make flash-mega`, run DIPs | `CRUSADERS COURTS / SCAN TO START` — the Mega's own idle text, and proof the Mega is alive |
| During `make flash-bridge` and the monitor | **Nothing new.** DIP 1 and 2 are off, so the ESP's UART is on the USB socket and the Mega is not on the other end of it. Watch the monitor, not the glass. |
| Run DIPs restored, box not yet claimed | `CLAIM CODE <8 hex>` — type it into the admin Devices screen to connect the board |
| Run DIPs restored, box already claimed | `CONNECTED / SCAN TO START` |

The identity screen is painted at the end of `setup()` and again on the first
`!PONG` the bridge gets from the Mega, which is the first moment the glass is
reachable after a DIP change. If it never appears, the two halves are not
talking: check DIP 1 and 2.

**Rotating the club WiFi password** — change `secrets.h`, `make flash-bridge`,
restore the run DIPs. That is the whole of it. Nothing is stored on the box, so
nothing can be left holding a credential nobody can see.

## Why the logic lives on the ESP8266

The ESP8266 is the half with a network stack, a clock and enough RAM to hold a
roster. The Mega is 8 KB of SRAM driving relays. So the split is deliberate:

| | ATmega2560 | ESP8266 |
|---|---|---|
| **Role** | thin I/O, near-static | all the brains |
| **Owns** | buttons, scanner framing, relay drive, LCD, **independent auto-off timer** | protocol, state machine, device auth, heartbeat, roster cache, event queue |

Both are flashed over USB, by DIP switch, and neither can be flashed over the
network: the ATmega's ESP sits on **Serial3**, not the Serial0 bootloader port,
and no GPIO reaches the Mega's RESET pin. Adding one would be a wiring change.
The ESP *could* have taken over-the-air updates and did until firmware 1.2.0;
that was removed along with image signing and the runtime credential store,
because a fleet update mechanism for one box is a way for the box to break
itself and nothing else. The Mega's firmware is designed to almost never need
reflashing, and the ESP's now needs it about as rarely.

The Mega's auto-off timer is independent on purpose: if the ESP hangs, the WiFi
drops and the backend dies, **the lights still go off**. In the system this
replaces, the off command was scheduled inside an Excel macro on a Windows PC —
close the workbook mid-session and a court burned until somebody noticed.

Two things stand behind that timer on the Mega itself:

- **A hardware watchdog.** Armed at **8 s at the top of `setup()`** and re-armed to
  **2 s at the end of it**, then kicked once per pass of `loop()` and nowhere
  else. Two periods because the init it has to survive is over a second long
  (the LCD's own power-on sequence) while a healthy `loop()` pass is ~10 ms —
  arming only at the end left the one path that can hang forever, the LCD's
  synchronous I²C traffic, with nothing behind it. Anything that stops `loop()`
  returning —
  which used to include a wedged I²C bus under the LCD — ends in a reset that
  re-runs `ArduinoRelay::begin()`, which drives every relay pin to the released
  level *before* configuring it as an output. A watchdog reset therefore lands
  with all four contacts open, exactly like a power-on. An `.init3` hook clears
  `MCUSR` and disables the WDT before `main()`, so the firmware side can never
  contribute to a WDT boot loop; whether the club's Mega2560 **bootloader**
  survives a WDT reset is a bench check (older stk500v2 bootloaders loop) and is
  on the go-live checklist.
- **An I²C bus timeout on the LCD, and a bounded re-sync behind it.** The pinned
  AVR core ships with `Wire`'s timeout *disabled*, so one corrupted PCF8574
  transaction spun forever inside a paint. `LcdDisplay::begin()` brings the bus
  up and arms `Wire.setWireTimeout(25 ms, reset)` **before** it touches the
  panel — the library's own `init()` is over a second of synchronous traffic and
  used to run with the timeout still off. A timeout then abandons the rest of
  that write, skips the next 20 writes (`courtlogic::DisplayHoldoff`,
  host-tested), and the first write allowed after that **re-synchronises the
  controller** before it paints: up to nine bit-banged SCL clocks and a STOP
  while SDA reads low, `Wire.begin()` again, then the 4-bit reset sequence at the
  datasheet's ~10 ms rather than the library's 1.05 s of power-on waits.
  That last step is not decoration. **The timeout bounds the stall; it does not
  recover the display.** An abandoned write can take an En edge with it, and the
  HD44780 then pairs every later nibble wrongly — without the re-sync, one coil
  transient at 18:05 leaves every screen for the rest of the evening as garbage
  on a bus that is now perfectly healthy. The relay timer never waits on the
  glass either way.
  Still out of software's reach and on the go-live checklist: whether a PCF8574
  on this backpack really does hold SDA across a Mega-only reset, and how often a
  transient desynchronises a nibble in practice.

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
| Upload to ESP8266 over USB | 1 OFF, 2 OFF, 3 OFF, 4 OFF, **5 ON, 6 ON, 7 ON**, 8 OFF |
| ESP run/monitor over USB | **5 ON, 6 ON**, 7 OFF, others OFF |

The sheet documents the ESP-upload position directly: it differs from ESP
run/monitor only in **DIP 7**, which is the flash-mode line. No external serial
adapter, no soldering and no pad access is ever needed — flashing the ESP is a
DIP change like every other mode, which is what makes USB-only flashing a
two-minute job rather than a reason to build an update mechanism.

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
  fwversion/   the FW_VERSION_* string, alone so either half can carry it
  arduino_hal/ real drivers (AVR / ESP)   ← the ONLY place Arduino headers live
  posix_hal/   host drivers, for the simulator
src/
  court_mega/    ATmega2560 firmware — composition root only
  court_bridge/  ESP8266 firmware — composition root only
  simulator/     native device simulator — the same lib/ over posix_hal
test/          Unity tests, run on the host
tools/         strict compile gate, corpus generators
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
make install-iot     # creates src/iot/.venv (Python 3.12, via uv) with pio, lizard, gcovr
make test-iot        # Unity tests on the host — no board needed
make test-iot-asan   # the same suite under ASAN + UBSAN
make lint-iot        # clang-format, strict compile, purity + rollover gates
make build-iot       # compile for every target board
make complexity      # cyclomatic complexity, all three languages
make flash-mega      # USB-flash the ATmega2560 (prints the DIP positions)
make flash-bridge    # USB-flash the ESP8266, then open its monitor
make monitor-bridge  # watch the ESP's UART at 9600 (DIP 5 and 6 ON)
```

`make build-iot` compiles `court_bridge`, so it needs `src/common/secrets.h`
like a flash does — see *Flashing* above.

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
survive the breaker. This used to say the store made that impossible
(`hal::IStore` held 32-byte values, an `Event` is 48); the cap is **128** now and
an event would fit, so the honest statement is that persisting the ring has not
been built, not that it cannot be. It needs a record per slot plus a durable head
and tail, and a half-right version — a torn ring that replays a stale activation
— charges a member twice.

The cost when it happens: a court lit during an outage that ended in a power cut is
never reported, so the sweep treats it as a no-show and refunds it less a penalty
the member did not earn. Visible in the ledger, reversible by an admin, and in the
go-live checklist. The **sequence number** does persist, in blocks of 64 — that is
what the API's deduplication rests on, and reusing one loses a real event.

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

## What the box keeps in flash

Two things, and only because losing either would make the box re-provision
itself every time the breaker trips:

- **The device credential** — the id and key the claim flow returns, stored as
  two records because a 32-byte key is 64 hex characters and the store's value
  cap was 32 when it was written. Both halves and the id must load or the box
  treats itself as unclaimed; half a key signs every request wrongly and reads
  back as a revoked credential.
- **The API base URL** (`api_base`, up to 120 characters), learned from the
  discovery OFFER or from provisioning. The old `api_url` record was silently
  capped at 32, which is why a DNS-named advertised base used to fail discovery
  with nothing on the glass. A box that only holds the old record still boots
  off it; a URL that will not fit paints `API URL TOO LONG` rather than being
  truncated, because half a URL is a request to somewhere else.

Both carry a CRC-8 trailer (`bridgelogic::CredentialStore`), because
`hal::IStore` hands a torn write back as a value with `kOk` and a half-written
record has to read as *absent* rather than as something plausible.

**The WiFi credential is not in there.** It is compiled in from `secrets.h` —
see *Flashing*.
