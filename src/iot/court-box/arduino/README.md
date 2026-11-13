# Flashing the court box from the Arduino IDE

**This is the deployment route.** Open the sketch, pick the board and the port,
press Upload. No terminal, no `make`, and nothing to install from the Library
Manager — every library either half needs is vendored inside its own `src/`.

These two folders are **generated**. Edit the PlatformIO sources under
`src/iot/court-box/` (and the shared libraries in `src/iot/shared/lib/`), then run
`make arduino-export`; `make arduino-check` regenerates and
fails if the committed copies have gone stale. Editing a file in here is a
change that the next export deletes.

## Once per machine

1. Install the **Arduino IDE 2** (2.3 or newer).
2. **Preferences → Additional boards manager URLs**, add:
   `https://arduino.esp8266.com/stable/package_esp8266com_index.json`
3. **Boards Manager**, install both:
   - **Arduino AVR Boards** 1.8.6 (for the Mega)
   - **esp8266** by ESP8266 Community 3.1.2 (for the bridge)

Those two versions are what this export is compiled against in CI. They match
the platforms `src/iot/court-box/platformio.ini` pins (atmelavr@5.0.0 / framework-arduino-avr 5.2.0; espressif8266@4.2.1 / framework-arduinoespressif8266 3.30102.0), which
is what makes the IDE build and the PlatformIO build the same firmware.

No USB-serial driver is needed on current macOS. Only if **no** port ever
appears: `brew install --cask wch-ch34x-usb-serial-driver`, then replug.

## Once per checkout

Copy `court_bridge/secrets.h.example` to `court_bridge/secrets.h` — in the same
folder as `court_bridge.ino` — and fill in all four values. It is gitignored, and
the bridge **refuses to compile without it**.

| Value | What it is |
|---|---|
| `WIFI_SSID` / `WIFI_PASSWORD` | The club WiFi. The box takes a DHCP lease. |
| `API_BASE_URL` | The backend's **LAN** address and port, no trailing slash — e.g. `http://192.168.1.10:8088`. |
| `DEVICE_API_KEY` | The tenant's device API key, from the admin Devices page. Goes out as `Authorization: Bearer <key>`. |

Regenerating the key on the Devices page invalidates the old one **immediately**,
so a regeneration is a reflash and has to be planned as one.

## Flash, in this order

The box has one USB socket and a DIP block that routes it to one of the two
chips, so every upload is a switch change first. **Set the switches before you
press Upload**, and leave the box powered throughout.

### 1 — the Mega

| DIP | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Mega upload | OFF | OFF | **ON** | **ON** | OFF | OFF | OFF | OFF |

- Open `court_mega/court_mega.ino`
- **Tools → Board → Arduino AVR Boards → Arduino Mega or Mega 2560**
- **Tools → Processor → ATmega2560 (Mega 2560)**
- **Tools → Port** — the `/dev/cu.usbserial-*` (macOS) or `COM*` (Windows) that
  appears when the box is plugged in
- **Upload**

### 2 — the bridge

| DIP | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Bridge upload | OFF | OFF | OFF | OFF | **ON** | **ON** | **ON** | OFF |
| Bridge monitor | OFF | OFF | OFF | OFF | **ON** | **ON** | OFF | OFF |

- Open `court_bridge/court_bridge.ino` (it opens `secrets.h` in a second tab)
- **Tools → Board → esp8266 → Generic ESP8266 Module**
- **Tools → Flash Size → 4MB (FS:2MB OTA:~1019KB)**
- **Tools → CPU Frequency → 80 MHz**
- **Tools → Upload Speed → 115200**
- **Tools → Port**, then **Upload**

To watch it boot, move DIP 7 to OFF and open **Tools → Serial Monitor at 9600**.
Not 115200: that UART *is* the Mega link and its baud is fixed by the wiring, so
a monitor at the wrong speed shows framing garbage that reads as a dead board.

### 3 — run

| DIP | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| **Run** | **ON** | **ON** | **ON** | **ON** | OFF | OFF | OFF | OFF |

Set those, then **power-cycle the box**.

## What the LCD should show

| When | Glass |
|---|---|
| After the Mega upload, run DIPs | `SCAN YOUR QR` / `STARTING UP` — Mega 3.0.0 is alive. `CRUSADERS COURTS / SCAN YOUR CODE` means the Mega upload did NOT land (that is the 2.1.0 image) |
| During the bridge upload and monitor | **Nothing new.** DIP 1 and 2 are off, so the Mega is not on the other end of that UART. Watch the monitor, not the glass. |
| Run DIPs restored, box on the WiFi | `SCAN YOUR QR` / `READY` — and the box appears on the admin **Devices** page by itself within one heartbeat, with its court numbers and `mega_version` 3.0.0 against it |
| Run DIPs restored, box **not** on the WiFi | `SCAN YOUR QR` / `NO WIFI` — the two halves are talking and the radio is not. Check the SSID and password in `secrets.h`. `OUT OF SERVICE` means they are not talking: check DIP 1 and 2. |

If nothing ever appears, the two halves are not talking: check DIP 1 and 2.

## What is inside each sketch

| | `court_mega` | `court_bridge` |
|---|---|---|
| PlatformIO environment | `[env:court_mega]` | `[env:court_bridge]` |
| `lib/` modules | `arduino_hal`, `courtlogic`, `fwversion`, `hal`, `protocol`, `timebase` | `arduino_hal`, `bridgelogic`, `court`, `courtlogic`, `devapi`, `devcrypto`, `devlink`, `eventq`, `fwversion`, `hal`, `memcode`, `protocol`, `roster`, `timebase` |
| Build flags in `src/build_config.h` | 9 | 10 |

Vendored third-party libraries — copied out of `src/iot/court-box/.pio/libdeps/<env>/`,
which is what PlatformIO resolved from `lib_deps`, so the Library Manager is
never consulted and the two builds cannot get different versions. Each package
is copied whole apart from its `examples/` (the IDE would try to compile them):

| Library | Version | Where | Licence file |
|---|---|---|---|
| _(none)_ | | | |
| _(none)_ | | | |


`src/build_config.h` carries every `-D` its PlatformIO environment sets and is
included first in every file of the sketch, because the IDE cannot pass a build
flag and a target guard like `#ifdef TARGET_COURT_MEGA` has to be true in files
the `.ino` never includes.

Two flags are deliberately **not** mirrored: `-Wall -Wextra` (warnings are not
behaviour; `make lint-iot` is the gate) and `-std=gnu++17` (the Arduino AVR core
hard-codes `-std=gnu++11` and a sketch cannot override it, which is why `lib/`
is kept C++11-clean).

## The developer route

`make flash-mega` and `make flash-bridge` do the same two uploads from
PlatformIO, print the DIP positions and wait for the port. They need
`make install-iot` and a filled-in `src/iot/court-box/src/common/secrets.h`. Everything
else about the firmware — the wiring, the DIP block, why the logic lives on the
ESP8266, the rollover rule — is in [`../README.md`](../README.md).
