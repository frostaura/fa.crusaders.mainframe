---
name: crusaders-mainframe-decisions-players-returns
description: "An uncovered return waits: stamped, set aside from spendable, told once, retried on credit, sweep and start-up; a failed reconcile leaves a marker; nothing strands after an outage."
type: decision
last_verified: 2026-09-29
---

# Live decisions — players: a return that waits, and how it is never stranded

Spec: `docs/specs/players-and-splits.md` §3, §3a. When a return may post at all (coverage):
`decisions-players-deadline.md`. From the refuter rounds, 2026-09-28.

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
- **Return chaining is not recursive — accepted** (round 3): a share-transfer credit does not retry
  the receiver's own waiting returns; the next sweep does. Bounds retries to one level; costs a minute.
- **Admin remove / settle-outside answer `return_waiting` + `return_credits`** (round 3): the
  unlocked pre-check can lose a race to a spend; the desk is told the money did not move.
- **Catch-up is SQL-bounded and per club** (round 4): only seats whose target is surely 0 with
  money still net paid; a failed club is retried next pass, its sweep runs anyway (round 5).
- **A failed reconcile leaves `bookings.ShareReconcileDueAt`** (round 5): the hook or the sweep
  marks it, the minute sweep drains it any age, success clears it. *Why:* the narrowed catch-up
  skips S4/no-show games, so a swallowed hook failure on one would strand its return for good.
- **The marker backs off and is not erased by an older reconcile** (round 6): attempts and the
  last attempt are recorded; retry after 1 min, doubling, capped at 1 h (a permanent failure costs
  one retry and one log line an hour); a reconcile clears only a marker whose last attempt is not
  newer than its own start. The catch-up counts a club done once its failures are MARKED — the
  marker covers them — so a poisoned booking no longer reruns the whole catch-up every minute.
  Rolling the marker migrations back forgets outstanding markers.
- **Every hook reconciles one booking at a time** (round 7): the credit hook, like the settlement
  hook, gives each waiting booking its own try — a throwing one is marked due and the rest still
  retried. *Why:* one try around the loop let one poisoned game strand every later return unmarked.
  A marked booking with NO partner seats is still visited (the sweep reads marked bookings off
  `bookings`, not off seats) and cleared — else its marker sat there, read every minute, for ever.
- **The marker is staged WITH the money** (round 8, orchestrator): any save adding a non-share
  ledger row naming a booking, or changing its status / check-in, sets the marker in the same
  transaction (partner seats only; no attempt counted, so no backoff); the hook's reconcile clears
  it. Hooks run on `CancellationToken.None`. *Why:* a desk credit on a game past the sweep window
  whose hook never ran (dropped connection, restart) stranded the return for good; one save-level
  rule covers every settlement site, present and future, instead of each call site remembering.
- **Stamping or clearing a wait publishes a wallet frame** (reason `share_set_aside`, delta 0).
