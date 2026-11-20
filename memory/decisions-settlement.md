---
name: crusaders-mainframe-decisions-settlement
description: "How the ledger settles: a no-show releases its tail by truncating EndsAt, late evidence reverses it with two NEW rows (balance may go negative), the resold tail is displaced, offline scans judged at scan time."
type: decision
last_verified: 2026-11-20
---

# Live decisions — settlement and the ledger

Charge-at-booking, the two-row cancellation, "nothing back once the lights have been on", the reference rules and
"attendance means `CheckedInAt`" are CLAUDE.md invariants (the premise and its unsigned-off status are in
[`decisions.md`](decisions.md)); `docs/specs/settlement-model.md` is the authority. What follows is how the ledger settles
beneath them. Every rule exists because a club-facing outcome went wrong in a specific way — keep the why.

- **A settled no-show releases the court** by truncating `EndsAt` to the sweep clock in the same save as the status and
  the money. *Why this shape:* the GiST exclusion constraint and every overlap predicate exempt only Cancelled; a NoShow
  exemption would let a fresh no-show be overwritten before settlement. Before it, a swept no-show held its slot dark.
- **There is no "un-no-show" endpoint.** Compensate through the admin adjustment **naming the booking**
  (`relatedBookingId`, positive `AdminAdjustment`): the reversal then skips the money legs (`manual_compensation`); an
  unnamed one is invisible and the member is corrected twice. A goodwill credit naming the booking lowers `Owed`, so it
  passes a pro-rata refund on to partners (Dean, 2026-09-28 — [`decisions-players.md`](decisions-players.md)).
- **Late attendance evidence reverses a settled no-show.** `ReverseNoShowAsync` posts **two new rows, never an edit** — a
  debit reversing the refund and a credit reversing the penalty, each read back off the ledger (never recomputed from
  settings that may have moved), each **the same type as the row it reverses with the opposite sign**, so every report
  bucket nets back and the `BookingCharge` stands as the one thing paid. *Why not new types:* the buckets would show a
  refund and a penalty that, net, never happened. The WEBHOOK name follows the sign (`minutes.refund_reversed` /
  `minutes.penalty_returned`, `LedgerService.MirrorTypeOf`): `minutes.refunded` −45 told a consumer the opposite.
- **The reversal posts whatever the balance is** — a correction, not a purchase; a member who spent the refund goes
  negative, the honest state, and the next booking's balance guard collects it. No balance check, deliberately.
- **The reversal restores `EndsAt` and displaces the resold tail.** Leaving it truncated while the box's own timer ran
  the lights to the original end left the tail sellable while the court was lit. Every later overlapping booking nobody
  checked in on is cancelled with its money returned (`ResoldTailRefunded`, its own reference, an audit row, an email, a
  `booking.displaced` event); one somebody DID check in on survives and is named on the reversal audit as a collision —
  two people cannot both have played and the ledger does not guess.
- **A no-show refunded in full because no box was reachable (§6a) stays `NoShow`** but is stamped `OutageRefundedAt`;
  its ledger reason is "Court N was offline — booking refunded in full", never "No-show", and every admin count, list
  word (`refunded_outage`) and detail flag reads `Domain.NoShows`, not the raw status. *Why:* the member is mailed "you
  have not been marked down"; the admin read "No-shows 2" for one. **An outage refund reversed by a late check-in is
  never a no-show**: stored line "Outage refund reversed — the member was checked in after all" or "— {scanner} checked
  in after all" (`BookingService.cs:2096-2097`), audit carries `peripheral_outage`, mail `OutageRefundReversed`, no
  penalty row; a share re-taken is `AfterAttendance`. The cost of that §6a refund is [`watch.md`](watch.md) item 5.
- **Stored ledger lines are the club's voice** (R10 E10-6), shown as-is on admin ledgers and mapped to "you" on the
  member's: "Booking reinstated — … before this slot"; displacement rows "Refunded in full — the court was already in
  use …", never the `ResoldTailRefunded` token (that stays a `CancellationReason` marker).
- **Offline scans are judged at scan time, not upload time** (cue gate, `CheckedInAt`, code liveness at `OccurredAt`);
  only a future timestamp or one past **30 days** is clamped, audited. *Why not the roster's six hours:* that bounds
  fetch-to-scan; the event age bounds the OUTAGE, the very thing the queue survives — a six-hour clamp re-created the
  refund-and-penalise outcome.
- **A cancelled booking lit offline is charged the whole minutes the relay ran, rounded DOWN** (`LitWindow.ChargeMinutes`);
  board, trace and audit show the interval rounded up (`LitWindow.Minutes`). Cancelling never expired the roster code,
  so a box in a WiFi drop lit a refunded court and nothing recovered the money. *Why two counts (P13 §12.6):* every money
  remainder stays with the payer, but a court lit 61 s WAS lit into its second minute.
- **Booking-activation codes never identify a buyer or a payer** (`IdentificationResolver`: a user only for
  `MemberIdent`) — a roster code travels in clear on the LAN and sits in box RAM for hours.
- **Booking movements are referenced by their booking, not a unique key** (CLAUDE.md corrected 2026-11-13): a reinstated
  booking may be refunded again, and a unique `cancel:{booking}` reference would 500 a legitimate refund. A bulk-cancel
  key is hashed into its reference (a 199-char key overflowed the 255 column).
- **Bookings past `no_show_lookback_days` and never settled raise `booking.unsettled` daily**; the sweep still never
  settles them itself (it cannot know, that late, whether the court was played). The desk decides them row by row at
  `/admin/bookings` "Never settled" ([`decisions-admin-console.md`](decisions-admin-console.md)).
- **The sweep writes its verdict before its money** and every share movement follows the settlement through `ShareHook`
  ([`decisions-night.md`](decisions-night.md), [`decisions-players.md`](decisions-players.md)). `SweepOneAsync` sits at
  lizard's ceiling (length 200, CCN 15): extract before adding.
