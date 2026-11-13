---
name: crusaders-mainframe-decisions-device-v3
description: "Device contract v3 (2026-11-13): the last USB flash, signed OTA on both ESPs, the Mega as a steered renderer and relay guard, a continuous ON-only snapshot reconcile, runtime layout, key rotation with grace."
type: decision
last_verified: 2026-11-13
---

# Decisions — device contract v3, the last flash (2026-11-13)

Founder decisions taken by the orchestrator under Dean's "fix any and all" go-ahead, after the
2026-11-13 pre-go-live analysis. Specs: `docs/specs/device-api.md`, `device-serial-protocol.md`
(v3 chapter), `door-gate.md` §14; corpus families `ota/`, `provision/`, `display/`. Versions: Mega
3.0.0, bridge 3.0.0, door gate 2.0.0. Implemented by four parallel lanes (backend-device,
court-box firmware, door-gate firmware, frontend-admin).

- **The next USB flash is the last; the Mega is flashed too.** *Why:* the analysis found the
  stuck-screen, lost-`!ON` and Mega-reset defects live on the Mega, so leaving it at 2.x would
  freeze them in. Everything the bridge may ever need from it is a v3 frame or a bounded `!CFG`
  key; no frame from any bridge can stop it returning to landing or opening a relay on time.
- **Signed HTTP OTA on the ESP8266 bridge and the ESP32 gate**: RSA-2048 PKCS#1 v1.5 over a
  manifest binding target, version, size and SHA-256; strictly-newer versions only; path-only
  offers pulled from the board's own server; commit after verification; probation then rollback
  (ESP32: the other slot; ESP8266: a copy in LittleFS). *Why RSA, not ECDSA:* one portable verify
  (a modexp) runs identically on both chips and the host test runner, with no BearSSL/mbedTLS
  split to test twice. *Why the manifest is signed, not the image:* it puts the version and target
  inside the signature, so an old signed image can never pass as new. Private key: founder only.
- **The backend's snapshot (`courts`) is complete and sent every beat; the box re-lights from it,
  continuously, and never switches anything off on the server's word.** *Why ON-only:* a dropped or
  cut response must never darken a mid-game court; lights wrongly on are bounded by the relay's
  own deadline and the new authorisation cap. The one exception is the box's own provisional
  power-restore light, which it lit on stale evidence and cancels itself.
- **The snapshot is chain-aware and release-cause-aware**: seconds left run to the end of the
  chained run, and only a member's own OFF takes a booking out of it. *Why:* v2 lost paid
  extensions after a power dip and treated a Mega reset as the member leaving.
- **No relay state in the Mega's EEPROM.** *Why:* the bridge re-applies its persisted snapshot
  within seconds of `!BOOT`; a second copy would be a second truth that wears out.
- **Layout is a setting** (club default + per-board override), compact on any doubt; the landing
  CTA is `SCAN YOUR QR CODE` (expanded) and `SCAN YOUR QR` (compact). *Why the short form:* 17
  characters do not fit 16 and a scrolling call to action cannot be read at a glance.
- **Key rotation keeps every unretired key valid**; retirement never strands a board without
  `key:1` automatically; a known key can be restored after a database loss. *Why:* one Regenerate
  click used to mean reflashing every board.
- **D10 pay-for leaves the court-box image**; the server endpoint stays. *Why:* unreachable since
  2.3.0, and it can return by bridge OTA alone.
- **Deferred, not rejected:** a remote "switch a court off" (needs only a server change and a bridge
  OTA, since the Mega obeys `!OFF`); a configuration QR at the door (the portal covers it).
