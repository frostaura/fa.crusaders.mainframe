---
name: crusaders-mainframe-decisions-backend-r10
description: "Backend, review round 10 (lane BE10): an applied desk key replays before any shelf check, the wallet frame says why, the scanner is named, club refunds say so, ledger lines are the club's voice."
type: decision
last_verified: 2026-10-03
---

# Live decisions — backend, review round 10 (lane BE10)

- **A desk sale's idempotency key is looked up BEFORE the price and shelf checks** (J10-2,
  `WalletEndpoints.Desk.ReplayedSaleAsync`). *Why:* a retry after the discount moved or the package
  retired answered 409, the sheet said "Nothing was recorded", minted a new key and sold twice. The
  package is read by id, archived or not; a changed payload under the key is still
  `idempotency_key_reused`; the answer quotes the price the desk confirmed. Mutation-checked.
- **The live wallet `balance` frame carries a precise `reason` and `parts`** (E10-1). `LedgerPosting`
  has an UNSTORED `StreamReason` (`WalletStreamReasons`: `outage_refund`, `outage_refund_reversed`,
  `no_show_settled`, `no_show_reversed`, `pay_for_refund`, `pay_for_charge`, `displaced_refund`,
  `displaced_reinstated`); real cancellations keep `cancellation_refund` / `mixed`. `parts` is each
  row's `{reason by type, delta_minutes}`, summing to the delta. *Why:* an outage refund, its −32
  reversal and a pay-for refund all toasted "A cancelled booking put N minutes back", and a no-show
  `mixed` +11 hid its penalty. A new posting site that is not a plain cancellation sets one.
- **"Who scanned" is the identified member** (E10-2). `booking.lights_on`'s actor and
  `data.identified_user_id` are the scanner (organiser, accepted partner or pay-for payer);
  `user_id` stays the owner, `paid_by_user_id` is who paid. Every `court.lights_on` audit row records
  `identified_user_id`, and the admin trace event's `code_holder {user_id, name}` names it, so the
  Night says "with Pam's code" on Olga's booking (FD10 renders it). The cue worker's own
  `booking.lights_on` still lacks `paid_by_user_id` / `identified_user_id` (pre-existing divergence).
- **A pay-for refused `code_used` is on the payer's Night** like activate and walk-up (D10-1),
  attempt `pay_for`, quote and confirm both; the code is never recorded.
- **Door `code_used` is "Code already used"** (`DoorWords`) and is a log filter value
  (`DoorTrail.Reasons`, NOT `GateAccess.Reasons`, which the gate corpus pins) (E10-4).
- **Stored ledger lines are the club's voice** (E10-6): "Outage refund reversed — the member was
  checked in after all", "Booking reinstated — … before this slot"; displacement rows say "Refunded in
  full — the court was already in use …", never the `ResoldTailRefunded` token (that stays a
  `CancellationReason` marker). The member wallet maps the third person back to "you" (FC10).
  *Why:* the admin ledger shows the stored line as is.
- **A share returned because the CLUB refunded the session says so** (E10-7): `ShareLedger.ClubRefundOf`
  — outage, displaced, no-show (never after a reversal; a collect/removal keeps its own words) — sets
  `club_refund` on the `players.share_moved` payload and mail; headline "16 minutes of your share came
  back — the club refunded the session: the court's box was offline".
- **A take-back below the shortest court says so in the mail** (J10-3): "That leaves 10 minutes to
  spend — less than the 15 minutes a court needs." Spendable (not balance) against `slice_minutes`.
- Contracts handed to the frontend lanes: scratchpad asks BE10→FC10 (stream), →FD10 (code_holder,
  door), →FB10 (ledger line table), →integrator (types, webhooks doc).
