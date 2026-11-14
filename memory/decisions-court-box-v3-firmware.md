---
name: crusaders-mainframe-decisions-court-box-v3-firmware
description: "Court box 3.0.0 as built (2026-11-13): what the Mega image and bridge phase A implement, the soak's four invariants, and taps sampled inside the LCD paint (2026-11-14); bridge 3.1.0 carries phase B."
type: decision
last_verified: 2026-11-14
---

# Decisions — court box firmware 3.0.0, as built (2026-11-13)

Branch `fix/court-box`. Contract: `decisions-device-v3*.md`; this is what the code does.

- **Mega 3.0.0 is the whole of device-serial-protocol.md v3.** Tags/`!ACK`, `!WANT`, the cap,
  `!RW`/`!CMT`, ceiling/dwell/AFTON/chain, landing + marquee composed on the Mega, self-healing
  glass, liveness, `!CFG` incl. RPOL/LCDA/SBAUD/SSUF/SGAP/KEYS, `!HW`, `!DIAG` (`!HELD` left with the hotspot,
  `899e4388`; 29 verbs). *Why:* meant to be the last Mega image — anything missing costs a cable flash of the Mega to add.
- **The Mega drives the PCF8574 itself; LiquidCrystal_I2C is gone.** *Why:* the library fixes
  the address at construction and hides its nibble writer; the probe (HW-2) and periodic re-init
  need both. 400 kHz, falls back to 100 kHz on a NACK/error (PCF8574 is rated 100 kHz).
- **Released relays are inputs** (`hal::relayDriveFor`). *Why:* off for either module, so a wrong
  RPOL fails dark (HW-1); the simulator prints `(pin input)`.
- **A 256-byte Mega uplink queue, two link drains a pass, an 8 ms paint budget.** *Why:* DL-01/DL-02
  lost frames at the 64-byte rings. Static RAM 3,977/8,192 B, measured at `79a2fe54`.
- **Buttons are sampled inside the LCD paint** (DL-15, `a248a0c0`): the driver calls an idle
  hook between bus transactions and through every wait, pointed at `ButtonPanel::sample`, which
  latches completed presses for `poll()`; the debounce rule is unchanged. *Why:* one sample per
  pass let a re-init (~10.9 ms) or an 8 ms paint swallow a tap just past the 80 ms window. In
  `test_taps` (bus time modelled) taps of 83 ms or more always register: 2–8 missed per 1,000
  before, 0 after; the longest gap between samples went 10.9 → 0.8 ms.
- **A hint asked for inside the 2 s rate limit is deferred to its end** (FSF-11), cancelled if a
  bridge screen arrives first, and only a DIFFERENT hint is deferred (`38e51b1c`). *Why:* the
  dropped hint left a press unanswered; re-showing the same one held it 5 s, breaking E-BTN-1.
- **Host suites and the simulator report 3.0.0** (`[court_version]` in platformio.ini). *Why:* a
  host build calling itself 2.0.0 made the bridge's dialect selection speak v2 to the real Mega.
- **Bridge phase A only.** MegaTx (paced, tagged, acked, one screen in flight), the snapshot
  reconcile on every beat/boot/contradiction, the v3 heartbeat (caps codes:m1, hb:3, lcd:2 —
  **not** key/net), no identity overlays, release `cause`, one 512-byte reply buffer. Static
  RAM 57088/81920 (24832 for heap, the §13 floor is 24576).
- **The Reconciler never gives up on owed light.** After three failed `!WANT`s it reports
  `relight_failed` once and keeps trying at the 60 s pace; a relay that went dark under an owed
  snapshot is re-lit at once. *Why:* the soak found both (a garbled `!BOOT` left a paid court dark).
- **test_soak is the acceptance gate:** 1,000 sequences × 4 simulated minutes, I1 landing ≤ 62 s
  after the last input, I2 owed courts lit 5 s after a Mega reset, I3 no relay past end of play, I4
  every scan on the Mega's TX line in 200 ms. Mutation-checked. `SOAK_SEED`/`SOAK_TRACE` reproduce.

## What bridge 3.0.0 owed, and where it went

Phase B — `key_next`, `net`, the setup portal on `!HELD,09` (removed 2026-11-14), the supervisor, HW-8, LittleFS
records for the answer and every event, D10 out of the image, the 64-key ring,
`stack_budget.py`, `test_server_replies` — landed in **bridge 3.1.0**
([`decisions-bridge-3-1.md`](decisions-bridge-3-1.md)). Phase B's signed OTA landed too and was
removed on 2026-11-14 (`decisions-device-v3.md`). `test_compat`'s executor is still owed.
