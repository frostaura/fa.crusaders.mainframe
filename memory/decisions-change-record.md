---
name: crusaders-mainframe-decisions-change-record
description: "Rounds 1-3 lane B: membership decisions on the change record in their own save (a rejection can be approved); reasons required and mailed; webhooks recorded without secrets; overdraft figures are spendable, with U+2212."
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
- **The night trace has words for the account's own story** (applied, approved, turned down,
  suspended, reactivated, admin rights, code reset, passkeys, passwords) and **declares
  `credit.adjusted` not a person's night** — its ledger row is already on the wallet strand, and
  the twin made one top-up read twice (F3). Each admin notice kind carries `others_receiving` so the
  opt-out switch can warn that nobody else will be told (the dispatcher's own recipient test).
- **The console words the diff the server renders** (review round 2, F3-7, `presentChanges` in
  `lib/changeRecordCopy.ts`): ids hidden, credits and rand formatted, states and reason codes in
  words, `balance_before/after_credits` joined into one Balance row, one-sided values listed as
  facts rather than as a "Before" with a dash. *Why:* the writers store keys and tokens, and the
  record read `pending_approval`, `top_up_cash` and UUIDs; a new writer's key falls back to words.
  R3: instants in club day+clock, ISO dates as the club's short date, lengths and repeats in words
  (A-7); `spendable_credits` pairs as "Can spend"; a webhook row's facts are facts, not settings.
- **Review round 3 (lane B), `R3*HttpTests`:** a REJECTED applicant can be approved (A-2) —
  the same approval (audit, change row from `rejected`, welcome mail, webhook), rejection reason
  cleared; nothing else is approvable. *Why:* the console offered it and got a bare 404.
  **Both admin-grant mails carry the reason** (A-3) — required since B10, dropped on the way out.
- **Club webhooks are on the record** (A-5): `webhook.created`/`.deleted`, area `setting`, subject
  kind `webhook`, destination as scheme+host+port only. *Why:* URL credentials, path tokens and
  the signing secret must never reach a record every admin can read and export. No edit, enable,
  disable or rotate route exists to record.
- **An overdraft is reported on SPENDABLE** (A-8), the figure it is decided on and the desk's
  confirm step shows: the notice payload carries `HeldCredits` (null on older rows), the mail
  leads "Can spend after", naming the hold and balance when they differ, and the overdraft row
  carries `spendable_credits` beside `balance_credits`. Every negative credit figure in server
  prose uses U+2212 (`MoneyFormat.Credits`; rand untouched — a machine may read it).
- **Desk cancellations** (R4): reason required, `booking.cancelled_by_admin` in the cancel's own save — [`decisions-admin-writes.md`](decisions-admin-writes.md).
