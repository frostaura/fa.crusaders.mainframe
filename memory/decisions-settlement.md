---
name: crusaders-mainframe-decisions-settlement
description: "How the ledger settles: a no-show releases its tail by truncating EndsAt, late box evidence reverses it with two NEW rows (never an edit, balance may go negative), the resold tail is displaced, offline scans judged at scan time."
type: decision
last_verified: 2026-10-03
---

# Live decisions — settlement and the ledger

Every rule here exists because a club-facing outcome went wrong in a specific way. The why is
recorded so the next agent who sees only the cost does not reverse it. The unit and the
charge-at-booking premise are in [`decisions.md`](decisions.md).

- **Nothing comes back once the lights have been on**, and **attendance means `CheckedInAt`** —
  never the clock and never `ChargedAt`, which under charge-at-booking is set on every row.
  Cancelling refunds in full less the late-cancellation penalty, posted as **two rows rather than
  one net row**, because a net row cannot answer "how much penalty did I pay?".
- **A settled no-show releases the court** by truncating the row's `EndsAt` to the sweep clock in
  the same save as the status and the money. *Why this shape:* the GiST exclusion constraint and
  every overlap predicate exempt only Cancelled; adding a NoShow exemption would let a fresh
  no-show be overwritten before settlement. Before it, a swept no-show held its whole slot dark and
  unsellable.
- **There is no "un-no-show" endpoint.** Compensate through the admin adjustment, **naming the
  booking** (`relatedBookingId`, positive `AdminAdjustment`): the reversal then skips the money legs
  (`manual_compensation`); an unnamed one is invisible and the member is corrected twice.
- **Late attendance evidence reverses a settled no-show.** A box offline past the grace window
  lights the court from its roster and queues the scan; by upload time the sweep has already
  refunded and penalised the member who actually played. `ReverseNoShowAsync` posts **two new rows,
  never an edit** — a debit reversing the refund and a credit reversing the penalty, each read back
  off the ledger rather than recomputed from settings that may have moved, each **the same type as
  the row it reverses with the opposite sign** so every report bucket nets back to the truth and the
  `BookingCharge` stands as the one thing paid. *Why not new ledger types:* the buckets would show
  a refund and a penalty that, net, never happened. The WEBHOOK name follows the sign instead
  (`minutes.refund_reversed` / `minutes.penalty_returned`, `LedgerService.MirrorTypeOf`, R6 E6-11):
  `minutes.refunded` −45 told a consumer the opposite of its figure; the trace words them likewise.
- **A no-show refunded in full because no box was reachable (§6a) stays `NoShow`** — the money and
  every reversal path are untouched — but is stamped `OutageRefundedAt`, and every admin count, list
  word (`refunded_outage`) and detail flag reads `Domain.NoShows`, never the raw status (R6 E6-6).
  *Why:* the member is mailed "you have not been marked down"; the admin read "No-shows 2" for one.
- **The reversal posts whatever the balance is.** It is a correction, not a purchase; a member who
  spent the refund goes negative, which is the honest state — they owe the court they played on —
  and the next booking's balance guard collects it. No balance check, deliberately.
- **The reversal restores `EndsAt` and displaces the resold tail.** Leaving it truncated while the
  box's own timer ran the lights to the original end left the tail sellable while the court was lit,
  and the second buyer was then swept for a court someone else was on. Every later overlapping
  booking nobody checked in on is cancelled with its money returned (`ResoldTailRefunded`, its own
  reference, an audit row, an email, a `booking.displaced` event); one somebody *did* check in on
  survives and is named on the reversal audit row as a collision — two people cannot both have
  played and the ledger does not guess.
- **Offline scans are judged at scan time, not upload time** (cue gate, `CheckedInAt`, code
  liveness at `OccurredAt`); only a future timestamp or one past **30 days** is clamped, audited.
  *Why not the roster's six hours:* that bounds fetch-to-scan; the event age bounds the OUTAGE, the
  very thing the queue survives — the six-hour clamp re-created the refund-and-penalise outcome.
- **A cancelled booking lit offline is charged the whole minutes the relay actually ran, rounded
  DOWN** (`LitWindow.ChargeMinutes`); the board, trace and audit show the same interval rounded up
  (`LitWindow.Minutes`). Cancelling never expired the roster code, so a box in a WiFi drop lit a
  refunded court and nothing recovered the money. *Why two counts (P13, contract §12.6):* every
  money remainder stays with the payer, but a court lit 61 s WAS lit into its second minute.
- **Booking-activation codes never identify a buyer or a payer** (`IdentificationResolver`: a user
  only for `MemberIdent`). A roster code travels in clear on the LAN and sits in box RAM for hours.
