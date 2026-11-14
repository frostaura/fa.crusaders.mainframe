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
  one row takes the minutes from the partner, the other adds them to the organiser, both naming
  the booking, posted in one save under references `share:{participant}:{seq}:out` (the paying
  member's row) and `:in` (the receiving member's). Both rows are whole minutes and the pair nets
  to exactly 0, so **no club report moves** — revenue,
  spend, refunds, penalties and the per-booking `Owed` sum are what they were.
- **`booking_participants`** — one row per seat: `Seat` 1–4 (1–2 team A, 3–4 team B; 1 is the
  organiser), `UserId` (null for a guest or an unclaimed link seat), `GuestName`, `Status`
  (`invited` · `accepted` · `declined` · `withdrawn` · `removed` · `lapsed`), `ShareMinutes` (what
  the seat is asked to pay), `ConsentedMinutes` (the most the partner agreed to; both whole minutes), `ShortfallMinutes` (what a
  partner who paid part could not pay — pay what you can, §4; migration `AddSeatShortfall`), `ShareWeight`,
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

`SplitCalculator` divides the price `P` — the booking's length in minutes, `SliceMinutes ×
SliceCount`, a whole number — across the live seats so the shares **sum to `P` exactly, always**
(pinned over 5 000 generated cases):

| Mode | Partner seat | Organiser (seat 1) |
| --- | --- | --- |
| `equal` | `⌊P / payers⌋` — whole minutes, rounded down | `P − Σ partners` |
| `ratio` | `⌊P × weight / Σ weights⌋` — weights 0–100 | `P − Σ partners` |
| `amount` | the organiser's figure: a whole number of minutes ≥ 0, else `split_amount_invalid` | `P − Σ partners`, refused below 0 (`split_exceeds_price`) |

Guests are in the split with share 0 and are not a head in an equal split. **The rounding rule**:
partners are rounded down to whole minutes, and the organiser — who chose to split — keeps the
remainder, so the shares always sum to the price: a 32-minute game split equally three ways is 10
and 10 for the partners and 12 for the organiser. Nothing holds a fraction of a minute. Adding a player re-splits an `equal`/`ratio` booking (every
share goes down — and what each paying partner had paid over their new share goes back as the
ADDER's act, §6 R16); removing, declining or withdrawing does NOT re-split — the organiser absorbs the
freed share until they re-split themselves, and their own seat's `share_minutes` says so: it is
recomputed as `P − Σ live partners` in one statement after the seat change commits (review round 4,
M4-6).

## 3. What a partner pays — the reconcile

`ShareLedger.ReconcileAsync(booking)` is the one writer of `ShareTransfer`. For each partner seat:

```
target = min( ConsentedMinutes , ⌊ Owed(b) × ShareMinutes / P ⌋ )    — ShareRules.TargetFor
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
| paid by hand (the desk's settle-outside) | 0 |
| displaced (S8) | 0 |
| cancelled before anybody checked in | 0 — **the late-cancel penalty is the organiser's alone** |
| cancelled after check-in (S4) | the full share — but the unpaid figure of a cancelled game is 0 (below) |
| no-show (S5) | pro rata of the penalty, rounded down; the organiser keeps the remainder. A 30% penalty on a 32-minute booking is `⌊32 × 30 / 100⌋ = 9`, and a partner holding 16 of the 32 owes `⌊9 × 16 / 32⌋ = 4` |
| no-show with no reachable box (S5a) | 0 |
| no-show reversed (S6), live, played | the full share |

**A cancelled game asks nobody for anything (R17 E17-2).** `ShareLedger.UnpaidAsync` — the "unpaid"
of every screen, reminder and sweep — treats a `Cancelled` booking as closed, even when asked
`evenIfClosed`, so no seat of it reads as owing; and `PlayerNotices.NeedsConsent(booking, seat)` is
false on it (there is no overload without the booking, so no caller can forget it). The reconcile's
own `IsClosed` is NOT changed. *Why:* a cancelled court that lit after all still collects the
partners' shares through `Owed` (the table above); only the asking stops — the detail read
"10 unpaid" and asked for consent on a game that was off.
| **closed** — the seat lapsed, or the share deadline passed | the above, but never more than already paid: a return is still made, a collection never is |

**What the organiser is told on a split cancel (review round 1, B3).** The member's
`GET /bookings/{id}/cancellation-quote` gains `net_minutes` (the refund less what goes on to the
partners) and `partner_refunds: [{user_id, name, minutes}]`, each computed by the share rule above
against the cancelled booking; `POST /bookings/{id}/cancel` answers `{refunded_minutes,
penalty_minutes, net_minutes, partner_refunds}`, each partner's figure measured against what they
had paid **when the cancel took the booking, read off the ledger afterwards** — what is still paid
in plus every return posted from the cancellation's instant on (`SplitCancelView.AfterAsync`,
`ShareLedger.ReturnedOfAsync`; R19 J19-4) — so a return that waits for cover is still named, and so
is an accept that landed while the cancel waited on the booking row. Before R19 the figures came
from a snapshot taken before the cancel: that accept's share was sent straight back by the cancel's
reconcile while the answer said `partner_refunds: []` and counted the partner's minutes in the
organiser's net. The desk's `POST /admin/bookings/{id}/cancel`
answers the same four fields, and each `POST /admin/bookings/bulk-cancel` result row carries
`net_minutes` and `partner_refunds` (lane F1's ask), read after the cancel by the same rule.

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
the partner buying minutes afterwards does not reopen it, although the sweep still reconciles the
booking for a week (returns still flow). Only an admin's explicit collect
(`ReconcileOptions.OverdraftSeatId`, `ShareLedger.CollectAsync`) may collect from a closed seat or
take a partner below zero. A collection checks the partner's **spendable** minutes (§3a), not
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
  run in. Retries run in the same order (seats within a booking, the sweep, the incoming-minutes hook) so the
  receipts read that way; the arithmetic, not the order, is what guarantees it.
  A waiting return that grows (a partial refund, then a desk remove on the same seat) **keeps its
  original stamp**, so the extra is served ahead of returns stamped in between — deliberately: the
  amount belongs to the same seat's claim, and one stamp per seat keeps the queue simple (review
  round 7). Its single `players.return_waiting` notice likewise stays the one sent when it first
  waited, showing the amount owed back THEN — the growth is not re-announced; the receipt when it
  posts carries the full figure (accepted, review round 8).
- **A no-show return names the penalty.** Its receipt and mail say a partner's share came back less their part of the no-show penalty ("11 minutes of your share came back — nobody checked in, and 4 minutes are your part of the no-show penalty"), never "the club refunded the session" alone; the member notice payload carries `kept_minutes` (review round 11, E11-2).
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
waiting on one is reached only by the sweep's read of stamped seats). Partners are funded 100 minutes; the steps are withdraw, organiser and desk remove,
  settle-outside, cancel, a goodwill adjustment, a purchase, a correction debit, deadline passing, random-order
  reconciles, an organiser spend (allowed exactly when the model's spendable covers it), check-in
  then cancel (S4), lowering a share, a concurrent burst (every reconcile, the sweep, a desk adjustment
  and a desk remove together), and — on debt seeds — a squeeze: free balance thinned below zero, the
  biggest share withdrawn after its deadline, the smallest on another game likewise, then a purchase
  of 4 minutes — and, on a seed with an old game, an old-game squeeze: the free balance pushed down, a
  goodwill 16 minutes naming the old game (its returns wait), a purchase leaving the first short by less than
  a young game's hold, then that game's deadline passing, so only the sweep can pay it. After every step it checks the balance never ran negative at any return row, **liveness**
  (a balance covering every earmark plus every waiting return leaves nothing waiting), and FCFS
  across the step (a return paid while an earlier-stamped one still waits took no more than its
  own game's earmark); at the end it brings the organiser's balance to exactly earmarks plus waiting returns
  and requires nothing left waiting.

The rule is keyed on coverage, never on the deadline: a hold released at the deadline and spent,
or a share a cancellation after check-in (S4) released at once and the organiser spent, is not
covered, before the deadline or after. Spend checks, by contrast, set aside EVERY waiting return
(§3a). An uncovered return **waits**:

- the seat is stamped `ReturnPendingSince` (indexed) and **both sides are told once**, under
  `players.return_waiting` — never again while it keeps waiting;
- it is retried by the minute sweep, which selects every seat carrying the stamp **however old
  the booking**, and at once by **any minutes the organiser receives** — a purchase, a desk
  sale or adjustment, a refund, anything but a share moving between players (`ShareHook`'s
  incoming-minutes hook, after the commit);
- the stamp clears when the return posts or is no longer due;
- **while it waits it is set aside** from what the organiser may spend, exactly like a hold
  (§3a, `owed_back_minutes`). Posting stays all-or-nothing, so minutes arriving short of the whole
  return accumulate, unspendable, until they cover it — 10 minutes bought against a waiting return
  of 16 cannot be spent on any booking, and the next 6 pay the partner;
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
  hook, the post-settlement and the incoming-minutes hook alike, each failing booking marked — goes on.
  A marked booking with no partner seats (its players all came off, or it never had any) is still
  visited — the sweep reads marked bookings straight off `bookings` — and its marker cleared
  (review round 7). A club's start-up catch-up counts as done once every booking it failed on is
  marked (the marker makes it good); only a failure it could not even mark is retried next pass.
  Rolling the marker migrations back forgets outstanding markers (their `Down` says so).
- **the marker is staged with the money** (review round 8): every save that may move a booking's
  `Owed` — a ledger row naming it other than a share transfer (a refund, a penalty, a desk
  adjustment up or down naming it), or a change to its status or check-in — sets `ShareReconcileDueAt` on it, when
  it has partner seats, in the SAME transaction (`MainframeDbContext.ShareStaging`), counting no
  failed attempt, so the sweep takes it at its next pass without backing off. The hook's
  reconcile, starting after the commit, clears it (the guarded clear). A settlement whose hook
  never runs — the admin's connection dropped, a restart in between — is therefore made good by the
  next minute sweep however old the game; before, a desk adjustment adding minutes on a game past the sweep's window
  stranded the partner's return for good. And the hook itself runs on `CancellationToken.None`,
  whatever token its caller hands it: a request's cancellation must not abort money follow-up.
- a return starting or stopping waiting moves the organiser's spendable without a ledger row, so
  their live wallet gets a `balance` frame with `delta_minutes` 0 and the reason `share_set_aside`.

**Chaining is not recursive.** When a waiting return posts it pays the partner, but minutes
arriving as a share transfer do not themselves retry that partner's own waiting returns — if Sam's
refund from Olive would cover Sam's waiting refund to Jo, Jo is paid at the next minute sweep, not
in the same breath. That bounds every retry to one level; the cost is a minute's delay down a chain.

Nothing overdraws the organiser silently: only the desk's named overdraft — an admin remove or
settle-outside sent with `allowNegativeBalance` (§7) — posts it regardless. In practice most late
returns follow a fall in what the organiser owes, which refunds them first.

**When it runs**: after every participant action (after its own commit); after each existing
settlement path commits — `POST /bookings/{id}/cancel`, `POST /admin/bookings/{id}/cancel`, the
admin bulk cancel, the no-show sweep, each court-box event that settles a booking, and **a desk
minutes adjustment naming the booking** (`POST /admin/minutes/{user}/adjust` with
`relatedBookingId`, however old the booking) — through `ShareHook`, in a fresh scope, never
throwing; and in `ShareWorker`'s minute sweep over every split booking whose game ended within
`share_lapse_hours` + 7 days (which also reaches the bookings a reversal displaced or a release
reinstated). The settlement code itself is unchanged.

**Lapse notices** go only for a game that was on (booked, completed, no-show). An invite on a
cancelled or displaced game lapses silently — its players were already told the game was off.
The lapse sweep reads accepted seats only in the week after the deadline (a paid seat never
lapses), but every still-INVITED seat past its deadline whatever its age (a partial index holds only
unanswered seats), so an invite outlives no worker outage.

## 3a. Held minutes — shares are not spendable until the deadline

Decided 2026-09-28 (reversible; `memory/decisions-players.md`). A share can come back: the partner
withdraws, the organiser lowers or re-splits (adding a player re-splits an equal booking), removes
them, the desk records it as paid by hand, or the organiser cancels late (the penalty is theirs
alone, so the refund falls short of the returns). Each return debits the organiser, so minutes an
organiser receives as shares are **held**:

- **What**: per booking the member is the payer of, the net of their `ShareTransfer` rows on it,
  until that booking's share deadline. A **cancelled** booking holds only the returns still to be
  posted, so a settled cancellation frees at once.
- **Derived, never stored** (`Services/Players/ShareHolds.cs`): no ledger row moves. The balance is
  unchanged; `spendable = balance − held`.
- **Every member spend check** reads `LedgerService.GetSpendableAsync`: a booking (single, bulk, on
  behalf), a walk-up, the charge on activation, a volunteer paying at the box, a partner paying a
  share (accept and reconcile). A refusal's `current_minutes` is the spendable figure. Only an
  admin's explicit `allowNegativeBalance` looks past it.
- **Consistent under the lock**: a collection raises the organiser's balance and hold in one save,
  so spendable does not move; a return locks the organiser, the lock every spend check holds.
- **A cancelled booking holds only its pending returns.** After a cancellation BEFORE check-in the
  refund covers every return; after check-in (S4) every share stays owed in full, so nothing is
  held and the organiser may spend it. Anything that later hands such a share back is a return
  that must be covered (§3) — the desk's overdraft is the only way past that.
- **One meaning for `balance_minutes`: the raw balance, everywhere.** Wherever a balance is shown
  beside a spend — `GET /wallet`, the wallet SSE stream's opening frame and named `balance` frame,
  the invite view, the accept's answer, the admin booking quote and the admin bulk quote —
  `spendable_minutes`, `held_minutes` and `owed_back_minutes` sit beside it; `GET /wallet`, the
  stream and `GET /me/profile` also carry `held_until` (the earliest release — a stamped deadline).
- **`owed_back_minutes`** is the other part that is not spendable: returns already due to
  partners and WAITING for this member's minutes (§3). Kept apart from `held_minutes` because it
  means something else — money that is going, not money that might — and it has no release date.
  `spendable_minutes = balance_minutes − held_minutes − owed_back_minutes`, and every spend check
  uses exactly that. A booking's own hold is not counted twice when it also has a waiting return.

## 4. Consent

- A partner **accepts** a seat naming the share they were shown — `expectedShareMinutes` (a whole number), required
  on both accept routes (`400 expected_share_required`, asked only once the seat is the caller's).
  A share that has risen past it is refused `409 share_changed {share_minutes}` and nothing
  changes: a tap is consent to the figure the partner read, not the one the organiser typed after.
  Otherwise the seat becomes `accepted`, `ConsentedMinutes` rises to the share, and the first
  payment posts in the SAME save, under the partner's lock. A partner who cannot cover it from
  their spendable minutes is answered `402 insufficient_balance` with `current_minutes` /
  `required_minutes` and nothing changes. The loser of a racing accept is answered from the
  winner's row: 200 only if the consent on it still covers the share (and the share is still the
  figure they named), else `409 share_changed`. **An accept that loses its save to any other write
  on the seat** — the organiser's re-split or nudge, the desk — reads the seat again as it now stands
  (R19 J19-1, `AfterLostAcceptAsync`): still open → `409 share_changed {share_minutes}` when the share
  is not the figure they named (up **or** down — their next tap must be on the figure now on the
  sheet), else `409 conflict_retry`; `409 invite_closed` / `booking_not_open` only for a seat or game
  that really closed (or a link seat another member claimed first). Nothing was written either way.
- **Pay what you can.** A partner short of their share may accept paying part of it: the accept
  body's optional `payMinutes` (whole minutes) is the share the seat will stand at. It must be more
  than 0, less than the share, and not below what the seat has already paid, else
  `400 pay_minutes_invalid {share_minutes, paid_minutes}`. **Only a partner who is short may**
  (money lane BM-5): when what the seat has paid plus the partner's spendable minutes covers the
  share, it is `409 share_affordable {share_minutes, paid_minutes, spendable_minutes}` — read under
  the accept's payer lock — because any partner could otherwise drop their share to one minute and
  leave the organiser carrying it. What it costs is checked against spendable minutes like any
  accept (`402 insufficient_balance`). Under the accept's own lock and in
  its one save (`PlayersService.PayWhatYouCanAsync`): the booking becomes an `amount` split — every
  other live partner keeps the share they had (weights 0), this seat's share and consent become
  `payMinutes`, and the organiser's seat is the remainder `P − Σ live partners`, so it rises by
  exactly the shortfall. The organiser already paid the whole price at booking, so **no ledger row
  moves for them**; the seat records the difference as `ShortfallMinutes` (accumulating, ≥ 0), the
  seat is accepted, and `payMinutes` is collected as an ordinary accept's pair. The accept's audit row
  carries `shortfall_minutes`, and the organiser is told (inbox and mail, `players.shortfall`): "Sam
  could pay 6 minutes of their 10 minutes share for Court 1, … — 4 minutes are left to cover. You're
  covering it for now; you can split it with the other players." That mail ("Sam paid 6 minutes of
  their 10 minutes share — Court 1") is the organiser's one mail about it: the part payment's own
  `players.share_moved` receipt stays on their inbox only (browser lane BM-21 — two subjects for one
  act, one saying "paid their share", contradicted each other). A second tap answers the same 200
  (the seat is accepted and paid at its new share); a lost race is answered as any accept's.
  **The others decide**: the booking detail shows each seat's `shortfall_minutes` and
  `money.left_to_cover_minutes`, and the organiser's page offers "Split what's left" — the short
  partner locked at what they paid, a whole-minute portion for every other paying player (the
  organiser first) opening on an equal split (partners rounded down, the organiser keeps the
  remainder), saved as an `amount` re-split with each partner at share + portion. **Any successful
  re-split clears every seat's `ShortfallMinutes`** — the organiser has decided, even a split that
  moves nothing — and a partner asked for more is asked again under the raise rule below; nothing
  more is taken from them until they say yes.
- **An open link seat is claimed only through its link.** The seat route answers an unclaimed seat
  `404 invite_not_found`, so a participant id seen in a detail view is no way round a rotated link.
- **Raising a share needs re-consent.** A re-split that raises a partner above their consent
  collects nothing; the seat reads `needs_consent: true`, the partner is mailed, and their next
  accept collects the difference. **One rule decides it everywhere** (R16 J16-1,
  `PlayerNotices.NeedsConsent(booking, seat)`): an accepted seat, NOT recorded as paid by hand, on a
  game that is not cancelled (R17 E17-2), whose share is above its consent — the same answer on the booking detail, the invite view, `GET /me/invites/{pid}` and
  the split's answer. A share the club settled by hand never asks. **Lowering refunds** at once, and lowers the consent with it, so a
  later raise is a new question rather than a debit they agreed to about a different figure.
- An **admin's accept on a member's behalf records no consent** — the reconcile collects nothing.
  It is on the record all the same (R16 E16-1, §6).
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
  themselves. Asked only for a game still ahead, and only on the first yes. Peak hours and group
  windows bind the organiser only.
- **Nor is a member at their cap added (R16 J16-11).** The organiser's add and the desk's add of a
  member who already holds their daily cap on that club day are refused `409 at_daily_limit
  {user_id, name}` — the same rule (`BookingRules.PartnerCapRefusalAsync`) their accept would meet,
  so the invite could never be taken and an equal split would have gone down for nothing. Nothing is
  added or re-split. Asked only for a game that has not started. A booking made WITH such a player
  (`POST /bookings`, `/bookings/bulk`) is still booked; its answer carries `players: null,
  players_error: "at_daily_limit"`.
- **At the court**: an accepted partner with an active membership finds the booking through
  `CourtActivationService.FindForUserAsync` (QR / code), `CandidatesAsync` + `PlayersOfAsync`
  (PIN, biometric). Their scan checks the booking in and stamps their OWN seat's `CheckedInAt`; it
  never makes them the payer — **a payer override on a split booking is ignored**.
  **Every seat stamp is on the record (R17 J17-4):** `SeatCheckIn.StampAsync` stamps the seat AND
  stages one `court.checked_in` audit row in the same save — actor = subject = the scanner (the Night
reads its subject as the booking's organiser since R18 E18-4, §6),
  `ScanAt` the scan, details `{booking_id, participant_id, organiser_user_id, court_number, method,
  occurred_at, lit_court, reversed_no_show}` (`lit_court`: the same scan also wrote
  `court.activated`). It is written on the first activation, on a repeat arrival at a lit court and
  on a late upload that reverses a no-show; a booking with no seats writes none. *Why:* only the
  first scanner's check-in reached the record, so a partner who scanned after the court was lit was
  "checked in" on the booking page and on nobody's Night. **Players scanning at once are each
  checked in (R17 J17-1):** a scan whose save loses the booking (or seat) row to another scan is
  decided again on the rows as they now are (`DatabaseRetry.ReDecideOnLostRaceAsync`, up to 3
  attempts) — the court is lit by then, so the second look is a repeat arrival that stamps only the
  scanner's seat; charged once either way. Five parallel scans of one booking gave 1 OK and four
  500s, and lost the partners' stamps.
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
- **Directory (D13)** — every active member who has not switched `findable` off (it defaults ON, 2026-10-06; no preferences row means on; admins are members and are listed like anyone), never never the caller, id + name +
  photo plus what tells two namesakes apart from the caller's own history (R16 J16-3, below) —
  never an email, phone or membership number — a query of at least 2 characters (a LIKE wildcard is a literal), and a per-member
  budget of `directory_searches_per_minute`.
- **Recent partners** are derived (accepted seats on the same bookings in the last
  `recent_partner_days` that have started and were checked in at the box — a game still ahead is
  not "played with"), never stored; **favourites** are private to the member who starred them.
- **The picker tiebreak (R16 J16-3).** Directory, favourites and recent-partner rows carry
  `played_with_you` (games the caller and that member both played — each the booker or an accepted
  seat — on a booking the box checked in, that has started and is not cancelled; all time; 0 when
  never), `last_played_with_you_at` (the latest such game's start, or null), `member_since`
  (`yyyy-MM-dd`, the earliest membership's creation date **in the club's zone** — R17; it was the
  UTC date, so a member who joined 00:00–02:00 in Johannesburg read the day before — or null) and
  **`member_ref`** (R17 L17-2): four Crockford base-32 characters (no I, L, O, U), stable for one
  member at one club, derived by hash (`MemberRefs.Of(tenant, user)`: SHA-256 of the two ids, 20
  bits). It is **never** the membership number, an email or a phone, and says nothing the row's
  `user_id` does not; it exists only so two namesakes are never the same line — a pre-launch club
  joins in one month, so "Member since Oct 2026" told nobody apart. The picker escalates month →
  day → ref among the rows it shows together. `PlayersQuery.PlayedWithAsync`; nothing private.
- **The inbox** (`member_notifications`) and member mail share the R23 outbox, generalised with an
  `Audience` (admins · member) and a `RecipientUserId`. Each notice is staged in the same save as
  its event — the inbox line and the outbox row together. Non-urgent kinds wait for the end of
  **quiet hours** (`member_quiet_start_minute`–`member_quiet_end_minute`, 21:00–07:00 club time);
  urgent ones (a share receipt, a cancelled game) go at once. The admin feed reads admin rows only.
- **A held mail is re-derived when it leaves (review round 2, C8, `MemberMailRelease`).** Every
  non-urgent member mail is judged against CURRENT state at the send, whatever held it: **dropped**
  when obsolete (invite no longer open, game off, seat declined/removed/withdrawn/lapsed, result no
  longer pending or not the reader's to confirm, reminder's share paid, a waiting return posted, a
  removal undone by a re-add) — finished `Suppressed` with `dropped: <reason>` and its dedupe key
  moved aside, so a later genuine event can still mail; **re-rendered** otherwise with today's
  court, start, share, score and deadline; and **coalesced** per (member, booking, kind) for the
  repeatable kinds (invite, club seat, reminder, share changed, result to confirm) — only the
  latest goes. A lapse and a waiting return name one partner each and are never coalesced;
  receipts (urgent kinds) are never re-derived. A night's mail leaves in the order it happened
  (claim order `DueAt, CreatedAt`), and a cancellation never follows the invite it supersedes —
  the invite is dropped, and an unanswered invitee is never mailed the cancellation (M4-5).
  A receipt of the reader's OWN action is born read: an accept's payment, and the organiser's own
  remove, split change or cancellation (review round 4, I4-5).
  A named `notification` frame (`{"unread_count": n}`) is published on the member's wallet SSE
  stream after each change, so the bell can update without polling.

| Kind | To | Mailed | Urgent |
| --- | --- | --- | --- |
| `players.invited` | the invited member | yes | no |
| `players.share_moved` | both sides of every pair | yes | yes |
| `players.reminder` | an unanswered / unpaid partner (club cadence, or the organiser's nudge) | yes | no |
| `players.lapsed` | the partner and the organiser | yes | no |
| `players.game_cancelled` | every live partner; and the organiser when the CLUB cancels their game before anybody checked in (R18 J18-9) | accepted partners only; an unanswered invitee gets the inbox line (M4-5); the organiser's line is inbox only | yes |
| `players.game_changed` | a removed partner, or one whose share moved; both players when the club records a share as paid by hand (R16 J16-6) | yes — except the organiser's settled-by-hand line, inbox only | no |
| `players.response` | the organiser (accepted / declined / withdrew; the club accepted for a partner — R16 E16-1) | a decline or a withdrawal is mailed ("Sam can't make it" / "Sam has pulled out", browser lane BM-20 — an organiser who did not open the app turned up expecting an opponent); dropped at release when the game is off or the partner is back on it. An accept stays inbox only — its payment receipt is the mail | no |
| `players.return_waiting` | the partner and the organiser, once, when a return starts waiting (§3) | yes | no |
| `players.shortfall` | the organiser, when a partner pays only part of their share (pay what you can, §4); the mail is dropped at release once the organiser has re-split (`shortfall_split`) or the seat or game is gone | yes | no |

**A member whose address is not confirmed is not mailed yet, and not forgotten** (browser lane
BM-01): a club may approve a member before they click the verify link, and their notices used to
finish "sent" to nobody. A member row now waits (`Pending`, `last_error: awaiting_verified_address`,
looked at again every 6 hours), is released in the same save that confirms the address (the verify
link or the welcome link), and the release judgement above still drops whatever is no longer true;
it is suppressed as `recipient_unverified` only after 14 days. A suspended or deleted recipient's
row is suppressed as `recipient_inactive`. The organiser's own mails close with "you organised this
court booking", a partner's with "a member of the club added you to a court booking" (BM-21).

Since review round 13:
- **`players.game_cancelled` names who cancelled.** It says the club cancelled it, with the admin's
  recorded reason, or that the organiser did (E13-6, X13-3).
- **A link to a game the reader is no longer on carries their seat.** This covers a removed,
  withdrawn, declined or lapsed seat, on the `game_changed`, `share_moved` and `return_waiting`
  mails and inbox lines. The link is `/bookings/{id}?seat={participant_id}`, and the page answers
  "You were taken off this game" / "You left this game" rather than not-found (J13-3). In the
  wallet ledger, a share line for a booking the member can no longer read
  (`share_bookings[id] === null`) has no "View booking" link.
- **A withdrawal is the partner's own act.** It writes the audit row `players.withdrew`, with actor
  and subject both the partner, and `{booking_id, participant_id, organiser_user_id,
  court_number, starts_at, paid_minutes}`. The share that comes back is posted with the partner as
  the actor on both ledger legs, never the system. Both receipts say "they withdrew" / "you
  withdrew". The Night shows `booking.withdrew` on the partner and `booking.partner_withdrew` on
  the organiser (E13-4).
- **The "club put you in X's game" mail promises only what holds.** The share moves when the
  member accepts it, or when the club collects it (J13-7).
- **Every share move names who caused it (R14).** The share cause says which act moved it:
  `share_returned` is only "the partner withdrew"; `player_added` (a player joined and an
  `equal`/`ratio` split went down — R16); `organiser_removed` (the organiser took them
  off); `split_changed` (the organiser lowered their share while they stay on the game); an admin's
  removal stays `club_removed`; the club recording a share as paid by hand is `club_settled`;
  a return that no record explains (a desk adjustment to the booking, a removal from before R14) is
  `share_back`, which names nobody. A cause and its actor come **only from a record** — the
  removal's or the split's own audit row, newer than the seat's last share move — never from the
  seat's state alone, so a later desk adjustment can't read as the organiser's split change. Share rows from an organiser removal, a split change, a
  member cancel (on time or late) and a club cancel carry the **acting person** as ledger actor,
  like the refund beside them. Audit rows `players.removed`, `players.split_changed` and
  `players.game_cancelled` are written in the act's own save; the Night shows `booking.taken_off` /
  `booking.took_player_off`, `booking.split_changed` / `booking.changed_split` and
  `booking.game_cancelled`. The live frame carries `actor_name` — the player who acted, only when
  that is another player on the game (members are told "the club", never an admin's name);
  `share_paid` frames name nobody on either side. On a member's own wallet rows an admin actor reads
  "The club"; the admin ledger, the Night and the CSV keep the admin's name.
- **A late check-in's reversal is the scanner's (R14 E14-3)** on the audit row, both money legs,
  the re-collected shares, the Night ("Sam's check-in reached the club late — no-show reversed") and
  every webhook.
- **The club cancelling a session that had started (refund 0)** still tells the booker: an inbox
  notice and a balance-neutral `cancelled_no_refund` frame; the mail says nothing was refunded and
  promises no wallet line. Refund policy is unchanged (R14 E14-5). The mail, the inbox line and the
  frame (`checked_in_by_name`) name who had checked in — "Pat Smith had checked in already", or
  "You had…" to the member who did; never "Somebody" (R16 E16-3; `feature-spec.md` §11).
- **Links without `?seat=` still land (R14 J14-10).** A 404 from `GET /bookings/{id}` carries
  `own_seat_id` — the viewer's own closed seat, newest, and nothing else — so old invites and mails
  reach "You were taken off this game". Invites carry `consented_minutes` so a seat the club added
  is never told its share "went up" (J14-9). `GET /wallet` carries `share_places` (court and start
  only) for a share booking the member can no longer read.
- **The club's acts are the club's (R15 J15-1, E15-3).**
  - **Who removed or added a member.** The 404 and `GET /me/invites/{pid}` carry `removed_by: "club" | "organiser" | null`, where null means no removal, or one from before R14. Invites carry `added_by_club`. A member is never told the organiser took them off, or invited them, when the club did.
  - **Audit rows.** Settle-outside, collect and admin add write `players.settled_outside`, `players.share_collected` and `players.added_by_club`: the subject is the partner, the actor is the admin, and the organiser is in the details.
  - **The Night.** It reads each act from where the viewer stands:
    - `booking.club_took_player_off`;
    - `booking.share_settled_outside`, `booking.partner_share_settled_outside` and `booking.settled_share_outside`;
    - `booking.share_collected`, `booking.partner_share_collected` and `booking.collected_share`;
    - `booking.added_to_game`, `booking.club_added_player` and `booking.added_player`;
    - `booking.game_no_show` and `booking.game_no_show_reversed`, which put the organiser's no-show and its reversal on the Night of a partner who paid into it.

    Share rows state the direction, the other person and the cause, read off the record; the ledger still stores no cause. `players.game_cancelled` is saved before its share rows.
  - **A split change on a settled seat.** For a share the club recorded as paid by hand, a split change moves nothing in the app and asks for no consent.
  - **The partner's word on a started session.** When the club cancels a session that had started, a partner who paid a share is told it stands (R17 E17-2 narrows this — below).
- **Every seat act is on the record and in every voice (R16).**
  - **An add's share move is the adder's (J16-2).** When an add lowers an `equal`/`ratio` split, each partner whose share moved gets a `players.split_changed` audit row in the add's own save, details `{share_minutes, previous_share_minutes, because: "player_added", joined, by_club}` (`joined` names who joined: "Jo Partner", "Jo Partner and Kim"). The reconcile after the add runs with the adder — the organiser, or the admin — as ledger actor, the organiser's own receipt born read. The share cause is `player_added` (`WalletShareCauses.PlayerAdded`) on the frame, the wallet row, the inbox, the mail, the Night and the CSV: "Jo Partner joined Court 1, Mon 5 Oct, 18:00, so the split went down". The frame's `actor_name` names the organiser when they added; it is null when the club did ("the club"). The reconciles after an accept, a decline or a club accept-on-behalf carry NO actor: a waiting return of another seat retried there would otherwise be put down to them.
  - **Who changed a share (J16-1).** Booking-detail seat rows, `GET /me/invites/{pid}` and the invite rows carry `share_changed_by: "organiser" | "club" | null` and `share_changed_by_name` (the organiser's name; null for the club), off the seat's newest `players.split_changed` record (`ShareChanger`); null/null when nothing has changed it since the invite. A split change on a settled seat tells the partner the organiser changed the split and that, paid by hand, nothing moves in the app.
  - **Accept-on-behalf (E16-1).** Writes `players.accepted_by_club` (subject the partner, actor the admin, organiser in the details) in the act's own save. The Night reads `booking.accepted_for_them` (the partner), `booking.club_accepted_player` (the organiser) and `booking.accepted_for_player` (the admin). The organiser's inbox gains a `players.response` line: "The club accepted Sam Partner's place in your game — Court 1, Thu 8 Oct, 08:00".
  - **Settle-outside tells both (J16-6).** `players.game_changed` (payload `SettledByHand`) to the partner (mailed: "The club recorded that you paid Olive Organiser by hand for Court 1, Thu 8 Oct, 08:00 — nothing moves in the app") and to the organiser (inbox only: "The club recorded that Sam Partner paid you by hand for …"), deduped per act. **"Nothing moves" only when nothing came back (R17 L17-8):** when the partner had paid in the app, that goes back with its own receipt and the lines say so — the partner's "— the 10 minutes you paid in the app go back to you", the organiser's "— the 10 minutes they paid in the app go back to them"; the payload carries `ReturnedMinutes` (null when none) and the mail's callout reads "The 10 minutes you paid in the app for this share go back to your balance — you will get a separate receipt for it. Nothing more moves in the app: the rest is between you and Olive Organiser." `PlayerNotices.SettledOutsideAsync(…, paidInApp, …)` — the desk may record one seat twice. A later cancellation tells a settled partner "you paid Olive Organiser by hand, so that is between you and Olive Organiser", never that anything comes back.
  - **A started session the club cancelled (J16-7).** Besides the inbox line, each accepted partner not settled by hand **who paid a share** (`PaidAsync > 0` — R17 E17-2) gets a balance-neutral wallet frame `reason: "cancelled_share_stands"` (`delta_minutes` 0, `parts: []`, the booking, `cancelled_by: "club"`). The booker keeps `cancelled_no_refund`.
  - **Share lines name the court and the day (E16-4)** — the withdrawal, no-show and club-refund receipts too — and a club removal its cause on both sides ("the club took you off …" / "the club took them off …"). The organiser's collect mail is titled as the club's (E16-5).
- **Money words true per seat, and every seat act on the Night (R17).**
  - **"Your share stands" only to a partner who paid one (E17-2).** On a started game the club cancels, the `cancelled_share_stands` frame, the inbox ending and the mail's "stands" go only to a live seat whose `PaidAsync > 0`. A partner who paid nothing (the desk accepted for them at consent 0; an unanswered invite) reads "— it had started, but you had paid no share, so nothing moves" (inbox) and "The session had started, but you had not paid a share, so nothing moves in your balance." (mail); the payload flag is `GameCancelledPayload.PaidNoShare` (false on older rows). A share paid by hand keeps its own ending (J16-6). *Why:* "stands" was about minutes they never paid.
  - **One wording: "paid by hand" (L17-8).** Every server surface — the Night, receipts and share causes, mail subjects and callouts, the change-log label ("Recorded a share as paid by hand") — says "paid by hand", never "outside the app"; the partner's share-moved mail subject is "Your share came back: paid by hand — Court 1". The wire codes (`settle-outside`, `settled_outside`, `club_settled`, `booking.share_settled_outside`) keep their names.
  - **Every seat check-in is on the Night (J17-4).** Each seat stamp writes `court.checked_in` (§5). The Night maps it to `court.checked_in`: on the scanner's own Night "Checked in at Court 1 for Olive Organiser's booking" when it is somebody else's game (`TraceFacts.SeatOfName`), "Checked in at Court 1" on their own; on the organiser's Night "Sam Partner checked in at Court 1". A row whose scan also lit the court (`lit_court`, or the same scanner's `court.activated` for the booking) folds into that activation — one check-in, one row.
  - **The lights coming on is on every player's Night (E17-4).** `court.lights_on` joins the partner view (`TraceKinds.PartnersViewActions`), but only for a member who was in the session — an accepted seat, or the payer at the box (D10, who holds no seat) — never an invitee who declined or never answered. Nothing new is written; the existing lights row is read off the booker.
  - **A member's own invite, accept and decline are on the record (E17-8).** Audit rows `players.invited` (actor the organiser, subject the invitee; organiser-made adds only — the club's add stays `players.added_by_club`), `players.accepted` (a fresh self-accept; details add `share_minutes`, `paid_minutes`) and `players.declined` (details add `share_minutes`), each with `{booking_id, participant_id, organiser_user_id, starts_at}`, in the act's own save. Six Night kinds: `booking.invited` / `booking.invited_player`, `booking.accepted` / `booking.partner_accepted`, `booking.declined` / `booking.partner_declined` (the member's side / the organiser's side) — "Olive Organiser invited them to a game on Court 1", "Sam Partner accepted a place in their game on Court 1".
- **Every act says what happened, once, and every audit action has a word (R18).**
  - **A seat act is idempotent in its target state (J18-3/J18-4).** Decline on a declined seat, withdraw on a withdrawn one, the organiser's or the desk's remove on a removed one, the desk's accept-on-behalf on an accepted one and settle-outside on a seat already paid by hand answer `200` in the route's own shape, as the first press did, and write **nothing** — no change record, audit row or notice; `SettledOutsideAt` keeps its first instant. A different state is still refused for what happened (a decline after an accept is `not_invited`).
  - **A collision on a dedupe key is "already said", never a fault (J18-2).** When a seat act's save loses a race — a version miss, or a unique violation on anything but the seats (`member_notifications` / `admin_notifications` dedupe keys: the twin raised the same notice) — the seat is read again: in the act's target state → `200` (the twin moved the shares, once); else `409 conflict_retry`. **`409 seat_taken` only for a seat or member really taken** — a unique violation on `booking_participants` (`SeatRaces`). Parallel desk accept-on-behalf presses 500'd on the admin-notice key, and a declining twin read "That seat was taken".
  - **A full booking says full (R19 J19-5).** Adding to a booking whose four seats are live (the organiser's counts, written or not) is `409 booking_full {max_players: 4}` — for the organiser and the desk, member, guest or link alike; asking for more players than there are free seats is `409 too_many_players {max_players: 3, free_seats}`. Both were `seat_taken`, which sent the organiser looking for a seat that does not exist. A seat NAMED in the request that somebody holds, with room elsewhere, is still `409 seat_taken`.
  - **A re-split's twin answers 200 (R19 J19-6).** A `PUT …/split` that loses its save to a twin that already put every live share, weight and the mode where this request would — a double tap, a retried request — answers the same `200` with the same shares and writes nothing, as the seat twins do (J18-3/J18-4). A different concurrent split (or an accept, a removal) keeps `409 conflict_retry`.
  - **An accept holds the booking (J18-5).** The accept takes the booking row `FOR NO KEY UPDATE` after the member and seat locks and before reading it, so a cancel landing mid-accept waits for it, or the accept reads the cancel and answers `409 booking_not_open {booking_id}` (it was `invite_closed`) with no money moved. Not `FOR SHARE`: the accept's own save updates the booking (the play recompute marker), and two shared holders deadlocked upgrading.
  - **The organiser is told when the club cancels (J18-9).** A `players.game_cancelled` inbox line, "The club cancelled your booking on Court 1, Thu 8 Oct, 08:00", keyed `game-cancelled:{booking}:{organiser}` so it is said once, not mailed (the cancellation mail is theirs) — for partnered and seatless bookings alike (`ClubCancelNotices.ForOrganiser`, raised in `ShareSweep`). Not for the organiser's own cancel, a displacement (told by its own notice), or a session somebody had checked in to (the cancellation's own save already wrote that line, "it had started").
  - **"Your share stands" names who checked in (E18-2).** The `cancelled_share_stands` frame carries `checked_in_by_name` / `checked_in_by_you`, by the one rule the booker's `cancelled_no_refund` frame uses (`ClubCancelNotices.CheckedInByAsync`; `BookingService` calls it), so the two frames of one cancel can never name two people.
  - **Every check-in row's subject is the booking's organiser (E18-4).** On every Night: `court.activated` stores it so; a seat's `court.checked_in` stores the seat holder (who is already the actor) and the Night reads the organiser from its `organiser_user_id` (`AdminMemberTraceAssembly.SubjectOf`). The actor is always the scanner.
  - **Lights rows print at the scan (E18-7).** `court.lights_on` is stamped `ScanAt` the scan that lit the court — online the activation's instant, on a late upload the event's `occurred_at` — never the upload, so the row prints at one instant on every Night, beside the receipt and the `booking.lights_on` webhook's `occurred_at`.
  - **Lights restored after a power cut has its word (E18-3).** `court.lights_restored` reads `lights.restored` — "Court 1 lights came back on after a power cut" — on the organiser's Night and every player's (`TraceKinds.PartnersViewActions`, the same players-only rule as `lights_on`).
  - **No audit action reads "no word for this" (E18-3).** `R18TraceGuardTests` scans the WHOLE API — every audit-shaped action constant and every `Action = …` literal — and each must reach a Night word or the declared list of acts that are no person's Night (`TraceKinds`: the club's console acts — doors shut and reopened together, the door-log and monitoring exports, a monitoring resolve, the member-code phase change — and the retention sweep). New words: `account.pin_set` ("Set their court PIN"), `account.pin_set_for_them`, `account.pin_cleared`, `account.fingerprint_enrolled` ("… enrolled their fingerprint") and `account.admin_inherited` ("Became an administrator — the club's set-up names their address"). The old guard read four named files, and `court.lights_restored` is written from a fifth.
  - **A member's own late check-in is in their voice (E18-8).** On their own Night it reads "Their check-in reached the club late — no-show reversed" (or "outage refund reversed"), never their own name in the third person (`TraceFacts.BySelf`). An uploaded activation the server accepted — `ok`, `reversed_no_show`, `after_cancel`, `displaced_collision` — names its member as subject, so the device activity says who scanned, and its verdict row (`TraceKinds.AcceptedVerdictActions`) is never a refusal on a Night.
- **One lighting, one instant, one organiser (R19).**
  - **An activation receipt prints at its lighting's instant (E19-2).** The box's queue re-uploads a scan the server already answered online, stamped with the box's own clock; a receipt row with a server `court.lights_on` twin now prints at the twin's `ScanAt`, so the organiser's "lights came on" sits at the same instant on every Night after the queue drains. **Receipt rows are about the booking's organiser** — subject in the JSON and the CSV — whoever scanned (`AdminMemberTraceAssembly.Twins`).
  - **The release's lights-off prints at the release (E19-2).** The `court.lights_off` row of a box's `release` is stamped at the release the box reported (its receipt's instant), and partners who played see it on their Night — `court.lights_off` joins `TraceKinds.PartnersViewActions` under the same rule as `lights_on` (E17-4: an accepted seat, or the payer at the box).
  - **A seatless payer paid and lit (E19-3).** A pay-for payer with no accepted seat reads "Pam Payer paid for Court 2 at the court box and lit it" on the organiser's Night and "Paid for Court 2 at the court box and lit it for Olga Organiser's booking" on their own (`TraceFacts.PaidAndLit`) — never "checked in": they were not a player on it, and their scan is nobody's attendance (`play.md` §1). A payer holding a seat reads as before.
  - **Lights restored names the organiser (E19-4).** `court.lights_restored`'s subject is the booking's organiser, never the pay-for payer the court's light state names as its cause. It is written once per board boot (`door-gate.md` §12, R19 E19-1).
  - **The no-show's cause before its money (E19-5).** The sweep stamps `booking.no_show` at its instant and the refund and penalty one microsecond (the stored precision) after it (`NoShowWorker.CauseThenMoney`), so the Night, the CSV and the webhooks read the verdict before the money it moved — as a cancellation's rows have since R15.

## 7. Endpoints

Requests are camelCase, answers snake_case. Every refusal is `{ "error": "<code>", …figures }`.

### Member

| Route | Body → answer |
| --- | --- |
| `POST /api/v1/bookings` | + optional `players: [{userId?, guestName?, link?, seat?, weight?, amount?}]`, `splitMode`, `organiserWeight`. `amount` is a whole number of minutes. Validated in full (against the price) BEFORE booking. → `{booking_id, balance_after_minutes, players: {booking_id, participants: [{participant_id, seat, user_id, guest_name, status, share_minutes, invite_token, invite_path}]}, players_error}` — `players_error` is the add's refusal code when the booking stood but the seats could not be added, e.g. `at_daily_limit` (§5) |
| `POST /api/v1/bookings/bulk` | + the same `players`/`splitMode`/`organiserWeight`, applied to every newly booked item → adds `players: [{booking_id, players, players_error}]`. The payload's shape is checked price-free, then the split against EVERY item's price, before anything is booked: any failure books nothing |
| `POST /api/v1/players/split-preview` | `{priceMinutes, splitMode, organiserWeight, players}` → `{price_minutes, shares: [{seat, team, share_minutes, weight}]}` — pure, for the live totals bar |
| `GET /api/v1/bookings/{id}` | → the detail: `booking_id, court_id, court_name, starts_at, ends_at, sold_ends_at, status, split_mode, viewer {role: organiser\|player\|admin, participant_id}, organiser {user_id, name, photo_url}, players [ {participant_id, seat, team, kind: organiser\|member\|guest\|open_link, user_id, name, photo_url, status, share_minutes, weight, consented_minutes, paid_minutes, target_minutes, unpaid_minutes, returned_minutes, needs_consent, share_changed_by, share_changed_by_name, collect_needs_overdraft, settled_outside, lapsed, checked_in_at, invited_at, responded_at, shortfall_minutes} ], money {price_minutes, organiser_owed_minutes, shares_received_minutes, organiser_net_minutes, unpaid_minutes, share_deadline, is_split, refunded_minutes, penalty_minutes, paid_by {user_id, name, photo_url}|null, paid_by_minutes, left_to_cover_minutes} (`paid_by` names whoever took the charge over at the box — D10 — and `paid_by_minutes` what they paid; the organiser's `organiser_owed_minutes` is then what the organiser's OWN rows net to, nothing once refunded — review round 6, E6-2) (`unpaid_minutes` counts every live partner seat still owing, an unclaimed open link seat at its full share until the seat closes or the game is off — review round 1, B4; `returned_minutes` is, on a cancelled game, what the cancellation sent back and, elsewhere, every return so far — review round 4, M4-4), attendance {checked_in_at, players_checked_in} (a booking with no seats counts its organiser from `checked_in_at` — E6-7), refunded_for_outage (a no-show refunded in full because no box on its court was reachable; the status stays `no_show`, the admin is not to read it as one — E6-6), cancelled_by `member|club|null`, cancel_cause `displaced|null` and cancel_reason (the admin's own words on a club cancel; null otherwise) — read from the cancellation's audit row, never from `Booking.CancellationReason`; all three null unless cancelled, and the page says "The club cancelled this game." + "Reason: …", the displacement sentence, or who cancelled (R13 C13-1, J13-6), permissions {can_invite, can_change_split, can_cancel, can_accept, can_decline, can_withdraw, withdraw_closes_at}, timezone` (the club's IANA zone, top level — see below). 404 for anyone not on it and not an admin — a declined, withdrawn, removed or lapsed seat is not "on it". |
| `POST /api/v1/bookings/{id}/players` | organiser: `{players, splitMode?, organiserWeight?}` → as the create's `players`; `409 player_previously_declined` / `player_previously_removed {user_id}`, `409 player_invite_limit {limit, invites_made}`, `409 at_daily_limit {user_id, name}` (§5), `409 booking_full {max_players}` / `409 too_many_players {max_players, free_seats}` (R19 J19-5) |
| `DELETE /api/v1/bookings/{id}/players/{pid}` | organiser → `{participant_id, status}` |
| `POST /api/v1/bookings/{id}/players/{pid}/nudge` | organiser → `{participant_id, nudges_left}`; `429 nudge_limit {limit, retry_after}`; `409 nothing_to_nudge` |
| `POST /api/v1/bookings/{id}/players/{pid}/link` | organiser → `{participant_id, invite_token, invite_path}` (rotates) |
| `PUT /api/v1/bookings/{id}/split` | organiser: `{mode, seats: [{participantId, weight?, amount?}]}` → `{booking_id, split_mode, shares: [{participant_id, seat, share_minutes, weight, needs_consent}]}`; `409 conflict_retry` when a different split won the race — an identical twin answers the same `200` (R19 J19-6). A successful split clears every seat's `ShortfallMinutes` (pay what you can, §4) |
| `POST /api/v1/bookings/{id}/players/{pid}/accept` | partner: `{expectedShareMinutes, payMinutes?}` (`payMinutes`: pay what you can, §4 — `400 pay_minutes_invalid {share_minutes, paid_minutes}` unless `paid ≤ payMinutes < share` and `> 0`) → `{participant_id, booking_id, status, share_minutes, consented_minutes, paid_minutes, balance_minutes, spendable_minutes, held_minutes}`; `400 expected_share_required`, `409 share_changed {share_minutes}` (also after a lost race when the share moved, R19 J19-1), `409 conflict_retry` (a lost race, share unmoved), `402 insufficient_balance`, `409 share_affordable {share_minutes, paid_minutes, spendable_minutes}` (a `payMinutes` from a partner who could pay the whole share — BM-5), `409 partner_cap_exceeded {cap: slots\|minutes, …}`, `409 booking_not_open {booking_id}` on a cancelled game (R18 J18-5), `409 invite_closed`, `409 already_in_booking`, `409 player_previously_removed`, `403 membership_inactive`; `404 invite_not_found` for an unclaimed link seat (claim it by its link) |
| `POST …/{pid}/decline` · `POST …/{pid}/withdraw` | partner → `{participant_id, status}`; withdraw `409 withdraw_window_closed {closed_at}`. A second decline or withdraw — or its twin landing first — answers the same 200 and writes nothing (R18, §6) |
| `GET /api/v1/me/invites` | → `{items: [invite], count, timezone}` — the Invites tab and badge; each `invite` also carries `timezone` |
| `GET /api/v1/me/invites/{participantId}` | → the caller's OWN seat in any status: `{participant_id, booking_id, status, needs_consent, share_changed_by, share_changed_by_name, lapsed, settled_outside, booking_status, court_name, starts_at, ends_at, organiser_name, share_minutes, timezone}`; 404 for anybody else's seat (review round 1, for F2's deep links) |
| `GET /api/v1/invites/{token}/preview` | **anonymous** — `{organiser_first_name, court_name, starts_at, ends_at, share_minutes, timezone}` and nothing else; `404 invite_not_found` for an unknown or other club's token, an answered seat, a game that is not `Booked`, or a closed share window. The token is the credential; global per-address limiter (review round 1, F2) |
| `GET /api/v1/invites/{token}` | → `invite`; 404 `invite_not_found`, 409 `invite_closed`, 409 `already_in_booking`, 409 `player_previously_removed` |
| `POST /api/v1/invites/{token}/accept` · `…/decline` | as the seat routes (accept takes `{expectedShareMinutes, payMinutes?}`) |
| `GET /api/v1/me/partners/recent` | → `{items: [{user_id, name, photo_url, last_played_at, games, played_with_you, last_played_with_you_at, member_since, member_ref}]}` (the last four: §6's picker tiebreak, R16 J16-3 / R17 L17-2) — only games that have started AND the box checked in (review round 1, B11) |
| `GET /api/v1/me/bookings/upcoming` | → `{timezone, items: [{booking_id, court_name, starts_at, ends_at, role: organiser\|partner, status, players [{name, photo_url, status}], my_share_minutes, needs_action}]}` — every `Booked` game whose end is ahead where the caller is organiser or on an ACCEPTED partner seat, soonest first, at most 50 (review round 1, B2). `my_share_minutes`: a partner's own share; the organiser's is the price less the live partners' shares. `needs_action`: a partner asked for more than they consented to, or still owing on an open seat. The schedule marks an accepted partner's game `isMine: true` with `role: "partner"` (`"organiser"` on the booker's own; null otherwise). |
| `GET /api/v1/me/bookings/recent` | → `{timezone, items: [ …the upcoming item…, result_status: none\|pending\|confirmed\|disputed, can_record }]}` — every `Booked`/`Completed`/`NoShow` game that ENDED within `result_record_days` (7) where the caller is the organiser or holds an accepted partner seat, newest first, at most 50 (review round 2, C3). `result_status` is the live result (a pending one past its deadline reads `confirmed`); `can_record` is play.md §3.1's test with no live result. The upcoming list does not carry the two fields. |
| *(notice)* `players.club_seat` | review round 1, B8: the club added the member to a game (`Accepted: false`, links the invite; keyed `invited:club:` so the invite loop's collapse applies) or put them in it (admin add with `accepted`, or accept-on-behalf; links the booking; nothing collected until they accept their share). Mailed. A club collect's receipts say the club collected it and, below zero, where the partner's balance stands; a received share's receipt says it is held and until when (B12). |
| `GET /api/v1/me/partners/favourites` · `PUT`/`DELETE /api/v1/me/partners/favourites/{userId}` | → `{items: [{user_id, name, photo_url, played_with_you, last_played_with_you_at, member_since, member_ref}]}` / `{user_id, favourite}` |
| `GET /api/v1/members/directory?q=` | → `{items: [{user_id, name, photo_url, played_with_you, last_played_with_you_at, member_since, member_ref}]}`; `400 query_too_short`, `429 directory_rate_limited {retry_after_seconds}` |
| `GET /api/v1/me/notifications?cursor&limit` | → `{items: [{id, kind, headline, link, booking_id, created_at, read_at}], unread_count, next_cursor, timezone}` |
| `GET /api/v1/me/notifications/unread-count` | → `{unread_count}` |
| `POST /api/v1/me/notifications/{id}/read` · `POST …/read-all` | → `{id, read}` / `{marked}` |
| `GET/PUT /api/v1/me/preferences` | + `share_results` (D13, stored only); `findable_in_directory` and `show_on_leaderboards` accepted as aliases of `findable` and `show_in_leaderboards` |

`invite` = `{participant_id, booking_id, status, seat, team, open_link, court_name, starts_at, ends_at, organiser {user_id, name, photo_url}, players, share_minutes, to_pay_minutes, needs_consent, share_changed_by, share_changed_by_name, settled_outside, consented_minutes, balance_minutes, spendable_minutes, held_minutes, balance_after_minutes, short_by_minutes, share_deadline, cap, timezone}` — `balance_minutes` is the viewer's raw balance and `balance_after_minutes` that less `to_pay_minutes`; `short_by_minutes` is measured against `spendable_minutes` (§3a), which is what the accept checks; `share_deadline` is the booking's frozen deadline (§3); `cap` is null, or the partner-cap figures when accepting would break the partner's own daily cap.

**Every member payload that is a cold entry point carries the club's zone** as a top-level `timezone` (as does `GET /api/v1/me/profile`, read at every app start). A member opens a booking or an invite straight from a mail, on a phone that may be in another zone; the client learns the zone from any top-level `timezone` and, until it has, writes court times in the phone's zone. A stored zone the platform cannot read is reported as `UTC`, the zone the times were actually computed in.

**Wallet and profile (§3a)**: `GET /api/v1/wallet` adds `held_minutes`, `spendable_minutes`,
`held_until`; the wallet SSE stream's opening frame and named `balance` frame carry the same three;
`GET /api/v1/me/profile` adds `held_minutes`, `owed_back_minutes`, `held_until`. `held_until` is null when nothing is held.
All of them (and the admin member detail) also carry `held_parts: [{minutes, until}]` — one part per share deadline,
soonest first, summing to `held_minutes` (review round 2, C4); `held_until` is the first part's `until`, kept for older clients.
The admin booking quote and the admin bulk quote add `spendable_minutes` and `held_minutes`;
their `balance_minutes` is raw and their `overdraws` is on spendable.

### Admin (god mode — every one in `admin_change_log`)

| Route | Body → answer |
| --- | --- |
| `POST /api/v1/admin/bookings/{id}/players` | `{userId? \| guestName?, accepted?, reason?}` — neither: an open link seat. `accepted` places a member without their consent (collects nothing). → as the organiser's add, including `409 at_daily_limit {user_id, name}` (§5) and `409 booking_full` / `too_many_players` (R19 J19-5) |
| `POST /api/v1/admin/bookings/{id}/players/{pid}/remove` | `{reason, allowNegativeBalance?}` → `{participant_id, status, return_waiting, return_minutes}` — `return_waiting` is true (with `return_minutes`, the amount due back) when the hand-back passed the coverage check but a spend raced it and the reconcile left it waiting (§3); `return_minutes` is null otherwise. `allowNegativeBalance: true` is required whenever the hand-back is not covered by the organiser's coverage (§3), whatever the deadline: `400 overdraft_not_authorised {return_minutes, covered_minutes}` |
| `POST …/{pid}/accept` | `{reason}` — accept on behalf; records no consent; writes `players.accepted_by_club` and tells the partner and the organiser (§6, R16 E16-1) |
| `POST …/{pid}/settle-outside` | `{reason, allowNegativeBalance?}` → as remove, with `return_waiting` / `return_minutes` — paid by hand; anything collected in-app goes back. Accepted seats only: `409 player_not_accepted`. `allowNegativeBalance: true` is required whenever the hand-back is not covered, as for remove |
| `POST …/{pid}/collect` | `{reason, allowNegativeBalance?}` — the only path that may take a partner below zero, or collect from a lapsed seat → `{participant_id, collected_minutes, balance_after_minutes}`. `allowNegativeBalance: true` is needed only when the partner's spendable minutes (§3a) do not cover what would be collected (R16 J16-10) — decided again under the partner's lock — else `400 overdraft_not_authorised {collect_minutes, balance_minutes}` (`balance_minutes` is the spendable figure) and nothing is written; a covered share collects without it. The admin booking detail's seat row says which in advance: `collect_needs_overdraft` true / false, null where collect does not apply (organiser, guest, not accepted, settled outside, nothing unpaid, a game not booked or completed). `409 player_not_accepted` on a seat nobody accepted, `409 share_settled_outside` on one the club recorded as paid by hand (R16 E16-8), `409 nothing_to_collect`, `409 conflict_retry`. The consent, the change-log line (the figure actually posted) and the pair are one transaction under the partner's lock |

Remove, accept-on-behalf and settle-outside on a seat already in their target state answer as the
first press did and write nothing; a lost race re-reads the seat (`200` if it landed, else
`409 conflict_retry`) — R18, §6.

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
| Held minutes, spendable | `Services/Players/ShareHolds.cs`, `Services/LedgerService.cs` — `GetHeldAsync`, `GetSpendableAsync` |
| The one writer of `ShareTransfer` | `Services/Players/ShareLedger.cs` |
| After settlement / the minute sweep | `Services/Players/ShareHook.cs`, `ShareSweep.cs`, `Workers/ShareWorker.cs`; the marker staged with the money: `Persistence/MainframeDbContext.ShareStaging.cs` |
| Partner cap (D12) | `Services/BookingRules.cs` — `PartnerCapRefusalAsync`, `HeldAsync`; on adds, `PlayersService.DailyLimitRefusalAsync` (R16) |
| Partner at the court / door | `Services/CourtActivationService.cs`, `Services/GateAccess.cs`, `Endpoints/PinEndpoints.cs`, `Biometric/BiometricService.cs` |
| Member notices | `Services/Players/MemberNotices.cs`, `MemberEventCatalogue.cs`, `Email/EmailTemplatesPlayers.cs`, `Services/AdminNotificationDispatcher.cs` |
| Reads | `Services/Players/PlayersQuery.cs`; routes `Endpoints/PlayersEndpoints.cs`, `Endpoints/MemberNotificationEndpoints.cs` |

Pinning tests: `SplitCalculatorTests`, `ShareRulesTests`, `PlayerSettingsTests`, `PlayersHttpTests`,
`PlayersAccessHttpTests`, `PlayersReviewHttpTests` (the adversarial review's findings, one test each),
`PlayersRefuteHttpTests` … `PlayersRefute8HttpTests` (the refuter's rounds on those fixes),
`PlayersPropertyHttpTests` (the seeded property search), and per review round the `R13…`/`R15…`/`R16…`
HTTP suites (R16: `R16SeatActsHttpTests`, `R16WordsHttpTests`, `R16NightBadgesPickerHttpTests`).
