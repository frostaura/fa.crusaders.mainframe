---
name: crusaders-mainframe-decisions-door-gate
description: "One pull-only ESP32 per door, one image for every door; only a 200 is an answer and a 200 refusal is never second-guessed; the lock is asserted LOCKED before its pin is an output; it is wired fail-secure where the owner asked for fail-safe."
type: decision
last_verified: 2026-09-19
---

# Live decisions — the door gate

The court box's contract, the shared-library rule and the wiring-is-fixed rule all apply
unchanged: [`decisions-device.md`](decisions-device.md). What follows is the gate's own.

- **The door gate is built** (2026-09-19), as `src/iot/door-gate`: one ESP32 per door, QR scanner
  on `Serial2`, one relay on the lock, one LED. Pull-only like the court box — no listening socket,
  no static IP, no `WiFi.config()`; Carl's sketch had all three and its `/open` endpoint unlocked
  the door for anyone on the club WiFi. **One image for every door**: nothing per-gate is compiled
  in, a door is named in the admin console (`gate_key`) and the board learns its name from the
  heartbeat, so a spare board is a spare board.
- **The gate reads the API differently from the court bridge, deliberately.** `devapi::react()`'s
  `Rejected` class means "a 4xx this box caused — drop it", which is right for an event upload and
  wrong for a door, so `gatelogic::onGateResponse` does not use it. **Only a 200 is an answer**; a
  200 `opened:false` is authoritative and is NEVER second-guessed against the roster; everything
  else — 0, 401, 403, 404, 429, any 5xx, and a 200 whose body cannot be parsed — falls back to the
  roster. *Why:* both directions have a victim. Second-guessing a refusal admits the member barred
  this morning through a booking nobody cancelled; refusing on an outage leaves a member with a
  valid booking outside because a container was restarting.
- **A door is released for `gate.unlock_seconds`, never for what is left of the booking.** The
  roster's `grantMs` is 25 minutes for a late arrival, and a door held open for 25 minutes is not a
  door. The gate's offline degraded mode is also narrower than the court box's *by contract*: only a
  member with a rostered booking gets in, because a walk-up member's 60-second code can never be in
  a roster.
- **The lock's two polarity flags are independent and are composed in one function.**
  `GATE_RELAY_ACTIVE_HIGH` is about the relay MODULE; `GATE_UNLOCK_ENERGISES_RELAY` is about the
  LOCK's wiring (NO vs NC contact). Only the composition says anything about the door, and it is
  written once in `gatelogic::lockPinLevel` with all four combinations tested. **The locked level is
  written into the pin's output register BEFORE `pinMode(OUTPUT)`** — a GPIO leaves reset as an
  input and starts driving whatever is already latched, so the sketch's `pinMode`-first ordering is
  a door that clicks open on every reset. `IPinOut` is two calls precisely so a fake can prove the
  order; mutation-proved.
- **OPEN, and the owner's to settle: the door is wired fail-SECURE and the owner asked for
  fail-safe.** "Released when there is no power" needs a fail-safe lock through the relay's NC
  contact with `GATE_UNLOCK_ENERGISES_RELAY=0`; Carl's board is wired the other way, which is the
  firmware default because it is what is on the wall. Firmware cannot create the property — it is
  the lock and the supply. Flipping the flag alone on hardware wired the other way inverts the
  firmware's whole idea of the door. Recorded as a go-live item (§12) and in
  `src/iot/door-gate/README.md`'s truth table. **Fire egress must be mechanical and independent of
  this board; nothing here is a life-safety device.**
- **The gate ships firmware 1.0.0 while `[common]` pins 2.0.0.** `[common]` and `[strict_host]` are
  kept byte-identical across all three projects on purpose — the shared libraries are compiled by
  all of them — so `[env:door_gate]` `build_unflags` the three `FW_VERSION_*` defines and sets its
  own. The divergence sits in the board environment, where a firmware version belongs, and
  `main.cpp` `static_assert`s the major number that survives so a silently ineffective unflag is a
  compile error rather than a board reporting somebody else's version.
