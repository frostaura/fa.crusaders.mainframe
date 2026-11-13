---
name: crusaders-mainframe-decisions-door-gate-v3
description: "Gate 2.0.0 (2026-11-13), the last cable flash: what survives a reset and where, signed OTA with probation, key ring, runtime network and portal, the v3 readers, and why each choice was made."
type: decision
last_verified: 2026-11-13
---

# Decisions — gate 2.0.0, how the door implements contract v3

The contract and its why are [`decisions-device-v3.md`](decisions-device-v3.md) and the two
addendum topics; the spec is `docs/specs/door-gate.md` §14. These are the door's own choices.

- **The gate keeps its own canonical images** (roster entries, code days/keys, step sync) and
  builds the shared `Roster`/`KeyRing` from them. *Why:* the shared classes keep their contents
  private and are the court-box lane's; the door must still put them in RTC memory and flash.
- **Warm state is a sealed image (magic, length, CRC-32) in raw `RTC_NOINIT` bytes**, dated by
  `esp_rtc_get_time_us()`; every age is re-anchored on boot. *Why raw bytes:* an object there
  would be constructed — zeroed — on every boot. A power-on is always cold.
- **Cold state is NVS, written only on a content change.** An aged roster re-sent is not new
  content (each window moved by the elapsed time, 2 s slack); only its age is checkpointed, every
  10 min. *Why:* the roster's seconds change every beat, and writing it every beat wears a 20 KB
  NVS out inside a year. A power-on reads windows as of the last checkpoint and trusts them for
  `power_restore_trust_minutes`; the step clock is never cold-restored (member codes wait for a
  beat), so the code keys are not written to flash at all.
- **Undelivered events are persisted with their own boot id and seq and re-uploaded first.**
  *Why:* the server deduplicates on (device, boot_id, seq), so a re-upload of one whose receipt
  was lost is a no-op; re-queuing under the new boot would duplicate it and misdate it.
- **Records are written at the top of a pass, never inside a decision**, and no record buffer is
  a stack local. *Why:* the first stack measurement (stackan.py, windowed ABI, from `loopTask`)
  read 8464 B against an 8 KB task — two `= Record()` temporaries. Now 4576 B, worst path
  heartbeat → OTA offer → RSA verify, inside the contract's 6000.
- **The release signature is checked before a byte is downloaded**, and again over what arrived.
  *Why:* an unsigned offer costs nothing and an unsigned 900 KB download costs a minute of a busy
  door's loop. A cut or refused download is retried after 10 min and never failed-listed; a hash or
  signature mismatch is failed-listed for good.
- **Probation is the firmware's own** (NVS record: boots counted from `setup()`, rollback on the
  fourth or when the window passes, the other slot reselected). Arduino's default marks the app
  valid at boot. *Why:* the bootloader's own rollback would roll back on the FIRST crash; the
  contract says three. Whether the prebuilt bootloader has rollback at all is a bench check.
- **A 401 is retried once with the other key, and the key that worked is tried first after.**
  *Why:* a 401 is as likely a server restored from an old backup as a retired key; never erasing
  and remembering the working key costs one extra call once, not on every request.
- **A base URL that never earned an accepted beat is abandoned and its version never re-adopted.**
  *Why:* the server re-sends `net` while the board's `net_ver` is lower; re-adopting the typo each
  time the old URL reached the server would be a ten-minute outage on a loop.
- **The setup form is validated by writing it as the JSON a server `net` would be and reading it
  with `devnet::adoptNet`.** *Why:* one rule set; a value the portal accepts is one the server
  would have sent, and the page names the same refusal reasons the console does.
- **The scanner's idle gap is 150 ms and only ends a line on a pass that found the UART empty**;
  a gap-ended line needs 8+ characters. *Why:* a gap measured across a 4-second call would cut a
  member's scan in two; 8 is the Mega's own rule, so both devices treat suffix-less scanners alike.
- **The gate's hardware facts stay compiled** (§14.6): an OTA image corrects any of them.
- **MCV1-10's wire form is the gate's proposal, not yet a corpus vector:** a replay refusal's event
  carries `"reason":"replayed","online":<bool>` after `duration_ms`. The server ignores unknown
  event fields today; the contract and backend lanes own pinning and rendering it.
- **The simulator has no OTA slot and no portal** (a process cannot replace its own image or open
  an access point); both are proven against the same `GateApp` in `test_gate_v3` with simulated
  power cuts, warm resets and OTA reboots. It gained `--warm`, file-backed records and exit 75 on
  a restart request.
