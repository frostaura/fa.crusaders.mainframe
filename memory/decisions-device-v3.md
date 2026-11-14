---
name: crusaders-mainframe-decisions-device-v3
description: "Device contract v3 (2026-11-13): OTA and the setup hotspot removed 2026-11-14, so every change is a cable flash with four secrets; the Mega a steered renderer and relay guard, an ON-only snapshot reconcile, key rotation."
type: decision
last_verified: 2026-11-13
---

# Decisions — device contract v3 (2026-11-13; OTA and hotspot removed 2026-11-14)

Founder decisions taken by the orchestrator under Dean's "fix any and all" go-ahead, after the
2026-11-13 pre-go-live analysis. Specs: `docs/specs/device-api.md`, `device-serial-protocol.md`
(v3), `door-gate.md` §14; corpus `provision/`, `display/`, `compat/`. Mega 3.0.0, bridge 3.1.0,
gate 2.0.0, built by four lanes (backend-device, court-box, door-gate, frontend-admin).

- **No remote firmware update: every firmware change, to any chip, is a cable flash** (founder,
  2026-11-14: *"I don't want OTA. That's a complexity we don't need right now."*). *Why, as he gave
  it:* complexity not needed yet. What that complexity was, measured at removal: two chip-specific
  update paths, a release key to keep, rollback and probation proven on the host and never on a chip,
  and ~4,000 deleted lines in the court box alone (`f4a9b20b`). Removed whole, not switched off: no
  `ota` in any answer, no download route, no firmware table, no console panel, no signer;
  `DeviceContractV3` was edited in place because it is unreleased. Kept: key rotation, the
  server's `net`, flash persistence and the lifeline. **It reverses the old "the next USB flash
  is the last" rule:** the planned flash is now the last *planned* visit, never the last possible
  one (`device-api.md` §1, §7). Restorable from `99e9c5ee`.
- **No setup hotspot: a flash takes exactly `WIFI_SSID`, `WIFI_PASSWORD`, `API_BASE_URL`,
  `DEVICE_API_KEY`** (founder, 2026-11-14: *"we don't need a hotspot. We just need the cable to
  flash, just like before"*; `899e4388`). *Why:* the flashing contract stays as it was; the portal
  was the only reason for a fifth value. Gone: both portals, `!HELD` (29 verbs), `SETUP_AP_PASSWORD`,
  `local` adoption. Dead residue: console/backend still handle `net_src: "local"`.
- **The Mega is flashed to 3.0.0 too, and v3 makes cable flashes rare.** *Why:* the analysis found
  the stuck-screen, lost-`!ON` and Mega-reset defects live on the Mega, so leaving it at 2.x would
  freeze them in. Everything the bridge may ever need from it is a v3 frame or a bounded `!CFG`
  key; no frame from any bridge can stop it returning to landing or opening a relay on time.
- *Superseded 2026-11-14 —* **signed HTTP OTA on both ESPs.** Its design, for a restore: RSA-2048
  over a manifest binding target, version, size and SHA-256 (RSA for one portable verify on both
  chips and the host; the manifest signed so an old image can never pass as new).
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
  2.3.0, and it can return with a bridge cable flash alone.
- **Deferred, not rejected:** a remote "switch a court off" (a server change and a bridge cable
  flash; the Mega obeys `!OFF`).
- **The same day's addendum** made the frozen firmware forward-compatible for its whole life, moved
  every compiled hardware fact to a setting, and made every board report its own health:
  `decisions-device-v3-compat.md`, `decisions-device-v3-hardware.md`, and for the member code
  `decisions-member-code-cutover.md`.
