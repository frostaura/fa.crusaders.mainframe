---
name: crusaders-mainframe-decisions-backend-r13b
description: "Backend, review round 13 (lane BE13b): one frame per sweep and reversal, a withdrawal is the partner's act, who cancelled is read from the record, off-game links name the seat."
type: decision
last_verified: 2026-10-05
---

# Live decisions — backend, review round 13 (lane BE13b)

Contract: C13-1…C13-7 (lane scratch contract, folded into this topic). Earlier: `decisions-backend-r12.md`.

- **One action, one frame — now the sweep and the late reversal too** (E13-5, C13-2). `NoShowWorker`
  opens a `WalletFrameScope` per due booking before settling and releases after the `ShareHook`
  follow-up; `ReverseNoShowAsync` holds its booking and runs the share hook INSIDE the hold
  (`SharesFollowAsync`) — the device batch's own hook afterwards finds nothing. Frame: settlement
  reason, net delta, share rows last in `parts`, `share_cause` from the share. *Why:* the organiser
  toasted twice, 50–250 ms apart. Partners' frames are unchanged (one share row).
- **A withdrawal is the partner's act** (E13-4, C13-4): `players.withdrew` audit (actor = subject =
  partner, `paid_minutes`), the return posted with the partner as actor (`ReconcileOptions(me)`), receipts
  "— you withdrew / they withdrew". A return that waits because the organiser's free balance is below
  zero is the coverage rule working (decisions-players-returns), not a missing return — fixtures that
  insert a charge without crediting the organiser see exactly that.
- **Who cancelled is read from the record** (J13-6, E13-6, `BookingCancellation`): the `booking.cancelled`
  audit row's actor (≠ booker ⇒ club) and `waive_reason` (the desk's required reason), or the
  displacement marker. Never written to `Booking.CancellationReason` (money discriminator). Members are
  told "the club", never the admin's name. Detail: `cancelled_by` / `cancel_cause` / `cancel_reason`.
- **A member off the game is linked to their seat** (J13-3): `/bookings/{id}?seat={seat}` in share
  receipts, return-waiting and taken-off mails and inbox — the page's `NotOnGame` reads it. Chosen over
  dropping the link: the page already had the state.
- **The outage reversal's stored line names a partner scanner** (E13-3): "— Sam Partner checked in after
  all"; the payer's own scan keeps "the member was…" (FE MEMBER_VOICE maps only that).
- **`booking.created` `actor.is_admin` is `User.IsAdmin`** — the E13-2 rule, not `actorId != userId`.
- **Mail promises** (J13-7, J13-9): the club-seat mail says a share moves on accept OR a club collect; the
  revoke mail's reason is a labelled fact row.
- **C13-7 (counterparty_name per share part, court_name/booking_starts_at on the frame)** lives entirely
  in `LedgerService` (BE13a's file this round): `WalletFrame.BookingId` landed; the LedgerService patch
  and its test were handed over, not applied by this lane.
- Tests: `R13SweepFrameHttpTests`, `R13PlayersWordsHttpTests`, `R13MailWordsTests`,
  `R13BookingCreatedActorHttpTests`; R9 outage tests moved to the one-frame contract.
- **Method, 2026-10-05:** with lanes sharing one tree, a sibling's half-written test file breaks every
  build. The lane ran its filtered suites in an rsync'd copy of `src/backend` (+ `docker-compose.yml`,
  `nginx/`, `docs/`, `whitelizard.txt`, which the repo-root tests look for) under its scratchpad.
