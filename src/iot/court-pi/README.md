# `src/iot/court-pi` — the court box on a Raspberry Pi

The court light box with one **Raspberry Pi** in place of the WeMos Mega 2560 + ESP8266 board.
Relays, buttons, LCD, scanner and power supply stay; see
[`docs/specs/court-box-pi.md`](../../../docs/specs/court-box-pi.md) for the design and
[`docs/court-box-pi.html`](../../../docs/court-box-pi.html) for the schematic and diagrams.

**Status: proposed.** Built and smoke-tested on a Linux host; not yet run on a Pi.

## What is in here

| Path | What it is |
|---|---|
| `src/court_io/main.cpp` | **court-io**, the Mega's role: `courtlogic::CourtBox` (unchanged) on `linux_hal` |
| `lib/linux_hal/` | GPIO relays and buttons (kernel GPIO chardev, no libgpiod), the I2C LCD, the UART scanner, the Unix-socket link, sd_notify. `PiPins.h` is the pin map |
| `compat/` | Arduino core, ESP8266WiFi, ESP8266HTTPClient and LittleFS on Linux, so **court-brain** is `court-box/src/court_bridge/main.cpp` compiled **unchanged** |
| `test/test_court_pi.cpp` | host tests for what court-pi adds (`ctest`) |
| `config/common/secrets.h.example` | the bridge's four first-boot values; copy to `secrets.h` (gitignored) |
| `deploy/` | systemd units, the hardware-watchdog drop-in, the `config.txt` block, the polkit rule, `court-box.env.example`, `install.sh` |

Nothing under `../court-box` or `../shared` is copied or edited: `CMakeLists.txt` compiles them in
place. The court box's logic is proven by `make test-iot`; this project's tests prove only the
Linux layer.

## Build and test on any Linux machine

```bash
cp config/common/secrets.h.example config/common/secrets.h   # fill in all four values
cmake -S . -B build && cmake --build build -j
(cd build && ctest --output-on-failure)
```

## Run it without a Pi (the bench)

```bash
cd build
./court-io --bench --link ./link.sock --run-dir ./run          # type: scan ABC123 / btn A / quit
COURT_BRAIN_LINK=./link.sock COURT_BRAIN_DATA=./data COURT_BRAIN_RUN=./run \
  COURT_BRAIN_IFACE=eth0 COURT_BRAIN_MANAGE_WIFI=0 ./court-brain
```

court-io prints the relays and the glass; court-brain talks to `API_BASE_URL` from `secrets.h`.
(A socket path is limited to 107 bytes, so keep it short or relative.)

## Install on the Pi

1. Raspberry Pi OS Lite (64-bit). Enable SSH with a key; join the WiFi or plug in Ethernet.
2. Wire it by the schematic — mains isolated. Before connecting the SSRs, check every buffer output
   reads 0 V with the Pi off and while it boots.
3. Clone this repository on the Pi and fill in `config/common/secrets.h`.
4. `sudo src/iot/court-pi/deploy/install.sh`, then `sudo reboot`.
5. To keep the old box's court numbers and button map, put the ESP8266's MAC in `COURT_BRAIN_MAC`
   in `/etc/court-box/court-box.env` and `sudo systemctl restart court-brain`. Never run both
   boxes at once with the same MAC.
6. `journalctl -u court-io -u court-brain -f`. Within one heartbeat the Devices page shows
   firmware 3.1.0 and Mega 3.0.0.

An update is `git pull` and the same `install.sh`.

## Settings (`/etc/court-box/court-box.env`)

| Variable | Default | Meaning |
|---|---|---|
| `COURT_BRAIN_IFACE` | `wlan0` | whose MAC is the box's identity; the radio `net` changes drive |
| `COURT_BRAIN_MAC` | empty | keep a retired ESP8266's identity |
| `COURT_BRAIN_MANAGE_WIFI` | `1` on `wl*` | `1`: the server's `net` drives nmcli; `0`: the OS owns the network |
| `COURT_BRAIN_LINK` / `_DATA` / `_RUN` | `/run/court-box/link.sock`, `/var/lib/court-box/brain`, `/run/court-box` | paths |

court-io takes `--gpiochip`, `--i2c` (default `/dev/i2c-1`), `--scanner` (default `/dev/serial0`;
a USB scanner is `/dev/ttyACM0`) and `--link` on its command line.
