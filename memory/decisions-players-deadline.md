---
name: crusaders-mainframe-decisions-players-deadline
description: "The share deadline is frozen per booking; a return posts only when the organiser's coverage pays for it, whatever the deadline — else it waits, stamped, told once, retried on any credit and by the sweep."
type: decision
last_verified: 2026-09-28
---

# Live decisions — players: the deadline, and when money may go back

Spec: `docs/specs/players-and-splits.md` §3, §3a, §7. From the two refuter rounds on the review
fixes, 2026-09-28, pinned in `PlayersRefuteHttpTests` and `PlayersRefute2HttpTests`.

- **The deadline is frozen per booking** — `bookings.ShareDeadlineAt`, stamped when a booking
  first gets players from the setting at that moment; everything (open, hold, lapse, reminders,
  sweep window) reads the stamp. *Why:* a club raising `share_lapse_hours` reopened games whose
  released holds were spent. *Backfill* (`ShareDeadlineBackfill.cs`) reads the setting exactly as
  `TryInt`: a JSON number that is an Int32 integer, else 48, then 1–168 — its first version took
  a JSON string and rejected in-range ten-digit values (round 2). Down drops the column safely.
- **A return is keyed on COVERAGE, never on the deadline** (round 2, orchestrator decision): it
  posts without a named overdraft only if the organiser's balance less what they hold for their
  OTHER bookings covers it. *Why:* round 1 keyed the guard on the deadline, but a game cancelled
  after check-in (S4) releases its shares at once, so an admin remove before the deadline
  overdrew an organiser who had spent it. The hold on this booking is what may go back, so it
  covers — ordinary returns never wait.
- **Admin remove / settle-outside refuse an uncovered hand-back** without `allowNegativeBalance`
  (`400 overdraft_not_authorised {return_credits, covered_credits}`), whatever the deadline; with
  it, on the change record (`overdraft_authorised`). The ledger holds the same line in a race.
- **An uncovered return WAITS rather than overdraw** — chosen over refusing so no settlement hook
  or sweep fails with nobody to answer. It is stamped `ReturnPendingSince` (indexed); both sides
  are told ONCE (`players.return_waiting`, mailed, not urgent — stamping null→set is the "once");
  the sweep selects stamped seats however old (the 7-day window stranded them); and any credit to
  the organiser (not a share transfer) retries at once via `ShareHook.AfterCreditAsync` after the
  commit — one mechanism covering top-up ITN, desk adjustment and refunds, rather than call sites.
  *Cost:* a partner's refund can wait on the organiser's next credit. The desk-side admin notice
  kind was optional and was NOT added: the partner and organiser mails say it; the admin feed does not.
- **The lapse and reminder reads are bounded** to bookings whose deadline passed within a week /
  is still ahead (indexed on the stamp); they had read every accepted seat in history every minute.
