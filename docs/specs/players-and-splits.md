# Players and splits (D11–D13)

**Up to four players on a booking, and who pays what.** Playtomic is the reference and the bar:
partners on a booking, the cost split any way, invites that work over WhatsApp — and none of its
known failures: partners who never pay, a running ledger of debts between friends, equal-only
splits, social features that expose members who never asked to be found.

It is normative for the backend. The frontend builds from the endpoint catalogue in §7. Where code
and this document disagree, one of them is a defect; say which.

---

## 1. The model

- **The booking stays single-payer.** The organiser (the booking's payer — seat 1) is charged the
  whole price at booking, exactly as for a one-player booking, and every settlement path — cancel,
  no-show, reversal, displacement, a cancelled court lit after all, a release — keeps settling
  against the organiser alone. `settlement-model.md` is untouched and still true of a split booking.
- **A partner's share moves to the organiser** as a `ShareTransfer` ledger pair when they accept:
  one row debits the partner, the other credits the organiser, both naming the booking, posted in
  one save under references `share:{participant}:{seq}:out` (the debited member's row) and
  `:in` (the credited member's). The pair nets to zero, so **no club report moves** — revenue,
  spend, refunds, penalties and the per-booking `Owed` sum are what they were.
- **`booking_participants`** — one row per seat: `Seat` 1–4 (1–2 team A, 3–4 team B; 1 is the
  organiser), `UserId` (null for a guest or an unclaimed link seat), `GuestName`, `Status`
  (`invited` · `accepted` · `declined` · `withdrawn` · `removed` · `lapsed`), `ShareCredits` (what
  the seat is asked to pay), `ConsentedCredits` (the most the partner agreed to), `ShareWeight`,
  `SplitMode` (seat 1 only), `InviteTokenHash`, `CheckedInAt`, `SettledOutsideAt`, `LapsedAt`,
  nudge and reminder counters, and `Version` (optimistic concurrency, bumped by the context).
- **The four-player ceiling is the database's**: `Seat BETWEEN 1 AND 4` and a unique index on
  `(tenant, booking, seat)` partial on the live statuses (`invited`, `accepted`); a second unique
  index, same filter, stops one member holding two live seats. A declined or removed row keeps its
  history and frees its seat.
- **A booking with no rows is "just the booker".** Nothing is backfilled; seat 1 is written the first
  time a second player is added.
- **Guests** are named by the organiser, carry share 0 (CHECK constraint), need no acceptance, are
  not members, and are never admitted by a board.

## 2. Splitting the price

`SplitCalculator` divides the price `P` across the live seats so the shares **sum to `P` exactly,
always** (pinned over 5 000 generated cases):

| Mode | Partner seat | Organiser (seat 1) |
| --- | --- | --- |
| `equal` | `⌊P / payers⌋` — whole credits, rounded down | `P − Σ partners` |
| `ratio` | `⌊P × weight / Σ weights⌋` — weights 0–100 | `P − Σ partners` |
| `amount` | the organiser's figure, ≥ 0, ≤ 2 dp | `P − Σ partners`, refused below 0 (`split_exceeds_price`) |

Guests are in the split with share 0 and are not a head in an equal split. **The rounding rule**:
partners are rounded down to whole credits, and the organiser — who chose to split — takes the odd
credit and any sub-credit fraction. Adding a player re-splits an `equal`/`ratio` booking (every
share goes down); removing, declining or withdrawing does NOT re-split — the organiser absorbs the
freed share until they re-split themselves.

## 3. What a partner pays — the reconcile

`ShareLedger.ReconcileAsync(booking)` is the one writer of `ShareTransfer`. For each partner seat:

```
target = min( ConsentedCredits , ⌊ Owed(b) × ShareCredits / P ⌋₂ )    — ShareRules.TargetFor
paid   = −Σ the partner's rows under share:{participant}:*
post   = the pair for (target − paid)
```

`Owed(b)` is the organiser's own figure from the settlement model (every non-transfer row naming
the booking on the payer's wallet, negated), so a share follows every settlement path without a
rule of its own:

| State | Partner's target |
| --- | --- |
| not accepted (invited, declined, withdrawn, removed, lapsed) | 0 |
| settled outside the app (admin) | 0 |
| displaced (S8) | 0 |
| cancelled before anybody checked in | 0 — **the late-cancel penalty is the organiser's alone** |
| cancelled after check-in (S4) | the full share |
| no-show (S5) | pro rata of the penalty — `⌊9.60 × 16/32⌋₂ = 4.80` |
| no-show with no reachable box (S5a) | 0 |
| no-show reversed (S6), live, played | the full share |

**Idempotent**: it posts only the difference, so running it twice — or from the hook and the worker
in the same minute — writes nothing the second time. **Locked on the debited member only**: a
collection locks the partner (their balance check is the one that counts), a return locks the
organiser. Two reconciles racing to post one pair lose on the reference's unique index and re-read.

**Never a debt.** A collection the partner cannot cover is not posted; the share stays unpaid and
payable by the partner until the **share deadline** — the SOLD end plus `share_lapse_hours` (48) —
after which it lapses and the organiser's cover stands. Only an admin's explicit collect can take a
partner below zero.

**When it runs**: after every participant action (after its own commit); after each existing
settlement path commits — `POST /bookings/{id}/cancel`, `POST /admin/bookings/{id}/cancel`, the
admin bulk cancel, the no-show sweep, and each court-box event that settles a booking — through
`ShareHook`, in a fresh scope, never throwing; and in `ShareWorker`'s minute sweep over every split
booking whose game ended within `share_lapse_hours` + 7 days (which also reaches the bookings a
reversal displaced or a release reinstated). The settlement code itself is unchanged.

## 4. Consent

- A partner **accepts** a seat: the seat becomes `accepted`, `ConsentedCredits` rises to the share,
  and the first payment posts in the SAME save, under the partner's lock. A partner who cannot
  cover it is answered `402 insufficient_balance` with `current_credits` / `required_credits` and
  nothing changes.
- **Raising a share needs re-consent.** A re-split that raises a partner above their consent
  collects nothing; the seat reads `needs_consent: true`, the partner is mailed, and their next
  accept collects the difference. **Lowering refunds** at once, and lowers the consent with it, so a
  later raise is a new question rather than a debit they agreed to about a different figure.
- An **admin's accept on a member's behalf records no consent** — the reconcile collects nothing.
- **Withdraw**: an accepted partner may pull out only outside the club's late-cancel window
  (`penalty_window_minutes` before the start — the same line the organiser's own cancellation is
  held to); inside it, `409 withdraw_window_closed`.

## 5. Access, cap and the box (D12)

- **D12 — the partner's daily cap.** An accepted seat counts against the PARTNER's
  `member_max_slots_per_day` / `member_per_day_max_minutes` (their groups' caps apply), both when
  they accept (`409 partner_cap_exceeded` with the cap's figures) and when they later book for
  themselves. Asked only for a game still ahead, and only on the first yes. Peak hours, group
  windows and pricing bind the organiser only.
- **At the court**: an accepted partner with an active membership finds the booking through
  `CourtActivationService.FindForUserAsync` (QR / code), `CandidatesAsync` + `PlayersOfAsync`
  (PIN, biometric). Their scan checks the booking in and stamps their OWN seat's `CheckedInAt`; it
  never makes them the payer — **a payer override on a split booking is ignored**.
- **At the door**: an accepted partner passes `GateAccess`'s booking-window test exactly as the
  organiser does. An invited seat admits nobody.
- **Pay-for at the box (P7)** must refuse a split booking with `split_pay_in_app`. The predicate is
  `ShareLedger.IsSplitAsync(bookingId)` (and the code `ShareLedger.SplitPayInApp`); the pay-for
  route itself is P7's. Device rosters (the multi-REF entry) are P7's too.

## 6. Invites, directory, inbox

- **Invite links** — each member or open seat gets 128 random bits, base64url (22 characters),
  shown ONCE in the response and stored only as a SHA-256. The app path is `/j/{token}`. Copying a
  link again rotates it (`POST …/link`); the old one stops working. A link addressed to another
  member answers 404, like a token that names nothing.
- **Member invites by mail** link to `/invites/{participantId}` (signed in) — never a token, because
  a token written into an outbox payload would be a credential stored in clear.
- **Directory (D13)** — opted-in (`findable`), active members only, never the caller, id + name +
  photo only, a query of at least 2 characters (a LIKE wildcard is a literal), and a per-member
  budget of `directory_searches_per_minute`.
- **Recent partners** are derived (accepted seats on the same bookings in the last
  `recent_partner_days`), never stored; **favourites** are private to the member who starred them.
- **The inbox** (`member_notifications`) and member mail share the R23 outbox, generalised with an
  `Audience` (admins · member) and a `RecipientUserId`. Each notice is staged in the same save as
  its event — the inbox line and the outbox row together. Non-urgent kinds wait for the end of
  **quiet hours** (`member_quiet_start_minute`–`member_quiet_end_minute`, 21:00–07:00 club time);
  urgent ones (a share receipt, a cancelled game) go at once. The admin feed reads admin rows only.
  A named `notification` frame (`{"unread_count": n}`) is published on the member's wallet SSE
  stream after each change, so the bell can update without polling.

| Kind | To | Mailed | Urgent |
| --- | --- | --- | --- |
| `players.invited` | the invited member | yes | no |
| `players.share_moved` | both sides of every pair | yes | yes |
| `players.reminder` | an unanswered / unpaid partner (club cadence, or the organiser's nudge) | yes | no |
| `players.lapsed` | the partner and the organiser | yes | no |
| `players.game_cancelled` | every live partner | yes | yes |
| `players.game_changed` | a removed partner, or one whose share moved | yes | no |
| `players.response` | the organiser (accepted / declined / withdrew) | inbox only | — |

## 7. Endpoints

Requests are camelCase, answers snake_case. Every refusal is `{ "error": "<code>", …figures }`.

### Member

| Route | Body → answer |
| --- | --- |
| `POST /api/v1/bookings` | + optional `players: [{userId?, guestName?, link?, seat?, weight?, amount?}]`, `splitMode`, `organiserWeight`. Validated in full (against the quoted price) BEFORE booking. → `{booking_id, balance_after_credits, players: {booking_id, participants: [{participant_id, seat, user_id, guest_name, status, share_credits, invite_token, invite_path}]}, players_error}` |
| `POST /api/v1/bookings/bulk` | + the same `players`/`splitMode`/`organiserWeight`, applied to every newly booked item → adds `players: [{booking_id, players, players_error}]` |
| `POST /api/v1/players/split-preview` | `{priceCredits, splitMode, organiserWeight, players}` → `{price_credits, shares: [{seat, team, share_credits, weight}]}` — pure, for the live totals bar |
| `GET /api/v1/bookings/{id}` | → the detail: `booking_id, court_id, court_name, starts_at, ends_at, sold_ends_at, status, split_mode, viewer {role: organiser\|player\|admin, participant_id}, organiser {user_id, name, photo_url}, players [ {participant_id, seat, team, kind: organiser\|member\|guest\|open_link, user_id, name, photo_url, status, share_credits, weight, consented_credits, paid_credits, target_credits, unpaid_credits, needs_consent, settled_outside, lapsed, checked_in_at, invited_at, responded_at} ], money {price_credits, organiser_owed_credits, shares_received_credits, organiser_net_credits, unpaid_credits, share_deadline, is_split}, attendance {checked_in_at, players_checked_in}, permissions {can_invite, can_change_split, can_cancel, can_accept, can_decline, can_withdraw, withdraw_closes_at}`. 404 for anyone not on it and not an admin. |
| `POST /api/v1/bookings/{id}/players` | organiser: `{players, splitMode?, organiserWeight?}` → as the create's `players` |
| `DELETE /api/v1/bookings/{id}/players/{pid}` | organiser → `{participant_id, status}` |
| `POST /api/v1/bookings/{id}/players/{pid}/nudge` | organiser → `{participant_id, nudges_left}`; `429 nudge_limit {limit, retry_after}`; `409 nothing_to_nudge` |
| `POST /api/v1/bookings/{id}/players/{pid}/link` | organiser → `{participant_id, invite_token, invite_path}` (rotates) |
| `PUT /api/v1/bookings/{id}/split` | organiser: `{mode, seats: [{participantId, weight?, amount?}]}` → `{booking_id, split_mode, shares: [{participant_id, seat, share_credits, weight, needs_consent}]}` |
| `POST /api/v1/bookings/{id}/players/{pid}/accept` | partner → `{participant_id, booking_id, status, share_credits, consented_credits, paid_credits, balance_credits}`; `402 insufficient_balance`, `409 partner_cap_exceeded {cap: slots\|minutes, …}`, `409 invite_closed`, `409 already_in_booking`, `403 membership_inactive` |
| `POST …/{pid}/decline` · `POST …/{pid}/withdraw` | partner → `{participant_id, status}`; withdraw `409 withdraw_window_closed {closed_at}` |
| `GET /api/v1/me/invites` | → `{items: [invite], count}` — the Invites tab and badge |
| `GET /api/v1/invites/{token}` | → `invite`; 404 `invite_not_found`, 409 `invite_closed`, 409 `already_in_booking` |
| `POST /api/v1/invites/{token}/accept` · `…/decline` | as the seat routes |
| `GET /api/v1/me/partners/recent` | → `{items: [{user_id, name, photo_url, last_played_at, games}]}` |
| `GET /api/v1/me/partners/favourites` · `PUT`/`DELETE /api/v1/me/partners/favourites/{userId}` | → `{items: [{user_id, name, photo_url}]}` / `{user_id, favourite}` |
| `GET /api/v1/members/directory?q=` | → `{items: [{user_id, name, photo_url}]}`; `400 query_too_short`, `429 directory_rate_limited {retry_after_seconds}` |
| `GET /api/v1/me/notifications?cursor&limit` | → `{items: [{id, kind, headline, link, booking_id, created_at, read_at}], unread_count, next_cursor}` |
| `GET /api/v1/me/notifications/unread-count` | → `{unread_count}` |
| `POST /api/v1/me/notifications/{id}/read` · `POST …/read-all` | → `{id, read}` / `{marked}` |
| `GET/PUT /api/v1/me/preferences` | + `share_results` (D13, stored only); `findable_in_directory` and `show_on_leaderboards` accepted as aliases of `findable` and `show_in_leaderboards` |

`invite` = `{participant_id, booking_id, status, seat, team, open_link, court_name, starts_at, ends_at, organiser {user_id, name, photo_url}, players, share_credits, to_pay_credits, needs_consent, balance_credits, balance_after_credits, short_by_credits, share_deadline, cap}` — `cap` is null, or the partner-cap figures when accepting would break the partner's own daily cap.

### Admin (god mode — every one in `admin_change_log`)

| Route | Body → answer |
| --- | --- |
| `POST /api/v1/admin/bookings/{id}/players` | `{userId? \| guestName?, accepted?, reason?}` — neither: an open link seat. `accepted` places a member without their consent (collects nothing). → as the organiser's add |
| `POST /api/v1/admin/bookings/{id}/players/{pid}/remove` | `{reason}` → `{participant_id, status}` |
| `POST …/{pid}/accept` | `{reason}` — accept on behalf; records no consent |
| `POST …/{pid}/settle-outside` | `{reason}` — paid by hand; anything collected in-app goes back |
| `POST …/{pid}/collect` | `{reason, allowNegativeBalance: true}` — the only path that may take a partner below zero → `{participant_id, collected_credits, balance_after_credits}`; `400 overdraft_not_authorised` |

Change-log actions: `booking.player_added`, `booking.player_removed`,
`booking.player_accepted_on_behalf`, `booking.share_settled_outside`, `booking.share_collected`
(all but the first require a reason).

## 8. Settings

Every number is a `tenant_settings` key — clamped on read, bounded on `PUT /admin/settings`
(`<key>_out_of_range`), rendered from the clamped value on `GET`:

| Key | Default | Bounds |
| --- | --- | --- |
| `share_lapse_hours` | 48 | 1–168 |
| `share_reminder_hours` | 24 | 6–168 |
| `share_reminder_max` | 2 | 0–10 (0 = off) |
| `player_nudge_limit` (per player per 24 h) | 2 | 0–10 |
| `directory_searches_per_minute` | 30 | 5–120 |
| `member_quiet_start_minute` | 1260 (21:00) | 0–1439 |
| `member_quiet_end_minute` | 420 (07:00) | 0–1439 (equal to start = off) |
| `recent_partner_days` | 90 | 7–365 |
| `member_notification_retention_days` (read lines) | 180 | 7–730 |

## 9. Where this is enforced

| Rule | Code |
| --- | --- |
| Seats, split, consent, accept/decline/withdraw | `Services/Players/PlayersService.cs`, `PlayersService.Member.cs`, `SplitCalculator.cs` |
| The target rule | `Services/Players/ShareRules.cs` |
| The one writer of `ShareTransfer` | `Services/Players/ShareLedger.cs` |
| After settlement / the minute sweep | `Services/Players/ShareHook.cs`, `ShareSweep.cs`, `Workers/ShareWorker.cs` |
| Partner cap (D12) | `Services/BookingRules.cs` — `PartnerCapRefusalAsync`, `HeldAsync` |
| Partner at the court / door | `Services/CourtActivationService.cs`, `Services/GateAccess.cs`, `Endpoints/PinEndpoints.cs`, `Biometric/BiometricService.cs` |
| Member notices | `Services/Players/MemberNotices.cs`, `MemberEventCatalogue.cs`, `Email/EmailTemplatesPlayers.cs`, `Services/AdminNotificationDispatcher.cs` |
| Reads | `Services/Players/PlayersQuery.cs`; routes `Endpoints/PlayersEndpoints.cs`, `Endpoints/MemberNotificationEndpoints.cs` |

Pinning tests: `SplitCalculatorTests`, `ShareRulesTests`, `PlayerSettingsTests`, `PlayersHttpTests`,
`PlayersAccessHttpTests`.
