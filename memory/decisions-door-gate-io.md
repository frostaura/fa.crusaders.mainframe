---
name: crusaders-mainframe-decisions-door-gate-io
description: "The door gate's edges: a compiler-checked API_BASE_URL, what a UART overrun costs, a response body read into the caller's buffer under a cap and a deadline, the no_push counter, and the Arduino-IDE flash route."
type: decision
last_verified: 2026-09-19
---

# Live decisions — the door gate's edges

What the loop does with these is in [`decisions-door-gate-loop.md`](decisions-door-gate-loop.md);
the toolchain traps around building them are in [`gotchas-build.md`](gotchas-build.md).

- **`API_BASE_URL` is checked by the compiler** (2026-09-19): `http://` + an IPv4 literal + an
  optional `:port`, no trailing slash, and it must fit the URL buffer. *Why each:* a **hostname**
  resolves through lwIP DNS, which NEITHER HTTP timeout bounds (~16 s then ~15 s), so every
  heartbeat would trip the watchdog — a reset loop that admits nobody; **`https://`** is accepted by
  `HTTPClient::begin` against a plain `WiFiClient` and then spoken as cleartext to port 443; a
  **trailing slash** produces `//api/v1/...`, a 404, which the gate correctly reads as "learned
  nothing" and answers from its roster — a door silently offline-only against a healthy server.
  No console, display or provisioning path exists, so the compiler is the only place to catch it.
  The grammar propagates failure as an **integer offset**, not as `nullptr`, for the UBSan reason in
  `gotchas-build.md`; every function is one return statement because the sketch is gnu++11.
- **An overrun costs everything that was BUFFERED when it happened, and nothing after the next
  terminator** (corrected round G2 — it used to cost only the line in ASSEMBLY, which was the WRONG
  line). A FIFO overruns when it is FULL: the driver keeps the OLD bytes and drops what arrived
  next, so the hole is at the TAIL of ~1 kB drained 64 bytes a pass. A good buffered line was
  therefore dropped and the holed one handed up several passes later as a valid token — a refusal
  for somebody standing there, or a match on another member's booking. **The old test could not see
  it** because its fixture fed a PARTIAL line before signalling, which made the line in assembly and
  the holed line the same line; the real shape is whole lines first. `takeRxError` is a
  `std::atomic<bool>::exchange` now — it was a `volatile bool` read-then-write across two cores (the
  UART event task has no core affinity and runs at max priority), so an error signalled between the
  halves was swallowed. `setRxBufferSize(1024)` and `onReceiveError` are still installed BEFORE
  `Serial2.begin`, where they are honoured, and the assembler is still reset at boot and on a link
  edge as its header had always promised.
- **The response body is read into the caller's buffer, capped and on the call's own deadline**
  (round G2). `http.getString()` heap-allocated the WHOLE body — sized by whatever the peer sends —
  under two comments promising it did not, then TRUNCATED it into `out` and returned the peer's 200.
  `isCompleteObject` is the only reason that was not a silent roster replacement; the scan parser
  has no such guard, and `{"opened":true,` cut after the comma is a door that opens. A body that
  does not fit or does not arrive is status 0 — a transport failure, so the scan goes to the roster
  rather than to a parser holding half an object. `setTimeout` is an INTER-BYTE timeout a dribbling
  peer resets on every byte, so the deadline is absolute and sampled before the call starts.
  **Residual:** HTTPClient's own header loop inside `POST()` still cannot be interrupted, so a peer
  that dribbles HEADERS can outlast `kWorstBlockingCallMs`. That is the watchdog's case, and it is
  the one precondition on the 8 010 ms release-overrun sentence.
- **A truncated heartbeat body is no push at all** (`devlink::applyRoster`, shared with the court
  box): the element walk cannot tell a short roster from a cut one, so committing what arrived
  discarded every booking whose bytes were lost AND re-stamped the cache fresh. An accepted
  heartbeat that pushed nothing is now COUNTED and sent back as an optional `no_push` in the next
  request — it is otherwise wholly unobservable, and a diagnostic blink was rejected because this
  lamp is what tells a member their scan was seen. **Omitted at zero**, so a healthy board's body
  stays byte-identical to the corpus request vector. The backend's acceptance and its corpus vector
  (B7) had not landed when this shipped.
- **The gate is flashed from the Arduino IDE, like every other board here.** Carl flashes the boards
  and has no PlatformIO. `src/iot/tools/arduino_export.py --project` generates
  `door-gate/arduino/door_gate/`; `make arduino-check` covers both projects. **Verified by compiling
  the generated sketch** (`arduino-cli`, `esp32:esp32@2.0.17`, 59% of flash), not inferred.
- **The gate sets its own firmware version outright and no longer inherits `[common]`.**
  `build_unflags` removes EVERY matching token including the environment's own, so MINOR and PATCH
  never reached the compiler and 1.0.0 was right only by luck. `main.cpp` `#error`s unless all three
  parts are defined and are the gate's.
