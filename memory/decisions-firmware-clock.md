---
name: technologies-crusaders-squash-control-system-decisions-firmware-clock
description: "Firmware's 32-bit clock rules: every gating Deadline is observed on every pass so none outlives a 2^31 ms quiet spell, and every age is observed per pass and latches past its bound so none reads fresh after 2^32 ms."
type: decision
last_verified: 2026-11-20
---

# Live decisions — firmware time on a 32-bit millisecond clock (rounds 17–18)

Applies to both boards (court-box bridge and door gate) and the shared `timebase`, `roster`, `memcode` libraries.
The type now enforces part of it: `tb::Deadline`'s `at` is private (`timebase/TimeBase.h:80-95`), so a naive
`now >= x.at` comparison no longer compiles; the rollover grep gate (`Makefile:145`, `ci.yml:541`, regex ending
`\.at\b`) stays as the second line ([`gotchas-gates.md`](gotchas-gates.md)).

- **R17 — a `tb::Deadline` that gates "may I yet?" must be observed on EVERY pass, not only by the step it gates.**
  *Why:* an armed Deadline more than 2^31 ms old reads as PENDING again (signed difference) for up to another 24.8 days,
  and each was looked at only when its own step ran — which does not run while the radio is down, the breaker is open,
  or nobody is at the door. Measured red in the native suites at quiet spells of 2^31 ms + 1 day and 0xF0000000 ms
  (1 day and 2^31 − 1 s were the already-green controls).
  - Court box: `bridgelogic::pumpEventDrain` takes `online` and observes the pace first; `main.cpp` used to return
    before the drain when offline, so `DrainPace::ready()` — the only thing that disarms an elapsed window — never ran.
    A parameter rather than the caller's guard, because the guard is exactly what hid it. An elapsed window is disarmed
    within one pass; a running window is not shortened by offline passes (tested).
  - Door gate: `GateApp::forgetElapsedWindows(now)` runs in every `pass()` before any step reads a window — after only
    the uptime tick, the watchdog kick and `persistDirty` (`GateApp.cpp:129-134`) — and disarms `eventsAt_`,
    `heartbeatFloorAt_`, `firstCallAt_`, `scanCallFloorAt_` and `unreadableAt_` once ended (disarmed reads exactly as
    elapsed, so no decision changes); `UnlockTimer::tick()` spends an ended relock dwell. Each line proved by deleting it:
    after a long outage the drain AND heartbeat stayed silent with the link back (the roster never refilled); a boot
    hold-back after a watchdog reset did the same; after a long quiet spell the first member back was refused
    `too_fast` / `relocking`; an unreadable line got no answer. **`heartbeatAt_` is deliberately excluded**: its
    `expired()` means "due" and disarmed means "never"; the link-up edge re-arms it to now, its own cure.
  - **Not fixed, recorded:** `gatelogic::FaultLog`'s per-code `nextAt` and overflow window are looked at only by
    `drain()`, which `pumpFaults` skips while the ring is FULL; a ring full for over 24.8 days offline would hold its
    fault counts up to 24.8 more days. Diagnostic-only; the cure is the same per-pass observation.
- **R18 — an AGE ("how old is it?") is observed on EVERY pass and LATCHES once past its bound; only a re-anchor clears
  it.** *Why:* every age is `tb::since`, a 32-bit difference, so one 2^32 ms + 1 s old reads ONE SECOND old; no single
  reading can tell the two apart (the arguments are bit-identical), so a pure query cannot be fixed — the age has to be
  watched. R17's rule for Deadlines applied to the other half of the clock. Contract, stated in each header: `observe()`
  runs at least once between the bound and 2^32 ms (49.4 days of slack against a loop running every few ms). 64-bit
  uptime was rejected: it would change every roster, verifier and screen signature for the same guarantee.
  - `roster::Roster::observe` latches `agedOut_` past `maxAgeMs` (`commitReplace` clears it); `memcode::StepClock::observe`
    past `maxAgeMs` (`sync` clears); `bridgelogic::WallClock::observe` past `kMaxClockTrustMinutes` (a day) — NOT the
    tenant's window, so lengthening `clock_trust_minutes` still revives a clock merely past the old window (`adopt`
    clears). Court box: `loop()` observes all three right after `gUptime.tick`. Gate: `forgetElapsedWindows` observes
    roster, step clock, `ScanDebounce` (a member scanning exactly one wrap later had been dropped) and `LedPattern` (an
    ended cue had replayed the refusal stutter at nobody).
  - Measured red first at 2^32 ms + 1 s and + 1 day on every clock base: a 49.7-day-old roster admitted a booking (gate
    opened offline), the step clock read trusted 143 165 steps behind, the wall clock sent the Mega a time ~17 h wrong,
    the debounce dropped a scan, the lamp replayed. Each gate wiring line was mutation-checked except the step clock's
    (the stale roster masks it at the door; its unit test carries it).
  - **Not fixed, recorded:** `StateReconcile`'s belief age reads young for 2 s once per 49.7 days — one `!STATE`
    contradiction deferred to the next periodic frame (10 s), self-healing, no lights or money effect. The Mega's own
    timers were out of scope.
- **A gate version follows its shared libraries' behaviour**: the gate moved to 1.1.2 in R18 because the roster and step
  clock changed; `gate_sim.py`'s DSIM check reads the version from the gate's `[env:simulator]` (the current one:
  [`decisions-court-box.md`](decisions-court-box.md)).
