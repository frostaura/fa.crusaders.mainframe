# `src/iot/court-box` — court-control firmware

Firmware for the Crusaders court box: a **WeMos Mega 2560 + onboard ESP8266**
driving four court-light relays, a **20×4 LCD (2004A, driven as 20×4)**, an
eight-button panel and a QR scanner.

One of the PlatformIO projects under `src/iot`. The device-agnostic libraries it
builds on — time, the HAL ports, the event queue, the roster cache, `devlink` —
are **not in this directory**: they live in [`../shared/lib`](../shared/lib) and
arrive through `lib_extra_dirs = ../shared/lib` in `platformio.ini`. What is
here is what is true of *this* hardware. See [`../README.md`](../README.md) for
the split and for what belongs on which side of it.

**The wiring is fixed and cannot change.** Every pin, serial port, baud rate and
DIP position below reflects hardware that is already built and working. Firmware
adapts to the hardware, never the reverse.

## Flashing — the whole procedure

Both halves are flashed over USB. There is no over-the-air path, no discovery,
no claim code and no provisioning call: one club, one box, and the person
holding the screwdriver is the person who knows the WiFi password and holds the
API key. Changing any of them is a reflash.

**The route is the Arduino IDE 2: open the sketch, pick the board and the port,
press Upload.** No terminal, no `make`, and nothing to install from the Library
Manager — the two sketch folders under [`arduino/`](arduino/) carry every
library either half needs. The full page, with the board settings, the DIP
positions and the order, is [`arduino/README.md`](arduino/README.md); the short
version is below. `make flash-mega` / `make flash-bridge` do the same two
uploads from PlatformIO and are the **developer** alternative, further down.

Those sketch folders are **generated** from the sources in `lib/`, in
`../shared/lib/` and in `src/`, and from the build flags in `platformio.ini`, by
`make arduino-export`.
`make arduino-check` regenerates and fails on a diff, so the folder a technician
opens cannot drift from the build CI tests. Never hand-edit anything in there.

**Once per machine**

1. Install the **Arduino IDE 2** (2.3 or newer).
2. *Preferences → Additional boards manager URLs*:
   `https://arduino.esp8266.com/stable/package_esp8266com_index.json`
3. *Boards Manager*: **Arduino AVR Boards 1.8.6** and **esp8266 3.1.2** — the
   versions CI compiles the sketches against, matching the platforms
   `platformio.ini` pins.

No USB-serial driver is needed on current macOS — the CH340 on this board is
handled by the system. Only if **no** `/dev/cu.*` port ever appears:
`brew install --cask wch-ch34x-usb-serial-driver`, then replug.

**Once per checkout**

```bash
cp src/iot/court-box/arduino/court_bridge/secrets.h.example src/iot/court-box/arduino/court_bridge/secrets.h
```

Fill in all four values. It is gitignored, and the bridge **refuses to compile
without it** — `#error` on a missing value, `static_assert` on an empty one,
because an image with a blank in it looks identical to a working one until it is
screwed to a wall.

| Value | What it is |
|---|---|
| `WIFI_SSID` / `WIFI_PASSWORD` | The club WiFi. The box takes a DHCP lease; there is no static-IP option and there must not be one. |
| `API_BASE_URL` | The backend's **LAN** address and port, no trailing slash — e.g. `http://192.168.1.10:8088`. |
| `DEVICE_API_KEY` | The tenant's device API key, from the admin Devices page. It goes out as `Authorization: Bearer <key>` on every call. |

The PlatformIO build reads its own copy at `court-box/src/common/secrets.h`, so a
developer who uses `make flash-bridge` fills that one in instead. Same four
values; two files, because the Arduino IDE can only see what is inside the
sketch folder.

**Upload — Mega first, then the bridge, then the run DIPs and a power cycle**

| Step | Sketch | Board settings |
|---|---|---|
| 1 | `arduino/court_mega/court_mega.ino` | *Arduino Mega or Mega 2560*, Processor **ATmega2560** |
| 2 | `arduino/court_bridge/court_bridge.ino` | *Generic ESP8266 Module*, Flash Size **4MB (FS:2MB OTA:~1019KB)**, CPU **80 MHz**, Upload Speed **115200** |

Set the DIPs from the table below **before** each Upload, restore the run
positions afterwards, and **power-cycle the box**. To watch the bridge boot, use
the IDE's Serial Monitor **at 9600** — that UART *is* the Mega link and its baud
is fixed by the wiring, so 115200 shows framing garbage that reads as a dead
board.

**Why there is a key at all when both ends are on the club LAN.** The box and
the backend do sit on the same network, and the box never leaves it. But the
backend's public surface is a Cloudflare tunnel — that is how members book and
how the admin controls and monitors the club remotely, and the SPA reaches the
same API through it. So `/api/v1/device/*` is reachable from the internet, and
the key is what stands in front of it. Nothing in this firmware assumes the box
is ever off the LAN, and nothing assumes the API is LAN-only.

Regenerating the key on the Devices page invalidates the old one **immediately**,
so a regeneration is a reflash and has to be planned as one.

**The DIP block, in order** — the same rows as the table under *DIP switches*
below, which is the wiring sheet's and is hardware truth:

| Step | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Upload `court_mega` | OFF | OFF | **ON** | **ON** | OFF | OFF | OFF | OFF |
| Upload `court_bridge` | OFF | OFF | OFF | OFF | **ON** | **ON** | **ON** | OFF |
| Watch the bridge boot (Serial Monitor, 9600) | OFF | OFF | OFF | OFF | **ON** | **ON** | OFF | OFF |
| **Run** — restore these before the box goes back on the wall | **ON** | **ON** | **ON** | **ON** | OFF | OFF | OFF | OFF |

**The developer alternative — the same two uploads from PlatformIO**

```bash
brew install uv          # the toolchain installer make install-iot uses
make install-iot         # creates src/iot/.venv (Python 3.12) with pio, lizard, gcovr
cp src/iot/court-box/src/common/secrets.h.example src/iot/court-box/src/common/secrets.h   # then fill it in

make flash-mega          # the ATmega2560
make flash-bridge        # the ESP8266, then drops into the serial monitor
```

Each target prints the DIP positions it needs, waits for the USB port to
appear, uploads, and reminds you what to set the switches back to. Pass
`UPLOAD_PORT=/dev/cu.usbserial-XXXX` to name the port yourself. A technician
never needs any of it; these targets and `make build-iot` / `make test-iot`
exist for development and CI.

**What the LCD shows, step by step**

| When | Glass |
|---|---|
| After the `court_mega` upload, run DIPs | `CRUSADERS COURTS` / `SCAN YOUR CODE` — the Mega's **own** landing screen, painted from `courtlogic::ScreenBuffer` with no frame involved, and proof the Mega is alive. On a 2004A row 2 shows the live court state and row 3 the action row |
| During the `court_bridge` upload and the monitor | **Nothing new.** DIP 1 and 2 are off, so the ESP's UART is on the USB socket and the Mega is not on the other end of it. Watch the monitor, not the glass. |
| Run DIPs restored, box on the WiFi | `CONNECTED / SCAN TO START` — and the box appears on the admin Devices page by itself within one heartbeat, with its court numbers against it |
| Run DIPs restored, box **not** on the WiFi | `CRUSADERS COURTS / SCAN TO START` — the two halves are talking and the radio is not. Check the SSID and password. |

The identity screen is painted at the end of `setup()` and again on the first
`!PONG` the bridge gets from the Mega, which is the first moment the glass is
reachable after a DIP change. If it never appears, the two halves are not
talking: check DIP 1 and 2.

**Rotating the WiFi password, the API key or the base URL** — change
`secrets.h`, upload `court_bridge` again, restore the run DIPs. That is the
whole of it for all three. No credential is stored on the box, so nothing can be
left holding one nobody can see.

**Firmware version history** lives in the comment at the top of this project's
`platformio.ini`. The current images are **bridge 2.2.6 and Mega 2.0.0**: 2.2.6
paces the event drain — a refused upload waits 15 s, doubling to 5 min, instead
of being re-posted on every pass, and a 404 keeps the event; 2.2.5
escapes the scanned token in the activate, walk-up and pay-for bodies and writes
every byte above 0x7E as `\u00XX`, so a scan of a quote or a stray high byte
the Mega passed through is no longer a body the server cannot parse; 2.2.4
keeps a walk-up's scan through a refusal the member can fix by choosing less
time (`TOO LONG / TRY LESS TIME`), forgetting it only for a used or unknown
code, and reads a used code at pay-for as `CODE USED`; 2.2.3
arms nothing for a code the server already acted on (`code_used`), a code
nobody owns or a refusal it cannot name, and forgets that scan, so a photo of
the code that just lit somebody's court cannot buy a walk-up or a pay-for on
their minutes; it also waits on `ONE MOMENT / Checking code` while an
activation is asked, and remembers whose game a court is only when its `!ON`
actually left; 2.2.2
gives the same screen on a court the box lit online for that member (a walk-up,
a pay-for, or an activation the roster does not name yet); 2.2.1
shows the member who rescans the code that just lit their own court `COURT B IS
ON` with its OFF bound, rather than `CODE USED`; 2.2.0 is the glass in minutes rather than credits (`PAY 45 MIN?`, `TOO FEW MINUTES`;
[`docs/specs/minutes-and-packages.md`](../../../docs/specs/minutes-and-packages.md) §8),
on top of 2.1.0's single rotating member code and D10 pay-for
([`docs/specs/member-code.md`](../../../docs/specs/member-code.md)), on the
ESP8266 only — the Mega is reflashed for neither. 2.0.0 was a contract break:
request signing, the discovery beacon, claim codes, provisioning, the device
clock and the flash credential store are all gone, replaced by the bearer key
above and the box's MAC in each request body.

## Why the logic lives on the ESP8266

The ESP8266 is the half with a network stack and enough RAM to hold a roster.
The Mega is 8 KB of SRAM driving relays. So the split is deliberate:

| | ATmega2560 | ESP8266 |
|---|---|---|
| **Role** | thin I/O, near-static | all the brains |
| **Owns** | buttons, scanner framing, relay drive, the LCD — **the landing screen and every screen deadline** — and the **independent auto-off timer** | protocol, state machine, device auth, heartbeat, roster cache, event queue, and **the words on every screen** |

Both are flashed over USB, by DIP switch, and neither can be flashed over the
network: the ATmega's ESP sits on **Serial3**, not the Serial0 bootloader port,
and no GPIO reaches the Mega's RESET pin. Adding one would be a wiring change.
The ESP *could* have taken over-the-air updates and did until firmware 1.2.0;
that was removed along with image signing and the runtime credential store,
because a fleet update mechanism for one box is a way for the box to break
itself and nothing else. Firmware 2.0.0 finished the job — request signing, the
discovery beacon, claim codes and the device clock went the same way, for the
same reason. The Mega's firmware is designed to almost never need reflashing,
and the ESP's now needs it about as rarely.

The Mega's auto-off timer is independent on purpose: if the ESP hangs, the WiFi
drops and the backend dies, **the lights still go off**. In the system this
replaces, the off command was scheduled inside an Excel macro on a Windows PC —
close the workbook mid-session and a court burned until somebody noticed.

**The screen-revert deadline is on the Mega for exactly the same reason**, and
that is why it was moved: a timer that returns the glass to the landing screen
is useless if it lives on the half whose crash is what left the screen stuck.
See *About the display* above.

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

The physical panel is a **2004A (20×4)** and the firmware now drives it as
**20×4**. **Nothing about the wiring changed** — it is the same PCF8574 backpack
at the same I²C address on the same two pins. What changed is two build flags,
`-DLCD_COLS=20 -DLCD_ROWS=4` in `platformio.ini`'s `[lcd]` block, which
`hal::kDisplayCols` / `kDisplayRows` read and from which `court::kLineLen` is
**derived**. That derivation is the fix: the width used to be hardcoded at 16 in
`court/Session.h` while the flags said something else, so the panel's geometry
lived in two places that could disagree — and on the 2004A that is actually
fitted, the hardcoded number won and four columns of every line were
unreachable.

#### The safe-subset contract — what makes widening it safe

**Rows 0 and 1, truncated at column 16, must still be a complete and correct
message on every screen.** Rows 2–3, and the columns past 16, carry
**enrichment only**. A 1602 fitted by mistake then degrades to exactly the old
behaviour rather than to half a sentence — which is the property the 16×2
decision was originally taken for, kept, and now stated as a contract instead of
as a build flag. `court::kSafeSubsetCols` is the 16, and a `static_assert`
refuses a panel narrower than it, because that would make the contract
unsatisfiable rather than merely degraded.

**The host suite builds at the same 20×4.** A host build at 16×2 proving a
firmware built at 20×4 proves the degraded path and calls it the real one. The
degraded path is proven by the contract instead — a test over the whole screen
table at once — which needs no second build.

**Somebody still has to look at the panel before a club box is flashed.**
Everything here is right for a 2004A and silently wrong for a 1602, where rows
2–3 and columns 17–20 write into DDRAM that is off-glass. The contract makes
that a *degraded* screen rather than a *lying* one, which is what makes shipping
it reasonable — not a reason to skip the look. It is on
[`docs/go-live-checklist.md`](../../../docs/go-live-checklist.md).

#### The four-row layout

Zones never swap meaning between screens, so a member learns where to look once:

| Row | Carries |
|---|---|
| 0 | **title** — what is true |
| 1 | **detail** — the number, or the reason |
| 2 | **live court state** (or secondary detail) — rendered from `RelayGuard`, which is the authority on every court's remaining time, so it costs **zero** link bandwidth |
| 3 | **action row** — what to press, plus a **countdown or a clock** in the right-hand five columns, never both |

**No custom glyphs, deliberately.** The countdown is plain digits. A progress bar
would cost CGRAM that the I²C re-sync path has to restore after every bus wedge,
and it carries no information the digits do not.

#### The landing screen and every screen deadline live on the Mega

**The ESP is the half that goes away** — that is the founding argument of the
whole Mega/ESP split below, and it applies to the glass exactly as it applies to
the relay auto-off timer. A screen-revert timer on the ESP is a timer that stops
when the ESP crashes, and every stuck screen is a screen whose only possible
rescuer is the half that just failed.

So `courtlogic::ScreenBuffer` owns the landing screen, the overlay deadline, the
hint row and the live court row. Every screen the bridge paints is an
**overlay** that cannot outlive its deadline, and the deadline is clamped by the
**decoder** into [1, 120] seconds — on the way in, out of reach of any
configuration. What does **not** move here is the **copy**: verdict wording is
exactly the thing a club changes its mind about, and the Mega is the half that
cannot be reflashed without a screwdriver. Words stay on the ESP; mechanism
lives on the Mega.

The bug this closes was a refusal screen that never left the panel with every
button dead behind it, and it was intermittent *by membership status*, which is
why it survived review. The grammar is in
[`docs/specs/device-serial-protocol.md`](../../../docs/specs/device-serial-protocol.md)
— `!ROW` stages, `!SHOW` commits atomically, `!IDLE` says what the status row
says, `!MAP` gives each relay its club court number.

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

**Two `lib/` directories, one include namespace.** PlatformIO's LDF resolves
`../shared/lib` exactly as it resolves this project's own `lib/`, so a source
file includes `timebase/TimeBase.h` and `protocol/Codec.h` the same way and
never has to know which directory each came from. What decides where a module
lives is whether a *different* device would want it unchanged.

```
../shared/lib/ device-agnostic — every Crusaders firmware compiles these
  timebase/    rollover-safe millis() primitives   ← read this first
  hal/         port interfaces + null implementations
  hal_fakes/   recording test doubles
  devcrypto/   lowercase hex encode/decode
  fwversion/   the FW_VERSION_* string, alone so either half can carry it
  devapi/      the bearer header, the response-status policy, and a heapless
               JSON scanner
  eventq/      what the device DID, queued until the API can hear about it
  roster/      who may open what, cached and age-limited
  devlink/     the heartbeat body and the interval it adopts, one queued event
               as an upload body, the roster push parsed out of a heartbeat
               response, and the circuit breaker in front of every API call

lib/           THIS box — no other device wants these
  protocol/    Mega <-> ESP serial codec
  courtlogic/  the Mega's behaviour: auto-off timer, debounce, scan framing,
               auth window, frame dispatch, and ScreenBuffer — the landing
               screen, the overlay deadline, the hint row and the live court
               row — everything main.cpp does NOT do
  court/       what a scan means; the button map; the walk-up pad
  bridgelogic/ the ESP's decisions ABOUT THIS BOX: the online-then-roster scan
               flow, the auth window, walk-up request + nonce, relight, the !ON
               retry, `!STATE` reconciliation — everything court_bridge/main.cpp
               does NOT do. Plus RosterTokenFits.h, the one place the roster's
               token cap and the protocol's argument cap are asserted against
               each other.
  arduino_hal/ real drivers (AVR / ESP)   ← the ONLY place Arduino headers live
               (the simulator's host drivers are ../../shared/lib/posix_hal —
               the door gate's simulator uses the same ones)
src/
  court_mega/    ATmega2560 firmware — composition root only
  court_bridge/  ESP8266 firmware — composition root only
  simulator/     native device simulator — the same lib/ over posix_hal
test/          Unity tests for THIS project, run on the host. The shared
               libraries have their own suite in ../shared/test; `make test-iot`
               runs both, and that pair is the whole of it. No count is quoted
               here on purpose — a number in a README is stale the next time
               anybody adds a test, and it was never evidence in the first place.
tools/         strict compile gate (covers every project under src/iot), corpus
               generators, the Arduino sketch exporter
arduino/       GENERATED Arduino IDE sketches — the flashing route. Never hand-edited;
               `make arduino-export` writes it and `make arduino-check` fails on a diff.
```

Everything under either `lib/` except `arduino_hal/` and the shared
`posix_hal/` is free of Arduino headers, so the same code compiles for AVR, Xtensa **and** the host test
runner. That is what lets the whole logic layer be proven with no board
attached. CI enforces the rule with a grep gate, across both directories.

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
make arduino-export  # regenerate arduino/ from lib/, src/ and platformio.ini
make arduino-check   # regenerate and fail if the committed sketches are stale
make flash-mega      # USB-flash the ATmega2560 (prints the DIP positions)
make flash-bridge    # USB-flash the ESP8266, then open its monitor
make monitor-bridge  # watch the ESP's UART at 9600 (DIP 5 and 6 ON)
```

`make build-iot` compiles `court_bridge`, so it needs `court-box/src/common/secrets.h`
like a flash does — see *Flashing* above. All of these targets are run from the
repository root and cover every project under `src/iot`, not just this one.

### The rollover rule

`millis()` wraps every ~49.7 days, and a box in a cupboard is normally up that
long. **Never compare times directly.** Use `tb::reached(now, deadline)` or
`tb::Deadline`, both in `lib/timebase`.

The firmware this replaces got it wrong in both directions on adjacent lines —
using `0` as a "disarmed" sentinel (0 is a legal `millis()` value) and comparing
with `now >= expiresAt` (false for 49.7 days after the wrap, so the relay was
never released). `make lint-iot` greps for raw comparisons against any
`*deadline` / `*expires` / `*AtMs` identifier outside `lib/timebase`.

The same rule reaches the wire. The heartbeat's `uptime_ms` and both `uptime_ms`
fields on an events batch are rendered from the 64-bit `tb::Uptime64` value the
composition root keeps (`bridgelogic::renderHeartbeatBody`,
`bridgelogic::renderEventBody`) — a `uint32_t` anywhere on that path is the wrap
re-entering through the API at day 49.7, and it used to be: an activation queued
before the wrap and uploaded after it went up stamped 49.7 days ahead of its own
batch. The box carries **no clock at all** any more; the server dates an event
from the difference between those two uptimes.

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
second opinion. When the API cannot be asked (no link, **no court list yet**,
the circuit breaker open, a transport failure, a 5xx, a malformed 200) the
scan is decided **on the box**, from the roster cache the heartbeat fills, in
microseconds — so a router reboot is a slower scan, not a dark court. The flow is
`lib/bridgelogic/ScanFlow`.

Three details of that flow that were each a review finding:

- **The first heartbeat goes out the moment the WiFi link comes up**, not 30 s
  after boot. Until it has answered, `court_numbers` is empty and the box is
  *not* online: a scan is refused locally from the roster rather than recorded as
  attendance server-side and then refused at the box because the granted court
  maps to nothing.
- **A circuit breaker** (`lib/bridgelogic/ApiBreaker`) sits in front of every
  API call. Two consecutive transport failures — the request never completed,
  or a 5xx — and the API is judged down for a backoff window of 15 s, doubling to
  a cap of 120 s while it stays down. While open, scans go straight to the roster
  and the event drain waits; the heartbeat keeps its cadence and is the probe.
  Any completed answer, 401 and 429 included, closes it. Without this, a host that
  was off with the AP up cost every scan two 4 s connect timeouts.
- **The event drain has its own backoff** (`lib/bridgelogic/EventDrain`). A
  post that leaves the head event where it was — 401, 403, 404, 408, 429, a 5xx,
  or a 200 that acknowledges nothing — waits 15 s, doubling to 5 min, before the
  next; anything that moves the queue clears it. The event is kept through all of
  those (a 404 means the console deleted the box, and its next heartbeat
  registers it again); only another 4xx drops it. Without this, a disabled box
  re-posted its `boot` event every pass and spent the club's whole device
  budget, so every other box was answered 429 too.
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

## What the box keeps in flash

**One record: the event queue's sequence high-water mark.** Everything else that
used to live there — the device id, the device key, the tenant slug, the API
base URL, the WiFi credential — is compiled into the image from `secrets.h`, so
a change to any of them is a reflash and there is nothing on the box that can go
stale, be left holding a credential nobody can see, or disagree with the image.

The sequence mark earns its place because the API deduplicates events on
`(tenant, device, seq)` with a **permanent** unique index. A box that restarted
its numbering at 1 after a power cut would have every event up to its old
high-water silently receipted as a duplicate — and under charge-at-booking a
lost activation is the no-show sweep refunding-and-penalising a member who
played. It is written in blocks of 64 (`eventq::kSeqCheckpointStride`) rather
than per event, so the flash sees roughly one write per busy evening: skipping
sequence numbers after an unclean reboot is free, reusing one is a lost event.

`hal::IStore` still hands a torn write back as a value with `kOk`, so the record
carries its own check digits and a damaged one reads as *absent* — which
restarts numbering from 1, the one case where a number can be reissued, and is
survivable because the operator sees a Boot event immediately before the
repeat.
