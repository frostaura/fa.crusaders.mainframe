---
name: crusaders-mainframe-decisions-device
description: "The device contract: one per-tenant API key, auto-registration, no discovery; the brains are on the ESP8266; the wiring is fixed. Runtime credentials arrived with v3; OTA came with it and left again (2026-11-14)."
type: decision
last_verified: 2026-10-03
---

# Live decisions — the device contract and firmware

**The physical wiring is fixed and is not ours to change.** Three adversarial passes produced zero
electrical findings; the pin map matches the schematic and the club's old sketches exactly. Any fix
that needs a wire moved is the wrong fix.

- **The device contract is hobby grade** (founder, 2026-09-05/06): no HMAC device auth, discovery,
  claim codes, per-device keys or device clock — one per-tenant bearer key, and a box auto-registers
  on its first heartbeat. *Why:* box and backend share a LAN and only the frontend is public, and
  that machinery defended a threat model that does not exist here. Requests are still unsigned.
  **Its "no runtime credential store" clause was reversed on 2026-11-13** (key rotation, runtime
  WiFi/server — `decisions-device-v3.md`): a box sealed at the court makes every reflash a visit.
  **Its "no OTA" clause stands:** v3 reversed it, the founder restored it on 2026-11-14. **`devcrypto` regained
  SHA-256, HMAC, HKDF and base64url on 2026-09-23** for one narrower job — verifying the member
  code's OFF half offline ([`decisions-member-code.md`](decisions-member-code.md)) — not for
  device auth (still one bearer key).
- **The firmware tree is one PlatformIO project per device plus `shared/`** (2026-09-19; the rule
  for what goes in `shared/lib` is CLAUDE.md's). *Why:* a second device needs all of it; the
  alternatives were a copy that drifts or a package versioned for two consumers of one repo.
- **Flashing is the Arduino IDE**, from the generated sketches in `src/iot/court-box/arduino/`;
  PlatformIO stays the tested build and `court_mega` compiles byte-identical between the two. *Why:*
  the founder flashes these boards, and a Makefile target is not how that happens at a squash club.
  The C++11 consequence is a build trap — [`gotchas-build.md`](gotchas-build.md).
- **The brains live on the ESP8266.** The ATmega2560 cannot be flashed over WiFi — its ESP sits on
  Serial3, not the Serial0 bootloader port, and no GPIO reaches RESET — so the Mega is a thin I/O
  layer with an **independent per-relay auto-off timer** and everything volatile runs on the ESP.
  *Why:* the Mega image stays frozen while the bridge carries what the server steers (since
  2026-11-14 neither chip updates over the air, so a bridge change is a cable flash too), and the
  independent timer is the fail-safe — nothing strands a lit court when the network goes away.
- **The LCD layout is a runtime setting from Mega 3.0.0** (`decisions-device-v3.md`). *Why:* the
  fitted panel is unknown (a "2004A" in a build photo, "a 16x2" in code comments). Look at it.
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
- **Buttons are remappable** as a **per-device override of the club map**, validated against that
  box's own court count — one map validated against every box made mixed fleets unconfigurable.
- **Every URL a box is handed is gateway-true**, rebuilt from `X-Forwarded-*` and trusted only from
  `Gateway:TrustedProxies`; an `https` advertised base URL **refuses to start**. The box fetches with
  a plain `WiFiClient` and has no heap for TLS, so an https base hands it a URL it can never open.
- **Authentication runs before the rate limiter**, and the policy partitions per member — behind the
  gateway the whole club shared one bucket keyed on the proxy address. The device scheme is not the
  default one, so device calls are keyed per BOARD by their own middleware (`decisions-backend-r17a.md`).
- **Gates** (2026-09-19): one ESP32 per door on this contract unchanged — [`decisions-door-gate.md`](decisions-door-gate.md), [`decisions-gate.md`](decisions-gate.md).
