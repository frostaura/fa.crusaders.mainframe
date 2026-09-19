---
name: crusaders-mainframe-decisions-door-gate-loop
description: "The door gate's pass and what shares its one blocking call: the step order, the 12 s watchdog relation and its lamp fault, the event drain's backoff, a 403 that empties the roster on every path, and the true release-overrun bound."
type: decision
last_verified: 2026-09-19
---

# Live decisions — the door gate's pass

Behaviour and safety: [`decisions-door-gate.md`](decisions-door-gate.md). The edges this loop
talks through — the URL, the UART, the HTTP body, the flash route — are in
[`decisions-door-gate-io.md`](decisions-door-gate-io.md).

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
  - **The member at the door wins the pass, but bounded.** A scanner streaming forever would
    otherwise win every pass; after `kMaxScanPassesBeforeHeartbeat` (4) consecutive passes in which
    a scan took the call with a heartbeat due, the heartbeat goes first.
- **A 403 on ANY of the three device paths commits an EMPTY roster** — scan, heartbeat and event
  drain alike (G2). Two of the three did; a claim probe on the README sentence found the third.
  Denying only the scan in front of you leaves the next link drop admitting every rostered member
  for the rest of the staleness window.
- **At most ONE blocking call per pass**, watchdog kicked immediately before and after each.
  - **`GATE_WATCHDOG_SECONDS` is 12, not 8**, and `watchdogSeconds * 1000 >= kWorstBlockingCallMs +
    2 s` is a `static_assert`. The two HTTP timeouts are separate numbers summing to 8 s, and 8 s of
    watchdog against an 8 s worst-case call is a guaranteed reset loop.
  - **`esp_task_wdt_init` is a RECONFIGURATION** over the core's own 5 s TWDT — IDF 4.4 documents it
    and returns `ESP_OK`. It is retried three times and the result is reported on the boot log line
    AND (G2) by a **4 Hz lamp blink** for as long as it is false, because the boot log has scrolled
    past by the time anybody is at the door. The DOOR is untouched either way: refusing to open for
    a missing watchdog is a door that admits nobody, far worse than one running on 5 s.
  - **The true release bound, which replaced a false "can never" sentence:** a blocking call in
    flight when the deadline passes delays the relay write, so `physical release <= granted window +
    kWorstBlockingCallMs + kIdleDelayMs` = **8 010 ms over the deadline, a worst case of 38.01 s**
    against the 30 s cap. Its one precondition is in `decisions-door-gate-io.md`.
