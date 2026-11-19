# Court box on a Raspberry Pi (`src/iot/court-pi`)

**Status: PROPOSED** — on branch `claude/friendly-shannon-0y9nhv`, built and smoke-tested on a Linux
host, not yet run on a Pi or wired to the club's hardware. Needs the founder's go-ahead before it
replaces the Mega + ESP8266 board, and the electrician's sign-off on the relay side
(`memory/safety-relays.md`) exactly as the current board does.

The door gates are out of scope: they stay ESP32 (`door-gate.md`).

The visual companion — schematic, interactive header map, process architecture, scan sequence and
the failure chain — is [`docs/court-box-pi.html`](../court-box-pi.html).

## 1. What changes and what does not

| | Today (WeMos Mega 2560 + ESP8266) | On the Pi |
|---|---|---|
| I/O + independent timer | ATmega2560, `court_mega/main.cpp` | process **`court-io`**, same `courtlogic::CourtBox` |
| Brain (API, roster, events) | ESP8266, `court_bridge/main.cpp` | process **`court-brain`**, same `main.cpp`, compiled unchanged |
| Link between them | Serial3 @ 9600, DIP 1 + 2 | Unix socket `/run/court-box/link.sock`, the same v3 bytes |
| Hardware layer | `arduino_hal` | `court-pi/lib/linux_hal` (GPIO chardev, i2c-dev, termios) and `court-pi/compat` (Arduino/WiFi/HTTP/LittleFS on Linux) |
| Reported versions | Mega 3.0.0, bridge 3.1.0 | the same: the server cannot tell them apart |
| Serial protocol, device API | v3 / v3 | unchanged — no backend change |
| Update route | Arduino IDE, USB cable, DIP switches | `git pull && sudo src/iot/court-pi/deploy/install.sh` on the Pi |

Nothing under `court-box/` or `shared/` is edited by this change. `court-pi/CMakeLists.txt` names
their directories and compiles them, as PlatformIO's `lib_extra_dirs` does.

## 2. Board

**Raspberry Pi 5, 2 GB** is the board (founder, 2026-11-19). Ethernet where a cable reaches the box,
a robust radio where it does not. 2 GB is far more than both processes use (a few MB each). What the
Pi 5 changes against the older boards, all handled here:

| Pi 5 fact | What the box does about it |
|---|---|
| GPIO lives on the **RP1** I/O controller (`pinctrl-rp1`), `gpiochip0` on 6.6+ kernels, `gpiochip4` on early 6.1 | court-io finds the chip **by label**, never by number |
| The 40-pin header is pin-for-pin the Pi 4's | the pin map in §3.1 is unchanged |
| `/dev/serial0` is the separate 3-pin **debug UART** connector, not GPIO 14/15 | the scanner is on **UART0** → `/dev/ttyAMA0`, enabled by `dtparam=uart0=on` |
| RP1's reset-default pulls are not documented as the BCM2711's are | the box does not rely on them: `config.txt` `gpio=…=ip,pd` from the firmware stage, and the external pull-downs |
| Wants **5 V 5 A** (27 W) over USB-C PD; on less it caps USB at 600 mA and warns | a fused **5.1 V 5 A** buck into USB-C plus `usb_max_current_enable=1` (no PD to negotiate) |
| Throttles under sustained heat in a closed box | the **official Active Cooler** (or a vented case with fan); the load is light, but a sealed enclosure in summer is not |
| Requires Raspberry Pi OS **Bookworm** or later | the install procedure says so |
| Has an RTC header (`J5`) | optional: a battery there gives a correct clock before the first heartbeat; the bridge does not need it |

The same build still runs on a Pi 4, 3B+ or Zero 2 W (`config.txt` carries a `[pi4]` section), so
any of them is a usable spare.

## 3. Electrical

The Pi's GPIO is **3.3 V and not 5 V tolerant**; the Mega's was 5 V. Every 5 V part therefore
reaches the Pi through an interface:

| Signal | Interface | Why |
|---|---|---|
| Relays A–D | **74AHCT125** quad buffer at 5 V, `OE̅` to GND, **10 kΩ pull-down on each input** | A 3.3 V-input/5 V-output buffer drives the SSRs as the Mega's 5 V pins did, keeps field wiring off the SoC, and the pull-downs hold every input low whenever no software drives it |
| LCD SDA / SCL | **BSS138 bidirectional shifter** (HV 5 V, LV 3.3 V) | The PCF8574 backpack pulls its bus up to 5 V, and at 5 V its V<sub>IH</sub> is 3.5 V — above the Pi's 3.3 V high |
| Scanner TX → Pi RX | third channel of the same shifter, into UART0 RXD (`/dev/ttyAMA0`) | 5 V TTL into a 3.3 V pin. A USB scanner needs no shifter: pass `--scanner /dev/ttyACM0` |
| Buttons | none: SoC pull-ups, switch to GND | Same as the Mega (`INPUT_PULLUP`, pressed = LOW); debounce stays in `ButtonPanel` |
| Status LED | 330 Ω | Lit while any court is lit, as on Mega pin 13 |

**Relay polarity now lives in a resistor.** Mega 3.0.0 released a relay by making its pin an input,
so a wrong drive level failed dark for either module type, and the immutable-wiring rule forbade a
pull-down (`decisions-device-v3-hardware.md`). Replacing the board is a rewiring, and with a
buffer in the path the input is never high-Z at the SSR, so the pull resistor states the module's
polarity instead: the club's SSRs are active-high, so the resistors pull **down**. If an active-low
module is ever fitted, the resistors become pull-ups and `hw_relay_active_level` becomes `low`; the
box still fails dark. court-io keeps the Mega's semantics on the Pi side (released = input with
bias disabled, `relayDriveFor` unchanged), so a wrong `RPOL` still cannot light a court.

**Power.** The Pi 5 gets its own fused **5.1 V 5 A** buck from the Mean Well PSU, into the USB-C
socket (the header's 5 V pins bypass the Pi's input protection); check the Mean Well's spare
capacity covers ~27 W more. A plain buck cannot negotiate USB-PD, so `config.txt` sets
`usb_max_current_enable=1` to tell the Pi the supply is 5 A. The existing fused LM2596 5 V rail keeps
feeding the LCD, the scanner, the buffer's VCC and the shifter's HV side. All grounds are common.
The 9 V rail goes if it only fed the Mega's barrel jack.

### 3.1 Pin map

BCM GPIO numbers with the 40-pin header's physical pin. The source of truth is
`court-pi/lib/linux_hal/include/linux_hal/PiPins.h`; `test_court_pi` proves the table's rules.

| Function | Mega pin | Pi GPIO | Physical pin |
|---|---|---|---|
| Relay A / B / C / D | 2 / 3 / 4 / 5 | 17 / 27 / 22 / 23 | 11 / 13 / 15 / 16 |
| Court button A / B / C / D (green) | 22 / 24 / 26 / 28 | 5 / 6 / 13 / 19 | 29 / 31 / 33 / 35 |
| 15 / 30 / 45 / 60 min (black) | 30 / 32 / 34 / 36 | 26 / 16 / 20 / 21 | 37 / 36 / 38 / 40 |
| Status LED | 13 | 24 | 18 |
| LCD SDA / SCL | 20 / 21 | 2 / 3 (I2C1) | 3 / 5 |
| Scanner TX → Pi RX | RX2 17 | 15 (UART0 RXD, `/dev/ttyAMA0`) | 10 |
| Scanner RX (never written) | TX2 16 | 14 (UART0 TXD) | 8 |
| 3.3 V reference (shifter LV) | — | — | 1 |
| GND | — | — | 6, 9, 14, 20, 30, 34, 39 |

Why these pins: on the BCM2711 every relay GPIO is pulled **down** from reset (GPIO 9–27); on the
Pi 5 that is not relied on — `config.txt` (`gpio=17,27,22,23=ip,pd`) sets pull-down from the
firmware stage, and the external resistors hold them regardless — and no pin touches the HAT ID EEPROM (0/1), I2C1 (2/3), 1-wire (4), SPI0 (7–11) or
UART0 (14/15) except for its own purpose. GPIO 25 (pin 22) is left spare for a future hardware
dead-man if the committee wants one independent of software altogether.

## 4. Software

**`court-io`** (`court-pi/src/court_io/main.cpp`) is the Mega's composition root re-done with
`linux_hal`: `GpioRelay` and `GpioButtons` on the GPIO character device (uAPI v2 — no libgpiod),
`I2cLcd` (a port of `arduino_hal::LcdDisplay`: the same address probe order, `DisplayHoldoff`
re-sync, and 8 ms paint budget, with the kernel's I2C timeout in place of Wire's), `UartScanner`
(termios on `/dev/ttyAMA0`; `ScanAssembler` still auto-detects the baud), `UnixLinkServer`. Modes: the box; `--bench`
(console relays/LCD, `scan`/`btn` on stdin — the box on a laptop); `--release` (every relay line an
input, then exit).

**`court-brain`** is `court-box/src/court_bridge/main.cpp` and `EspLifeline.cpp`, unchanged,
compiled against `court-pi/compat`:

| ESP8266 core | On Linux |
|---|---|
| `Serial` (UART0 to the Mega) | `UnixLinkClient`: re-dials every 500 ms, discards writes while court-io is away (a UART with nobody listening does the same; `MegaTx` retries anything unacknowledged) |
| `HTTPClient` / `WiFiClient` | one HTTP/1.0 POST on a POSIX socket, each phase bounded by the bridge's own `CallBudget` timeout |
| `WiFi.status()` | a default route in `/proc/net/route` (WiFi or Ethernet) |
| `WiFi.macAddress()` | `COURT_BRAIN_IFACE`'s MAC, or `COURT_BRAIN_MAC` to keep the retired ESP's identity |
| `WiFi.begin()` (the server's runtime `net`) | `nmcli device wifi connect` in the background when `COURT_BRAIN_MANAGE_WIFI=1`, permitted by a polkit rule for the `court` user only |
| `LittleFS` | `/var/lib/court-box/brain`; every write-mode close `fsync`s and every rename `fsync`s the directory |
| RTC user memory | a file in `/run` — survives a process restart, wiped by a power cycle, as RTC memory is |
| `ESP.getResetInfoPtr()` | `power_on` on the first start since boot, `software` after (both benign to `DeviceTelemetry`) |
| `ESP.restart()` | `exit(0)`; systemd restarts it |
| heap / stack / flash diag | `MemAvailable`, `RLIMIT_STACK`, the data partition — far above the server's floors |

The surface is exactly what the bridge calls: a call it starts making that `compat/` does not
provide is a compile error on the Pi build, not a silent gap.

`secrets.h` is the same four values, in `court-pi/config/common/secrets.h` (gitignored), and is still
only the first-boot default (`device-api.md` §6, §8).

## 5. Safety chain

The court box's founding rule — the half that holds the relays keeps working when the half that
holds the network does not — is kept by process isolation plus four layers behind court-io:

| Fails | What happens | Lights |
|---|---|---|
| court-brain crashes / hangs | court-io times every court out itself and shows OUT OF SERVICE; systemd restarts court-brain (`WatchdogSec=30`) | off on their timers |
| court-io crashes | `ExecStopPost=court-io --release` makes every relay line an input; restart in 1 s; court-brain re-lights booked courts from the snapshot as after a Mega reset | dark ≤ 1 s |
| court-io hangs | `WatchdogSec=2` (the Mega's 2 s WDT) kills it; then as above | dark ≤ 3 s |
| kernel / systemd hangs | SoC watchdog (`RuntimeWatchdogSec=15`, the BCM2712's own) resets the board; the external pull-downs, then `config.txt`, hold relay inputs low through the reboot | dark ≤ 15 s |
| power, SD card, Pi itself | nothing drives the buffer inputs; the 10 kΩ pull-downs hold the SSRs open | dark |

The Linux GPIO driver leaves a line's direction as it was when its owner exits, which is why the
release step is explicit (`ExecStartPre` and `ExecStopPost`) rather than assumed.

## 6. Install and migration

See `court-pi/README.md` for the full procedure. In short: Raspberry Pi OS Lite 64-bit (Bookworm or later); fit the Active Cooler; fill in
`secrets.h`; `sudo src/iot/court-pi/deploy/install.sh`; reboot. The installer builds and runs the
host tests on the Pi, installs both services, the watchdog configuration, the boot `config.txt`
block, the polkit rule, and moves the journal to RAM to spare the SD card.

To keep the old box's court numbers, button map and LCD settings, set `COURT_BRAIN_MAC` to the
ESP8266's MAC. The old board and the Pi must never run at once with the same MAC.

## 7. Verified, and not yet

Verified on a Linux host (this branch):

- both programs build with `-Wall -Wextra` clean from the unchanged firmware sources; the new
  sources pass the repo's pinned clang-format 18.1.8;
- `ctest`: pin-table rules, URL and MAC grammars, the HTTP client against a real socket, the socket link;
- end to end with `court-io --bench` + `court-brain` + a stub API: heartbeat v3 reports
  `firmware_version 3.1.0`, `mega_version 3.0.0`, caps `hb:3 key:1 net:1 lcd:2 codes:m1`; a scan
  posts `/activate`, greets `HI DEAN`, closes court C and releases it when the 6 s grant ends;
  **court-brain SIGKILLed mid-game, court-io still released the court on time**; the restarted
  brain reconnected and reported `reset: software`.

Owed on the bench before go-live (none of it reachable from a host):

- GPIO, I2C and UART on a real Pi 5 (RP1 found by label, UART0 on `/dev/ttyAMA0`); LCD address probe and re-sync on the real backpack;
- the Pi 5 under the 5.1 V 5 A buck: no under-voltage or USB-current warning in `vcgencmd get_throttled`, and temperature in the closed box on a warm evening;
- every buffer output at 0 V with the Pi off, booting, and with court-io stopped;
- the SSRs' input current against the 74AHCT125's drive (spec 8 mA per output at 5 V; if an SSR
  needs more, a ULN2803-style sink per channel replaces the buffer);
- the scanner's supply and TX level, and whether it offers USB-CDC (which removes the shifter);
- the failure table in §5, each row by hand: pull power, `kill -9` each process, `SIGSTOP` court-io;
- an SD-card power-cut soak with the event queue mid-write.

## 8. Open for the founder

- **Remote updates.** A Pi can be updated over SSH; the ESP deliberately could not (founder,
  2026-11-14). Recommendation: SSH on, key-only, LAN-only, no automatic updates — an update is a
  person running `install.sh`, the same deliberate act a cable flash is today.
- **Retire or keep `court-box/`'s Mega/ESP targets.** They stay buildable and unchanged until the
  Pi has run a season; the logic is shared, so keeping them costs nothing.
