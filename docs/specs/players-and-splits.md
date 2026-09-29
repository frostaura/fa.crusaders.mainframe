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
closed → target = min( target , paid )          (lapsed, or past the share deadline)
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
| **closed** — the seat lapsed, or the share deadline passed | the above, but never more than already paid: a return is still made, a collection never is |

**Idempotent**: it posts only the difference, so running it twice — or from the hook and the worker
in the same minute — writes nothing the second time. **Locked on the debited member only**: a
collection locks the partner (their balance check is the one that counts), a return locks the
organiser. Two reconciles racing to post one pair lose on the reference's unique index and re-read.

**The share deadline is frozen per booking.** `bookings.ShareDeadlineAt` is stamped the first time
a booking gets players — the SOLD end plus `share_lapse_hours` as the club has it at that moment —
and everything reads the stamp: whether the game is open, the hold, the lapse, reminders, the
minute sweep's window. Changing `share_lapse_hours` later affects only bookings not yet stamped, so
raising it can never reopen a game whose held shares were released and spent. (Migration
`AddBookingShareDeadline` backfilled every booking that already had players from its club's
setting read exactly as `TenantSettingsAccessor` reads it — a JSON number that is an integer in
Int32 range, else 48 — then clamped 1–168; `Persistence/ShareDeadlineBackfill.cs`.)

**Never a debt.** A collection the partner cannot cover is not posted; the share stays unpaid and
payable by the partner until the **share deadline** after which it lapses and the organiser's
cover stands. **A closed seat is never collected from**:
the partner topping up afterwards does not reopen it, although the sweep still reconciles the
booking for a week (returns still flow). Only an admin's explicit collect
(`ReconcileOptions.OverdraftSeatId`, `ShareLedger.CollectAsync`) may collect from a closed seat or
take a partner below zero. A collection checks the partner's **spendable** credits (§3a), not
their balance.

**Nor a debt the other way — a return must be COVERED.** A return from booking X to seat s posts
only when the organiser's **coverage** for it pays for it (`LedgerService.GetCoverageAsync`,
`ShareHolds.CoverageAsync`):

```
earmark(b)  = held(b), or 0 for a game cancelled after check-in (S4)
need(b)     = what the returns stamped BEFORE s ask of booking b
drawn       = Σ min(need(b), earmark(b))        excess = Σ max(0, need(b) − earmark(b))
earmarked   = Σ earmark(b)                      — S4 holds are NOT in it

coverage(X, s) = min( max(0, earmark(X) − need(X)) ,  max(0, min(balance, earmarked) − drawn) )
               + max(0, balance − earmarked − excess)
```

- **Held money is earmarked.** What the organiser holds for X is X's partners' money, so a return
  up to X's own hold covers: an ordinary return — a withdrawal, a lowered share — never waits
  behind a return waiting on another game.
- **Waiting returns queue, first come first served** by `ReturnPendingSince`, then participant id;
  a return not yet stamped counts as the newest. An earlier return draws first on its own game's
  earmark and then on the free balance; a later one gets only what is left. That holds even when
  games still hold money and a desk debit has left the holds underwater (only `min(balance,
  held(all))` stands behind them) — the older return is paid first, whatever order the reconciles
  run in. Retries run in the same order (seats within a booking, the sweep, the credit hook) so the
  receipts read that way; the arithmetic, not the order, is what guarantees it.
  A waiting return that grows (a partial refund, then a desk remove on the same seat) **keeps its
  original stamp**, so the extra is served ahead of returns stamped in between — deliberately: the
  amount belongs to the same seat's claim, and one stamp per seat keeps the queue simple (review
  round 7). Its single `players.return_waiting` notice likewise stays the one sent when it first
  waited, showing the amount owed back THEN — the growth is not re-announced; the receipt when it
  posts carries the full figure (accepted, review round 8).
- **A game cancelled after check-in earmarks nothing.** Every share on it stays owed in full, so it
  held nothing and the organiser could spend it; its "hold" appears only once a return falls due on
  it — the very return being asked about. Its returns are payable from the free balance only (and
  so is the admin pre-check); the hold is still set aside from spending.
  An S4 hold is left out of `earmarked` as well: it IS the pending returns this formula pays from
  the free balance, so subtracting it too charged each such return twice — it posted only once the
  balance reached twice the return (review round 6). Spend checks still set it aside (§3a).
- **Never more than the balance.** Coverage cannot exceed the balance, so no return takes an
  organiser below zero without the desk's named overdraft.
- **The desk's pre-check and the ledger agree.** The pre-check is this same formula on the state
  before the hand-back, with the seat as the newest return; the hand-back changes no earmark (an
  open game's hold is what it received; an S4 game's is not an earmark), so the ledger reaches the
  same answer — only a spend racing in between can differ, and then the answer says
  `return_waiting`. `PlayersPropertyHttpTests` holds this, and every rule in this section, over
  seeded random scenarios (150 seeds in CI; `PLAYERS_PROPERTY_SEEDS` for more,
  `PLAYERS_PROPERTY_FIRST_SEED` to move the window, `PLAYERS_PROPERTY_BIAS` = `mixed` | `debt` |
  `balanced`). Some played games are dated 10–40 days back, past the sweep's window (so a return
waiting on one is reached only by the sweep's read of stamped seats). Partners are funded 100; the steps are withdraw, organiser and desk remove,
  settle-outside, cancel, goodwill credit, top-up, correction debit, deadline passing, random-order
  reconciles, an organiser spend (allowed exactly when the model's spendable covers it), check-in
  then cancel (S4), lowering a share, a concurrent burst (every reconcile, the sweep, a desk credit
  and a desk remove together), and — on debt seeds — a squeeze: free balance thinned below zero, the
  biggest share withdrawn after its deadline, the smallest on another game likewise, then a top-up
  of 4 — and, on a seed with an old game, an old-game squeeze: the free balance pushed down, a
  goodwill 16 naming the old game (its returns wait), a top-up leaving the first short by less than
  a young game's hold, then that game's deadline passing, so only the sweep can pay it. After every step it checks the balance never ran negative at any return row, **liveness**
  (a balance covering every earmark plus every waiting return leaves nothing waiting), and FCFS
  across the step (a return paid while an earlier-stamped one still waits took no more than its
  own game's earmark); at the end it tops the organiser up to exactly earmarks plus waiting returns
  and requires nothing left waiting.

The rule is keyed on coverage, never on the deadline: a hold released at the deadline and spent,
or a share a cancellation after check-in (S4) released at once and the organiser spent, is not
covered, before the deadline or after. Spend checks, by contrast, set aside EVERY waiting return
(§3a). An uncovered return **waits**:

- the seat is stamped `ReturnPendingSince` (indexed) and **both sides are told once**, under
  `players.return_waiting` — never again while it keeps waiting;
- it is retried by the minute sweep, which selects every seat carrying the stamp **however old
  the booking**, and at once by **any credit the organiser receives** — a top-up, a desk
  adjustment, a refund, anything but a share moving between players (`ShareHook.AfterCreditAsync`,
  after the commit);
- the stamp clears when the return posts or is no longer due;
- **while it waits it is set aside** from what the organiser may spend, exactly like a hold
  (§3a, `owed_back_credits`). Posting stays all-or-nothing, so credit arriving short of the whole
  return accumulates, unspendable, until it covers it — a top-up of 10 against a waiting 16 cannot
  buy an 8-credit court, and the next 6 pay the partner;
- after an outage nothing strands: the worker's first pass after it starts reconciles, per club,
  every booking on which a return is due and neither made nor stamped, whatever its age
  (`ShareSweep.CatchUpAsync`) — chosen in SQL from seats whose target is certainly nothing (off the
  game, settled by hand, or on a game cancelled before check-in) whose member has still paid
  something net, so it is normally empty. A club whose catch-up fails is tried again on the next
  pass, and its minute sweep runs anyway. (No-show and cancelled-after-check-in returns follow the
  organiser's `Owed` through the settlement hook and are not re-read on every start.)
- **a failed reconcile is remembered**: when the post-settlement hook, or the sweep on one booking,
  throws, the booking is marked `ShareReconcileDueAt` (indexed) and the sweep reconciles it however
  old it is. Each failure counts an attempt and stamps `ShareReconcileLastAttemptAt`; the sweep
  waits a minute after the first, doubling each time up to an hour, so a booking that fails for good
  costs a retry an hour and one log line per step. A reconcile that succeeds clears the marker —
  but only one recorded before it STARTED, so a failure recorded while it ran survives. One
  booking's failure is logged and the rest of the club's sweep — and every other booking in the
  hook, the post-settlement and the credit hook alike, each failing booking marked — goes on.
  A marked booking with no partner seats (its players all came off, or it never had any) is still
  visited — the sweep reads marked bookings straight off `bookings` — and its marker cleared
  (review round 7). A club's start-up catch-up counts as done once every booking it failed on is
  marked (the marker makes it good); only a failure it could not even mark is retried next pass.
  Rolling the marker migrations back forgets outstanding markers (their `Down` says so).
- **the marker is staged with the money** (review round 8): every save that may move a booking's
  `Owed` — a ledger row naming it other than a share transfer (a refund, a penalty, a desk credit
  or debit naming it), or a change to its status or check-in — sets `ShareReconcileDueAt` on it, when
  it has partner seats, in the SAME transaction (`MainframeDbContext.ShareStaging`), counting no
  failed attempt, so the sweep takes it at its next pass without backing off. The hook's
  reconcile, starting after the commit, clears it (the guarded clear). A settlement whose hook
  never runs — the admin's connection dropped, a restart in between — is therefore made good by the
  next minute sweep however old the game; before, a desk credit on a game past the sweep's window
  stranded the partner's return for good. And the hook itself runs on `CancellationToken.None`,
  whatever token its caller hands it: a request's cancellation must not abort money follow-up.
- a return starting or stopping waiting moves the organiser's spendable without a ledger row, so
  their live wallet gets a `balance` frame with `delta_credits` 0 and the reason `share_set_aside`.

**Chaining is not recursive.** When a waiting return posts it credits the partner, but a credit
arriving as a share transfer does not itself retry that partner's own waiting returns — if Sam's
refund from Olive would cover Sam's waiting refund to Jo, Jo is paid at the next minute sweep, not
in the same breath. That bounds every retry to one level; the cost is a minute's delay down a chain.

Nothing overdraws the organiser silently: only the desk's named overdraft — an admin remove or
settle-outside sent with `allowNegativeBalance` (§7) — posts it regardless. In practice most late
returns follow a fall in what the organiser owes, which credits them first.

**When it runs**: after every participant action (after its own commit); after each existing
settlement path commits — `POST /bookings/{id}/cancel`, `POST /admin/bookings/{id}/cancel`, the
admin bulk cancel, the no-show sweep, each court-box event that settles a booking, and **a desk
credit adjustment naming the booking** (`POST /admin/credit/{user}/adjust` with
`relatedBookingId`, however old the booking) — through `ShareHook`, in a fresh scope, never
throwing; and in `ShareWorker`'s minute sweep over every split booking whose game ended within
`share_lapse_hours` + 7 days (which also reaches the bookings a reversal displaced or a release
reinstated). The settlement code itself is unchanged.

**Lapse notices** go only for a game that was on (booked, completed, no-show). An invite on a
cancelled or displaced game lapses silently — its players were already told the game was off.
The lapse sweep reads accepted seats only in the week after the deadline (a paid seat never
lapses), but every still-INVITED seat past its deadline whatever its age (a partial index holds only
unanswered seats), so an invite outlives no worker outage.

## 3a. Held credits — shares are not spendable until the deadline

Decided 2026-09-28 (reversible; `memory/decisions-players.md`). A share can come back: the partner
withdraws, the organiser lowers or re-splits (adding a player re-splits an equal booking), removes
them, the desk settles it outside the app, or the organiser cancels late (the penalty is theirs
alone, so the refund falls short of the returns). Each return debits the organiser, so credits an
organiser receives as shares are **held**:

- **What**: per booking the member is the payer of, the net of their `ShareTransfer` rows on it,
  until that booking's share deadline. A **cancelled** booking holds only the returns still to be
  posted, so a settled cancellation frees at once.
- **Derived, never stored** (`Services/Players/ShareHolds.cs`): no ledger row moves. The balance is
  unchanged; `spendable = balance − held`.
- **Every member spend check** reads `LedgerService.GetSpendableAsync`: a booking (single, bulk, on
  behalf), a walk-up, the charge on activation, a volunteer paying at the box, a partner paying a
  share (accept and reconcile). A refusal's `current_credits` is the spendable figure. Only an
  admin's explicit `allowNegativeBalance` looks past it.
- **Consistent under the lock**: a collection raises the organiser's balance and hold in one save,
  so spendable does not move; a return locks the organiser, the lock every spend check holds.
- **A cancelled booking holds only its pending returns.** After a cancellation BEFORE check-in the
  refund covers every return; after check-in (S4) every share stays owed in full, so nothing is
  held and the organiser may spend it. Anything that later hands such a share back is a return
  that must be covered (§3) — the desk's overdraft is the only way past that.
- **One meaning for `balance_credits`: the raw balance, everywhere.** Wherever a balance is shown
  beside a spend — `GET /wallet`, the wallet SSE stream's opening frame and named `balance` frame,
  the invite view, the accept's answer, the admin booking quote and the admin bulk quote —
  `spendable_credits`, `held_credits` and `owed_back_credits` sit beside it; `GET /wallet`, the
  stream and `GET /me/profile` also carry `held_until` (the earliest release — a stamped deadline).
- **`owed_back_credits`** is the other part that is not spendable: returns already due to
  partners and WAITING for this member's credits (§3). Kept apart from `held_credits` because it
  means something else — money that is going, not money that might — and it has no release date.
  `spendable_credits = balance_credits − held_credits − owed_back_credits`, and every spend check
  uses exactly that. A booking's own hold is not counted twice when it also has a waiting return.

## 4. Consent

- A partner **accepts** a seat naming the share they were shown — `expectedShareCredits`, required
  on both accept routes (`400 expected_share_required`, asked only once the seat is the caller's).
  A share that has risen past it is refused `409 share_changed {share_credits}` and nothing
  changes: a tap is consent to the figure the partner read, not the one the organiser typed after.
  Otherwise the seat becomes `accepted`, `ConsentedCredits` rises to the share, and the first
  payment posts in the SAME save, under the partner's lock. A partner who cannot cover it from
  their spendable credits is answered `402 insufficient_balance` with `current_credits` /
  `required_credits` and nothing changes. The loser of a racing accept is answered from the
  winner's row: 200 only if the consent on it still covers the share (and the share is still the
  figure they named), else `409 share_changed`.
- **An open link seat is claimed only through its link.** The seat route answers an unclaimed seat
  `404 invite_not_found`, so a participant id seen in a detail view is no way round a rotated link.
- **Raising a share needs re-consent.** A re-split that raises a partner above their consent
  collects nothing; the seat reads `needs_consent: true`, the partner is mailed, and their next
  accept collects the difference. **Lowering refunds** at once, and lowers the consent with it, so a
  later raise is a new question rather than a debit they agreed to about a different figure.
- An **admin's accept on a member's behalf records no consent** — the reconcile collects nothing.
- **Withdraw**: an accepted partner may pull out only outside the club's late-cancel window
  (`penalty_window_minutes` before the start — the same line the organiser's own cancellation is
  held to); inside it, `409 withdraw_window_closed`.

## 5. Access, cap and the box (D12)

- **Only a live seat makes a member a player.** A member whose seat was declined, withdrawn,
  removed or lapsed reads the booking detail as a stranger does (404). A member **removed** from a
  booking cannot claim any seat of it again — an open link or an addressed one
  (`409 player_previously_removed`, also on opening the link); only an admin's add puts them back.

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
- **Pay-for at the box (P7)** refuses a split booking with `split_booking` — the code the box
  firmware and the device corpus pin (`SPLIT BOOKING` / `PAY IN APP`); an earlier draft of this
  spec said `split_pay_in_app`, which no device reads. The predicate is
  `BookingPlayerQueries.IsSplitAsync`, reached through P7's `IBookingPlayers` seam
  (`ParticipantBookingPlayers`, `docs/specs/member-code.md` §13), which also puts each accepted
  partner's REF on the booking's v1 roster entry. The payer override at
  the box uses the SAME predicate — a live partner seat with a share, OR any share row on the
  booking — so a booking whose partner came off with a return still to post is not handed, with
  that return, to a volunteer.

## 6. Invites, directory, inbox

- **No invite loop.** The organiser cannot invite again a member who declined or was removed from
  the same booking (`409 player_previously_declined` / `player_previously_removed`, `{user_id}`);
  an admin can. A booking is given at most `player_invites_per_booking` member invites and link
  seats over its life, dead ones included (`409 player_invite_limit {limit, invites_made}`; admin
  adds are exempt), counted under the booking's own lock so concurrent adds cannot both squeeze
  under it. An invite — or a removal — raised for the same (booking, member) inside the reminder
  cadence (`share_reminder_hours`) reaches the inbox but is not mailed again; a collapsed invite is
  still mailed by the club's reminder when the cadence ends. An invite is collapsed only when that
  reminder will come — reminders on (`share_reminder_max` > 0) and the first due before the share
  deadline — otherwise it is mailed at once.
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
| `players.return_waiting` | the partner and the organiser, once, when a return starts waiting (§3) | yes | no |

## 7. Endpoints

Requests are camelCase, answers snake_case. Every refusal is `{ "error": "<code>", …figures }`.

### Member

| Route | Body → answer |
| --- | --- |
| `POST /api/v1/bookings` | + optional `players: [{userId?, guestName?, link?, seat?, weight?, amount?}]`, `splitMode`, `organiserWeight`. Validated in full (against the quoted price) BEFORE booking. → `{booking_id, balance_after_credits, players: {booking_id, participants: [{participant_id, seat, user_id, guest_name, status, share_credits, invite_token, invite_path}]}, players_error}` |
| `POST /api/v1/bookings/bulk` | + the same `players`/`splitMode`/`organiserWeight`, applied to every newly booked item → adds `players: [{booking_id, players, players_error}]`. The payload's shape is checked price-free, then the split against EVERY item's price, before anything is booked: any failure books nothing |
| `POST /api/v1/players/split-preview` | `{priceCredits, splitMode, organiserWeight, players}` → `{price_credits, shares: [{seat, team, share_credits, weight}]}` — pure, for the live totals bar |
| `GET /api/v1/bookings/{id}` | → the detail: `booking_id, court_id, court_name, starts_at, ends_at, sold_ends_at, status, split_mode, viewer {role: organiser\|player\|admin, participant_id}, organiser {user_id, name, photo_url}, players [ {participant_id, seat, team, kind: organiser\|member\|guest\|open_link, user_id, name, photo_url, status, share_credits, weight, consented_credits, paid_credits, target_credits, unpaid_credits, needs_consent, settled_outside, lapsed, checked_in_at, invited_at, responded_at} ], money {price_credits, organiser_owed_credits, shares_received_credits, organiser_net_credits, unpaid_credits, share_deadline, is_split}, attendance {checked_in_at, players_checked_in}, permissions {can_invite, can_change_split, can_cancel, can_accept, can_decline, can_withdraw, withdraw_closes_at}`. 404 for anyone not on it and not an admin — a declined, withdrawn, removed or lapsed seat is not "on it". |
| `POST /api/v1/bookings/{id}/players` | organiser: `{players, splitMode?, organiserWeight?}` → as the create's `players`; `409 player_previously_declined` / `player_previously_removed {user_id}`, `409 player_invite_limit {limit, invites_made}` |
| `DELETE /api/v1/bookings/{id}/players/{pid}` | organiser → `{participant_id, status}` |
| `POST /api/v1/bookings/{id}/players/{pid}/nudge` | organiser → `{participant_id, nudges_left}`; `429 nudge_limit {limit, retry_after}`; `409 nothing_to_nudge` |
| `POST /api/v1/bookings/{id}/players/{pid}/link` | organiser → `{participant_id, invite_token, invite_path}` (rotates) |
| `PUT /api/v1/bookings/{id}/split` | organiser: `{mode, seats: [{participantId, weight?, amount?}]}` → `{booking_id, split_mode, shares: [{participant_id, seat, share_credits, weight, needs_consent}]}` |
| `POST /api/v1/bookings/{id}/players/{pid}/accept` | partner: `{expectedShareCredits}` → `{participant_id, booking_id, status, share_credits, consented_credits, paid_credits, balance_credits, spendable_credits, held_credits}`; `400 expected_share_required`, `409 share_changed {share_credits}`, `402 insufficient_balance`, `409 partner_cap_exceeded {cap: slots\|minutes, …}`, `409 invite_closed`, `409 already_in_booking`, `409 player_previously_removed`, `403 membership_inactive`; `404 invite_not_found` for an unclaimed link seat (claim it by its link) |
| `POST …/{pid}/decline` · `POST …/{pid}/withdraw` | partner → `{participant_id, status}`; withdraw `409 withdraw_window_closed {closed_at}` |
| `GET /api/v1/me/invites` | → `{items: [invite], count}` — the Invites tab and badge |
| `GET /api/v1/invites/{token}` | → `invite`; 404 `invite_not_found`, 409 `invite_closed`, 409 `already_in_booking`, 409 `player_previously_removed` |
| `POST /api/v1/invites/{token}/accept` · `…/decline` | as the seat routes (accept takes `{expectedShareCredits}`) |
| `GET /api/v1/me/partners/recent` | → `{items: [{user_id, name, photo_url, last_played_at, games}]}` |
| `GET /api/v1/me/partners/favourites` · `PUT`/`DELETE /api/v1/me/partners/favourites/{userId}` | → `{items: [{user_id, name, photo_url}]}` / `{user_id, favourite}` |
| `GET /api/v1/members/directory?q=` | → `{items: [{user_id, name, photo_url}]}`; `400 query_too_short`, `429 directory_rate_limited {retry_after_seconds}` |
| `GET /api/v1/me/notifications?cursor&limit` | → `{items: [{id, kind, headline, link, booking_id, created_at, read_at}], unread_count, next_cursor}` |
| `GET /api/v1/me/notifications/unread-count` | → `{unread_count}` |
| `POST /api/v1/me/notifications/{id}/read` · `POST …/read-all` | → `{id, read}` / `{marked}` |
| `GET/PUT /api/v1/me/preferences` | + `share_results` (D13, stored only); `findable_in_directory` and `show_on_leaderboards` accepted as aliases of `findable` and `show_in_leaderboards` |

`invite` = `{participant_id, booking_id, status, seat, team, open_link, court_name, starts_at, ends_at, organiser {user_id, name, photo_url}, players, share_credits, to_pay_credits, needs_consent, balance_credits, spendable_credits, held_credits, balance_after_credits, short_by_credits, share_deadline, cap}` — `balance_credits` is the viewer's raw balance and `balance_after_credits` that less `to_pay_credits`; `short_by_credits` is measured against `spendable_credits` (§3a), which is what the accept checks; `share_deadline` is the booking's frozen deadline (§3); `cap` is null, or the partner-cap figures when accepting would break the partner's own daily cap.

**Wallet and profile (§3a)**: `GET /api/v1/wallet` adds `held_credits`, `spendable_credits`,
`held_until`; the wallet SSE stream's opening frame and named `balance` frame carry the same three;
`GET /api/v1/me/profile` adds `held_credits`, `owed_back_credits`, `held_until`. `held_until` is null when nothing is held.
The admin booking quote and the admin bulk quote add `spendable_credits` and `held_credits`;
their `balance_credits` is raw and their `overdraws` is on spendable.

### Admin (god mode — every one in `admin_change_log`)

| Route | Body → answer |
| --- | --- |
| `POST /api/v1/admin/bookings/{id}/players` | `{userId? \| guestName?, accepted?, reason?}` — neither: an open link seat. `accepted` places a member without their consent (collects nothing). → as the organiser's add |
| `POST /api/v1/admin/bookings/{id}/players/{pid}/remove` | `{reason, allowNegativeBalance?}` → `{participant_id, status, return_waiting, return_credits}` — `return_waiting` is true (with `return_credits`, the amount due back) when the hand-back passed the coverage check but a spend raced it and the reconcile left it waiting (§3); `return_credits` is null otherwise. `allowNegativeBalance: true` is required whenever the hand-back is not covered by the organiser's coverage (§3), whatever the deadline: `400 overdraft_not_authorised {return_credits, covered_credits}` |
| `POST …/{pid}/accept` | `{reason}` — accept on behalf; records no consent |
| `POST …/{pid}/settle-outside` | `{reason, allowNegativeBalance?}` → as remove, with `return_waiting` / `return_credits` — paid by hand; anything collected in-app goes back. Accepted seats only: `409 player_not_accepted`. `allowNegativeBalance: true` is required whenever the hand-back is not covered, as for remove |
| `POST …/{pid}/collect` | `{reason, allowNegativeBalance: true}` — the only path that may take a partner below zero, or collect from a lapsed seat → `{participant_id, collected_credits, balance_after_credits}`; `400 overdraft_not_authorised`, `409 nothing_to_collect`, `409 conflict_retry`. The consent, the change-log line (the figure actually posted) and the pair are one transaction under the partner's lock |

Change-log actions: `booking.player_added`, `booking.player_removed`,
`booking.player_accepted_on_behalf`, `booking.share_settled_outside`, `booking.share_collected`
(all but the first require a reason).

## 8. Settings

Every number is a `tenant_settings` key — clamped on read, bounded on `PUT /admin/settings`
(`<key>_out_of_range`), rendered from the clamped value on `GET`:

| Key | Default | Bounds |
| --- | --- | --- |
| `share_lapse_hours` (frozen per booking when it first gets players, §3) | 48 | 1–168 |
| `share_reminder_hours` | 24 | 6–168 |
| `share_reminder_max` | 2 | 0–10 (0 = off) |
| `player_nudge_limit` (per player per 24 h) | 2 | 0–10 |
| `directory_searches_per_minute` | 30 | 5–120 |
| `member_quiet_start_minute` | 1260 (21:00) | 0–1439 |
| `member_quiet_end_minute` | 420 (07:00) | 0–1439 (equal to start = off) |
| `recent_partner_days` | 90 | 7–365 |
| `member_notification_retention_days` (read lines) | 180 | 7–730 |
| `player_invites_per_booking` (member invites + link seats, ever) | 8 | 4–20 |

## 9. Where this is enforced

| Rule | Code |
| --- | --- |
| Seats, split, consent, accept/decline/withdraw | `Services/Players/PlayersService.cs`, `PlayersService.Member.cs`, `SplitCalculator.cs` |
| The target rule | `Services/Players/ShareRules.cs` |
| Held credits, spendable | `Services/Players/ShareHolds.cs`, `Services/LedgerService.cs` — `GetHeldAsync`, `GetSpendableAsync` |
| The one writer of `ShareTransfer` | `Services/Players/ShareLedger.cs` |
| After settlement / the minute sweep | `Services/Players/ShareHook.cs`, `ShareSweep.cs`, `Workers/ShareWorker.cs`; the marker staged with the money: `Persistence/MainframeDbContext.ShareStaging.cs` |
| Partner cap (D12) | `Services/BookingRules.cs` — `PartnerCapRefusalAsync`, `HeldAsync` |
| Partner at the court / door | `Services/CourtActivationService.cs`, `Services/GateAccess.cs`, `Endpoints/PinEndpoints.cs`, `Biometric/BiometricService.cs` |
| Member notices | `Services/Players/MemberNotices.cs`, `MemberEventCatalogue.cs`, `Email/EmailTemplatesPlayers.cs`, `Services/AdminNotificationDispatcher.cs` |
| Reads | `Services/Players/PlayersQuery.cs`; routes `Endpoints/PlayersEndpoints.cs`, `Endpoints/MemberNotificationEndpoints.cs` |

Pinning tests: `SplitCalculatorTests`, `ShareRulesTests`, `PlayerSettingsTests`, `PlayersHttpTests`,
`PlayersAccessHttpTests`, `PlayersReviewHttpTests` (the adversarial review's findings, one test each),
`PlayersRefuteHttpTests` … `PlayersRefute8HttpTests` (the refuter's rounds on those fixes),
`PlayersPropertyHttpTests` (the seeded property search).
