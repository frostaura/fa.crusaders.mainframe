# Flashing a door gate from the Arduino IDE

**This is the deployment route.** Open the sketch, pick the board and the port,
press Upload. No terminal, no `make`, nothing to install from the Library
Manager — every library this firmware needs is vendored inside `src/`.

This folder is **generated**. Edit the PlatformIO sources under
`src/iot/door-gate/` (and the shared libraries in `src/iot/shared/lib/`), then
run `make arduino-export`; `make arduino-check` regenerates and fails if the
committed copy has gone stale. Editing a file in here is a change that the next
export deletes.

## Once per machine

1. Install the **Arduino IDE 2** (2.3 or newer).
2. **Preferences → Additional boards manager URLs**, add:
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
3. **Boards Manager**, install **esp32** by Espressif Systems **2.0.17**.

That version is what this export is compiled against in CI, and it matches the
platform `src/iot/door-gate/platformio.ini` pins (espressif32@6.9.0 / framework-arduinoespressif32 3.20017) — which is what
makes the IDE build and the PlatformIO build the same firmware. Installing a
different major version is not a small difference: 3.x renamed and reorganised
enough of the core that this sketch is not expected to compile against it.

No USB-serial driver is needed on current macOS. Only if **no** port ever
appears: `brew install --cask wch-ch34x-usb-serial-driver`, then replug.

## Once per board

Copy `secrets.h.example` to `secrets.h` — in **this** folder, beside
`door_gate.ino` — and fill in all four values. It is gitignored, and the gate
**refuses to compile without it**.

| Value | What it is |
|---|---|
| `WIFI_SSID` / `WIFI_PASSWORD` | The club WiFi. The board takes a DHCP lease; there is no static-IP option. |
| `API_BASE_URL` | The backend's **LAN IPv4 ADDRESS** and port, `http://` only, no trailing slash — e.g. `http://192.168.1.10:8088`. The sketch `static_assert`s all of that and will not compile otherwise. A **hostname** is an unbounded DNS wait (16 s, then 15 s) that no HTTP timeout covers, so every heartbeat would reset the board; `https://` is accepted by the HTTP client and then sent in **cleartext** to port 443; a trailing slash produces `//api/v1/...` and a 404 that reads at the door as an outage; `0.0.0.0` is the example file's own placeholder and `255.255.255.255` is the broadcast address, and both are refused. Not the public tunnel hostname either: that sends every scan out to Cloudflare and back while somebody stands at the door. |
| `DEVICE_API_KEY` | The tenant's device API key, from the admin Devices page. Goes out as `Authorization: Bearer <key>`. |

**Every value in `secrets.h.example` is a placeholder, and every placeholder is
a compile error.** The file used to ship plausible values — a real-looking SSID
and LAN address — which compile, flash, and produce a board that joins nothing
and posts to a machine that is not the club's. There is one LED on this
hardware, so that board and a board whose server is down look identical from the
bottom of the ladder. If the Upload fails with `static assertion failed: …
placeholder`, that is this guard: fill the value in.

Regenerating the key on the Devices page invalidates the old one
**immediately**, so a regeneration is a reflash of **every** board that carries
it and has to be planned as one.

**The same four values go on every door.** Nothing per-gate is compiled in: a
door is named in the admin console (`gate_key`), the API keys that name to the
board's MAC, and the board never needs to know it — it does not read `gate_key`
and has no field to keep one in. Two doors run byte-identical images and a spare
board is a spare board rather than a board for one particular door.

## Flash

- Open `door_gate/door_gate.ino` (it opens `secrets.h` in a second tab)
- **Tools → Board → esp32 → ESP32 Dev Module**
- Leave every other **Tools** setting at its default. Flash size, partition
  scheme, PSRAM and CPU frequency are all the board's defaults and none of them
  is load-bearing for this firmware.
- **Tools → Port** — the `/dev/cu.usbserial-*` or `/dev/cu.wchusbserial-*`
  (macOS) or `COM*` (Windows) that appears when the board is plugged in
- **Upload**

To watch it boot: **Tools → Serial Monitor at 115200**. On this board UART0 is
the USB console and nothing else — unlike the court bridge, whose UART0 *is* its
link to the Mega. The scanner is on `Serial2`.

## The flags you may change, and what each one is

They are all in `src/build_config.h`, and **the defaults below are the values
measured on the board that is already on the wall** — Carl's wiring, tested.
Changing one here changes it for the IDE build only; the PlatformIO build reads
`src/iot/door-gate/platformio.ini`, and `make arduino-check` will fail until the
two agree again. **If a change is meant to stick, make it in `platformio.ini`
and re-run `make arduino-export`.**

| Flag | Default | What it is |
|---|---|---|
| `GATE_SCANNER_RX_PIN` | 4 | The scanner's TX into the ESP32, on `Serial2`. |
| `GATE_SCANNER_TX_PIN` | 17 | The ESP32's TX to the scanner. Wired and unused — the scanner only talks. |
| `GATE_SCANNER_BAUD` | 9600UL | 8N1. |
| `GATE_RELAY_PIN` | 26 | Drives the door lock through the relay module. |
| `GATE_RELAY_ACTIVE_HIGH` | 1 | **The relay MODULE.** 1 if driving its input HIGH energises the coil. Cheap opto-isolated boards are usually active LOW; Carl's is active HIGH. |
| `GATE_UNLOCK_ENERGISES_RELAY` | 1 | **The LOCK's wiring.** 1 if an energised coil *releases* the lock. See the truth table below before touching this one. |
| `GATE_LED_PIN` | 27 | The lamp — the board's entire user interface. |
| `GATE_LED_ACTIVE_HIGH` | 1 | 1 if HIGH lights it. |
| `GATE_UNLOCK_DEFAULT_MS` | 3000UL | Release time until the first heartbeat tells the board the club's own. |
| `GATE_UNLOCK_HARD_CAP_MS` | 30000UL | A safety bound, not a default: the lock can never stay released longer than this, whatever the server answers and however often somebody scans. |
| `GATE_WATCHDOG_SECONDS` | 15 | Task watchdog period. |
| `HEARTBEAT_INTERVAL_MS` | 30000UL | Starting cadence. The tenant's own is adopted from the first response. |
| `ROSTER_MAX_AGE_MS` | 21600000UL | 6 h. A roster older than this admits **nobody**, however good the match looks. |

Leave alone: `FW_VERSION_*` (the heartbeat reports it, and the sketch `#error`s
unless all three parts are present and are the gate's), `TARGET_DOOR_GATE`,
`GATE_MAX_TOKEN_LEN` (asserted equal to the roster's) and `EVENTQ_SLOTS`.

`GATE_WATCHDOG_SECONDS` is in the table above but is **not** a free choice: the
sketch `static_assert`s that it exceeds one worst-case blocking HTTP call —
connect **plus** response, which a single call can spend both of — with room for
a whole pass on top. Lower it and the build fails, which is the point: a
watchdog no longer than the call it is timing resets the board before the call
can return, every time the API host goes quiet, so the board reset-loops and
admits nobody.

A value outside its range is a **compile error**, not a surprise on a wall. The
sketch asserts that the pins are output-capable (GPIO 34–39 on an ESP32 are
input-only, and a relay on one of them is a lock that never opens), that the
lock does not share a pin with the LED or the scanner, and that the hard cap is
inside the contract's 1–30 s.

## The two polarity flags, and what a dead board does to the door

`GATE_RELAY_ACTIVE_HIGH` is a fact about the **relay module**.
`GATE_UNLOCK_ENERGISES_RELAY` is a fact about **the lock's own wiring** — which
contact of the relay the lock is fed through. They are independent, and only
their composition says anything about the door.

| `ACTIVE_HIGH` | `UNLOCK_ENERGISES` | pin when **locked** | pin when **released** | dead or rebooting board |
|:---:|:---:|:---:|:---:|---|
| 1 | 1 | LOW | HIGH | coil de-energised → **locked** |
| 1 | 0 | HIGH | LOW | coil de-energised → **released** |
| 0 | 1 | HIGH | LOW | coil de-energised → **locked** |
| 0 | 0 | LOW | HIGH | coil de-energised → **released** |

Read the last column as: with no power, or with the board held in reset, the
relay coil is de-energised whatever the pin was doing. What the door then does
is decided by `GATE_UNLOCK_ENERGISES_RELAY` alone — **`0` means a de-energised
coil releases the door.**

**Carl's board is wired `GATE_UNLOCK_ENERGISES_RELAY=1`**: the coil is energised
to release, so a power cut leaves the door **locked**. That is the default
because it is what is on the wall today. Changing it is a lock change and a
rewire, not a flag change — flipping the flag alone, on hardware wired for `1`,
inverts the firmware's whole idea of the door.

> **Fire egress must be mechanical and independent of this board.** A door on an
> escape route has to open from the inside by pushing it — a panic bar, a
> mechanical handle — with no power, no relay and no firmware involved. Nothing
> in this repository is a life-safety device, nothing here is rated or certified
> as one, and no combination of the flags above turns it into one.

## What the LED means

| Pattern | Meaning |
|---|---|
| Solid | the lock is released — push the door |
| 3 fast blinks | refused |
| Slow 1 Hz blink | the radio is not associated; the board is deciding from its roster |
| 2 quick blinks | the board has just booted |

After an Upload with the board on the club WiFi, expect two quick blinks and
then a dark lamp, and the board appears on the admin **Devices** page by itself
within one heartbeat as `Kind=Gate`.

## When something is wrong

| What you see | What it is |
|---|---|
| A slow 1 Hz blink that never stops | The radio never associated. Check `WIFI_SSID` and `WIFI_PASSWORD` in `secrets.h`. The door still opens for a member with a rostered booking until the roster goes stale. |
| A fast 4 Hz blink | The task watchdog refused to arm after three tries. The door is unaffected and still opens; the board is running on the core's 5 s watchdog instead of its own. Report it. |
| **The lamp stays dark and the board never appears on the Devices page** | Nothing is running. In order: is the board powered and is `GATE_LED_PIN` the pin the lamp is actually on? Open **Tools → Serial Monitor at 115200** and press the board's RESET — one line naming the firmware version, the MAC and the API address should appear. **No line at all** means the Upload did not take (wrong **Port**, or a board that needs BOOT held) or the sketch is not running. **A line, but nothing on the Devices page** means the MAC is reaching no server: check the `api=` address on that line against where the backend actually is, and that the board and the backend are on the same LAN. |
| The Upload fails on `static assertion failed` | A value in `secrets.h` is still the example file's placeholder, or `API_BASE_URL` is not `http://` + an IPv4 address. The message names which. |
| The Upload fails with hundreds of `redefinition of …` errors | **iCloud Drive.** A synced folder fabricates numbered duplicates — `Json 2.cpp`, `GateApp 2.h` — and the IDE compiles **every** `.cpp` under `src/` recursively, so each duplicate is a second definition. They are invisible in Finder's default view and are never committed. From the repository root: `make sweep-icloud`. By hand, from this sketch folder: `find . -name '* [0-9].*' -print -delete` and then `find . -name '* [0-9]' -print -delete`. Then Upload again. |

## What is inside this sketch

| | `door_gate` |
|---|---|
| PlatformIO environment | `[env:door_gate]` |
| Board | `esp32:esp32` 2.0.17, FQBN `esp32:esp32:esp32` |
| `lib/` modules | `devapi`, `devcrypto`, `devlink`, `esp32_hal`, `eventq`, `fwversion`, `gatelogic`, `hal`, `roster`, `timebase` |
| Build flags in `src/build_config.h` | 19 |

| Library | Version | Where | Licence file |
|---|---|---|---|
| _(none)_ | | | |

`src/build_config.h` carries every `-D` its PlatformIO environment sets — with
`build_unflags` applied by exact token, exactly as PlatformIO applies it. That
is what makes the firmware version in here
**1.0.0** rather than the 2.0.0 that `[common]` pins for the
court box — this environment does not inherit `[common]` at all and spells its
own version out, which is what stopped `build_unflags` deleting the tokens it
had just been given. `build_config.h` is included first in every file of the sketch,
because the IDE cannot pass a build flag and a target guard like
`#ifdef TARGET_DOOR_GATE` has to be true in files the `.ino` never includes.

> All three of `FW_VERSION_MAJOR`, `FW_VERSION_MINOR` and `FW_VERSION_PATCH`
> are in `build_config.h`, and the sketch `#error`s unless all three are
> defined **and** are the gate's. They used not to be: `[env:door_gate]`
> inherited `[common]`'s 2.0.0 and unflagged it, and `build_unflags` removes
> **every** token that matches — including the environment's own — so
> `-DFW_VERSION_MINOR=0` was added and then deleted, on both build routes, and
> `src/fwversion/Version.h`'s `#ifndef` fallback of 0 supplied the value. The
> image reported 1.0.0 by luck. The environment no longer inherits `[common]`
> at all; it spells out `-std=gnu++17` and sets its own version.

Two flags are deliberately **not** mirrored: `-Wall -Wextra` (warnings are not
behaviour; `make lint-iot` is the gate) and `-std=gnu++17` (the ESP32 core
appends `-std=gnu++11` and a sketch cannot override it).

> **So everything this sketch links must be valid C++11 as well as C++17**, and
> that is not a detail — it is the constraint that decides how several of these
> headers are written. `-std=gnu++11` is hard-coded in the core's `platform.txt`
> and the IDE has no mechanism to override it; `build_unflags` is a PlatformIO
> mechanism the IDE never sees, so the PlatformIO build gets C++17 and this one
> does not. A multi-statement `constexpr` function is green under `pio run` and
> red here — it has happened once already, in `LockDriver.h` — while `inline
> constexpr` *variables* survive as a GCC extension. Only the `arduino-cli
> compile` step in CI catches the difference.

## The developer route

`pio run -d src/iot/door-gate -e door_gate -t upload` does the same upload from
PlatformIO. It needs `make install-iot` and a filled-in
`src/iot/door-gate/src/common/secrets.h`. Everything else about this firmware —
the wiring, how a scan is decided, the offline degraded mode, the rollover rule
— is in [`../README.md`](../README.md).
