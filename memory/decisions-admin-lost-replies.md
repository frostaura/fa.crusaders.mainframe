---
name: crusaders-mainframe-decisions-admin-lost-replies
description: "Admin writes whose reply is lost are read back before anything is said (R2 desk/approve/settings, R3 every other write via lostReply); dialogs word it via describe; Settings draft honesty."
type: decision
last_verified: 2026-09-30
---

# Live decisions — the admin console after a lost reply (review rounds 2–3, lane F3)

A 5xx, a timeout or a dropped connection is an UNKNOWN outcome, never "didn't go through".

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
- **Round 3 put the rest on `lib/lostReply`'s `writeOrReadBack`** (F2's helper; words from
  `lostReplyCopy`'s `unsureWords`): device-key regeneration (key differs), admin grant/revoke
  (member's `is_admin`), schedule skip/restore/end/hours (`lib/scheduleReadBack.ts`), webhook
  delete (id gone), group archive/restore/delete (list), court add/edit (list). Still direct: the
  group sheet's save and member-group assignment, device edit/delete.
- **`ConfirmDialog` takes `describe(error)`** before `describeFailure`: how a dialog says an `UnsureOutcome`.
- **The desk top-up's live region speaks the caller's line** (`{ said }` from `onApply`): not
  known / nothing arrived / an earlier press landed — never "didn't go through" over an unknown.
  A 409 `idempotency_key_reused` re-reads the balance (row AND sheet target). *Why:* the sheet
  showed the pre-landing balance and an "after" summed onto it (R3 I-6).

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
  focuses the field, beside a visible "(required)" and `aria-required`. Every admin reason dialog
  uses it since R3 (AdminRoleSwitch's own-rights box has its own `notReadyMessage`).
- A kept Settings draft says "while you signed in again" only when a save met a 401 (the kept
  copy carries `afterSessionEnd`); a 429 on save is transient and names no field (R3 A-9, A-12).
