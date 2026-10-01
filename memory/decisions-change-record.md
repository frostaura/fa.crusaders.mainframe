---
name: crusaders-mainframe-decisions-change-record
description: "Rounds 1-4: membership decisions on the change record in their own save (a rejection can be approved); reasons required and mailed; webhooks recorded without secrets; every vocabulary action now has a writer."
type: decision
last_verified: 2026-10-01
---

# Live decisions — the club's record of what its desk did (review round 1, lane B)

Vocabulary: `Services/AdminChangeActions.cs`. Tests: `R1ChangeRecordHttpTests`, `R1MoneyHttpTests`.

- **Approve, reject, suspend, reactivate and the admin temporary password are recorded in the
  decision's own save** (B5; the recorder rides `MemberApprovalService`'s notifier bundle — the
  constructor is at the 6-parameter gate). *Why:* in the vocabulary from the start, never written.
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
  facts rather than a "Before" with a dash. *Why:* writers store keys and tokens (`pending_approval`,
  `top_up_cash`, UUIDs); a new writer's key falls back to words. R3 (A-7): instants in club day+clock,
  ISO dates short, lengths and repeats in words; `spendable_credits` pairs as "Can spend".
- **R3 (lane B):** a REJECTED applicant can be approved (A-2) — the same approval, reason cleared;
  nothing else is approvable. *Why:* the console offered it and got a bare 404.
  **Both admin-grant mails carry the reason** (A-3) — required since B10, dropped on the way out.
- **Club webhooks are on the record** (A-5): `webhook.created`/`.deleted`, area `setting`, subject
  kind `webhook`, destination as scheme+host+port only — URL credentials, path tokens and the
  signing secret never reach a record anyone can export; the console shows them as facts, not settings.
- **An overdraft is reported on SPENDABLE** (A-8), the figure it is decided on: the notice payload
  carries `HeldCredits` (null on older rows), the mail leads "Can spend after" (hold and balance
  named when they differ), the row carries `spendable_credits` beside `balance_credits`. Negative
  credits in server prose use U+2212 (`MoneyFormat.Credits`; rand untouched — machines read it).
- **Every action in the vocabulary has a writer** (R4 wave B, `R4ChangeRecordWritersHttpTests`): courts
  (`AdminCourtEndpoints`), devices + the club key (never the key), door fleet switches, blocks/lifts,
  fault resolves (note = reason), each in its action's own save, changed fields only; a no-op or
  refused action records nothing, and a failed save detaches its staged rows. Play-result rows carry
  `status` on both sides. Desk cancels: [`decisions-admin-writes.md`](decisions-admin-writes.md).
- **R5 (lane F):** a hold lift needs `?reason=` (reason-required). A bulk cancel ALSO writes each
  booking's `booking.cancelled_by_admin` (`part_of_batch`) — a member's record lacked courts taken
  from a list; both bulk rows are labelled and list `after.bookings`.
