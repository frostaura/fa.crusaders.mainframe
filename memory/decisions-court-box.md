---
name: crusaders-mainframe-decisions-court-box
description: "The court box as built, and the one place firmware versions live: Mega 3.0.0, bridge 3.1.0, gate 2.0.0, Mega first; scan-first landing, greeting, scan-to-extend a lit court; the Mega's renderer, taps and soak gate."
type: decision
last_verified: 2026-11-20
---

# Decisions — the court box as built

The contract and its why: [`decisions-device.md`](decisions-device.md) and the `decisions-device-v3*.md` topics; the
bridge's own choices: [`decisions-bridge.md`](decisions-bridge.md), [`decisions-bridge-scan-flows.md`](decisions-bridge-scan-flows.md).

## Versions — recorded here and nowhere else
- **At `7893321d`: Mega 3.0.0, bridge 3.1.0, door gate 2.0.0** (`court-box/platformio.ini:351,357` and `:414-415,439`
  over `[common]` 2.0.0; `door-gate/platformio.ini:241-243`, which sets the gate's version outright). Host suites and the
  simulator report 3.0.0 (`[court_version]`, `:289-290`) — a host build calling itself 2.0.0 had made the bridge speak v2
  to the real Mega. **No flash of any v3 image is recorded.** Flash the **Mega first**, then the bridge with **3.1.0, never
  3.0.0** (3.0.0 was phase A only), each with the four secrets ([`decisions-device-v3.md`](decisions-device-v3.md)).
- History (superseded lines, kept so nobody re-derives them): bridge 2.2.5 (R15) → 2.2.9 (R19) → 2.3.0 (2026-10-11) →
  3.0.0 → 3.1.0; Mega 2.0.0 → 2.1.0 (active-high, 2026-10-11) → 3.0.0; gate 1.1.0 → 1.1.1 (R17) → 1.1.2 (R18) → 2.0.0. The
  old "never reflash the Mega" rule held only while nothing the Mega did had to change; 2.1.0's polarity and v3's defects
  ended it. The Devices page showing these versions is what confirms a flash. `platformio.ini`'s own history comments
  are partly stale (the bridge block at `:431-438` still says both chips are 3.0.0; the 2.3.0 entry is joined onto the
  previous line at `:59`).

## The panel, as the founder directed it (2026-10-11, `4ac90a67`, `be903b60`, `0d92f5f4`, `6f62f3c8`)
- **The landing screen is "scan your code"** (v3: `SCAN YOUR QR CODE` expanded, `SCAN YOUR QR` compact), and every
  overlay reverts to it on its own (`kRevertSeconds` 10, choices 20). *Why:* the LCD sat on the last payment screen and
  the next players had nothing to act on.
- **A recognised scan greets by first name with the spendable balance**: `/activate` returns `greeting_name`
  (accent-folded printable ASCII, ≤16, empty not null — `MemberDisplay`) and `balance_minutes`, from the ledger, for a
  recognised member only; above 9999 the box shows WELCOME rather than a cut unit.
- **Pressing a lit court shows its minutes left; after a scan it EXTENDS.** Founder's choices: any member who scans may
  extend any lit court; pressing your own lit court after a scan is extend-only; an unscanned press shows minutes left
  plus a scan hint. **This replaced D10 pay-for and press-to-switch-off at the panel** (pay-for left the image at
  3.1.0). `POST /extend` sells a NEW walk-up-shaped booking from the end of play (never a longer `EndsAt` on someone
  else's row), cut at the next booking and at closing, debited as `LightsPurchase` under `extend:{device}:{nonce}`; a
  replayed nonce returns the first purchase; `/extend` is bounded by the walk-up cap. A cut or field-less 200 is
  UNDECIDED (BUSY / PRESS AGAIN, nonce kept) — the server has probably charged.

## Mega 3.0.0 (branch `fix/court-box`, 2026-11-13; taps 2026-11-14)
- **It is the whole of device-serial-protocol.md v3**: tags/`!ACK`, `!WANT`, the cap, `!RW`/`!CMT`, ceiling / dwell /
  AFTON / chain, landing + marquee composed on the Mega, self-healing glass, liveness, `!CFG` incl.
  RPOL/LCDA/SBAUD/SSUF/SGAP/KEYS, `!HW`, `!DIAG` (29 verbs since `!HELD` left with the hotspot). *Why:* meant to be the
  last Mega image ("designed to almost never need reflashing"), so anything missing costs a cable flash of the Mega.
- **The Mega drives the PCF8574 itself; LiquidCrystal_I2C is gone** (`LcdDisplay.h`): the library fixed the address at
  construction and hid its nibble writer; the probe and periodic re-init need both. 400 kHz, falling back to 100 kHz on
  a NACK/error (PCF8574 is rated 100 kHz). Relay level, LCD address, scanner baud and court keys are runtime facts
  ([`decisions-device-v3-hardware.md`](decisions-device-v3-hardware.md)).
- **A 256-byte uplink queue, two link drains a pass, an 8 ms paint budget** (`CourtBox.h:86`, `LcdDisplay.h:61`).
  *Why:* DL-01/02 lost frames at the 64-byte rings. Static RAM 3,977 / 8,192 B (measured at `79a2fe54`; no firmware
  changed between it and `7893321d`).
- **Buttons are sampled inside the LCD paint** (DL-15, `a248a0c0`): the driver calls an idle hook between bus
  transactions and through every wait, pointed at `ButtonPanel::sample`, which latches completed presses for `poll()`;
  debounce unchanged. *Why:* one sample per pass let a re-init (~10.9 ms) or an 8 ms paint swallow a tap just past the
  80 ms window. `test_taps` (bus time modelled): taps of 83 ms or more always register — 2–8 missed per 1,000 before,
  0 after; the longest gap between samples 10.9 → 0.8 ms.
- **A hint asked for inside the 2 s rate limit is deferred to its end** (FSF-11, `38e51b1c`), cancelled if a bridge
  screen arrives first; only a DIFFERENT hint is deferred — re-showing the same one held it 5 s, breaking E-BTN-1.
- **`test_soak` is the acceptance gate**: 1,000 sequences × 4 simulated minutes; I1 landing ≤ 62 s after the last input,
  I2 owed courts lit 5 s after a Mega reset, I3 no relay past end of play, I4 every scan on the Mega's TX line in 200 ms.
  Mutation-checked; `SOAK_SEED`/`SOAK_TRACE` reproduce. **The Reconciler never gives up on owed light**: after three
  failed `!WANT`s it reports `relight_failed` once and keeps trying at the 60 s pace (the soak found a garbled `!BOOT`
  leaving a paid court dark). `test_compat`'s court-box executor is still owed (the gate has `test_gate_compat`).
