---
name: crusaders-mainframe-decisions-firmware-event-drain
description: "Court box wire and event drain (R15 FW15, R16 FW16): every scanned byte escaped, a 4xx drops the head with no backoff, a refusal that keeps it backs off 15 s to 5 min, a 404 keeps it, breaker untouched."
type: decision
last_verified: 2026-10-05
---

# Live decisions: what the court box sends, and how its event drain reacts (rounds 15–16)

Bridge versions are recorded once, in [`decisions-firmware-r19.md`](decisions-firmware-r19.md).
The gate's own drain rule is in [`decisions-door-gate-loop.md`](decisions-door-gate-loop.md).

## Escaping (R15, D15-1)

- **The scanned token is ESCAPED in the activate, walk-up and pay-for bodies**
  (`bridgelogic::escapeScan` over `devapi::json::escapeInto`). *Why:* the Mega's assembler passes
  `"`, `\` and every byte above 0x7F through, and the Mega is untouchable; a bare `%s` made one
  scan an unparseable body. The event subject already went through the same escaper (G4 B1).
- **`escapeInto` writes every byte from 0x7F up as `\u00XX` (its Latin-1 code point); output is
  pure printable ASCII.** *Why:* a raw high byte is legal JSON only inside valid UTF-8, and the
  escaper cannot know what a scanner meant — a lone 0xE9 was answered 500, the drain retried the
  head event forever and the breaker read it as an outage. *Accepted cost:* a scan that WAS valid
  UTF-8 (`C3 A9`) arrives as two code points. Member codes are ASCII, so no real code changes.
  The gate links the same escaper, but its assembler admits only the roster alphabet.
- **Body buffers are header constants the host suite renders into** — `kActivateBodyCap` 224,
  `kWalkUpBodyCap` 320, `kPayForBodyCap` 320 (an escaped 24-byte scan plus a confirm label is 271).
  *Why:* `main.cpp` is outside the native build, so a literal there was a size no test could hold.
- **Corpus:** `http/cases.json` carries four `*-escaped-scan` / `-escaped-subject` vectors
  (`token_hex`/`subject_hex` = `51225c58e9ff`: Q " \ X 0xE9 0xFF).

## The drain (R15–R16, D16-2, D16-3)

- **The drain lives in `bridgelogic::pumpEventDrain` (`lib/bridgelogic/EventDrain`), not `main.cpp`.**
  *Why:* the defect was only visible across thousands of passes on a moving clock;
  `test/test_eventdrain` runs it as the loop does (one step a pass, 10 ms tick, 5 ms a call).
- **A 4xx the box caused (400 `malformed_body` included) drops the head event with no backoff** —
  `devapi::react` → `Rejected`, `devlink::isTransportFailure` false. *Why:* the queue moved, and one
  bad event must not cost the rest of the ring fifteen seconds each. The server answers a bad device
  body 400, never 5xx (`decisions-backend-r15a.md`).
- **Backoff 15 s doubling to a 5 min cap, armed by any post that leaves the ring the same length,
  cleared by any post that shortens it** — the gate's rule, ported rather than shared because the
  gate's drain also commits an empty roster on a 403 (a door rule). *Why:* a disabled box (403 in
  ~5 ms) re-posted its `boot` event every pass, spent the club's device budget and pushed every
  other box and the gate into 429, which each then re-posted every pass. Measured: **240 000 → at
  most 16 posts an hour** under persistent 401/403/404/408/429 or a 200 that acknowledges nothing.
  The window is armed from a clock read AFTER the call. `DrainPace::ready` disarms an elapsed
  window (see R17's per-pass rule in [`decisions-firmware-r17.md`](decisions-firmware-r17.md)).
- **A 404 on `/events` KEEPS the event** (`bridgelogic::eventOutcome`, this route only). *Why:* the
  API's only 404 there is an unknown MAC — the console deleted the row — and the next heartbeat
  re-registers the box, after which the same event is accepted. The gate's rule since G3.
- **The breaker (`devlink::ApiBreaker`) is deliberately unchanged.** *Why:* it decides whether SCANS
  go online; a 401/403/404/429 means the API is there, and opening it would route every scan to the
  roster and change the gate's binary too. The server half — one box's refusals spending every
  box's budget — was closed by the per-board limiter (`decisions-backend-r17a.md`).
