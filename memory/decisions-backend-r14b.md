---
name: crusaders-mainframe-decisions-backend-r14b
description: "Backend round 14 (lane BE14b): share causes split by act, the acting person is every share row's actor, removals/splits/cancelled games are on the record, reversals are the scanner's."
type: decision
last_verified: 2026-10-05
---

# Live decisions — backend, review round 14 (lane BE14b)

Earlier: `decisions-backend-r13b.md`. Contract: lane scratch `r14-contract-BE14b`, folded in here.

- **`share_cause` is decided by the act, read off the seat** (X14-2/E14-1). `share_returned` = the
  partner withdrew ONLY; `organiser_removed` (seat Removed, no club hand), `split_changed` (seat still
  live), `club_removed` unchanged for an admin. Decided in `ShareLedger.CauseOf` from `SeatFacts`
  (seat status + the `players.removed` record), not from the caller's options — so a return that
  waited for cover and posts on a sweep keeps its cause. *Why:* the caller is gone by then.
- **The acting person is the share rows' actor** (E14-2/J14-3). `ShareLedger.ActorOf`: the caller's
  `ReconcileOptions.ActorUserId`, else derived — scanner (attended), the `booking.cancelled` record's
  actor (`BookingCancellation.ActorUserId`; club AND member AND late cancel), the withdrawing partner,
  the organiser (removal / split), the removal record's actor. Null = system. Organiser removal and
  split change now pass `ReconcileOptions(organiserId)`. `OwnActionBy`/born-read is unchanged (derived
  actors never make a receipt born read). Frame `actor_name` names the actor only when they are a
  player on the game (`ShareWhy.ActorIsPlayer`) and not the frame's member — admins stay "the club".
- **On the record** (E14-2): `players.removed` (actor organiser or admin, subject partner, details
  `participant_id`, `organiser_user_id`, `by_club`) in the removal's save; `players.split_changed`
  per partner whose share moved (`share_minutes`, `previous_share_minutes`); `players.game_cancelled`
  per live partner beside the "game is off" notice (detached when the notice dedupes). Night kinds
  `booking.taken_off` / `took_player_off` / `split_changed` / `changed_split` / `game_cancelled`
  (null on the canceller's own night — their `booking.cancelled` row says it).
- **A late check-in's reversal is the scanner's** (E14-3): audit, both legs (so CSV, Night,
  `minutes.refund_reversed`), and the re-collected shares. `SettledLegsAsync` now finds earlier
  reversal legs by their `noshow-reversal:{id}:` reference, not by the system actor. Displacement
  rows it causes stay the system's.
- **The club cancelling a started session** (E14-5): refund policy unchanged (0). Booker gets an
  inbox `players.game_cancelled` (not mailed) and a balance-neutral frame `reason:
  cancelled_no_refund`; the cancellation mail says "Nothing — the session had started" instead of
  promising a wallet line (`CancelledSlot.SessionStarted`).
- **`GET /wallet?include=share_bookings` carries `share_places`** (E14-7, FE14m's ask): `{bookingId: {court_name, starts_at}}` for every booking the member has a share row on, readable or not (`share_bookings` keeps its null for an off-game booking). Court and start only — tenant-filtered, own rows only.
- **404 detail names the viewer's own closed seat** (`own_seat_id`, J14-10) — own seat only.
- Share receipts for removal / split / cancel say who, with court and day; share mails after a
  cancel name who cancelled (J14-8). Outage-reversal mail: one "so".
- Tests: `R14ShareCausesHttpTests`, `R14NightAndCancelHttpTests` — 24/24 red at HEAD 0ab1b559 first.
