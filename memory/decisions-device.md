---
name: crusaders-mainframe-decisions-device
description: "The device contract is hobby-grade by founder decision — one per-tenant API key, auto-registration, no OTA or discovery; the brains are on the ESP8266 because the Mega cannot be flashed over WiFi; the wiring is fixed and untouchable."
type: decision
last_verified: 2026-09-11
---

# Live decisions — the device contract and firmware

**The physical wiring is fixed and is not ours to change.** Three adversarial passes were run under
that constraint and produced zero electrical findings; the pin map matches the schematic and the
club's old working sketches exactly. Any fix that needs a wire moved is the wrong fix.

- **The device contract is hobby grade** (founder, 2026-09-05/06). No OTA, no image signing, no
  runtime credential store, no HMAC device auth, no discovery, no claim codes, no per-device keys,
  no device clock. One per-tenant API key in `secrets.h`; a box auto-registers on its first
  heartbeat. *Why:* the box and the backend share a LAN and only the frontend is public — this is
  one club with one box, and the security machinery was defending a threat model that does not
  exist here while being the largest single source of firmware complexity and flashing ceremony.
  Everything it removed had been built and tested; deleting working code was the point, not a loss.
  **`lib/devcrypto` survives as a hex codec only** (`src/Hex.cpp`, `include/devcrypto/Hex.h`,
  confirmed 2026-09-16) — the library name is residual, so a grep for "crypto" here finds a hit that
  means nothing. Rename it if you are in that tree anyway; do not read it as surviving device auth.
- **Flashing is the Arduino IDE**, from the generated sketches in `src/iot/arduino/`; PlatformIO
  stays the tested build and `court_mega` compiles byte-identical between the two. *Why:* the
  founder flashes these boards, and a Makefile target is not how that happens at a squash club.
  The C++11 consequence of that route is a build trap — [`gotchas-build.md`](gotchas-build.md).
- **The brains live on the ESP8266.** The ATmega2560 cannot be flashed over WiFi — its ESP sits on
  Serial3, not the Serial0 bootloader port, and no GPIO reaches RESET — so the Mega is a thin I/O
  layer with an **independent per-relay auto-off timer** and everything volatile runs on the ESP.
  *Why:* it makes USB-only flashing of the Mega a non-event instead of a recurring trip to the club,
  and the independent timer is the fail-safe: existing sessions run to completion and nothing
  strands a lit court when the network goes away. The physical buttons are the manual override.
- **The LCD is driven as 16×2** although the fitted panel is a 20×4 (2004A, confirmed from a build
  photo). Safety over screen real estate; the geometry is a compile-time constant.
- **The legacy single-byte serial dialect is refused on the production Mega** (`LegacyDialect::
  Refuse`; the simulator opts in). The bare `A` was the one message that closed a relay with no
  checksum, on a UART that receives the ESP's 74880-baud boot banner at every ESP reset — a phantom
  ninety-minute lighting with no booking behind it. The codec keeps the dialect for the bench.
- **`!AUTH` arms only on a recognised scan, and a grant binds the window to the court it lit.**
  Arming on every scan let any barcode open thirty seconds of buttons — with a mapped OFF button a
  stranger could dark a league match — while disarming on every grant locked the paying member out
  of their own OFF.
- **The Mega runs a 2 s watchdog and a `Wire` bus timeout.** A wedged I2C bus under the LCD froze
  `loop()` and with it the independent auto-off, leaving a court lit until someone pulled power. A
  stall now ends in a reset that re-runs `setup()` and opens every relay first. Whether the club's
  bootloader survives a watchdog reset is a bench check on the go-live list.
- **Buttons are remappable from the admin panel**, as a **per-device override with the club map as
  default**, validated against that box's own court count. *Why per-device:* one tenant-wide map
  validated against every box made a fleet with mixed court counts unconfigurable. Free either way,
  because the Mega already reports raw keypresses and lets the brain decide.
- **Every URL a box is handed is gateway-true**, rebuilt from `X-Forwarded-*` and trusted only from
  `Gateway:TrustedProxies`; an `https` advertised base URL **refuses to start**. The box fetches
  with a plain `WiFiClient` and has no heap for TLS, so an https base hands every box a URL it can
  never open, and a box behind a non-default port otherwise loops on unreachable addresses.
- **Authentication runs before the rate limiter**, and the auth policy partitions per member. The
  Court Code page refreshes on a timer for every member who has it open, so behind the gateway the
  whole club shared one bucket keyed on the proxy address — ten opens in a minute took down login,
  PIN and board provisioning club-wide.
- **Gates are no longer parked** (2026-09-19) — one ESP32 per door, built on this contract
  unchanged. Their own decisions are in [`decisions-gate.md`](decisions-gate.md).
