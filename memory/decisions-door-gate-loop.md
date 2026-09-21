---
name: crusaders-mainframe-decisions-door-gate-loop
description: "The door gate's pass and what shares its one blocking call: why the loop left main.cpp, the load-bearing step order, at most one call with the 15 s watchdog relation and its lamp fault, and the true release-overrun bound."
type: decision
last_verified: 2026-09-19
---

# Live decisions — the door gate's pass

Behaviour and safety: [`decisions-door-gate.md`](decisions-door-gate.md). How often it speaks
and what a refusal costs it: [`decisions-door-gate-cadence.md`](decisions-door-gate-cadence.md).
The edges this loop talks through — the URL and the UART — are in
[`decisions-door-gate-io.md`](decisions-door-gate-io.md), and the call itself is in
[`decisions-door-gate-http.md`](decisions-door-gate-http.md).

- **The loop lives in `gatelogic::GateApp`, not in `main.cpp`** (round G1). *Why:*
  `build_src_filter = -<*>` means the host suite cannot see `main.cpp`, and an adversarial review
  found four defects there at once — the release window armed from an instant sampled BEFORE the
  HTTP call that granted it (2.9 s round trip on a 3 s grant = a 100 ms relay pulse, door shut,
  entry logged); five blocking calls per pass against one watchdog kick; the release deadline
  checked before those calls; the debounce stamped from the same stale instant. `main.cpp` is
  construction plus `beginOutputs()` and `pass()`. The fake HTTP port **advances the fake clock**,
  which is the one thing that makes a stale instant expressible in a test — and since round G2 it
  also **answers per PATH and per CALL**, which is what made the critical below reachable at all.
- **THE STEP ORDER IS LOAD-BEARING** (round G2): link → scanner → lock → heartbeat → events → lamp.
  - **Link first.** Read after the scanner, `linkUp_` was a pass stale, so the first scan after the
    radio re-associated went to the roster — a member refused at a door whose network works.
  - **Heartbeat BEFORE the event drain, plus a backoff on the drain.** THE ROUND-G2 CRITICAL. Both
    share the pass's one blocking call, so with the drain first an `/events` that refused while
    KEEPING the head event — 401/403/408/429/5xx, or a 200 whose `accepted_through` misses the head
    — was re-posted every pass (~25/s) and the heartbeat never ran again. `begin()` queues a `boot`
    event on EVERY boot, so this was the normal path for any board meeting a rate limiter, a WAF or
    a club that disabled it. Three consequences, all worse than the refusal: the roster ages out at
    6 h and the door admits NOBODY; a disabled board never hears the heartbeat's 403 and keeps
    admitting rostered members; the API is hammered. Measured against the real loop over seven
    simulated hours, before → after: **0 → 840 heartbeats, 630 000 → 88 event posts**, and a
    rostered member arriving afterwards went from REFUSED to admitted. Backoff starts at 15 s and
    doubles to a 5 min cap, cleared by the queue actually MOVING rather than by the status — a 200
    that acknowledges nothing leaves the head exactly where a 429 does.
- **At most ONE blocking call per pass**, watchdog kicked immediately before and after each.
  - **`GATE_WATCHDOG_SECONDS` is 15**, and `watchdogSeconds * 1000 >= kWorstBlockingCallMs +
    2 s` is a `static_assert`. It was 8 against an 8 s call — a guaranteed reset loop — then 12
    against 8; G3 gave the response body its own budget, so a call is three 4 s phases and the
    worst case is 12 s.
  - **`esp_task_wdt_init` is a RECONFIGURATION** over the core's own 5 s TWDT — IDF 4.4 documents it
    and returns `ESP_OK`. It is retried three times and the result is reported on the boot log line
    AND (G2) by a **4 Hz lamp blink** for as long as it is false, because the boot log has scrolled
    past by the time anybody is at the door. The DOOR is untouched either way: refusing to open for
    a missing watchdog is a door that admits nobody, far worse than one running on 5 s.
  - **The true release bound, which replaced a false "can never" sentence:** a blocking call in
    flight when the deadline passes delays the relay write, so `physical release <= granted window +
    kWorstBlockingCallMs + kIdleDelayMs` = **12 010 ms over the deadline, a worst case of
    42.01 s** against the 30 s cap. It went UP at G3 because the old number was measured
    against a call whose body phase could be handed no time at all. One precondition, in
    `decisions-door-gate-io.md`.
  - **MEASURED 2026-09-21, and the bound is conservative.** `test/e2e-device`'s `DS8` drives the
    native simulator against a peer that accepts and never answers: one call **4 000 ms**, overrun
    **3 916 ms**, physical release on a 30 s grant **33 916 ms**, worst unkicked watchdog interval
    **4 001 ms**, connect budget alone **4 019 ms** against TEST-NET-1. The three phases are not all
    reachable in ONE call — a connect that times out has no header or body phase, and a peer that
    answers promptly spends nothing on the connect — so 12 000 ms needs a connect that is slow BUT
    SUCCESSFUL. A real state, so the bound stands; against a hung or absent host the honest worst
    case is ~34 s, not 42.
