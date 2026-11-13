---
name: crusaders-mainframe-decisions-court-box-v3-firmware
description: "Court box 3.0.0 as built (2026-11-13): what the last Mega image and bridge phase A implement, the soak's four invariants, and what the bridge still owes (OTA lifeline, flash records, pay-for code)."
type: decision
last_verified: 2026-11-13
---

# Decisions — court box firmware 3.0.0, as built (2026-11-13)

Branch `fix/court-box`. Contract: `decisions-device-v3*.md`; this is what the code does.

- **Mega 3.0.0 is the whole of device-serial-protocol.md v3.** Tags/`!ACK`, `!WANT`, the cap,
  `!RW`/`!CMT`, ceiling/dwell/AFTON/chain, landing + marquee composed on the Mega, self-healing
  glass, liveness, `!CFG` incl. RPOL/LCDA/SBAUD/SSUF/SGAP/KEYS, `!HW`, `!DIAG`, `!HELD`. *Why:* the
  last Mega image — anything missing is missing for the life of the box.
- **The Mega drives the PCF8574 itself; LiquidCrystal_I2C is gone.** *Why:* the library fixes
  the address at construction and hides its nibble writer; the probe (HW-2) and periodic re-init
  need both. 400 kHz, falls back to 100 kHz on a NACK/error (PCF8574 is rated 100 kHz).
- **Released relays are inputs** (`hal::relayDriveFor`). *Why:* off for either module, so a wrong
  RPOL fails dark (HW-1); the simulator prints `(pin input)`.
- **A 256-byte Mega uplink queue, two link drains a pass, an 8 ms paint budget.** Static RAM
  3999/8192. *Why:* DL-01/DL-02 lost frames at the 64-byte rings.
- **Host suites and the simulator report 3.0.0** (`[court_version]` in platformio.ini). *Why:* a
  host build calling itself 2.0.0 made the bridge's dialect selection speak v2 to the real Mega.
- **Bridge phase A only.** MegaTx (paced, tagged, acked, one screen in flight), the snapshot
  reconcile on every beat/boot/contradiction, the v3 heartbeat (caps codes:m1, hb:3, lcd:2 —
  **not** ota/key/net), no identity overlays, release `cause`, one 512-byte reply buffer. Static
  RAM 57088/81920 (24832 for heap, the §13 floor is 24576).
- **The Reconciler never gives up on owed light.** After three failed `!WANT`s it reports
  `relight_failed` once and keeps trying at the 60 s pace; a relay that went dark under an owed
  snapshot is re-lit at once. *Why:* the soak found both (a garbled `!BOOT` left a paid court dark).
- **test_soak is the acceptance gate:** 1,000 sequences × 4 simulated minutes, I1 landing ≤ 62 s
  after the last input, I2 owed courts lit 5 s after a Mega reset, I3 no relay past end of play, I4
  every scan on the Mega's TX line in 200 ms. Mutation-checked. `SOAK_SEED`/`SOAK_TRACE` reproduce.

## What the bridge still owes (not in this image)

- **Phase B — the lifeline**: signed OTA, `key_next`, `net`, the setup portal on `!HELD,09`, the
  link supervisor, HW-8. *Why deferred:* the brief sequences it after the integrator merges the
  door-gate lane's `devota`/`devnet`. **Until it ships, the bridge is not updatable over the air.**
- **LittleFS records** for snapshot, roster, code sync and undelivered events (BR-06, BR-07,
  FSF-09): a power cut with the server down restores nothing and loses queued attendance.
- **D10 pay-for code** still compiled (BR-17): unreachable from the panel since 2.3.0.
- `test_compat` (41 court_box + 19 scan cases), `test_server_replies`, `stack_budget.py`, the
  `ota_sign.py` tool.
