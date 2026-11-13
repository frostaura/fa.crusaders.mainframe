---
name: crusaders-mainframe-watch-doors
description: "What the door gates leave owed: no-power behaviour unmeasured and two facts owed by Carl, no gate has run on hardware, a court box's roster is an unnamed door key, and everything that is NOT a door row still grows for ever."
type: watch
last_verified: 2026-11-13
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
   contact (NO or NC) feeds it** — and neither is recorded anywhere here. Until they are, nothing
   in the tree claims what that door does in either failure. Then both are measured on a bench
   with a meter and an audible lock, along with the boot glitch, the same check after a watchdog
   reset, and the pre-`setup()` window where the pin is hi-Z and the relay module's input bias
   decides. **Do not close this by reasoning about the flags** — an earlier pass asserted "Carl's
   board is wired fail-secure" and prescribed a rewire, unverified and against wiring-is-fixed.
2. **No gate has run on hardware, and 2.0.0's flash is the last cable one.** Bench one board first:
   a real signed OTA round trip, a power cut with the server down, the BOOT-button portal, the RTC
   image across a watchdog reset, and whether the bootloader has app rollback. Fire egress must be
   mechanical; nothing here is a life-safety device.
3. **A court box's roster is a door key, and nothing gates it — open question for the owner.**
   A gate is pushed no roster until an admin names the door, which stops anyone holding the club
   device key self-registering a board and being handed the club's live codes. **A court box has
   no equivalent step:** its heartbeat hands an auto-registered board live booking codes for its
   courts immediately, and since the gate shipped those same codes open **doors** inside their
   booking's window. G3 narrowed the blast radius from both ends — such a board now mails nobody,
   and a club can hold at most 16 unacknowledged rows — but the roster itself is unchanged.
   *Should an auto-registered court box also get no roster?* Founder's call. It belongs in
   [`questions.md`](questions.md), where it is recorded.
4. **The DOOR half of this is closed; everything else still grows for ever.** Wave 1's
   `RetentionWorker` hard-deletes `gate.*`, `device.gate_open` and `device.unknown_scan` rows past
   `door_log_retention_days` (default 90), and the `gate_open`/`unknown_scan` receipts past
   `max(that, MaxEventAge)` — the receipts outlive the rows because they are what makes an upload
   idempotent, and a purged one turns an ordinary re-upload into a second row for one scan. What
   is **still unpurged**: every other `audit_log` row (anonymised at `retention_years`, never
   deleted) and every court-box receipt (`activation`, `release`), which the settlement reads. A
   club's tables still grow for the life of the deployment, just not with doors in them.
   **Capacity and cost, not correctness.**
   The jsonb `device_id` match is still unindexed and that is now a **measured** decision rather
   than an omission: on 400 000 rows across 20 tenants every Wave 1 read plans as an index scan on
   `IX_audit_log_TenantId_CreatedAt` (0.02–0.21 ms) with the containment as a cheap recheck, so a
   GIN index on `details_json` would buy nothing and cost write amplification on the hottest table
   in the product. The numbers are in `door-gate.md` §13. Revisit if a club's door outgrows a
   day's rows per page.
5. **GitGuardian is red on PR #3 and is very probably wrong.** The value it objects to is a
   **corpus fixture, not a credential**: a fake device API key beginning `k7Qz3mR9`, generated for
   the wire-protocol vectors and shared by the C++ and .NET suites. It lives in the two
   `cases.json` files under `src/contracts/device-protocol/`, that family's generator
   `gate/gen_cases.py`, and `src/iot/court-box/test/test_bridge/test_bridge.cpp`. It authenticates
   against nothing. **Confirm that before dismissing it** — read the finding, not this sentence —
   then either mark it as a known fixture or accept a permanently red check on every branch that
   touches the corpus. A scanner nobody believes is ignored on the day it is right.
