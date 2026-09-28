---
name: crusaders-mainframe-decisions-players-deadline
description: "The share deadline is frozen per booking; a return posts only when the organiser's coverage pays for it — else it waits, set aside from spendable, told once, retried on credit, sweep and start-up."
type: decision
last_verified: 2026-09-28
---

# Live decisions — players: the deadline, and when money may go back

Spec: `docs/specs/players-and-splits.md` §3, §3a, §7. From the three refuter rounds on the review
fixes, 2026-09-28, pinned in `PlayersRefute{,2,3}HttpTests`.

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
- **A waiting return is SET ASIDE from spendable** (round 3, orchestrator decision): spendable =
  balance − held − owed back, in every spend check; reported as `owed_back_credits`, apart from
  `held_credits` (going, not might-go; no release date). Posting stays all-or-nothing, so short
  credit accumulates until it covers the return. *Why:* otherwise each short top-up was spendable
  on a new court and the partner waited for ever. A booking's own hold is not counted twice.
- **Nothing strands after an outage** (round 3): the worker's first pass after a start reconciles
  every booking a return may have fallen due on, any age (`CatchUpAsync`, once — not every minute,
  so the minute sweep stays bounded); the lapse sweep takes every still-invited overdue seat, any age
  (partial index `IX_booking_participants_open_invites`). Accepted short seats past the week are
  closed by the clock anyway; only their lapse notice would be missed.
- **Return chaining is not recursive — accepted** (round 3): a credit arriving as a share transfer
  does not retry the receiver's own waiting returns; the next minute sweep does. *Why:* bounds each
  retry to one level; *cost:* a minute's delay per link.
- **Admin remove / settle-outside answer `return_waiting` + `return_credits`** (round 3): the
  coverage pre-check is not under the organiser's lock, so a spend can race it; the desk is told
  the money did not move rather than reading a bare 200.
