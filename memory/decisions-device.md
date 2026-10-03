---
name: crusaders-mainframe-decisions-device
description: "The device contract is hobby-grade by founder decision — one per-tenant API key, auto-registration, no OTA or discovery; the brains are on the ESP8266 because the Mega cannot be flashed over WiFi; the wiring is fixed and untouchable."
type: decision
last_verified: 2026-10-03
---

# Live decisions — the device contract and firmware

**The physical wiring is fixed and is not ours to change.** Three adversarial passes produced zero
electrical findings; the pin map matches the schematic and the club's old sketches exactly. Any fix
that needs a wire moved is the wrong fix.

- **The device contract is hobby grade** (founder, 2026-09-05/06). No OTA, signing, runtime
  credential store, HMAC device auth, discovery, claim codes, per-device keys or device clock: one
  per-tenant API key in `secrets.h`, and a box auto-registers on its first heartbeat. *Why:* box and
  backend share a LAN and only the frontend is public — one club, one box, and that machinery
  defended a threat model that does not exist here while being the largest single source of
  firmware complexity and flashing ceremony. Requests are still unsigned. **`devcrypto` regained
  SHA-256, HMAC, HKDF and base64url on 2026-09-23** for one narrower job — verifying the member
  code's OFF half offline ([`decisions-member-code.md`](decisions-member-code.md)) — not for
  device auth, which stays one bearer key.
- **The firmware tree is one PlatformIO project per device plus `shared/`** (2026-09-19).
  `timebase hal hal_fakes devcrypto fwversion devapi eventq roster` and the new `devlink` (heartbeat
  body + adopted interval, event-upload body, roster push, API breaker — lifted out of
  `bridgelogic`) live in `src/iot/shared/lib`, reached with `lib_extra_dirs = ../shared/lib`. *Why:*
  a second device needs all of it; the alternatives were a copy that drifts or a package versioned
  for two consumers of one repo. **A module belongs in `shared/` only if a second, unrelated device
  would want it UNCHANGED** — "could be shared" admits everything. Where a shared and a device
  constant must agree the assert lives on the device side, in
  `court-box/lib/bridgelogic/RosterTokenFits.h`.
- **Flashing is the Arduino IDE**, from the generated sketches in `src/iot/court-box/arduino/`;
  PlatformIO stays the tested build and `court_mega` compiles byte-identical between the two. *Why:*
  the founder flashes these boards, and a Makefile target is not how that happens at a squash club.
  The C++11 consequence is a build trap — [`gotchas-build.md`](gotchas-build.md).
- **The brains live on the ESP8266.** The ATmega2560 cannot be flashed over WiFi — its ESP sits on
  Serial3, not the Serial0 bootloader port, and no GPIO reaches RESET — so the Mega is a thin I/O
  layer with an **independent per-relay auto-off timer** and everything volatile runs on the ESP.
  *Why:* USB-only flashing of the Mega becomes a non-event rather than a trip to the club, and the
  independent timer is the fail-safe — nothing strands a lit court when the network goes away.
- **The LCD is driven as 20×4** — the fitted 2004A (confirmed from a build photo) — with rows 0–1
  holding the 16-column safe subset, so a 1602 swapped in degrades to a whole message rather than a
  lying one. The geometry is a compile-time constant (`[lcd]` in `court-box/platformio.ini`); the
  shared HAL's default, used by builds with no LCD flags, is still 16×2. Somebody must look at the
  panel before a club box is flashed (go-live checklist). R10 D10-2 corrected the "driven as 16×2"
  drift here and in two comments.
- **The legacy single-byte serial dialect is refused on the production Mega** (`LegacyDialect::
  Refuse`; the simulator opts in). The bare `A` closed a relay with no checksum on a UART that
  receives the ESP's 74880-baud boot banner at every reset — a phantom ninety-minute lighting with
  no booking behind it.
- **`!AUTH` arms only on a recognised scan, and a grant binds the window to the court it lit.**
  Arming on every scan let any barcode open thirty seconds of buttons — with a mapped OFF button a
  stranger could dark a league match — while disarming on every grant locked the paying member out
  of their own OFF button.
- **The Mega runs a 2 s watchdog and a `Wire` bus timeout.** A wedged I2C bus under the LCD froze
  `loop()` and with it the independent auto-off, leaving a court lit until someone pulled power; a
  stall now ends in a reset that opens every relay first. Whether the club's bootloader survives a
  watchdog reset is a bench check on the go-live list.
- **Buttons are remappable from the admin panel**, as a **per-device override with the club map as
  default**, validated against that box's own court count — one tenant-wide map validated against
  every box made a fleet with mixed court counts unconfigurable.
- **Every URL a box is handed is gateway-true**, rebuilt from `X-Forwarded-*` and trusted only from
  `Gateway:TrustedProxies`; an `https` advertised base URL **refuses to start**. The box fetches with
  a plain `WiFiClient` and has no heap for TLS, so an https base hands it a URL it can never open.
- **Authentication runs before the rate limiter**, and the policy partitions per member. The Court
  Code page refreshes on a timer for everyone who has it open, so behind the gateway the whole club
  shared one bucket keyed on the proxy address — ten opens a minute took login club-wide.
- **Gates are no longer parked** (2026-09-19) — one ESP32 per door, built on this contract
  unchanged. Firmware decisions: [`decisions-door-gate.md`](decisions-door-gate.md); API and access
  rules: [`decisions-gate.md`](decisions-gate.md).
