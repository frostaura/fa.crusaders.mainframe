---
name: crusaders-mainframe-decisions-players-deadline
description: "The share deadline is frozen per booking; a return posts only when coverage pays for it — its own game's earmark (none for S4) plus free balance, first come first served."
type: decision
last_verified: 2026-09-28
---

# Live decisions — players: the deadline, and when money may go back

Spec: `docs/specs/players-and-splits.md` §3, §3a, §7. From the refuter rounds on the review fixes,
2026-09-28, pinned in `PlayersRefute{,2,3,4,5}HttpTests`. How a return WAITS: `decisions-players-returns.md`.

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
- **Coverage earmarks held money and queues waiting returns** (rounds 4–5, orchestrator): a
  return may use its own game's earmark (less earlier returns' need there) only as far as money
  behind the holds is left after earlier returns' draws, plus free balance after earlier excess.
  *Why:* round 3 made ordinary withdrawals wait; round 4's sum let a later return claim an
  earmark an earlier one needed when holds were underwater. FCFS by stamp, then id; unstamped is
  newest; retries run in that order too (determinism only — the arithmetic is the guarantee, so
  an ordering mutant survives by design). **S4 games earmark nothing**: their "hold" is the return
  asked about, spent before. Spend checks still subtract all owed-back.
- **An S4 hold is not in the free-balance subtraction either** (round 6, orchestrator decision):
  it IS the pending returns the formula pays from free balance, so subtracting it too made each S4
  return need twice its amount (admin remove said covered, then waited). Spend checks still set it
  aside. *Proof obligation:* `PlayersPropertyHttpTests` — seeded random scenarios through the real
  endpoints, hook and sweep, checked against an independent model after every step (150 seeds in
  CI, `PLAYERS_PROPERTY_SEEDS` for more; 1,000 run locally before commit). It found the defect's
  mutant at seed 17; the refuter's own seeds 1005/1053/1113 are in the set but their generator was
  not recoverable, so the targeted admin-remove and goodwill tests carry those cases.
