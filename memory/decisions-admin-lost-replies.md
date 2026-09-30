---
name: crusaders-mainframe-decisions-admin-lost-replies
description: "Admin writes whose reply is lost are read back before anything is said (R2 desk/approve/settings, R3–R4 every other write via lostReply); dialogs word it via describe; Settings draft and version."
type: decision
last_verified: 2026-10-01
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
- **Tests perform the write, then fail the reply** (a mutating `respond`, then `refuse(504)`).
- **Round 3 put the rest on `lib/lostReply`'s `writeOrReadBack`** (F2's helper; words from
  `lostReplyCopy`'s `unsureWords`): device-key regeneration (key differs), admin grant/revoke
  (member's `is_admin`), schedule skip/restore/end/hours (`lib/scheduleReadBack.ts`), webhook
  delete (id gone), group archive/restore/delete (list), court add/edit (list). **R4 closed the
  rest:** group sheet save (the list reads as sent; a create = a NEW group of that name), group add
  (anybody asked for newly in the group — one save adds all or none), a member's groups (their
  detail holds the set sent), board edit/delete (the row as asked, or gone). No admin write is direct.
- **`ConfirmDialog` takes `describe(error)`** before `describeFailure`: how a dialog says an `UnsureOutcome`.
- **The desk top-up's live region speaks the caller's line** (`{ said }` from `onApply`): not
  known / nothing arrived / an earlier press landed — never "didn't go through" over an unknown.
  A 409 `idempotency_key_reused` re-reads the balance (row AND sheet target). *Why:* the sheet
  showed the pre-landing balance and an "after" summed onto it (R3 I-6).

Response contracts and paging: [`decisions-admin-contracts.md`](decisions-admin-contracts.md).

## Settings

- `useSettingsDocument` keeps `{ saved, draft }` as ONE state; every read carries unsaved edits
  onto it key by key (`draft.carryEdits`), and a kept draft is restored per key, dropping only keys
  someone saved since. **Why:** measured in a real browser — StrictMode's second read landed 300 ms
  after the restore and erased the kept draft; one unrelated key saved elsewhere dropped it whole.
- After a save the save bar stays as a visible, focusable status until the next edit (no toast).
- **R4 A4-1, against a versioned API** (B2's `version`; see `decisions-admin-writes`): a save sends
  only the edited keys (the whole weekday map if a day moved) + the version read, and keeps the
  reply's. A 409 `settings_changed` adopts theirs as saved, carries every edit that did not clash
  (`conflictOf`/`carryEdits`), names what they changed, offers "Put my value back" for a clash —
  saving again is still the admin's press. A 409 whose only "other" changes EQUAL our edits is our
  own lost earlier press: said as saved. No `version` served → the whole page, as the old API needs.
- `ConfirmDialog` `notReady`: the primary stays enabled and a press names the missing reason and
  focuses the field, beside a visible "(required)" and `aria-required`. Every admin reason dialog
  uses it since R3 (AdminRoleSwitch's own-rights box has its own `notReadyMessage`).
- A kept draft says "while you signed in again" only after a 401 (`afterSessionEnd`); a 429 on
  save is transient and names no field (R3 A-9, A-12), as on the desk top-up (R4 I4-4).
