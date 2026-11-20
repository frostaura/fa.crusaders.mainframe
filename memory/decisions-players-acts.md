---
name: technologies-crusaders-squash-control-system-decisions-players-acts
description: "Seat acts on a booking: pay what you can when short, collect and accept-on-behalf at the desk, at_daily_limit and booking_full, one consent rule, who changed a share and who removed or added a seat."
type: decision
last_verified: 2026-11-20
---

# Live decisions — acting on a seat (players, partners, the desk)

Money rules: [`decisions-players.md`](decisions-players.md); who/why: [`decisions-share-causes.md`](decisions-share-causes.md);
lost races, twins and the accept/cancel row lock: [`decisions-players-acts-races.md`](decisions-players-acts-races.md).

## Pay what you can (Dean: "the others should be able to decide how to split what's left")
Spec `players-and-splits.md` §4, §6's notice table, §7. Pinned in `PayWhatYouCanHttpTests` and
`components/players/__tests__/leftoverSplit.test.tsx` / `payWhatYouCan.test.tsx`.
- **The partner's side is an accept with `payMinutes`** — valid when `max(1, paid) ≤ payMinutes < share`
  (`PayWhatYouCan.IsValid`), else `400 pay_minutes_invalid`. **Only a partner who is SHORT may**: paid + spendable
  covering the share is `409 share_affordable`, read under the payer lock (2026-11-13, BM-5; *why:* any partner could
  drop to 1 minute and leave the organiser covering it). Same locks and one save as an ordinary accept: the booking is
  re-split to `amount` via `PlayersService.Resplit` (others keep their shares; the organiser's seat is the remainder),
  the seat's share and consent become `payMinutes`, the reconcile posts the pair. *Why no organiser row:* the
  organiser paid the whole price at booking; the larger seat share IS them covering it.
- **`booking_participants.ShortfallMinutes`** (migration `AddSeatShortfall`, `CHECK ≥ 0`) accumulates on a seat and is
  cleared on EVERY seat by any successful `PUT /split` (even one that moves nothing). The detail reads
  `players[].shortfall_minutes` and `money.left_to_cover_minutes` (live partners, Booked or Completed games only).
  The organiser is told `players.shortfall` (inbox + mail, not urgent, not coalesced), dropped at release
  (`shortfall_split`) once the shortfall is gone. **"Split what's left"** is a separate dialog over the same split
  route: the short partner locked, portions for the organiser and every other live paying partner (never a guest or a
  settled-by-hand seat), equal opening split with the organiser keeping the remainder, Save only at exactly the
  shortfall; a partner asked for more is asked again (the raise rule). Built as `877c1cf4`; its PR #4 was closed
  unmerged while the commit reached `main`.

## Desk acts
- **Collect** (R16): an unanswered invite is `409 player_not_accepted`, a settled seat `409 share_settled_outside`;
  `allow_negative_balance` is honoured only when spendable < due, re-decided under the partner's lock
  (`ShareLedger.CollectShortException`); the refusal carries `collect_minutes`, `balance_minutes`; the desk's seat row
  says `collect_needs_overdraft` (null = not applicable).
- **Accept-on-behalf** records `players.accepted_by_club` in the act's own save and an organiser inbox
  `players.response` line; it records NO consent. **Settle-outside tells both** (`players.game_changed` with
  `SettledByHand`: partner mailed, organiser inbox only); its dedupe key is per act (a seat may be settled twice — the
  property suite caught the unique-key 500); a later cancel says "between you and <organiser>".
- **`409 at_daily_limit {user_id, name}`** on organiser and desk adds when the member already holds the cap that club
  day (`PartnerCapRefusalAsync`, future games only); booking creation with such a player still books, with
  `players_error: at_daily_limit`.
- **No room is said as no room** (R19): `PlayersService.FullRefusal` in `AddAsync` — four live seats (organiser counted)
  → `409 booking_full {max_players: 4}`; fewer free seats than asked → `409 too_many_players {max_players: 3,
  free_seats}`; a NAMED seat someone holds with room elsewhere stays `seat_taken`. Checked after `already_in_booking`,
  before the invite-loop and cap rules.
- **One consent rule** (R16 J16-1): `PlayerNotices.NeedsConsent` everywhere (detail, invite view, `/me/invites/{pid}`,
  split). Seat rows and invites carry `share_changed_by` `organiser|club|null` + `share_changed_by_name` (organiser
  only; a desk change is never named to a member) off the newest `players.split_changed` record (`ShareChanger`).
- **Who took a seat off, who put it on** (R15 J15-1): the 404 booking detail (own seat only) and `GET /me/invites/{pid}`
  carry `removed_by: "club"|"organiser"|null` (off the `players.removed` record; null when not removed or pre-R14);
  invites (list, single, token view) carry `added_by_club` (`InvitedByUserId` ≠ organiser, guests never,
  `SeatFacts.AddedByClub`). *Why:* "Mia took you off" must never be said of the club's act.
