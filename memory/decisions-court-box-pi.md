---
name: crusaders-mainframe-decisions-court-box-pi
description: "Court box on a Raspberry Pi 5 (proposed 2026-11-19): court-io + court-brain processes compiling the unchanged Mega and bridge sources, relay fail-dark moved into pull-down resistors, and what is still owed on the bench."
type: decision
last_verified: 2026-11-19
---

# Decisions — court box on a Raspberry Pi (proposed, 2026-11-19)

Branch `claude/friendly-shannon-0y9nhv`. Spec: `docs/specs/court-box-pi.md`; diagrams:
`docs/court-box-pi.html` (published artifact https://claude.ai/artifact/VboQzT866FoxndvWh5PGE2).
Asked for by Dean: replace the court box's Mega + ESP8266 with a Pi; door gates stay ESP32.
**Not adopted yet** — awaiting the founder's go-ahead and a bench run on a real Pi.

- **The board is a Raspberry Pi 5** (Dean, 2026-11-19). *Consequences:* GPIO on RP1 found by
  label (chip number moved between kernels); scanner on UART0 `/dev/ttyAMA0` with
  `dtparam=uart0=on`, because `/dev/serial0` on a Pi 5 is the debug connector; a fused 5.1 V 5 A
  buck plus `usb_max_current_enable=1`; Active Cooler; RP1 reset pulls not relied on. The header
  is the Pi 4's, so the pin map did not move.
- **Two processes, not one.** `court-io` = `courtlogic::CourtBox` on `linux_hal`; `court-brain` =
  `court_bridge/main.cpp` compiled unchanged against `court-pi/compat`. Joined by a Unix socket
  carrying the same v3 bytes. *Why:* the half holding the relays must survive the half holding the
  network; on the Mega + ESP that was two chips. Tested: SIGKILL of court-brain mid-game, court-io
  still released the court on time.
- **Compile the bridge unchanged behind an Arduino/ESP compat layer instead of porting it.**
  *Why:* `main.cpp` is ~3000 reviewed lines; a fork would drift. The compat surface is exactly what
  the bridge calls, so a new call is a Pi compile error, not a silent gap. Versions reported stay
  Mega 3.0.0 / bridge 3.1.0, so the backend needs no change.
- **Relay fail-dark moves from "released = input" into a 10 kΩ pull-down per buffer input.**
  *Why:* the 3.3 V Pi needs a 74AHCT125 to drive the SSRs, and a buffer's output is never high-Z.
  Rewiring was requested, so the immutable-wiring rule that forbade a pull-down does not bind this
  board. Software still releases as an input (bias off), `config.txt` holds the pins pulled down
  from the firmware stage, and the SoC resets them pulled down.
- **Safety chain:** `ExecStartPre`/`ExecStopPost` `court-io --release` (Linux leaves a line's
  direction when its owner dies), `WatchdogSec=2` on court-io, 30 on court-brain, SoC watchdog 15 s.
- **Owed before go-live:** real GPIO/I2C/UART on a Pi; buffer outputs 0 V while off/booting/stopped;
  SSR input current vs the buffer's 8 mA; scanner level or USB-CDC; each failure-table row by hand;
  an SD power-cut soak. Founder decisions open: SSH updates (recommend key-only, LAN, manual), and
  when to retire the Mega/ESP targets (recommend after a season).
