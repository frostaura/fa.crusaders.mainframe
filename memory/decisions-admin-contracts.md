---
name: crusaders-mainframe-decisions-admin-contracts
description: "Every admin reply the console reads is pinned to its C# handler; paged admin reads (ledger totals from the server, members, a night); the change record is words for every action."
type: decision
last_verified: 2026-10-01
---

# Live decisions — what the admin console may assume about a reply (review rounds 2–4, lane F3)

- **Every admin reply the console reads is pinned to the C# that writes it**
  (`lib/adminResponses.contract.test.ts`, fixtures in `test/adminResponseFixtures.ts`, readers in
  `test/serverContract.ts`: anonymous objects, list items, dictionaries, records/classes with
  `JsonPropertyName` and the camelCase policy). Schedules and ledger types stay in their own files.
  **Why:** R4 A4-2 — the group add answered `{ results: [{ user_id, result }] }`, the screen read
  counts and `{ id, status }` rows and said "undefined of undefined done" and "refused" over people
  who were added; each suite stubbed the other side with its own guess (R2's "End undefined" again).
  **Page tests stub with the pinned fixtures**, never a shape written in the test.
- **Keys the UI reads that no handler sends are `it.fails`, each naming the screen**: booking-rules
  `club_hours` (the preview now takes the club's hours from settings), trace `approximate` /
  `device_code` / `outage_id` (the ≈ never shows; bursts key on `detail.door_name` instead),
  control-board `door`, group members `added_by_name`, `shut_by_shut_all_at`. Turning one green
  means the server started sending it — delete the `.fails`.
- **The older `serverResponseKeys` splits on commas before dropping comments**: a handler whose
  comments carry commas reads extra keys. Use `serverShapes` there (ledger `ListAsync`).
- **Transactions shows the SERVER's totals** for the whole range (first page's `totals`), rows a
  page at a time ("Show more movements"). A name search narrows rows only; its totals appear once
  every row is read. An API without totals is read to the end (2,000 cap) and totalled only whole.
  **Why:** `limit=1000` then summing read "MOVEMENTS 1000" over a 1664-movement range — wrong money.
  Its dates are CLUB days (`lib/clubDay`, half-open to the next club midnight); an emptied From is
  sent as 2000-01-01 because the server's own default is 90 days back, not unbounded.
- **Members are read a page at a time** (`photos=url`, 200 a page, all of them — every status chip
  counts the whole club), the rest appended with "Reading the rest…". **A night** asks 100 events,
  "Show more" with the cursor for the same day; B2 folds one night's pages into one privacy view.
- **The change record says every action in words** (`lib/changeRecordCatalogue.test.ts` iterates
  `AdminChangeActions.cs`, fixtures = what each writer stores, rendered as `AdminChangeDiff` does
  after jsonb). No JSON, ISO date, id, enum token, snake code, "bps", empty row or repeated figure.
  A new action without a fixture fails. 12 actions have no change-record writer at all (courts,
  devices, doors, holds, fault resolve) — a backend gap, recorded there.
- **Attention counts re-read on arrival, an application change, the minute poll and a tab return;
  a move between sections only when older than 30 s.** *Why:* every click re-read three counts.
