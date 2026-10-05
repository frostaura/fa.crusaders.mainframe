---
name: crusaders-mainframe-decisions-firmware-r16
description: "Firmware round 16 (lane FW16): the court box's event drain backs off 15 s to 5 min on any post that leaves the head event in place, a 404 keeps the event, the breaker is untouched; bridge 2.2.6."
type: decision
last_verified: 2026-10-05
---

# Live decisions: firmware, review round 16 (lane FW16, D16-2 and D16-3)

- **Bridge is 2.2.6; Mega stays 2.0.0; door gate stays 1.1.0.** Supersedes the "bridge 2.2.5"
  line in [`decisions-firmware-r15.md`](decisions-firmware-r15.md) and
  [`decisions-member-code.md`](decisions-member-code.md). No shared-library source changed, so
  the gate's image is unchanged: `make arduino-export` rewrote nothing under `door-gate/arduino/`.
- **The court box's drain lives in `bridgelogic::pumpEventDrain` (`lib/bridgelogic/EventDrain`),
  not in `main.cpp`.** *Why:* `main.cpp` is outside the native build, and the defect was only
  visible across thousands of passes on a moving clock. `test/test_eventdrain` runs it as the
  loop does — one step per pass, 10 ms tick, 5 ms per call — and counts posts.
- **Backoff 15 s doubling to a 5 min cap, armed by any post that leaves the ring the same
  length, cleared by any post that shortens it.** The gate's numbers and rule
  ([`decisions-door-gate-loop.md`](decisions-door-gate-loop.md)), ported rather than shared,
  because the gate's drain also commits an empty roster on a 403 — a door rule. *Why:* a
  disabled box (403 in ~5 ms) re-posted its `boot` event every pass, spent the club's 120/min
  device budget and pushed every other box and the gate into 429, which each of them then
  re-posted every pass. Measured in the suite: **240 000 → at most 16 posts per hour** under
  persistent 401/403/404/408/429 or a 200 that acknowledges nothing; after the refusal lifts the
  next post lands inside the window already running (at most 5 min) and the rest drain one per
  pass. The window is armed from a clock read AFTER the call.
- **A 400 or any other 4xx the box caused still drops the head with no backoff** — the queue
  moved, and one bad event must not cost the rest of the ring fifteen seconds each.
- **A 404 on `/events` KEEPS the event** (D16-3), via `bridgelogic::eventOutcome`, which
  overrides the shared `devapi::react` for this route only. *Why:* the API's only 404 here is
  an unknown MAC — the console deleted the row — and the next heartbeat re-registers the box,
  after which the same event is accepted. The gate's rule since G3.
- **The breaker (`devlink::ApiBreaker`) is deliberately unchanged.** *Why:* it decides whether
  SCANS go online; a 401/403/404/429 means the API is there, and opening it would route every
  scan to the roster and change the gate's binary too. The drain's own pace is the narrower cure.
- **`DrainPace::ready` disarms an elapsed window**, so a deadline armed more than 2^31 ms ago
  cannot read as pending again after a long idle stretch; the doubling state is kept.
- **Not done here, offered to the backend lane:** charging 401/403/404/429 device answers to the
  club-wide rate bucket still lets one misbehaving older-firmware box starve the others; a
  per-device limit or not charging refusals would close that server-side.
