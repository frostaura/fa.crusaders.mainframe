---
name: crusaders-mainframe-decisions-door-gate-v3
description: "Gate 2.0.0 (2026-11-13), flashed by cable with four secrets (OTA and setup portal removed 2026-11-14): what survives a reset and where, key ring, server-pushed network, the v3 readers, and why."
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
  read 8464 B against an 8 KB task — two `= Record()` temporaries. Then 4576 B, worst path
  heartbeat → OTA offer → RSA verify, inside the contract's 6000; that path left with OTA and the
  new worst path has not been re-measured (`stack_budget.json` still quotes 4,576).
- *Superseded 2026-11-14 — signed OTA removed* (`31cc8113`: GateOta, the slot and download
  drivers, probation and its LED pattern, the OTA record, `ota:1`). Its two choices, for a restore:
  the signature was checked before a byte was downloaded, and probation was the firmware's own
  because the bootloader's rollback fires on the FIRST crash. RAM 110,412 → 104,588 B.
- **A 401 is retried once with the other key, and the key that worked is tried first after.**
  *Why:* a 401 is as likely a server restored from an old backup as a retired key; never erasing
  and remembering the working key costs one extra call once, not on every request.
- **A base URL that never earned an accepted beat is abandoned and its version never re-adopted.**
  *Why:* the server re-sends `net` while the board's `net_ver` is lower; re-adopting the typo each
  time the old URL reached the server would be a ten-minute outage on a loop.
- *Superseded 2026-11-14 — the BOOT-button setup portal* (`899e4388`: the WebServer portal, the
  setup LED pattern, `local` adoption; RAM 104,588 → 100,776 B). Why in `decisions-device-v3.md`.
- **The scanner's idle gap is 150 ms and only ends a line on a pass that found the UART empty**;
  a gap-ended line needs 8+ characters. *Why:* a gap measured across a 4-second call would cut a
  member's scan in two; 8 is the Mega's own rule, so both devices treat suffix-less scanners alike.
- **The gate's hardware facts stay compiled** (§14.6): a cable flash corrects any of them.
- **MCV1-10's wire form is the gate's proposal, not yet a corpus vector:** a replay refusal's event
  carries `"reason":"replayed","online":<bool>` after `duration_ms`. The server ignores unknown
  event fields today; the contract and backend lanes own pinning and rendering it.
- **The simulator runs the same `GateApp`** as `test_gate_v3`, with simulated power cuts and warm
  resets; it gained `--warm`, file-backed records and exit 75 on a restart request.
