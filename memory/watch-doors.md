---
name: crusaders-mainframe-watch-doors
description: "What the door gates leave owed: the no-power behaviour is unmeasured and Carl owes two facts, no gate has run on hardware, a court box's roster is an unnamed door key, the blueprint artifact needs republishing."
type: watch
last_verified: 2026-09-19
---

# Watch list — the doors

Everything the door gate leaves open. The product-wide debts are [`watch.md`](watch.md); what
was decided and why is [`decisions-door-gate.md`](decisions-door-gate.md) and
[`decisions-gate-access.md`](decisions-gate-access.md). Every bench item below is §12 of
`docs/go-live-checklist.md`.

1. **What a door does with no power has never been measured, and two facts are missing.** The
   owner expects the door **released**. A power cut takes the lock's own supply with it, so the
   **lock type** decides that case whatever the flags say; a dead board with the lock supply still
   up de-energises the relay coil, and `GATE_UNLOCK_ENERGISES_RELAY` alone decides that one.
   **Carl owes two answers — which lock is fitted (fail-safe or fail-secure), and which relay
   contact (NO or NC) feeds it** — and neither is recorded anywhere in this repository. Until they
   are, nothing in the tree claims what that door does in either failure. Then both are measured
   on a bench with a meter and an audible lock, along with the boot glitch, the same check after a
   watchdog reset, and the pre-`setup()` window where the pin is hi-Z and the relay module's own
   input bias decides. **Do not close this by reasoning about the flags** — an earlier pass
   asserted "Carl's board is wired fail-secure" and prescribed a rewire, which was unverified and
   against the wiring-is-fixed rule.
2. **No gate has ever run on hardware.** Every decision is proved on the host — the polarity
   combinations, the release window and its cap, online-first and the roster fallback, the whole
   loop with its watchdog budget, the contract vectors — and none of that is a board on a wall
   with a lock on the other end. The firmware has never been flashed. Fire egress must be
   mechanical and independent of the board; nothing here is a life-safety device.
3. **A court box's roster is a door key, and nothing gates it — open question for the owner.**
   A gate is pushed no roster until an admin names the door, which is what stops anyone holding
   the club device key from self-registering a board and being handed the club's live codes. **A
   court box has no equivalent step:** its heartbeat hands an auto-registered board live booking
   codes for its courts immediately, and after the gate shipped those same codes open **doors**
   inside their booking's window. The naming gate protects the door's roster only. *Should an
   auto-registered, never-acknowledged court box also get no roster?* Founder's call, not an
   engineering one. It belongs beside the other door questions in
   [`questions.md`](questions.md), where the G2 backend lane was to record it — **check that it
   landed** rather than assuming this line is enough.
4. **Republishing `docs/system-blueprint.html` to its hosted artifact is owed.** Both founder-
   facing pages were regenerated on 2026-09-19 for the doors; the hosted copy is still the
   2026-09-06 revision and knows nothing about them. Republish to the **same URL** recorded in
   [`state.md`](state.md) so the link the founder holds stays good.
5. **GitGuardian is red on PR #3 and is very probably wrong.** The value it objects to is a
   **corpus fixture, not a credential**: a fake device API key beginning `k7Qz3mR9`, generated for
   the wire-protocol vectors and shared by the C++ and .NET suites. It lives in
   `src/contracts/device-protocol/http/cases.json`, `src/contracts/device-protocol/gate/cases.json`,
   that family's generator `src/contracts/device-protocol/gate/gen_cases.py`, and
   `src/iot/court-box/test/test_bridge/test_bridge.cpp`. It authenticates against nothing and
   never has. **Confirm that before dismissing it** — read the finding rather than this sentence —
   and then either mark it as a known fixture in the scanner or accept a permanently red check on
   every branch that touches the corpus. A scanner nobody believes is a scanner that will be
   ignored on the day it is right.
