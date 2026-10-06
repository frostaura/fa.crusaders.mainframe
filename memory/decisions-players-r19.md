---
name: crusaders-mainframe-decisions-players-r19
description: "Players round 19 (lane BE19j): a lost accept re-reads the seat; cancel refunds read off the ledger after the fact; a full booking is booking_full; identical re-split twins answer 200."
type: decision
last_verified: 2026-10-06
---

# Live decisions: players and splits, review round 19 (lane BE19j)

- **A lost accept is answered for the seat as it now stands (J19-1).** `AlreadyAnsweredAsync` →
  `AfterLostAcceptAsync` when the seat is not the caller's accepted seat: gone or claimed by another
  member → `invite_closed`; closed or cancelled → the accept's own `StandingRefusal` (`booking_not_open`,
  `invite_closed`, …); still open → `409 share_changed {share_minutes}` when the share differs from the
  `expectedShareMinutes` shown (UP **or down** — the next tap must be on the figure now on the sheet;
  the client's copy "Your share is now X" reads true both ways), else `409 conflict_retry` (R18's lost-race
  answer, not 503). *Why:* a re-split or nudge landing between the accept's read and its save answered
  "This invite has closed" above an open Accept button. Decline/withdraw already go through
  `SaveAsync(Landing)` → `conflict_retry`, never `invite_closed`; no change.
- **Cancel refunds are read after the cancel, off the ledger (J19-4).** `SplitCancelView.AfterAsync(id, ct)`:
  paid at the cancel = still paid in + returns posted from `CancelledAt` on (`ReturnedOfAsync`, the
  detail view's M4-4 rule); refund = that − `TargetFor`. *Why:* the pre-cancel snapshot missed an accept
  that landed while the cancel waited on the booking row (accept holds `FOR NO KEY UPDATE`), so the answer
  said `partner_refunds: []` while the ledger refunded the share. *Rejected:* computing inside the cancel's
  lock (BookingService, another owner, and the accept's own reconcile can post the return before the
  cancel's hook does, so "the cancel's own moves" is not reliable either). A collection cannot land after
  a cancel commits, so it is always in "still paid"; a waiting return is still paid in, so still reported.
  All three answers (member, desk, bulk cancel) call `AfterAsync(id, ct)`; the pre-read and its overload are gone.
- **No room is said as no room (J19-5).** `PlayersService.FullRefusal` in `AddAsync` (organiser and desk,
  member/guest/link): four live seats (organiser counted, written or not) → `409 booking_full {max_players: 4}`;
  fewer free seats than players asked → `409 too_many_players {max_players: 3, free_seats}`. A NAMED seat
  someone holds with room elsewhere stays `seat_taken`. Checked after `already_in_booking`, before the
  invite-loop and cap rules. Frontend already maps both codes (`PLAYERS_REFUSAL`).
- **An identical re-split twin is 200 (J19-6).** `ChangeSplitAsync` on a lost save (`conflict_retry`) →
  `SplitTwinAsync`: re-load, re-run `Resplit` on the fresh seats; mode, every live share, weight and consent
  unchanged → the same 200 body (`SplitAnswer`), nothing written (tracker cleared). Different split, or any
  other writer → `conflict_retry` as before.
- Tests: `R19PlayersHttpTests.cs` (`R19AcceptRaceHttpTests`, `R19CancelAnswerHttpTests`,
  `R19BookingFullHttpTests`, `R19SplitTwinHttpTests`) on R18's `TwinWriter`; a removal twin runs as SQL on its
  own connection (an HTTP removal waits on the inbox rows the accept marks read — test-rig deadlock only).
