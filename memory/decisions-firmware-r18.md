---
name: crusaders-mainframe-decisions-firmware-r18
description: "Firmware round 18 (lane FW18): every age is observed per pass and latches past its bound so none reads fresh after 2^32 ms; a busy pay-for quote is BUSY; PRESS AGAIN stays pressable; bridge 2.2.8, gate 1.1.2."
type: decision
last_verified: 2026-10-06
---

# Live decisions: firmware, review round 18 (lane FW18, D18-2 to D18-4)

- **The gate moved to 1.1.2 here** because the roster and step clock are SHARED libraries whose
  behaviour changed — a gate version follows its shared libraries' behaviour;
  `test/e2e-device/gate_sim.py`'s DSIM check expects it. Bridge 2.2.8 is superseded by 2.2.9 (R19).
- **THE RULE (D18-2): an AGE ("how old is it?") is observed on EVERY pass and LATCHES once past its
  bound; only a re-anchor clears it.** *Why:* every age is `tb::since`, a 32-bit difference, so one
  2^32 ms + 1 s old reads ONE SECOND old. No single reading can tell the two apart (the arguments
  are bit-identical), so a pure query cannot be fixed; the age has to be watched. This is R17's
  rule for Deadlines (which go pending again after 2^31 ms) applied to the other half of the clock.
  Contract, stated in each header: `observe()` runs at least once between the bound and 2^32 ms,
  which is 49.4 days of slack against a loop running every few ms. 64-bit uptime was rejected: it
  would change every roster, verifier and screen signature for the same guarantee.
  - `roster::Roster::observe` latches `agedOut_` past `maxAgeMs`; `commitReplace` clears it.
  - `memcode::StepClock::observe` latches past `maxAgeMs`; `sync` clears it.
  - `bridgelogic::WallClock::observe` latches past `kMaxClockTrustMinutes` (a day), NOT the
    tenant's window, so lengthening `clock_trust_minutes` still revives a clock that is merely past
    the old window (setTrustMinutes's promise, tested); `adopt` clears it.
  - Court box: `loop()` observes all three right after `gUptime.tick`. Gate:
    `GateApp::forgetElapsedWindows` observes roster, step clock, `ScanDebounce` (forgets a slot past
    its window: a member scanning exactly one wrap later was dropped) and `LedPattern` (clears an
    ended cue: the refusal stutter replayed at nobody).
  - Measured red first at 2^32 ms + 1 s and + 1 day on every clock base: a 49.7-day-old roster
    admitted a booking (gate opened offline), the step clock read trusted 143 165 steps behind, the
    wall clock sent the Mega a time ~17 h wrong, the debounce dropped a scan, the lamp replayed.
    Each gate wiring line was mutation-checked (deleted: its gate-level test goes red), except the
    step clock's, which the stale roster masks at the door; its unit test carries it.
  - **Not fixed, recorded:** `StateReconcile`'s belief age reads young for 2 s once per 49.7 days;
    the only effect is one `!STATE` contradiction deferred to the next periodic frame (10 s),
    self-healing, no lights or money effect. The Mega's own timers were out of scope (never touched).
- **D18-3: a pay-for QUOTE answered 0 / 429 / 5xx is Undecided — BUSY / PRESS AGAIN, or NO
  CONNECTION for 0 — and keeps the scan.** *Why:* the quote is only asked about a court the box
  believes is TAKEN, so falling through to CHOOSE TIME offered walk-up time on a court in play.
  404 and an unreadable 200 still fall through to the walk-up choice (a server that predates
  pay-for must behave as before). Dead link included deliberately: the walk-up it offered could
  not have been bought anyway.
- **D18-4: every answer that decided nothing — walk-up, pay-for quote, pay-for confirm — re-arms
  both ends of PRESS AGAIN for the whole choice window.** `bridgelogic::holdScanFor` keeps the scan
  at least `choiceMs` from now (never shortened) and `AuthPolicy::afterUndecided` re-arms the Mega
  window for a full TTL (>= choice by the parser rule) KEEPING its binding, so the member's own lit
  court stays theirs to switch off and no other becomes so. *Cost accepted:* each undecided answer
  can extend a scan past armPayForQuote's "scan memory plus one choice window" bound; each needs a
  press and a server that decided nothing, and the kept nonce makes the retry the same purchase.
