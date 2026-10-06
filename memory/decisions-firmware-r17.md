---
name: crusaders-mainframe-decisions-firmware-r17
description: "Firmware round 17 (lane FW17): every gating Deadline is spent on the pass it ends so none outlives a 2^31 ms quiet spell; a busy server reads BUSY / PRESS AGAIN at the box; bridge 2.2.7, gate 1.1.1."
type: decision
last_verified: 2026-10-06
---

# Live decisions: firmware, review round 17 (lane FW17, D17-2 and D17-4)

- **Versions** (2.2.7 / gate 1.1.1 this round) are superseded; current ones are in
  [`decisions-firmware-r19.md`](decisions-firmware-r19.md). The gate unflags `[common]`'s
  `-DFW_VERSION_PATCH=0` and sets its own (a different token, so it survives).
- **THE RULE: a `tb::Deadline` that gates "may I yet?" must be observed on EVERY pass, not only
  by the step it gates.** *Why:* an armed Deadline more than 2^31 ms old reads as PENDING again
  (signed difference), for up to another 24.8 days. Each of these was looked at only when its own
  step ran, and that step does not run while the radio is down, the breaker is open, or nobody is
  at the door. Measured red in the native suites at quiet spells of 2^31 ms + 1 day and
  0xF0000000 ms (1 day and 2^31 − 1 s are the controls that were already green).
- **Court box (D17-2): `pumpEventDrain` takes `online` and observes the pace first.** `main.cpp`
  used to return before the drain when `!gWifiUp || gBreaker.open()`, so `DrainPace::ready()` —
  the only thing that disarms an elapsed window — never ran offline. Now `drainEvents` computes
  `online` and always calls the pump; offline it never posts. A parameter rather than the caller's
  guard, because the guard is exactly what hid this. Bound: an elapsed window is disarmed within
  one pass of ending; a running window is not shortened by offline passes (tested).
- **Door gate (D17-2): `GateApp::forgetElapsedWindows(now)` runs first in every `pass()`** and
  disarms `eventsAt_`, `heartbeatFloorAt_`, `firstCallAt_`, `scanCallFloorAt_` and
  `unreadableAt_` once ended. Disarmed reads exactly as elapsed, so no decision changes.
  `UnlockTimer::tick()` (called every pass) now spends an ended relock dwell. What each one did
  before, each proved by deleting its line (mutation): after a long outage the drain AND the
  heartbeat stayed silent with the link back (so the roster never refilled); a boot hold-back
  after a watchdog reset did the same; after a long quiet spell with the link up the first member
  back was refused `too_fast` or `relocking`, and an unreadable line got no answer.
  **`heartbeatAt_` is deliberately excluded:** its `expired()` means "due" and disarmed means
  "never"; the link-up edge re-arms it to now, which is its own cure.
- **Not fixed, recorded:** `gatelogic::FaultLog`'s per-code `nextAt` and the overflow window use
  `expired()` and are only looked at by `drain()`, which `pumpFaults` skips while the ring is
  FULL. A ring full for over 24.8 days offline would hold its fault counts up to 24.8 more days.
  Diagnostic-only, and only on that path; the cure is the same per-pass observation.
- **D17-4: a 429 or 5xx on a walk-up or a pay-for confirm reads BUSY / PRESS AGAIN.** Both are
  already UNDECIDED (nonce kept, scan kept, pay-for quote re-armed for the choice window), so the
  same press retries the same purchase and the server answers a repeat with the first one. SEE THE
  DESK sent the member away from a retry that works. Walk-up: `byStatus()` in `WalkUp.cpp`
  (two-line `!LCD`). Pay-for: new `ScreenId::Busy`, APPENDED (kScreenCount 33): `BUSY` /
  `PRESS AGAIN` / `Never charged twice` / court cells, choice hold with countdown. Status 0 stays
  NO CONNECTION; an unreadable 200 on a confirm (also undecided) still reads SEE THE DESK.
- **The door gate has no transient-refusal wording:** a 429/5xx on `/gate` falls back to the
  roster and the member gets the roster's verdict at once. Not the D17-4 class.
