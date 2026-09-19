---
name: crusaders-mainframe-safety-relays
description: "RED: nobody has established whether the court relays switch a contactor coil or the lighting load directly. If direct, an electrician is needed before anything ships — no software decision touches this, and it gates go-live."
type: alert
last_verified: 2026-09-11
---

# Red — the relay question is an electrical safety matter, and it is unanswered

**Do the court relays switch a contactor coil, or the lighting load directly?** Owner: **Dean**.
Nobody has established which, and it is the only open item on this project that could hurt somebody.

- The fitted modules are rated **10A/250VAC**. That is plausible for one modern LED bank and
  **inadequate for older metal-halide**, which is what a club of this age may still have on court.
- **If they switch the load directly, a qualified electrician is required before anything ships.**
  No amount of software resolves it and no test can detect it.
- A **welded contact is a court whose lights cannot be switched off by anything** — the box has no
  readback and cannot even detect the condition. The independent auto-off timer on the Mega does
  not help: it opens a relay that is already stuck closed.
- This gates go-live ahead of every other item, including the deploy secrets and the committee
  sign-off. Expanded, with the consequence of skipping it, as item 1 of
  `docs/go-live-checklist.md`.

A second, smaller physical item rides with it and is also a person's decision rather than a
build's: the power topology is a Mean Well PSU feeding two fused buck converters — a 5V rail for
relay coils, LCD backlight and scanner, and a 9V rail into the Mega's VIN, whose onboard regulators
feed the ESP8266 half of the board. **An ESP transmit burst sagging those regulators, or the 5V
rail sagging under full relay + LCD + scanner load, produces exactly the intermittent faults that
get blamed on software.** Measure both rails under load before a club depends on it.

Delete this topic when the relay question is answered and, if the answer is "direct", the
electrician's work is done.
