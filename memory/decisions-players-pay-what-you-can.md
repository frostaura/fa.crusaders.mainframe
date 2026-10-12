---
name: crusaders-mainframe-decisions-players-pay-what-you-can
description: "Pay what you can (2026-10-12): a short partner accepts paying part of their share; the booking becomes an amount split, the organiser covers the rest with no new ledger row, is mailed players.shortfall, and any re-split clears ShortfallMinutes."
type: decision
last_verified: 2026-10-12
---

# Live decisions — players: pay what you can

Spec: `docs/specs/players-and-splits.md` §4 ("Pay what you can"), §6's notice table, §7. Asked by
Dean: "if players don't have enough minutes to pay their split, the others should be able to decide
how to split what's left." Pinned in `PayWhatYouCanHttpTests` (backend) and
`leftoverSplit.test.tsx` / `payWhatYouCan.test.tsx` (frontend).

- **The partner's side is an accept with `payMinutes`** — the share the seat will stand at, valid
  when `max(1, paid) ≤ payMinutes < share` (`PayWhatYouCan.IsValid`), else `400 pay_minutes_invalid`.
  It is the ordinary accept under the same locks and one save: the booking is re-split to `amount`
  through `PlayersService.Resplit` (other partners keep their shares; the organiser's seat is the
  remainder), the seat's share and consent become `payMinutes`, and the reconcile's own collection
  posts the pair. *Why no organiser row:* the organiser paid the whole price at booking; their
  larger seat share IS them covering it.
- **`booking_participants.ShortfallMinutes`** (migration `AddSeatShortfall`, `CHECK ≥ 0`) records
  what could not be paid; it accumulates on a seat and is cleared on EVERY seat by any successful
  `PUT /split` — the organiser deciding, even with a split that moves nothing. The detail reads it
  as `players[].shortfall_minutes` and `money.left_to_cover_minutes` (live partners, Booked or
  Completed games only).
- **The organiser is told** with `players.shortfall` (inbox + mail, not urgent, not coalesced); the
  mail is dropped at release (`shortfall_split`) once the shortfall is gone.
- **"Split what's left"** (organiser, booking page) is a separate dialog over the same split route:
  the short partner locked, portions for the organiser and every other live paying partner (never a
  guest or a settled-by-hand seat), equal opening split with the organiser keeping the remainder,
  Save only at exactly the shortfall. A partner asked for more is asked again (the raise rule).
- **MEMORY.md index not regenerated** in the session that added this file — the tree-root
  `audit-tree.py` was not present in that checkout; run it from the tree root.
