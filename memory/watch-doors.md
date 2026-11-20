---
name: technologies-crusaders-squash-control-system-watch-doors
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
2. **No gate has run on hardware, and every gate change is a cable flash** with the four secrets
   (no OTA, no setup portal since 2026-11-14). Bench one board first: a power cut with the server
   down and the RTC image across a watchdog reset. Fire egress must be mechanical; nothing here is a
   life-safety device.
3. **A court box's roster is a door key, and nothing gates it.** An auto-registered court box is handed live booking
   codes with no naming step, and those codes open doors inside their booking's window. G3 narrowed the blast radius
   (such a board mails nobody; at most 16 unacknowledged rows); the roster is unchanged. The founder's question is
   recorded once, in [`questions.md`](questions.md).
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
5. **GitGuardian now ignores the published test vectors** (`.gitguardian.yaml`:
   `src/contracts/device-protocol/**`, `src/iot/**/test/**`), decided at PR #15's merge
   (2026-11-14), where it was red only on those fixtures. *Why:* a check red on every corpus branch
   gets ignored on the day it is right. The cost: a real secret pasted under those paths would not
   be flagged, so real keys stay in the gitignored `secrets.h` and `.env` only.
