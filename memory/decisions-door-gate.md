---
name: crusaders-mainframe-decisions-door-gate
description: "One pull-only ESP32 per door; every readable 2xx and a 403 are answers, all else falls back to the roster; LOCKED before the pin drives; no-power behaviour unmeasured, the owner expects it released."
type: decision
last_verified: 2026-11-13
---

# Live decisions — the door gate

The court box's contract, the shared-library rule and the wiring-is-fixed rule all apply
unchanged: [`decisions-device.md`](decisions-device.md). What follows is the gate's own.

- **The door gate is built** (2026-09-19), as `src/iot/door-gate`: one ESP32 per door, QR scanner
  on `Serial2`, one relay on the lock, one LED. Pull-only like the court box — no listening socket,
  no static IP, no `WiFi.config()`; Carl's sketch had all three and its `/open` endpoint unlocked
  the door for anyone on the club WiFi. **One image for every door**: nothing per-gate is compiled
  in, a door is named in the admin console (`gate_key`), the API keys that name to the board's MAC,
  and the board never needs to know it — so a spare board is a spare board. *Corrected 2026-09-19:*
  "the board learns its name from the heartbeat" was false in four documents and a `kMaxGateKeyLen`
  constant sized a buffer that did not exist. Nothing in the firmware parses `gate_key`.
- **What counts as an answer** (2.0.0, 2026-11-13, superseding "only 200 and 403"): a **403** on
  any of the three device paths is the club taking the board out of service and commits an EMPTY
  roster; **every 2xx** whose body is one complete object with the right kinds is the server's
  decision, and its `opened:false` is never second-guessed against the roster; everything else —
  0, 401 after the key retry, 404, 408, 429, 5xx, a cut, HTML or over-buffer 2xx, an open with no
  integer `unlock_seconds` — is decided offline from the roster. *Why every 2xx:* a proxy or a later
  framework's 201 read as an outage taught the breaker the server was down (FC-4). *Why the 403:*
  falling back after one keeps admitting rostered members for the six-hour staleness window after
  an admin pressed the button meant to stop exactly that. **Residual:** only a board that cannot
  reach the server never hears the 403. The v3 rules as a whole:
  [`decisions-door-gate-v3.md`](decisions-door-gate-v3.md).
- **A door is released for `gate.unlock_seconds`, never for what is left of the booking.** The
  roster's `grantMs` is 25 minutes for a late arrival, and a door held open for 25 minutes is not a
  door. The gate's offline degraded mode is also narrower than the court box's *by contract*: only a
  member with a rostered booking gets in, because a walk-up member's 60-second code can never be in
  a roster.
- **The lock's two polarity flags are independent and are composed in one function.**
  `GATE_RELAY_ACTIVE_HIGH` is about the relay MODULE; `GATE_UNLOCK_ENERGISES_RELAY` is about the
  LOCK's wiring (NO vs NC contact). Only the composition says anything about the door, and it is
  written once in `gatelogic::lockPinLevel` with all four combinations tested. **The locked level is
  written into the pin's output register BEFORE `pinMode(OUTPUT)`** — a GPIO leaves reset as an
  input and starts driving whatever is already latched, so the sketch's `pinMode`-first ordering is
  a door that clicks open on every reset. `IPinOut` is two calls precisely so a fake can prove the
  order; mutation-proved.
- **OPEN — what the door does with no power is unmeasured.** The owner expects it RELEASED. A
  power cut takes the lock's own supply too, so the LOCK type decides that case, whatever the flags;
  a dead board with the lock supply still up is decided by `GATE_UNLOCK_ENERGISES_RELAY` alone.
  Which lock is fitted and which relay contact feeds it are recorded nowhere. *Corrected
  2026-09-19:* an earlier version of this topic, the README and go-live §12 asserted "Carl's board
  is wired fail-secure" and prescribed a lock change and a rewire — unverified, and against the
  wiring-is-fixed rule. The defaults are Carl's own real-door-tested sketch; go-live §12 now
  measures both failures and asks Carl the two facts. **Fire egress must be mechanical and
  independent of this board; nothing here is a life-safety device.**
- **How the pass is ordered, and what shares its one blocking call**, is its own topic:
  [`decisions-door-gate-loop.md`](decisions-door-gate-loop.md); how often it speaks and what a
  refusal costs it is [`decisions-door-gate-cadence.md`](decisions-door-gate-cadence.md). The
  edges it talks through — the URL check, the UART, the secrets guard, the flash route — are in
  [`decisions-door-gate-io.md`](decisions-door-gate-io.md), and the HTTP call itself is in
  [`decisions-door-gate-http.md`](decisions-door-gate-http.md).
