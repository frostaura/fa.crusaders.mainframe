---
name: crusaders-mainframe-decisions-players-deadline
description: "The share deadline is frozen per booking when it first gets players; after it a hand-back needs the desk's named overdraft, and a late return waits rather than overdrawing the organiser."
type: decision
last_verified: 2026-09-28
---

# Live decisions — players: the share deadline and what may happen after it

Spec: `docs/specs/players-and-splits.md` §3, §3a, §7. From the refuter's round on the review fixes,
2026-09-28, each pinned in `PlayersRefuteHttpTests`.

- **The deadline is frozen per booking** — `bookings.ShareDeadlineAt`, stamped when a booking
  first gets players from the setting at that moment; everything (open, hold, lapse, reminders,
  sweep window) reads the stamp. *Why:* the hold releases at the deadline and the organiser may
  then spend it; a club raising `share_lapse_hours` afterwards reopened the game — returns
  possible again, nothing held to cover them. A later setting change affects unstamped bookings
  only. *Migration:* `AddBookingShareDeadline` backfills every booking with players from its
  club's setting as read (clamped 1–168, 48 when unset or junk); Down drops the column, safe
  because the fallback is the old computation.
- **After the deadline, an admin remove or settle-outside needs `allowNegativeBalance` + a
  reason**, exactly like collect, on the change record (`overdraft_authorised`); without it
  `400 overdraft_not_authorised`. *Why:* those hand a paid share back from an organiser whose hold
  is gone — the desk must see and name the overdraft.
- **A return after the deadline WAITS rather than overdraw** (orchestrator's choice between
  "refuse" and "leave unpaid"; chosen for consistency with "no debts"): it posts only when the
  organiser's spendable credits cover it, and the next reconcile retries. *Why:* refusing would
  fail whatever triggered it (a settlement hook, a sweep) with nobody to answer; waiting keeps
  every path total and never creates an overdraft. *Cost:* in the rare case a partner's refund is
  pending until the organiser has credits — in practice late returns follow a fall in `Owed`,
  which credits the organiser first. Only the named overdraft posts it regardless.
