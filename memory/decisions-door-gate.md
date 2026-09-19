---
name: crusaders-mainframe-decisions-door-gate
description: "One pull-only ESP32 per door, one image for every door; 200 and 403 are the two authoritative answers and everything else falls back to the roster; LOCKED is asserted before the pin drives; what the door does with no power is unmeasured and the owner expects it released."
type: decision
last_verified: 2026-09-19
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
- **The gate reads the API differently from the court bridge, deliberately.** `devapi::react()`'s
  `Rejected` class means "a 4xx this box caused — drop it", which is right for an event upload and
  wrong for a door, so `gatelogic::onGateResponse` does not use it. **TWO statuses are answers**
  (2026-09-19, was one): a **200**, whose `opened:false` is authoritative and is NEVER
  second-guessed against the roster; and a **403**, which is the club taking this board out of
  service — it denies with `out_of_service`, and a 403 on the *heartbeat* commits an EMPTY roster.
  Everything else — 0, 401, 404, 408, 429, any 5xx, and a 200 whose body cannot be parsed — falls
  back to the roster. *Why the 403:* falling back after one would keep the door admitting rostered
  members for the full six-hour staleness window after an admin pressed the button that exists to
  stop exactly that. *Why the rest:* both directions have a victim — second-guessing a refusal
  admits the member barred this morning through a booking nobody cancelled; refusing on an outage
  leaves a member with a valid booking outside because a container was restarting.
  **Residual, and it cannot be closed:** a board that cannot REACH the server never hears the 403
  and keeps admitting rostered bookings until its roster goes stale.
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
- **How the loop, the watchdog, the URL check, the UART and the build are arranged** is its own
  topic: [`decisions-door-gate-loop.md`](decisions-door-gate-loop.md).
