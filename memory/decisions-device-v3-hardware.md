---
name: crusaders-mainframe-decisions-device-v3-hardware
description: "Mega 3.0.0 (2026-11-13): relays released as inputs so a wrong drive level fails dark; relay level, LCD address, scanner baud and line end, court keys become per-board settings reported back by !HW."
type: decision
last_verified: 2026-11-13
---

# Decisions — hardware facts at runtime on the last Mega image (2026-11-13)

Taken by the orchestrator under Dean's go-ahead after the HW-1…HW-11 gap report. Spec:
`docs/specs/device-serial-protocol.md` (*Hardware facts*), `device-api.md` §12, the commissioning
procedure in `lights-controller.md`.

- **A relay is released by making its pin an input; only "on" is driven, at a settable level.**
  *Why:* the only evidence for active-high is one sentence ("the club fitted normally-open SSRs"),
  and "normally open" describes the output, not the trigger — SSR boards ship in both. High-Z is off
  for both module types, so a wrong level now fails DARK; 2.1.0 with a wrong level lit every court
  whenever it meant off, with no recovery but a reflash. Prototyped in the analysis at +2 B RAM,
  +136 B flash.
- **The level is RAM on the Mega, re-sent by the bridge before any relay frame after every `!BOOT`,
  and changeable at any time** (closed relays re-driven at the new level). *Why:* a wrong level is
  dark, so changing it can only light a court that is meant to be lit; no EEPROM copy is needed,
  matching the v3 rule that the Mega persists no state.
- **No pull-down on the SSR inputs.** *Why:* the 2.1.0 notes asked an installer to fit one, which
  the immutable-wiring rule forbids, and an input release makes it unnecessary.
- **The LCD backpack is probed (0x27, 0x3F, then 0x20–0x26, 0x38–0x3E) and NACKs are counted.**
  *Why:* HW-61 boards carry either a PCF8574T (0x27) or a PCF8574AT (0x3F); a wrong address NACKs
  fast, which is not a timeout, so 2.1.0 left the glass blank and reported nothing.
- **The scanner's baud is auto-detected while idle and a line also ends at an idle gap.** *Why:*
  9600 and the CR/LF suffix are assumptions from an old sketch; a suffix-less scanner never
  completed a scan. The Mega never writes to the scanner, so it cannot configure one.
- **Which keys are court keys is a `KEYS` mask the bridge derives from `button_map`.** *Why:* 2.1.0
  hard-coded pins 30–36 as duration keys for unarmed presses, outside the backend's remap.
- **The gate's hardware facts stay compiled.** *Why:* the gate has no frozen half — an OTA image
  corrects them — so a setting would be code with no case to serve.
- **Still physical, still owed by a person:** the relay module's part number, trigger level, rating
  and output type, and whether it switches a contactor coil or the load (`safety-relays.md`); the
  button order; the panel's geometry; the bootloader surviving a watchdog reset (FWM-11).
- **HW-9 correction:** the hazard was never "a mismatched pair". Polarity lives only in the Mega
  image: a Mega still on 2.0.0 lights every court it means to switch off on these SSRs whatever the
  bridge runs, and nothing reported which Mega image was on the box until `mega_version` reached
  the heartbeat in v3.
