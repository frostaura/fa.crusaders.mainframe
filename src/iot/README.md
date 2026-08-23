# `src/iot` — court-control firmware

Firmware for the Crusaders court box: a **WeMos Mega 2560 + onboard ESP8266**
driving four court-light relays, a 16×2 LCD, an eight-button panel and a QR
scanner.

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
| ESP run/monitor over USB | **5 ON, 6 ON**, 7 OFF, others OFF |

> **Unverified, and it affects the schedule.** The sheet documents positions for
> Serial3↔ESP and USB↔Mega, but not for USB↔ESP8266 with GPIO0 pulled low —
> which is what a *first* ESP8266 flash needs. If the board has no such position,
> the initial flash requires an external USB-TTL adapter on the ESP module's
> TX/RX pads with GPIO0 grounded. Every flash after that is OTA.
>
> **Check this on the physical board before trusting any schedule**, and record
> the answer here.

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
protocol on that socket. `--start-ms 4294963200` puts the 49.7-day `millis()`
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

## Flashing

**Mega** — DIP 3,4 ON, then `pio run -e court_mega -t upload`.

**ESP8266** — normally OTA. For a first flash, see the DIP caveat above.

Copy `src/common/secrets.h.example` to `secrets.h` and fill it before flashing.
`secrets.h` is gitignored; it was committable until this project closed that gap.
