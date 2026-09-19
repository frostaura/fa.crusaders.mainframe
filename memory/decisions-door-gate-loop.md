---
name: crusaders-mainframe-decisions-door-gate-loop
description: "Door-gate firmware internals: the loop lives in host-testable GateApp, one blocking call per pass under a 12 s watchdog; API_BASE_URL is compiler-checked as http plus IPv4; UART overruns cost one line; truncated heartbeats are ignored; flashed from the Arduino IDE."
type: decision
last_verified: 2026-09-19
---

# Live decisions — the door gate's loop and build

Behaviour and safety decisions: [`decisions-door-gate.md`](decisions-door-gate.md).

- **The loop lives in `gatelogic::GateApp`, not in `main.cpp`** (2026-09-19, round G1). *Why:*
  `build_src_filter = -<*>` means the host suite cannot see `main.cpp`, and an adversarial review
  found four defects there at once — the release window armed from an instant sampled BEFORE the
  HTTP call that granted it (2.9 s round trip on a 3 s grant = a 100 ms relay pulse, door shut,
  entry logged); five blocking calls per pass against one watchdog kick (reset loop against a
  silently-dropping API host, roster never loads); the release deadline checked before those calls;
  the debounce stamped from the same stale instant. `main.cpp` is
  construction plus `beginOutputs()` and `pass()`. The fake HTTP port **advances the fake clock**,
  which is the one thing that makes a stale instant expressible in a test.
  - **At most ONE blocking call per pass**, watchdog kicked immediately before and after each.
  - **`GATE_WATCHDOG_SECONDS` is 12, not 8**, and `watchdogSeconds * 1000 >= kWorstBlockingCallMs +
    2 s` is a `static_assert`. The two HTTP timeouts are separate numbers whose sum is 8 s, and 8 s
    of watchdog against an 8 s worst-case call is a guaranteed reset loop.
  - **`esp_task_wdt_init` is a RECONFIGURATION** over the core's own 5 s TWDT — IDF 4.4 documents
    it and returns `ESP_OK` — and the return value is checked and reported on a one-line boot log
    rather than assumed. The board's UART0 console now carries that one line and nothing else.
  - **The true release bound, which replaces a false "can never" sentence:** the deadline is
    bounded by the hard cap, but a blocking call in flight when it passes delays the relay write.
    `physical release <= granted window + kWorstBlockingCallMs + kIdleDelayMs` = **8 010 ms over the
    deadline, a worst case of 38.01 s** against the 30 s cap.
- **`API_BASE_URL` is checked by the compiler** (2026-09-19): `http://` + an IPv4 literal + an
  optional `:port`, no trailing slash, and it must fit the URL buffer. *Why each:* a **hostname**
  resolves through lwIP DNS, which NEITHER HTTP timeout bounds (~16 s then ~15 s), so every
  heartbeat would trip the watchdog — a reset loop that admits nobody; **`https://`** is accepted by
  `HTTPClient::begin` against a plain `WiFiClient` and then spoken as cleartext to port 443; a
  **trailing slash** produces `//api/v1/...`, a 404, which the gate correctly reads as "learned
  nothing" and answers from its roster — a door silently offline-only against a healthy server.
  No console, display or provisioning path exists on this board, so the compiler is the only place
  to catch it; the grammar is one-return `constexpr` because the sketch compiles at `gnu++11`.
- **A UART overrun costs its line and only its line** (2026-09-19). `setRxBufferSize(1024)` and
  `onReceiveError` are both installed BEFORE `Serial2.begin`, where they are still honoured. *Why:*
  the core's 256-byte default is 267 ms of line-rate data at 9600 baud and the loop can be inside a
  blocking call for 8 s, so it overruns in ordinary service — silently, handing up a trimmed,
  printable, in-cap token nobody scanned, which is either a refusal for somebody standing there or a
  match on another member's booking. The assembler is also reset at boot and on a link edge, as its
  own header had promised since it was written and nothing ever did.
- **A truncated heartbeat body is no push at all** (2026-09-19, `devlink::applyRoster`, shared with
  the court box). The element walk cannot tell a short roster from a cut one, so committing what
  arrived discarded every booking whose bytes were lost AND re-stamped the cache fresh — refusing
  those members for the whole staleness window with nothing recording why. `devapi::json::
  isCompleteObject` is asked first and an incomplete body is treated exactly like an absent key.
- **The gate is flashed from the Arduino IDE, like every other board here.** Carl flashes the
  boards and has no PlatformIO, so a PlatformIO-only gate was a go-live blocker.
  `src/iot/tools/arduino_export.py --project` generates `door-gate/arduino/door_gate/`;
  `make arduino-check` covers both projects. **Verified by compiling the generated sketch**
  (`arduino-cli`, `esp32:esp32@2.0.17`, 59% of flash), not inferred — it failed first time on the
  C++11 constraint in [`gotchas-build.md`](gotchas-build.md).
- **The gate sets its own firmware version outright and no longer inherits `[common]`.**
  `build_unflags` removes EVERY matching token including the environment's own, so MINOR and PATCH
  never reached the compiler and 1.0.0 was right only because `Version.h`'s fallback is 0.
  `main.cpp` `#error`s unless all three parts are defined and are the gate's; the exporter raises
  rather than substituting a zero that happens to be right.
