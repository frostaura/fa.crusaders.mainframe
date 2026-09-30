---
name: crusaders-mainframe-decisions-admin-lost-replies
description: "Review round 2 lane F3: an admin write whose reply is lost is looked up before anything is said; schedule and ledger response shapes are pinned against the C# source; Settings keeps saved+draft as one state."
type: decision
last_verified: 2026-09-30
---

# Live decisions — the admin console after a lost reply (review round 2, lane F3)

A 5xx, a timeout or a dropped connection is an UNKNOWN outcome, never "didn't go through". The
reviewer found four admin writes that landed while the screen said they had failed.

- **Desk credit movement** (`components/members/adjustmentAttempt.ts`, both hooks): reads
  `/admin/ledger?userId&from=press−2 min` for a row of type AdminAdjustment/AdminTopUp with this
  signed amount and this reason as its comment. Found → the receipt, balance re-read from the
  member detail (null, never 0, if that read fails). Read and absent → "nothing arrived". Unreadable
  → "not known yet, open the ledger". **Why the ledger and not a retry:** a silent re-POST is the
  admin's press made again without asking; the key would make it safe, the wording would not.
- **The key names one intended movement**: a changed amount/reason/code/rand/booking mints a new
  one, EXCEPT while the last outcome is unknown — then the old key stays, so a changed payload meets
  the stored row as `409 idempotency_key_reused`, which the sheet words from `stored`. **Why:** a new
  key there is how a lost +200 and a corrected +250 both land.
- **Approve** (list and member page, `lostTransition.ts`): re-read the member; Active → "approved,
  the reply got lost"; waiting or 4xx → failed; unreadable → "not known".
- **Settings save**: re-read the settings and compare only the keys this save changed. **Webhook
  create**: re-read the list for a NEW id with this URL and filter (an already-listed twin is not
  this press's); its secret was in the lost reply, so the copy says recreate it to get one.
- **Tests perform the write, then fail the reply** (`respond` that mutates, then `refuse(504)` or
  throws `TypeError`). A stub that only fails proves nothing about a lost reply.

## Contracts pinned from the C# source

- `src/test/serverContract.ts`: `serverRecordFields` (request records), `serverResponseKeys`
  (top-level keys of every anonymous object a handler returns) and `serverEnumMembers`.
  `AdminSchedules.contract.test.ts` pins every schedule envelope (`{ schedule, timezone }`,
  `{ schedule, rows_created }`, …); `ledgerTypes.contract.test.ts` pins the admin ledger types
  AND the `LedgerEntryType` union in `lib/api.ts` (which now carries `AdminTopUp`). **Why:** the detail page read the envelope as the row and rendered
  "End undefined" over two green suites that each stubbed the other side with its own guess.

## Settings

- `useSettingsDocument` keeps `{ saved, draft }` as ONE state; every read carries unsaved edits
  onto it key by key (`draft.carryEdits`), and a kept draft is restored per key, dropping only keys
  someone saved since. **Why:** measured in a real browser — StrictMode's second read landed 300 ms
  after the restore and erased the kept draft; one unrelated key saved elsewhere dropped it whole.
- After a save the save bar stays as a visible, focusable status until the next edit (no toast).
- `ConfirmDialog` `notReady`: the primary stays enabled and a press names the missing reason and
  focuses the field, beside a visible "(required)" and `aria-required`. Suspend, reject, reset
  member code and match-result remove/keep use it; `AdminRoleSwitch` and `GroupCard` still use
  `confirmDisabled`.
