---
name: crusaders-mainframe-decisions-backend-r16b
description: "Backend round 16 (lane BE16b): an add's share move is the adder's act (player_added), one consent rule, at_daily_limit, collect tick only when short, badges at session end, picker tiebreak."
type: decision
last_verified: 2026-10-05
---

# Live decisions — backend, review round 16 (lane BE16b)

Earlier: `decisions-backend-r15b.md`. Tests: `R16SeatActsHttpTests`, `R16WordsHttpTests`,
`R16NightBadgesPickerHttpTests` (28/28 red at HEAD 3d3c25f5 first). Commit 56018952.

- **An add that lowers an equal/ratio split is on the record** (J16-2): one `players.split_changed`
  per partner whose share moved, details `because: "player_added"`, `joined` (names), `by_club`, in
  the add's save; the reconcile runs with the adder as actor. Cause `player_added`
  (`WalletShareCauses.PlayerAdded`) for frame, inbox, mail, Night, CSV. *Why a split_changed and
  not a new action:* every reader of split changes (SeatFacts, ShareRowCauses, Night) picks it up.
  Accept/decline/accept-on-behalf reconciles keep NO actor: a waiting return of another seat
  retried there would otherwise be misattributed to them.
- **One consent rule** (J16-1): `PlayerNotices.NeedsConsent` everywhere (detail, invite view,
  `/me/invites/{pid}`, split answer). `share_changed_by` `organiser|club|null` +
  `share_changed_by_name` (organiser only) off the newest split record (`ShareChanger`).
- **`409 at_daily_limit {user_id, name}`** (J16-11) on organiser and desk adds when the member
  already holds the cap that club day (`PartnerCapRefusalAsync`, future games only). Booking
  creation with such a player still books; `players_error: at_daily_limit`.
- **Collect** (E16-8/J16-10): unanswered invite `409 player_not_accepted`, settled seat
  `409 share_settled_outside`; `allow_negative_balance` only when spendable < due — re-decided
  under the partner's lock (`ShareLedger.CollectShortException`), refusal carries
  `collect_minutes`, `balance_minutes`. Desk seat row: `collect_needs_overdraft` (null = n/a).
- **Accept-on-behalf** (E16-1): `players.accepted_by_club` (subject partner, actor admin,
  organiser in details) in the act's save; Night kinds `booking.accepted_for_them` /
  `club_accepted_player` / `accepted_for_player`; organiser inbox `players.response` line.
- **Settle-outside tells both** (J16-6): `players.game_changed` with `SettledByHand` (partner
  mailed, organiser inbox only); dedupe key per act (a seat may be settled twice — the property
  suite caught the unique-key 500). A later cancel says "between you and <organiser>".
- **Started club cancel** (J16-7): each accepted, not-settled partner gets a balance-neutral
  frame `reason: cancelled_share_stands` (sent from `ShareSweep` via `ShareLedger.PublishFrameAsync`).
- **Words**: share lines name court AND day (withdraw, no-show, club refund) and a club removal
  its cause (E16-4); the Night's withdrawal rows go through the share sentence; collect mail to
  the organiser is the club's (E16-5); `court.activated` / reversal in the night-owner's voice
  via `TraceFacts.ByOther` / `ForOther` (E16-6).
- **Actor truth** (E16-7): ledger `actor_name` null only for own act and system, else the actor
  (shares by another member too); `actorName` agrees, "Automatic" for `Guid.Empty`. CSV `done_by`
  never blank: You / The club / Automatic / the player; a pay-for's legs name each other.
  `share_returned` stays the withdrawal cause (withdrawal-only since R14; FE copy keys on it).
- **Badges at session END** (E16-9): `AttendedSession.EarnsBadgesAt(now)` — ended, not cancelled;
  `PlaySweep` re-arms the marker to `EndsAt` after the start's pass. *Why:* badges are never taken
  back (play.md §3.3) and only the club can cancel a started session. NOT done: "only players
  who scanned" — R2's founder default (a partner who walked in behind the scanner counts) stands
  until the founder says otherwise.
- **Picker tiebreak** (J16-3): directory, favourites, recent carry `played_with_you`,
  `last_played_with_you_at`, `member_since` (yyyy-MM-dd). Admin combobox already had
  membership number and email.
