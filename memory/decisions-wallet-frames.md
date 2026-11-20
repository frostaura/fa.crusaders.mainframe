---
name: crusaders-mainframe-decisions-wallet-frames
description: "What the live wallet balance frame tells the phone: a precise reason and signed parts, one frame per action held across scopes, the share cause, who acted, who checked in, and the named frame before its unnamed twin."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the live wallet frame (server side)

The `balance` SSE frame is how a member's phone learns a movement it did not ask for. How the phone words it is
[`decisions-frontend-wallet-live.md`](decisions-frontend-wallet-live.md). Built in `Services/LedgerService.cs`
(`PublishFrameAsync`); none of the fields below is stored on a ledger row unless said.

- **A precise `reason` and `parts`** (R10 E10-1). `LedgerPosting` has an UNSTORED `StreamReason`
  (`WalletStreamReasons`: `outage_refund`, `outage_refund_reversed`, `no_show_settled`, `no_show_reversed`,
  `pay_for_refund`, `pay_for_charge`, `displaced_refund`, `displaced_reinstated`); real cancellations keep
  `cancellation_refund` / `mixed`. `parts` is each row's `{reason by type, delta_minutes}`, summing to the delta.
  *Why:* an outage refund, its −32 reversal and a pay-for refund all toasted "A cancelled booking put N minutes back",
  and a no-show `mixed` +11 hid its penalty. **A new posting site that is not a plain cancellation sets one.**
- **One action, one frame per member** (R12 X12-1, contract C1). `WalletFrameHolds` (singleton keyed tenant+booking,
  via `RealtimeOutbox.Holds`) + `WalletFrameScope`: the desk, member and bulk cancel endpoints hold the booking's frames
  across the `ShareHook` follow-up's scope; release sends one — reason = the first (primary), delta = net, parts =
  every row. A frame is held only when every row names the held booking. R13 extended it to `NoShowWorker` (a scope
  per due booking, released after the share follow-up) and `ReverseNoShowAsync` (runs the share hook INSIDE its hold,
  `SharesFollowAsync`; the device batch's later hook then finds nothing); share rows go last in `parts`. *Why:* refund
  +30 then share −15 toasted twice, 50–250 ms apart, from two commits in two scopes. Partners' frames are one share row.
- **`cancelled_by`** ("club" when an admin cancels somebody else's court, else "member"; null on non-cancellations).
- **Why a share moved: `share_cause`** (+ `share_kept_minutes` on a no-show), carried on the unstored
  `LedgerPosting.Share` and decided by `ShareLedger.CauseOf` from the receipts' own facts
  ([`decisions-share-causes.md`](decisions-share-causes.md)). It reaches only the FRAME (`LedgerService.cs:268`); `GET
  /wallet` rows read a cause re-derived off the record (`ShareRowCauses`), never a stored column.
- **Place and people:** each `parts` item carries `counterparty_name` (non-null on a share or pay-for leg,
  `LedgerPosting.CounterpartyUserId`), the frame `court_name` and `booking_starts_at` (`LedgerService.cs:261-265`) and
  `BookingId`. `actor_name` names the actor only when they are a player on the game and not the frame's own member
  (`ShareWhy.ActorIsPlayer`); admins stay "the club"; `share_paid` names nobody.
- **Who checked in:** `checked_in_by_name` (null when it was the frame's own member) on reversal and attended-share
  frames — the scanner is the seat stamped at `booking.CheckedInAt`, else the earliest `court.activated` scanner, else
  the booker (`ClubCancelNotices.CheckedInByAsync`, the one rule); `checked_in_by_you` when the late check-in was this
  member's own scan. The started-session cancel frame is built in `BookingService` and sent with `PublishFrameAsync`.
- **A desk-made booking's charge frame names the club** (R17 E17-1): `LedgerPosting.ByClub` → `WalletFrame.ByClub`
  (merged with OR) → `actor_name: "The club"` (`LedgerService.ClubActorName`), the mail's `MadeByClub` rule (actor ≠
  member). No inbox line: the member inbox has no club-booking kind.
- **Balance-neutral frames** the phone must still announce: `cancelled_no_refund` (the club cancelled a started session
  of the booker's, R14 E14-5) and `cancelled_share_stands` (each accepted, not-settled partner who PAID > 0 on such a
  game, R16 J16-7 / R17 E17-2, from `ShareSweep`), both naming the checker. `share_set_aside` (delta 0) is published
  when a waiting return's stamp is set or cleared ([`decisions-players-returns.md`](decisions-players-returns.md)).
- **The named `balance` frame is sent BEFORE its unnamed legacy twin** (R15 X15-6), so an older client sees the twin as
  a zero diff; every stream also opens with an unnamed snapshot. The client tags `onmessage` frames `"unnamed"`.
