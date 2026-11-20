---
name: crusaders-mainframe-decisions-players-acts-races
description: "Seat-act races: a dedupe collision is already said, idempotent twins, accept locking the booking row, a lost accept re-read for the seat as it stands, cancel refunds read off the ledger after."
type: decision
last_verified: 2026-11-20
---

# Live decisions — seat acts: twins and races

The acts themselves: [`decisions-players-acts.md`](decisions-players-acts.md).

- **A dedupe-key collision is "already said", never a fault** (R18, `Services/Players/SeatRaces`): a 23505 on
  `booking_participants` = a seat really taken → `seat_taken`; any other 23505 (notification dedupe keys) or a version
  miss = a lost race — `PlayersService.SaveAsync(ct, Landing)` / `PlayersAdminService.SaveAndSettleAsync` re-read the
  seat: in the act's target state → 200 `{participant_id, status}`; else `409 conflict_retry`. *Why:* parallel desk
  accepts 500'd on `IX_admin_notifications_TenantId_DedupeKey`; twin declines read "That seat was taken". **A players
  screen says its own `conflict_retry` sentence** (`PLAYERS_REFUSAL`, `playersCopy.ts:125`), which `playersRefusal`
  picks ahead of the generic one (`describeFailure`); only a lost-reply read-back (`unsure`) goes first.
- **Seat acts are idempotent in their target state** — decline on Declined, withdraw on Withdrawn, remove on Removed,
  accept-on-behalf on Accepted, settle-outside on settled → 200 and NO writes (`SettledOutsideAt` keeps its first
  instant). Another state is still refused for what happened (decline after accept = `not_invited`). **An identical
  re-split twin is 200** (R19, `SplitTwinAsync`: same mode, shares, weights, consent → same body, nothing written).
- **Accept locks the booking row `FOR NO KEY UPDATE`** after the member and seat advisory locks (R18). A cancel landing
  mid-accept waits, or the accept answers `409 booking_not_open {booking_id}` with no money moved. *Not `FOR SHARE`:*
  the accept's save updates the booking (play recompute marker) and two shared holders deadlocked upgrading.
- **A lost accept is answered for the seat as it now stands** (R19 J19-1, `AfterLostAcceptAsync`): gone or claimed by
  another → `invite_closed`; closed or cancelled → the accept's own refusal (`StandingRefusal`); still open →
  `409 share_changed {share_minutes}` when the share differs from the `expectedShareMinutes` shown (UP **or down** —
  the next tap must be on the figure now on the sheet; "Your share is now X" reads true both ways), else
  `409 conflict_retry`. *Why:* a re-split or nudge landing between the accept's read and its save answered "This
  invite has closed" above an open Accept button. Decline/withdraw already go through `SaveAsync(Landing)`.
- **Cancel refunds are read after the cancel, off the ledger** (R19 J19-4, `SplitCancelView.AfterAsync`): paid = still
  paid in + returns posted from `CancelledAt` on (`ReturnedOfAsync`); refund = that − `TargetFor`. *Why:* a
  pre-cancel snapshot missed an accept that landed while the cancel waited on the row lock, so the answer said
  `partner_refunds: []` while the ledger refunded the share. *Rejected:* computing inside the cancel's lock
  (BookingService, another owner, and the accept's own reconcile can post the return before the cancel's hook does,
  so "the cancel's own moves" is not reliable either). A collection cannot land after a cancel commits, so it is
  always in "still paid"; a waiting return is still paid in, so still reported. Member, desk and bulk cancel all call it.
