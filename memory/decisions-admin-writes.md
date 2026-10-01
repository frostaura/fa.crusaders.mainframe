---
name: crusaders-mainframe-decisions-admin-writes
description: "Review round 4 (B2, wave B): settings saves are partial and versioned (409 on stale), a schedule keeps the rules it replaced, a future end keeps running, desk cancels need a reason and are recorded."
type: decision
last_verified: 2026-10-01
---

# Live decisions — admin writes that two people or two dates can race (review round 4, lane B2)

Tests: `AdminSettingsHttpTests+Concurrency`, `R4ScheduleDatesHttpTests`, `R4ScheduleRuleFromHttpTests`,
`ScheduleRuleHistoryTests`, `R4AdminCancelRecordHttpTests`, `R4ControlBoardBoxesHttpTests`,
`R4TracePagingHttpTests`, `R4LedgerTotalsHttpTests`.

- **Settings saves name only their keys and the version they read** (A4-1). Every PUT key is
  optional (the eight booking keys were required, so the console sent all 64 and a stale tab put a
  colleague's values back). GET answers `version`; a stale `version` is `409 settings_changed` with
  `{ version, settings }` and nothing written; no `version` = no check. *Why a content hash*
  (`SettingsDocument`, canonical JSON — the column is `jsonb`, so Postgres re-orders and re-spaces):
  a no-op save leaves the version alone, and there is no column, so no migration. *Why a ROW lock*
  (`SELECT … FOR UPDATE` for the save): the member-code rollout patches the row with its own UPDATE,
  which waits on a row lock, and two saves on one version must not both land (forced-interleaving
  test, red without the lock). A value sent back that MEANS what is stored keeps the stored text,
  so `operating_hours` is no longer "changed" on every save. Cross-key checks use the value in force
  for the key not sent (day start/end, advance days vs schedule horizon).
- **A schedule's dates are read at the hours they are HELD at** (A4-3). A "from this date on" change
  keeps earlier dates at their old hours; the date list reports held rows' times (`rule_*`, `on_rule`
  beside), lists held dates the new rule no longer produces, and `next_occurrence` is the next held
  row, else the rule after the last held date. The change record's `after` carries `effective_from`.
  **The materialiser keys "already held" by (court, DATE)**, not start instant: by instant it tried
  the new hours over each earlier date, collided with the series' own row, stalled the horizon and
  mailed the admins a clash with itself.
- **A schedule keeps the rules its changes replaced** (wave B, migration `AddScheduleEarlierRules`):
  `booking_schedules.EarlierRulesJson` (jsonb) lists each replaced rule with the first date it no
  longer governs, and `ScheduleOccurrences.Expand` reads every date at the rule in force ON it. *Why:*
  holding hours by held rows covered only dates already materialised — a DAY change from a future
  date booked the new days before it, and a date past the horizon came out at the new hours. A list,
  not one rule: two changes can wait at once; a change earlier than a waiting one cuts it back to
  its own date (`ScheduleRuleHistory.Supersede`). `rule_*`/`on_rule` now mean the GOVERNING rule.
  The edit's conflict check starts at the effective date. The read exposes them (R5, A5-4):
  `rules[]` oldest first `{from, until (exclusive), days, start, end, interval_weeks, in_force}`.
- **A series ended from a future date keeps running until then** (A4-10): `Status` stays Active and
  materialising; the wire's status is "ended" once ended outright or past `end_date`, and the list
  filters on that.
- **Every desk cancellation needs a reason** (A4-4; `400 reason_required`, `waiveReason` accepted in
  its place). This REVERSES the earlier "reason belongs to the waiver alone" rule: the reason is the
  only record of why the club took somebody's court and it is mailed to them. `booking.cancelled_by_admin`
  (about the member, `subject_kind user`) is staged BEFORE the cancellation so it flushes in its
  save and is detached when nothing was cancelled. The record is append-only (a trigger refuses
  UPDATE), so figures known only after the save stay on the ledger rows.
- **The control board lists each box once** (A4-5, `boxes`, with MAC) so "not calling in" counts
  boxes; tiles and `other_boxes` carry `mac_address`. Admin-only surface.
- **The paged ledger's first page totals the whole range** (`totals`, null later) — the console had
  summed a capped read. **The trace's pages are one privacy view**: its view fold keys on the query
  minus `limit`/`cursor`; any other range still records.
- **Registration cap is atomic**, proved by parking 32 heartbeats on the held lock; the load flake
  (16 rows, 15 OK) was a post-commit failure. **Proving a race here:** hold the lock from the test's
  own connection and count waiters in `pg_locks` — never `pg_stat_activity`, which is snapshotted
  once per transaction and never shows a new waiter to a probe inside the holding transaction.
