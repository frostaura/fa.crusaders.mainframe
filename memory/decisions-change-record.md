---
name: crusaders-mainframe-decisions-change-record
description: "Review round 1 lane B: every membership decision is on the change record in its own save; code reset and admin grant need a reason; one privacy row per view; desk top-ups carry rand; ledger rows name who acted."
type: decision
last_verified: 2026-09-30
---

# Live decisions — the club's record of what its desk did (review round 1, lane B)

Vocabulary: `Services/AdminChangeActions.cs`. Tests: `R1ChangeRecordHttpTests`, `R1MoneyHttpTests`.

- **Approve, reject, suspend, reactivate and the admin temporary password write
  `admin_change_log` rows in the decision's own save** (B5; `MemberApprovalService`'s notifier
  bundle carries the recorder — the constructor is at the 6-parameter gate). *Why:* the actions
  were in the vocabulary from the start and nothing wrote them.
- **The desk's code reset requires a `reason`** (400 `reason_required`), records
  `member.code_reset` and emails the member (`MemberCodeReset`) (B6). *Why:* it signs them out
  everywhere and drops their passkeys; "who did this and why" had no answer.
- **Granting admin requires a reason, like revoking** (B10) — who administers the club is the
  change that can hide every other one, in both directions.
- **A settings change's `changes[].field` is the `tenant_settings` key** — the stable key the
  console maps to its own label (B17). No server label dictionary: the labels live in the
  frontend settings schema and a second copy would drift.
- **One privacy row per VIEW, not per request** (B19, `ViewAuditOnce`): the same admin, same
  path+query, same member within 30 s is folded; exports are never folded. *Why:* React's dev
  StrictMode (and any retry) fetched twice and each wrote an undeletable row. Process-local by
  design — on another topology the worst case is the old duplicate, never a lost row.
- **A desk top-up code must state the rand it took** (`zarReceived`, B7) on all three top-up codes
  (cash, EFT, card offline all post `AdminTopUp`, which revenue counts); stored as `ZarPaid`.
  *Why:* revenue is rand, and a credits-only row reported R0.00 for money the club handled.
  Other codes ignore the field — goodwill is not revenue.
- **Ledger rows carry `actor_name`** (B9): whoever moved money on the owner's behalf; null for
  the owner's own, the system's (`Guid.Empty`) and a member-to-member share unless an admin moved
  it. The older record fields stay camelCase; the round-1 additions use the contract's snake names.
