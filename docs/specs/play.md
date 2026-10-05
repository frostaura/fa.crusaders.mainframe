# Play (D14 MVP) — results, personal stats, streaks, badges, the court-time ring

**What a member did on court, kept for them alone.** Playtomic is the reference for the feel —
match results both sides agree on, a record that makes you want to come back — and the bar is to
beat its weak points: nothing public, nothing that nags, nothing earned by spending money, and no
result that one player can write into another's history without them seeing it.

This document is normative for the backend and is the contract two lanes build against in
parallel (§12). Where code and this document disagree, one of them is a defect; say which.

**Out of scope (D14):** ratings (Glicko), leaderboards, open games, the recap email, auto-pay,
reminder emails of any kind, webhooks for play events, and anything visible to another member
beyond a result on a booking they both played. `show_in_leaderboards` and `share_results`
(P11, stored only) stay reserved and are read by nothing here.

---

## 1. Vocabulary — exact

- **Player of a booking** — exactly P11's rule (`players-and-splits.md` §5, through
  `BookingPlayerQueries`): the booker (`bookings.UserId`), or a member holding a LIVE accepted
  seat. A declined, withdrawn, removed or lapsed seat is not a player. Admin blocks
  (`UserId` null) have no players.
- **Attended** — the invariant's meaning: attendance is `CheckedInAt`, set only by the court box's
  identification (or a no-show reversal on box evidence), **never the clock, never `ChargedAt`,
  and never a door scan** (`decisions-gate.md`: a door is never attendance). A member attended a
  booking when either
  1. their own seat carries `booking_participants.CheckedInAt` (they scanned), whatever the seat's
     status now; or
  2. the booking carries `bookings.CheckedInAt` and they are a player of it (the booker, or an
     accepted seat) — one scan lights the court for everybody on it, and partners who walked in
     behind the scanner played.

  Booking status is not consulted: a cancellation after check-in (S4) and a reversed no-show (S6)
  were attended; a no-show and a displaced booking (S8) were not, because they carry no check-in.

  **From when** (review round 2, B-11): a session counts from its court time or its check-in,
  whichever is later (`AttendanceQuery.AttendedAt`) — the rule a result already keeps (§3.1). A
  booking whose court time has not started is not yet attended, so a scan during early entry
  awards nothing until the court starts: the check-in's recompute marker is staged for the start
  (`PlayRecomputeDueAt = max(now, StartsAt)`), and the badge is dated then. The scan is evidence
  the member came, not the instant they played ("First court" at 06:24 for a 06:30 court).
- **Session** — one attended booking, from one member's point of view.
- **Played minutes** of an attended booking — `max(0, min(EndsAt, CancelledAt ?? EndsAt) − StartsAt)`
  in whole minutes, from the row as it stands (a released tail has already truncated `EndsAt`).
- **Club week** — Monday 00:00 to the next Monday 00:00, club-local (IANA zone from
  `tenant_settings.timezone` through `ClubClock`). **A week's key is its Monday's club-local
  date** (`DateOnly`), never `(year, ISO week number)` and never an instant plus 7 × 24 h. A
  session belongs to the week of its `StartsAt`'s club-local date.
- **Club month** — the club-local calendar month of a session's `StartsAt`.
- **Side** — `a` or `b` in a result. A result's lineup is its own (§3.2), not the seats' teams.

## 2. Data model

Every table carries `TenantId` and is `ITenantScoped` (global query filter). Status enums are
stored as strings (lower snake case) so the wire and the row read alike. Timestamps are
`timestamptz` written through `.Storable()` (`gotchas-postgres-offsets.md`).

### 2.1 `match_results` — one row per recorded match

| Column | Type | Notes |
| --- | --- | --- |
| `Id` | uuid PK | |
| `TenantId` | uuid | |
| `BookingId` | uuid FK → bookings | restrict delete |
| `Status` | text(16) | `pending` · `confirmed` · `disputed` · `voided` · `withdrawn` |
| `Format` | text(16) | `best_of_3` · `best_of_5` |
| `GamesJson` | jsonb | `[{"a":11,"b":7}, …]` in play order — validated by `SquashScore` (§4) before it is written |
| `GamesWonA`, `GamesWonB` | smallint | derived from `GamesJson` at write, for reads and reports |
| `WinnerSide` | char(1) | `a` · `b` |
| `SubmittedByUserId` | uuid | the member who recorded (or last edited) it; always in the lineup |
| `SubmittedAt` | timestamptz | the first recording |
| `EditedAt` | timestamptz null | the last edit |
| `ConfirmDueAt` | timestamptz null | set while `pending`: last submit/edit + `result_autoconfirm_hours` |
| `ConfirmedAt` | timestamptz null | |
| `ConfirmedByUserId` | uuid null | the confirming member; null when auto-confirmed |
| `AutoConfirmed` | bool | |
| `DisputedAt`, `DisputedByUserId` | null | |
| `DisputeNote` | text(280) null | shown to the booking's players and to admins |
| `ClosedAt`, `ClosedByUserId` | null | voided (admin) or withdrawn (member) |
| `CloseReason` | text(500) null | the admin's reason on void / uphold |
| `IdempotencyKey` | text(64) | the client's key on the create (§6.1) |
| `Version` | int | concurrency token, bumped on every modification (as `Booking.Version`); also the client's `expectedVersion` |
| `CreatedAt`, `UpdatedAt` | timestamptz | |

Indexes and constraints:
- **One live result per booking** — unique `(TenantId, BookingId)` filtered
  `"Status" IN ('pending','confirmed','disputed')`. A voided or withdrawn row keeps its history and
  frees the booking for a new record.
- Unique `(TenantId, SubmittedByUserId, IdempotencyKey)` — a replayed create finds its row.
- `(TenantId, ConfirmDueAt)` filtered `"Status" = 'pending'` — the auto-confirm sweep.
- `(TenantId, DisputedAt)` filtered `"Status" = 'disputed'` — the admin disputes list and count.
- CHECKs: `GamesWonA <> GamesWonB`; `WinnerSide IN ('a','b')`; `Format IN (…)`; `Status IN (…)`.

### 2.2 `match_result_players` — the lineup, frozen at submit/edit

| Column | Type | Notes |
| --- | --- | --- |
| `Id` | uuid PK | |
| `TenantId`, `ResultId` (FK cascade) | uuid | |
| `Side` | char(1) | `a` · `b` |
| `Position` | smallint | 1 or 2 |
| `UserId` | uuid null | a member |
| `ParticipantId` | uuid null | the guest's seat (`booking_participants.Id`) |
| `GuestName` | text(64) null | snapshot of the guest's name |

- CHECK exactly one of `UserId` / `GuestName` is set; `ParticipantId` set iff `GuestName` is.
- Unique `(ResultId, Side, Position)`; unique `(ResultId, UserId)` filtered `UserId IS NOT NULL`.
- `(TenantId, UserId)` — every per-member stats read.
- An edit replaces the rows in the same save.

### 2.3 `member_badges` — awarded, never revoked

`Id`, `TenantId`, `UserId`, `BadgeKey` text(48), `AwardedAt` (the **qualifying instant**, §5.4 —
not the insert time), `BookingId` null, `ResultId` null (what qualified it), `CreatedAt`.
Unique `(TenantId, UserId, BadgeKey)` — awarding is `INSERT … ON CONFLICT DO NOTHING`, so it is
idempotent however often or concurrently the evaluator runs.

### 2.4 `play_celebrations` — one-shot moments the PWA acknowledges

`Id`, `TenantId`, `UserId`, `Kind` text(24) (`badge` · `goal_reached`), `DedupeKey` text(120)
(`badge:{key}` · `goal:{yyyy-MM}`), `BadgeKey` null, `Month` text(7) null, `CreatedAt`,
`SeenAt` null. Unique `(TenantId, UserId, DedupeKey)`; index `(TenantId, UserId)` filtered
`"SeenAt" IS NULL`. `RetentionWorker` deletes seen rows older than
`member_notification_retention_days` (P11's key — one number for "how long a read notice lives").

### 2.5 `member_play_profiles` — the member's own play settings

`Id`, `TenantId`, `UserId` (unique with tenant), `MonthlyGoalMinutes` int null (null = no ring),
`CelebrationsEnabled` bool default true, `EvaluatorVersion` int default 0, `EvaluatedAt` null,
`CreatedAt`, `UpdatedAt`, `Version`. Created lazily (upsert on `(TenantId, UserId)`) by the first
write or evaluation — a member without a row reads as defaults.

### 2.6 `member_streak_pauses` — injury pauses

`Id`, `TenantId`, `UserId`, `StartedAt`, `EndedAt` null (null = still on), `CreatedAt`. Unique
`(TenantId, UserId)` filtered `"EndedAt" IS NULL` — at most one open pause.

### 2.7 `bookings.PlayRecomputeDueAt` — the recompute marker

`timestamptz null` + index `(TenantId, PlayRecomputeDueAt)` filtered `IS NOT NULL`. Staged in the
same transaction as any change that may move a member's play record (§7.1).

Migration `AddPlay` creates all of the above; its `Down` drops them (no money, nothing else reads
them). No backfill in SQL — the retro-award is the worker's (§7.3).

## 3. Results

### 3.1 When a result may be recorded

A player may record a result for booking `b` when **all** hold, else `409 result_not_recordable
{reason}`:

| Condition | `reason` |
| --- | --- |
| `b` is not an admin block and has at least two players or guests to line up | `not_enough_players` |
| `b.CheckedInAt` is set — the box saw the session (a door scan is not enough) | `not_checked_in` |
| the court time has started AND the check-in has happened — whichever is later (review round 1, B15: an early-entry scan does not open recording) | `not_started` |
| now ≤ `b.EndsAt` + `result_record_days` | `window_closed` |
| no live result exists on `b` | → `409 result_exists {result_id}` instead |

Recording may begin the moment the court is checked in — players often record between games.

### 3.2 The lineup

- **Singles (1 v 1) or doubles (2 v 2)** — nothing else (`lineup_invalid {reason: "side_size"}` /
  `"uneven_sides"`).
- **Candidates** are the booking's players (the booker and every live accepted member seat) and
  its **guest seats** (live, `GuestName` set). Anyone else is `lineup_invalid {reason:
  "unknown_player"}`; a player twice is `"duplicate_player"`.
- **Each candidate has a `player_key`**: `u:{userId}` for a member, `g:{participantId}` for a guest.
- **The submitter must be in the lineup** (`"submitter_not_in_lineup"`). Their side is the
  **submitting side**; the other is the **confirming side**.
- **Why the lineup is the result's own and not the seats' teams:** P11 puts a singles partner on
  the lowest free seat — seat 2, team A — so seat teams would record every singles game as two
  team-mates. The PWA pre-fills sides from the seat teams (`default_sides`, §6.1) — seats 1–2 vs
  3–4 when both teams are populated, else the booker vs the first other candidate — and the
  submitter confirms or swaps. The frozen rows (§2.2) are what history reads, so a later seat
  change cannot rewrite a match.
- **Guests appear but get no stats** — they have no member to attribute to. A result whose
  confirming side is all guests has nobody who can confirm it; it auto-confirms like any other
  (§3.3). It is the submitter's own private record and counts only in the submitter's side's
  stats — no other member's.

### 3.3 The state machine

```
record ─▶ pending ─┬─ edit (submitting side) ─────────────▶ pending   (clock restarts)
                   ├─ confirm (confirming side) ──────────▶ confirmed
                   ├─ ConfirmDueAt passes ────────────────▶ confirmed (auto)
                   ├─ dispute (confirming side) ──────────▶ disputed
                   ├─ withdraw (submitting side) ─────────▶ withdrawn  ▪
                   └─ void (admin) ───────────────────────▶ voided     ▪
disputed ─┬─ uphold (admin) ──▶ confirmed
          ├─ withdraw (submitting side) ──▶ withdrawn ▪
          └─ void (admin) ──▶ voided ▪
confirmed ── void (admin) ──▶ voided ▪                         ▪ terminal; frees the booking
```

| From | Action | Who | To | Effect |
| --- | --- | --- | --- | --- |
| — | record | a player of the booking, in the lineup | `pending` | `ConfirmDueAt = now + result_autoconfirm_hours`; notify the confirming side |
| `pending` | edit | a member of the **submitting** side | `pending` | games/format/lineup replaced; `Version`+1; the editor becomes `SubmittedByUserId`; **`ConfirmDueAt` restarts** — auto-confirm is consent by silence to the score shown, so a changed score earns a fresh window |
| `pending` | confirm | a member of the **confirming** side who is still a player | `confirmed` | `ConfirmedByUserId`, `ConfirmedAt` |
| `pending` | (deadline) | the clock | `confirmed` | `AutoConfirmed = true`, `ConfirmedAt = ConfirmDueAt` |
| `pending` | dispute | a member of the confirming side | `disputed` | `DisputedAt/By`, `DisputeNote` (≤ 280) |
| `pending`, `disputed` | withdraw | a member of the submitting side | `withdrawn` | frees the booking for a new record inside the window |
| `disputed` | uphold | admin, reason | `confirmed` | `ClosedByUserId` = admin, `CloseReason`; change log `play.result_upheld` |
| `pending`, `disputed`, `confirmed` | void | admin, reason | `voided` | change log `play.result_voided`; frees the booking |

- **The deadline is the instant; the worker only catches up.** A result whose `ConfirmDueAt` has
  passed is confirmed by whichever comes first — the minute sweep, or any read or action on it
  (which applies the confirmation in its own save before answering). A dispute arriving after
  the deadline is therefore `409 result_not_pending {status: "confirmed"}`, however recently the
  sweep ran. Same pattern as P11's frozen share deadline.
- **A confirmed result is immutable to members.** Only an admin void removes it. A disputed result
  never auto-confirms; it waits for an admin or the submitter's withdrawal.
- **Stats count `confirmed` results only.** Pending, disputed, voided and withdrawn count for
  nothing — so a disputed game costs neither side its record while the club looks.
- **Badges are never taken back** — not by a void, not by a reversal. A badge is a private
  moment already celebrated; revoking it is a new code path and an anti-celebration for a rare,
  harmless case. Stats, being derived, drop a voided result at once.
- **Double taps and races**: every mutating call names `expectedVersion`. A stale version is
  `409 result_changed {version, status}` — except that an action already in the state it asks for
  is `200` with the result (a second confirm by the same member, a second dispute, a withdraw of a
  withdrawn result by the same side). The concurrency token makes the auto-confirm sweep and a
  racing dispute lose cleanly: one save wins, the loser re-reads and answers from the winner's row.

### 3.4 What each player sees

On the booking (§6.1) every player — organiser or live seat, either side — sees the live result
(or the latest closed one with its status), the lineup by name and photo, the games, who recorded,
confirmed or disputed it, and the dispute note. **Nobody outside the booking sees any result.**
There is no member-to-member stats view, no public profile, and nothing in the directory.

## 4. Squash scoring — `SquashScore`

**Point-a-rally to 11 (PAR-11)**, the World Squash scoring system since 2009 and what every club
league plays: a game is won by the first to 11, **except that at 10–10 play continues until one
side leads by two**. The old hand-out scoring to 9 is not supported — nobody at the club plays it
and a second rule doubles the validation surface for nothing.

**Best of 3 or best of 5, chosen by whoever records the match**, defaulting to **best of 5** —
the standard match and what a club evening plays when the court is booked for 45 minutes or more;
best of 3 exists for a short slot or a warm-up match. The confirming side sees the format and can
dispute it like anything else. A match must be **complete** (§14 Q2).

### 4.1 A game `{a, b}`

Let `w = max(a, b)`, `l = min(a, b)`. In this order, the first failing rule is the reason:

| Rule | `reason` |
| --- | --- |
| `a ≥ 0` and `b ≥ 0`, integers | `negative` |
| `w ≤ 99` (a sanity bound; a real tie-break never approaches it) | `too_high` |
| `a ≠ b` | `tied` |
| `w ≥ 11` | `below_eleven` |
| `w − l ≥ 2` | `not_two_clear` |
| `w = 11` or `w − l = 2` (past 11 the game ends the moment the lead is two) | `overrun` |

### 4.2 A match

`needed = 2` for `best_of_3`, `3` for `best_of_5`. An unknown format is checked first. Then walk
the games in order, counting wins per side; for each game, **first** whether the match was already
decided, **then** its score: a game after either side reached `needed` is
`400 games_after_decided {game_index}`; ending with
neither at `needed` is `400 match_incomplete {games_needed}` (`games_needed` = `needed`); an
unknown format is `400 format_invalid`. A game failing §4.1 is `400 score_invalid {game_index, reason}` (0-based
index; the first failing game only).

### 4.3 Vectors — the shared corpus

The table below is `src/contracts/play/squash-scores.json` verbatim (created by the backend lane,
read by both `SquashScoreTests` and `playScore.test.ts` — the PWA's live validation must agree
with the server's to the reason):

| # | format | games | expected |
| --- | --- | --- | --- |
| 1 | bo3 | 11–7, 11–9 | ok · a 2–0 |
| 2 | bo3 | 11–7, 9–11, 12–10 | ok · a 2–1 |
| 3 | bo3 | 5–11, 11–13 | ok · b 0–2 |
| 4 | bo3 | 11–7, 11–9, 11–3 | games_after_decided · 2 |
| 5 | bo3 | 11–7 | match_incomplete · 2 |
| 6 | bo3 | (none) | match_incomplete · 2 |
| 7 | bo5 | 11–0, 11–0, 11–0 | ok · a 3–0 |
| 8 | bo5 | 11–9, 10–12, 14–12, 7–11, 11–5 | ok · a 3–2 |
| 9 | bo5 | 11–5, 11–5 | match_incomplete · 3 |
| 10 | bo5 | 11–5, 5–11, 11–5, 5–11, 11–5, 11–5 | games_after_decided · 5 |
| 11 | bo5 | 11–10, 11–0, 11–0 | score_invalid · 0 · not_two_clear |
| 12 | bo5 | 12–11, 11–0, 11–0 | score_invalid · 0 · not_two_clear |
| 13 | bo5 | 13–10, 11–0, 11–0 | score_invalid · 0 · overrun |
| 14 | bo5 | 14–10, 11–0, 11–0 | score_invalid · 0 · overrun |
| 15 | bo5 | 10–8, 11–0, 11–0 | score_invalid · 0 · below_eleven |
| 16 | bo5 | 11–11, 11–0, 11–0 | score_invalid · 0 · tied |
| 17 | bo5 | −1–11, 11–0, 11–0 | score_invalid · 0 · negative |
| 18 | bo5 | 100–98, 11–0, 11–0 | score_invalid · 0 · too_high |
| 19 | bo5 | 11–9, 15–13, 11–2 | ok · a 3–0 (15–13 is a legal tie-break) |
| 20 | bo5 | 11–9, 11–13, 12–10, 0–11, 11–4 | ok · a 3–2 |
| 21 | bo7 | 11–0, 11–0, 11–0, 11–0 | format_invalid |
| 22 | bo3 | 11–9, 11–10 | score_invalid · 1 · not_two_clear (the second game) |

## 5. Computation rules — personal stats, streak, ring, badges

All of it is **derived on read from bookings, seats, results and pauses** — never stored — except
the badges and celebrations, which are moments with a date (§2.3–2.4). Derived means a no-show
reversal, a void or a late seat change is reflected the next time anyone looks, with no sweep to
forget. The pure functions live in `Services/Play/` and take plain inputs so the property tests
can drive them without a database: `ClubWeek`, `StreakMath`, `PlayStats`, `BadgeRules`.

### 5.1 Personal stats (`PlayStats`)

| Figure | Definition |
| --- | --- |
| `sessions_attended` | count of attended bookings (§1), all time |
| `minutes_on_court` | Σ played minutes of attended bookings, all time — **from attendance, never from results** |
| `minutes_this_year` | the same, `StartsAt` in the current club-local calendar year |
| `matches_played` / `won` / `lost` | confirmed results with the member in the lineup; won when their side is `WinnerSide` |
| `games_won` / `games_lost` | Σ over those results, from the member's side |
| `win_rate_percent` | `round(100 × won / played)`, null when `played = 0` |
| `partners` | top 3 **members** by number of the member's attended sessions they were a player of; ties → most recent shared session. P11's word "partner" — the people you booked and played with, whichever side of the net |
| `opponents` | top 3 members most often on the other side of a confirmed result, with the head-to-head `won`/`lost`; ties → most recent |
| `form` | the last 5 confirmed results, newest first: `won` · `lost` |

### 5.2 The weekly streak (`ClubWeek`, `StreakMath`)

**Weeks, not days** — squash is two or three times a week at best, and a daily streak would be a
nag by construction. **A week counts when the member attended at least one session in it.**

Inputs: the set of attended week keys `A`, the member's pauses, the current week `C`, and the
club's `streak_rest_every_weeks` (`E`, 4), `streak_rest_cap` (`K`, 2) and
`streak_pause_weeks_per_year` (`Y`, 8). State: `streak` (attended weeks in the current run),
`counter` (attended weeks of progress towards the next rest week — it accrues **only while
`bank < K`**), `bank` (rest weeks held). Walk every week from the first attended week to `C`,
oldest first:

```
attended (w ∈ A)                 → streak += 1; if bank < K: counter += 1; if counter == E: bank += 1, counter = 0
paused (w is a paused week, §5.3) → nothing — neither counts nor breaks
w == C, not attended             → nothing — the week is still open ("pending")
missed, streak == 0              → nothing
missed, bank > 0                 → bank -= 1   — a REST week, applied automatically; streak and counter unchanged
missed, bank == 0                → streak = counter = bank = 0   — broken
```

- The **current streak** is `streak` after the walk; the **longest** is its maximum along the way.
  A streak is counted in attended weeks: rest and paused weeks keep it alive but do not add to it.
- **Rest weeks are earned, automatic and silent**: every `E` attended weeks of progress earn one,
  up to `K` banked; a missed week spends one without the member doing anything. **At the cap an
  attended week builds no progress**; progress resumes once a rest week is spent, and a spend
  keeps whatever progress was made. A break empties the bank and the progress. `K = 0` turns rest
  weeks off.
- **Why progress stops at the cap — a member who plays more must never see a shorter streak.**
  The first version earned at `counter % E == 0` with `counter` = the streak, and threw an earn
  away at the cap, so where a run started decided which earns were lost: X, who played weeks 1–12
  and 14, was broken at week 16, while Y — the same history minus week 1 — was still on a 12-week
  streak (found by the P12 build; pinned as a regression test). Stated as one credit number
  `c = bank × E + counter`, the rule is: attended → `c = min(c + 1, K × E)`; missed → `c − E` if
  `c ≥ E`, else broken. Both are non-decreasing in `c` and a break needs `c < E`, so an extra
  attended or paused week can only keep `c` — and the streak — at least as high.
- **The current week never breaks a streak** — it is only judged once it has ended, at the next
  read. Nothing runs at midnight on Sunday, and nothing is sent: **no reminder, no "your streak is
  at risk" message, in any channel** (D14: no nagging).
- **Property (tested, §11, rest weeks on, 2,000 seeds):** adding an attended week, or a paused
  week, anywhere never lowers the current streak; the result is independent of the order the inputs arrive in; the walk is
  identical whether run in one pass or resumed from any intermediate state.

**Week keys are DST- and year-safe by construction.** An instant becomes a club-local date through
`ClubClock.DateOf` (the one DST-correct primitive — D2-B36 in `ClubClock.cs`), and the week key is that date
minus `(dayOfWeek + 6) % 7` days — pure calendar arithmetic on `DateOnly`, so a 167- or 169-hour
week cannot shift a session across a boundary, and a year boundary is not special.

### 5.3 The injury pause

- The member turns it **on** (`POST /me/play/pause`) and **off** (`DELETE`). It takes effect from
  the **current** club week — never backwards, so it cannot rescue a week already missed.
- **Paused weeks**: every week from the week of `StartedAt` to the week of `EndedAt` (or `C` while
  on), inclusive — except a week the member attended, which simply counts as attended.
- **Allowance, not a timer**: at most `Y` paused-and-not-attended weeks per **club year** (the
  calendar year of the week's Monday). Weeks past the allowance are ordinary weeks even while the
  pause is on — they may spend a rest week or break the streak — and the PWA says so on the pause
  card ("Your 8 pause weeks for 2026 are used — this week counts"). A pause that outlives the
  allowance stays on (the member may still be injured), and the next year's allowance applies from
  its first week. Starting a pause with no allowance left is `409 pause_allowance_used`. `Y = 0`
  turns pausing off.
- **Why an allowance instead of a maximum length:** a per-pause maximum is defeated by switching
  off and on again; a yearly allowance bounds the only thing that matters — how much of a year a
  streak can survive without play — and needs no cooldown rule. Nothing is public, so the goal is
  honesty with oneself, not anti-cheat.

### 5.4 Worked examples

**A — rest weeks and a pause, across the autumn DST change.** Club zone `Europe/London` (fixtures
must use it; Johannesburg has no DST and every fixture club otherwise runs UTC). `E = 4`, `K = 2`,
`Y = 8`.

| Week (Mon) | What happened | streak | counter | bank | Note |
| --- | --- | --- | --- | --- | --- |
| 2026-09-07 | played | 1 | 1 | 0 | |
| 09-14 | played | 2 | 2 | 0 | |
| 09-21 | played | 3 | 3 | 0 | |
| 09-28 | played | 4 | 0 | 1 | rest week earned (counter back to 0); badge `streak_4` |
| 10-05 | missed | 4 | 4 | 0 | rest week spent automatically |
| 10-12 | played | 5 | 1 | 0 | |
| 10-19 | played **Sun 25 Oct 23:30 GMT** | 6 | 2 | 0 | the clocks went back at 02:00 that morning; `2026-10-25T23:30Z` is Sunday 23:30 local → week of **19 Oct**. The week of 19 Oct is 169 hours long; "Monday 19 Oct 00:00 BST + 168 h" would have put this session in the next week |
| 10-26 | played | 7 | 3 | 0 | |
| 11-02 | played | 8 | 0 | 1 | rest week earned |
| 11-09 | pause on Wed 11 Nov | 8 | 0 | 1 | paused (2026 allowance: 1 of 8 used) |
| 11-16 | pause off Fri 20 Nov | 8 | 0 | 1 | paused (2 of 8) — the week it ended is still paused |
| 11-23 | missed | 8 | 0 | 0 | rest week spent |
| 11-30 | missed | 0 | 0 | 0 | **broken** — no rest week left |
| 12-07 | played | 1 | 1 | 0 | a new streak |

**B — the spring change.** `2026-03-29T23:30Z` in London is **Monday 30 Mar 00:30 BST** → week of
**30 Mar**, although the UTC date is Sunday 29 Mar. `2026-03-29T00:30Z` is Sunday 00:30 GMT (the
clocks jump at 01:00) → week of 23 Mar. The week of 23 Mar is 167 hours long.

**C — the year boundary.** 2026 has an ISO week 53: **Mon 28 Dec 2026 – Sun 3 Jan 2027**. A
session on Sat 2 Jan 2027 is in week `2026-12-28`; one on Mon 4 Jan 2027 is in week `2027-01-04`;
the two weeks are consecutive, so a streak continues. Keying by `(calendar year, ISO week)` would
have split week `2026-12-28` into two keys, and keying by ISO week-year would put Mon 29 Dec 2025
in "2026-W01" — both wrong answers the Monday-date key cannot give. For the pause allowance, the
week `2026-12-28` belongs to **2026** (its Monday's year): a member with 7 paused weeks in 2026 who
pauses on Wed 23 Dec has week 12-21 paused (8 of 8), week 12-28 **not** paused (2026 used up —
counts as missed if they do not play, spending a rest week if they have one), and week 2027-01-04
paused again (1 of 8 for 2027).

**D — the cap.** Twelve straight weeks earn at weeks 4 and 8; the bank is then at the cap of 2, so
weeks 9–12 build no progress. Three missed weeks then follow: rest, rest, **broken**. (Had week 13
been played instead of missed after one rest, it would have built progress again — the bank was
below the cap.)

### 5.5 The monthly court-time ring

- The member sets `monthly_goal_minutes` (30–6000, multiples of 15; null removes it). **No goal →
  no ring**: the ring is hidden, and the card offers "Set a monthly goal" instead.
- Progress = Σ played minutes of attended bookings whose `StartsAt` falls in the current club
  month (a session crossing midnight on the last day belongs to the month it started).
- Reaching the goal is celebrated **once per club month** (`goal:{yyyy-MM}`, §7.2) — only when
  attendance crosses it. **Setting or lowering a goal the month has already reached records that
  month's celebration as already seen**, so a goal cannot be set to celebrate itself.

### 5.6 Badges — `BadgeCatalogue` (server-authoritative)

Attendance and participation only — **never money**: no badge reads a ledger row, a price, a
top-up or a share. Each badge is `{key, name, description, criteria}`; the API sends `name` and
`description` so the inbox headline, the PWA and the catalogue cannot drift.
`BadgeCatalogue.Version = 1` — bumping it re-evaluates every member (§7.3).

| Key | Name | Description (as shown) | Criteria · qualifying instant |
| --- | --- | --- | --- |
| `first_session` | First court | Played your first session at the club. | 1 attended session · its check-in |
| `sessions_10` | Ten up | Played 10 sessions. | 10th attended session · its check-in |
| `sessions_50` | Regular | Played 50 sessions. | 50th · its check-in |
| `sessions_100` | Centurion | Played 100 sessions. | 100th · its check-in |
| `first_result` | On the record | Your first match result is on the record. (R14 J14-11: earned by recording **or** confirming, so the words are true for both) | 1 confirmed result · its `ConfirmedAt` |
| `first_win` | First win | Won a match. | 1 confirmed result won · its `ConfirmedAt` |
| `partners_5` | Good company | Played with 5 different members. | 5 distinct other members across attended sessions (§5.1 `partners` rule) · the check-in of the session that made 5 |
| `early_bird` | Early bird | Played a session that started before 07:00. | a session starting before `play_early_bird_before_minute` club time · its check-in |
| `night_owl` | Night owl | Played a session that started at 21:00 or later. | a session starting at or after `play_night_owl_from_minute` · its check-in |
| `streak_4` | Four-week streak | Played every week for 4 weeks. | current streak reaches 4 at any point in history · the check-in of the first session in that week |
| `streak_12` | Twelve-week streak | Played every week for 12 weeks. | as above, 12 |
| `streak_26` | Half a year | Played every week for 26 weeks. | as above, 26 |

Ordering sessions uses `(CheckedInAt of the member's evidence, BookingId)` — the seat's own
`CheckedInAt` when set, else the booking's — so the Nth session is deterministic.

## 6. HTTP API

Conventions as P11 (`players-and-splits.md` §7): **request bodies camelCase, answers snake_case**
(every existing route; the wire's snake_case is the answer's), every refusal `{ "error": "<code>",
…figures }`, times ISO-8601 UTC, money never appears. Every write route sits in a group with
`RequireAuthorization()` and `RequireRateLimiting(RateLimitPolicies.Auth)`. Tenant is resolved
first on every route; **a booking or result of another club, or one the caller is not a player of,
is 404** — never 403, so an id reveals nothing (IDOR).

### 6.1 Member — results on a booking

`player` = `{player_key, kind: "member"|"guest", user_id, name, photo_url}` (guest: `user_id` and
`photo_url` null).

`result` = `{result_id, booking_id, status, format, games: [{a, b}], games_won: {a, b}, winner:
"a"|"b", sides: {a: [player], b: [player]}, submitted_by: {user_id, name}, submitted_at, edited_at,
version, confirm_due_at, confirmed_at, auto_confirmed, confirmed_by: {user_id, name}|null,
disputed_at, disputed_by: {user_id, name}|null, dispute_note, closed_at, closed_by_admin: bool,
viewer_side: "a"|"b"|null, viewer_outcome: "won"|"lost"|null}`

| Route | Body → answer |
| --- | --- |
| `GET /api/v1/bookings/{id}/result` | → `{booking_id, result: result\|null, permissions: {can_record, can_edit, can_confirm, can_dispute, can_withdraw}, not_recordable_reason: null\|"not_checked_in"\|"not_started"\|"window_closed"\|"not_enough_players", record_closes_at, candidates: [player], default_sides: {a: [player_key], b: [player_key]}, default_format: "best_of_5"}`. `result` is the live one, else the most recent closed one (so players see "the club removed this result"), else null. Applies a due auto-confirmation first (§3.3). 404 for a non-player |
| `POST /api/v1/bookings/{id}/result` | `{idempotencyKey, format, sideA: [playerKey], sideB: [playerKey], games: [{a, b}]}` → `201 result`; a replay of the same `idempotencyKey` by the same member → `200` with that result as it now stands. Errors: `400 idempotency_key_invalid` (1–64 chars), `400 format_invalid`, `400 lineup_invalid {reason}`, `400 score_invalid {game_index, reason}`, `400 match_incomplete {games_needed}`, `400 games_after_decided {game_index}`, `409 result_not_recordable {reason}`, `409 result_exists {result_id}` |
| `PUT /api/v1/bookings/{id}/result` | `{expectedVersion, format, sideA, sideB, games}` → `result` (still `pending`, `ConfirmDueAt` restarted). The caller must be a member of the submitting side and in the new lineup. `403 result_not_yours`, `409 result_not_pending {status}`, `409 result_changed {version, status}`, plus the create's validation errors |
| `POST /api/v1/bookings/{id}/result/confirm` | `{expectedVersion}` → `result`. `403 result_not_yours_to_confirm` (the caller is on the submitting side, or not in the lineup), `409 result_not_pending {status}`, `409 result_changed` |
| `POST /api/v1/bookings/{id}/result/dispute` | `{expectedVersion, note?}` → `result`. `400 note_too_long {max: 280}`, and as confirm |
| `POST /api/v1/bookings/{id}/result/withdraw` | `{expectedVersion}` → `result` (`withdrawn`). Submitting side only; `pending` or `disputed` only |

`result_not_yours` / `result_not_yours_to_confirm` are 403 because the caller IS a player of the
booking — they can see the result; they may not take this action on it.

### 6.2 Member — My game

| Route | Body → answer |
| --- | --- |
| `GET /api/v1/me/play` | → the whole section in one read (below) |
| `PUT /api/v1/me/play/settings` | `{monthlyGoalMinutes?: int\|null, celebrationsEnabled?: bool}` (absent = unchanged; `null` goal = remove) → `settings`. `400 goal_out_of_range {min: 30, max: 6000, step: 15}` |
| `POST /api/v1/me/play/pause` | `{}` → `pause`. `409 pause_active`, `409 pause_allowance_used {weeks_per_year}` |
| `DELETE /api/v1/me/play/pause` | → `pause`. `409 pause_not_active` |
| `GET /api/v1/me/play/results?cursor&limit` | → `{items: [result + {court_name, starts_at}], next_cursor}` — the member's confirmed, pending and disputed results, newest first; `limit` 1–50, default 20 |
| `GET /api/v1/me/play/celebrations` | → `{items: [{id, kind: "badge"\|"goal_reached", badge: {key, name, description}\|null, month: "yyyy-MM"\|null, goal_minutes\|null, created_at}]}` — unseen only, oldest first, at most 10 |
| `POST /api/v1/me/play/celebrations/seen` | `{ids: [uuid]}` (1–50) → `{seen: n}` — idempotent; ids that are not the caller's are ignored, never an error (they are not theirs to learn about) |

`GET /api/v1/me/play` →

```json
{
  "as_of": "2026-09-29T17:02:11Z",
  "timezone": "Africa/Johannesburg",
  "settings": { "monthly_goal_minutes": 600, "celebrations_enabled": true },
  "ring": { "month": "2026-09", "goal_minutes": 600, "attended_minutes": 405, "sessions": 9, "reached": false },
  "streak": {
    "current_weeks": 6, "longest_weeks": 11, "rest_weeks_banked": 1,
    "rest_every_weeks": 4, "rest_cap": 2,
    "this_week": "pending",
    "weeks": [ { "week_start": "2026-07-13", "state": "attended" } ]
  },
  "pause": { "active": false, "started_at": null, "weeks_used_this_year": 2, "weeks_per_year": 8 },
  "stats": {
    "sessions_attended": 58, "minutes_on_court": 2610, "minutes_this_year": 1980,
    "matches_played": 21, "matches_won": 12, "matches_lost": 9,
    "games_won": 47, "games_lost": 39, "win_rate_percent": 57
  },
  "partners": [ { "user_id": "…", "name": "Sam Naidoo", "photo_url": "…", "sessions": 14 } ],
  "opponents": [ { "user_id": "…", "name": "Alex Dube", "photo_url": "…", "matches": 6, "won": 4, "lost": 2 } ],
  "form": [ { "result_id": "…", "booking_id": "…", "starts_at": "…", "outcome": "won" } ],
  "badges": [
    { "key": "sessions_50", "name": "Regular", "description": "Played 50 sessions.",
      "earned": true, "awarded_at": "2026-08-14T05:31:00Z", "progress": null },
    { "key": "sessions_100", "name": "Centurion", "description": "Played 100 sessions.",
      "earned": false, "awarded_at": null, "progress": { "value": 58, "target": 100 } }
  ]
}
```

- `ring` is `null` when no goal is set. `streak.weeks` is the last 12 weeks, oldest first, each
  `attended` · `rest` · `paused` · `missed` · `pending`; `this_week` is the last entry's state.
- `badges` lists the whole catalogue in catalogue order, earned or not — progress on a locked badge
  is shown (it is the member's own data); `progress` is null for a badge with no count
  (`early_bird`, `night_owl`, `first_*`).
- A member with no attendance reads zeros and empty lists, never a 404.

### 6.3 Admin (every write in `admin_change_log`)

`admin_result` = `result` (without `viewer_*`) + `{court_name, starts_at, organiser: {user_id, name}}`.

| Route | Body → answer |
| --- | --- |
| `GET /api/v1/admin/play/results?status=&cursor&limit` | `status` = `disputed` (default) · `pending` · `confirmed` · `voided` · `withdrawn` · `all` → `{items: [admin_result], next_cursor, count}` (`count` for the status, whole club); disputed oldest first, the rest newest first; `limit` 1–100 |
| `GET /api/v1/admin/play/results/disputed/count` | → `{count}` — the nav badge's source |
| `POST /api/v1/admin/play/results/{id}/void` | `{reason}` (1–500, required) → `admin_result`. `400 reason_required`, `409 result_not_voidable {status}` (already voided or withdrawn — a second void by anyone is `200` with the row, and logs nothing) |
| `POST /api/v1/admin/play/results/{id}/uphold` | `{reason}` → `admin_result` (`confirmed`). `409 result_not_disputed {status}` |
| `GET /api/v1/admin/members/{userId}/play` | → `{sessions_attended, minutes_this_month, minutes_all_time, current_streak_weeks, matches_played, matches_won, matches_lost, open_disputes, badges_earned}` — counts only: **no partners, opponents, results list or badges list**. Not logged as a view (every figure but the record is on the member's bookings tab already; §14 Q3) |

Change-log: area `play` (new `AdminChangeAreas.Play`), subject `match_result` (new
`AdminChangeSubjects.MatchResult`), actions `play.result_voided` and `play.result_upheld`, actor
the admin, subject user **each member in the lineup** (one row per result, `subject_user_id` the
submitter, the lineup's member ids in the details), details `{result_id, booking_id, from_status,
reason, games, format}`.

### 6.4 Tenant settings

Every number is a `tenant_settings` key, clamped on read, bounded on `PUT /admin/settings`
(`<key>_out_of_range`), rendered clamped on `GET` — the P11 pattern (`PlayerSettings.cs` →
`Services/Play/PlaySettings.cs`).

| Key | Default | Bounds |
| --- | --- | --- |
| `result_autoconfirm_hours` | 48 | 12–168 |
| `result_record_days` (after the booking's end) | 7 | 1–30 |
| `streak_rest_every_weeks` | 4 | 2–12 |
| `streak_rest_cap` | 2 | 0–4 (0 = no rest weeks) |
| `streak_pause_weeks_per_year` | 8 | 0–26 (0 = no pausing) |
| `play_early_bird_before_minute` | 420 (07:00) | 0–720 |
| `play_night_owl_from_minute` | 1260 (21:00) | 720–1439 |

Changing a streak setting recomputes every member's streak on their next read (derived) — it can
raise or lower a displayed streak, never a badge already awarded. Stated rather than frozen:
the numbers are the club's, and freezing them per member would be a second streak model.

## 7. Workers, hooks and the recompute

**Derived stats need no job.** Only two things are stored and dated — badges and celebrations —
and one thing is decided by the clock — auto-confirmation. Everything below serves those three.
**No cron, no CI schedule** (standing rule): the jobs are an in-process `BackgroundService`, like
`ShareWorker`.

### 7.1 The marker, staged with the change (`MainframeDbContext.PlayStaging.cs`)

Any save that changes, for a booking with a `UserId`:
- `bookings.CheckedInAt` or `Status`;
- a `booking_participants` row's `Status` or `CheckedInAt`;
- a `match_results` row's `Status`, lineup or games;

sets that booking's `PlayRecomputeDueAt = now` (keeping an earlier value) **in the same
transaction** — setting the property on a tracked booking, else one
`UPDATE bookings SET "PlayRecomputeDueAt" = …` in the save's transaction. *Why a save-level rule
rather than call sites:* the check-in is written by the box's online scan, its uploaded event, the
walk-up, the kiosk and a no-show reversal, and P11 learned (review round 8) that a rule each call
site must remember is a rule one of them forgets. It mirrors `ShareStaging` and never touches a
ledger row.

### 7.2 The evaluator (`PlayEvaluator.EvaluateAsync(tenant, userId, now)`)

Idempotent and safe to run concurrently for one member:
1. Load the member's attended sessions, confirmed results, pauses and profile.
2. For every catalogue badge whose criteria hold, `INSERT … ON CONFLICT DO NOTHING` with its
   qualifying instant.
3. For each badge **this run inserted** whose qualifying instant is within the last 14 days
   (`PlayEvaluator.FreshWindow`, a constant — how old a moment may be and still be news, not a
   club policy): stage a celebration `badge:{key}` and a `play.badge_earned` inbox notice (§8).
   Older ones — the retro-award of a history — are inserted silently: a member opening the app
   for the first time after P12 sees their badges on the profile, not twelve overlays.
4. If a goal is set and this club month's attended minutes reach it, stage `goal:{yyyy-MM}`
   (unique — at most once a month).
5. When `CelebrationsEnabled` is false, celebrations are still written but with
   `SeenAt = CreatedAt`, so switching them back on replays nothing.
6. Stamp `EvaluatorVersion = BadgeCatalogue.Version`, `EvaluatedAt = now`; publish the unread
   frame (P11's `notification` SSE frame) after the commit when a notice was staged.

### 7.3 `PlayWorker` — once a minute, per club, each step caught and logged on its own

- **Auto-confirm**: pending results with `ConfirmDueAt ≤ now` (partial index), in batches of 200,
  each confirmed in its own save with its notices; a concurrency loss is skipped (the other writer
  decided).
- **Drain the marker**: bookings with `PlayRecomputeDueAt ≤ now`, up to 500; evaluate every member
  who is or was a player, has a seat, or is in a result's lineup on it; clear the marker only if
  it is not newer than this pass's start (the guarded clear P11 uses). A failure pushes the
  marker 5 minutes ahead and logs once — a poisoned booking costs a line every five minutes, not
  every minute.
- **Catch-up / retro-award**: members with any attendance whose profile is missing or has
  `EvaluatorVersion < BadgeCatalogue.Version`, 200 per pass, until none remain. This is the "first
  run from history" and the re-run after a catalogue change; it is silent by step 3.

### 7.4 `PlayHook` — immediacy for the member's own taps

After the commit of a result record / edit / confirm / dispute / withdraw / admin void / uphold,
and after `PUT /me/play/settings`, the endpoint evaluates the affected members at once in a fresh
scope on `CancellationToken.None`, never throwing (the marker already guarantees the worker will).
So the winner of a confirmed match has their "First win" by the time the confirmer's sheet closes.
A check-in is not hooked: the member is on court, and the minute worker is soon enough.

## 8. Notifications

Through P11's `MemberNotices.Stage` (inbox line + optional outbox row in the event's own save),
quiet hours `member_quiet_start_minute`–`member_quiet_end_minute` (21:00–07:00) for anything
mailed. Kinds are added to `MemberEventCatalogue`; only the mailed one joins `All`. A held
`play.result_to_confirm` is re-derived at release (C8, `players-and-splits.md` §6): dropped when no
result on the booking is pending for the reader to confirm, otherwise sent with the CURRENT
result's score — a withdrawn 3–0 is never asked about at 07:00.

| Kind | To | Mailed | Urgent | Dedupe key |
| --- | --- | --- | --- | --- |
| `play.result_to_confirm` | every member of the confirming side | **yes** — the first time per (booking, member) | no (waits for 07:00) | mail: `play.to_confirm:{booking}:{user}`; inbox line per version: `…:{result}:{version}` |
| `play.result_confirmed` | the submitting side's members; on auto-confirm, every member in the lineup | inbox only | — | `play.confirmed:{result}:{user}` |
| `play.result_disputed` | the submitting side's members | inbox only | — | `play.disputed:{result}:{user}` |
| `play.result_voided` | every member in the lineup | inbox only | — | `play.voided:{result}:{user}` |
| `play.badge_earned` | the member | inbox only | — | `play.badge:{user}:{key}` |

The `play.result_to_confirm` line reads from the recorder's side in first names — "Cara recorded a
2–1 win over Bongani (…). Is it right?", a doubles partner as "with Jo" — and every unread one on a
booking is marked read in the save of any act that answers or replaces it (confirm, dispute, edit,
withdraw, void, keep, auto-confirm), so the inbox never keeps an "Is it right?" that asks nothing
(review round 1, F2).

- **Why only one kind is mailed.** It is the one that asks the member to do something, with a
  deadline. The invariant "every player-affecting event sends an email" is about money, access and
  bookings; a result moves none of them, and P11 set the precedent with `players.response`
  (inbox-only: "a mail per answer is how an organiser learns to ignore the club's mail"). An
  edit or a re-record after a withdrawal writes a new inbox line but **no second mail** for the
  same booking — a submitter cannot mail-bomb an opponent by editing.
- **Admins are not mailed about disputes.** The Admin console's Results item carries a count badge
  (§9.4); a dispute is not urgent and the R23 outbox's admin kinds are about the club running.

**Copy** (headline ≤ 255; `{when}` is the club-local `Tue 30 Sep, 18:00`; names are display names):

| Kind | Inbox headline | Link |
| --- | --- | --- |
| `play.result_to_confirm` | `{Submitter} recorded {sideA} {ga}–{gb} {sideB} ({when}). Is it right?` | `/bookings/{id}?result=confirm` |
| `play.result_confirmed` | `Result confirmed: you {won\|lost} {g}–{g} ({when}).` · auto: `Result confirmed automatically: you {won\|lost} {g}–{g} ({when}).` | `/bookings/{id}` |
| `play.result_disputed` | `{Name} disputed the result of {when}. The club will look at it.` | `/bookings/{id}` |
| `play.result_voided` | `The club removed the result of {when}.` | `/bookings/{id}` |
| `play.badge_earned` | `New badge: {Badge name}.` | `/profile#my-game` |

Mail for `play.result_to_confirm` (`Email/EmailTemplatesPlay.cs`, the club's identity, both
bodies from one block list, no image — `decisions-email.md`):
- Subject: `Is this result right? {when} on {Court}`
- Body: `{Submitter} recorded your match on {Court}, {when}:` / the lineup and score, games in
  brackets — `Jo Botha 3–1 Sam Naidoo (11–7, 9–11, 11–5, 11–8)` / `If it's right, confirm it. If
  it isn't, say so and the club will look at it.` / `It will be confirmed automatically on
  {confirm_due_local} if nobody answers.`
- Button: `Check the result` → `{base}/bookings/{id}?result=confirm` (signed in; no token in the mail).

## 9. PWA surfaces

Copy lives in `lib/playCopy.ts` (the badge names and descriptions come from the API — §5.6). All
surfaces use the design system (`design-system.md`): `PageShell`/`Section`, `useAsyncAction` for
every mutation, `Skeleton` while reading, `StateBlock` for empty/error, icons only through the
barrel (adds `Trophy`, `Medal`, `Fire`, `Target`, `Pause`, `SunHorizon`, `MoonStars`), no `dark:`,
no numeric durations.

### 9.1 Profile — "My game" (`/profile`, anchor `#my-game`)

The **first** section on `/profile` (a member opens Profile to see this far more often than to
change a password). Title **My game**, description **Only you can see this.** Contents, in order:
1. **Court time ring** (`CourtTimeRing`) — SVG ring, `attended / goal`, centre `6 h 45 min`,
   caption `of 10 h this month`; `aria-label` states both; a `Target` button opens `GoalSheet`
   (a number input in hours with quarter-hour steps, 0.5–100 h, and `Remove goal`). No goal → a quiet row `Set a monthly goal`.
2. **Streak** (`StreakCard`) — `Fire` + `6-week streak`, `Longest 11`, a 12-cell week strip
   (attended filled · rest outlined with a small moon · paused striped · missed empty · this week
   dashed), `1 rest week banked` and the rule in one line (`Play once a week to keep it going.
   Every 4 weeks earns a rest week, up to 2.`). **The injury-pause switch** (`PauseSwitch`) sits
   here: `Injury pause` — `Pauses your streak without breaking it. 6 of 8 weeks left for 2026.`
3. **Stats** (`StatsGrid`) — sessions, time on court, matches W–L, games W–L, win rate; figures
   in tabular numerals.
4. **Form and people** — last-5 form chips (`W` success / `L` neutral — colour never alone: the
   letter is the signal), "Played most with" (3 avatars + session counts), "Toughest opponents"
   (head-to-head); link `All results` → `/profile/results`.
5. **Badges** (`BadgeGrid`) — earned in colour with date; locked muted with progress
   (`58 / 100`). Tapping opens its description.

Switch **Celebrations** (on by default) sits at the foot of the section with `Show a moment when
you earn a badge or reach your goal.`

### 9.2 Results on a booking (`/bookings/:id`)

- **`ResultCard`** in `BookingDetail` below attendance: nothing recorded + `can_record` → `Record
  the result` button; pending → the score, `Waiting for {names} to confirm · confirms itself
  {Thu 18:05}`, and to the confirming side `Confirm` / `Something's wrong`; disputed → `Disputed —
  the club will look at it` + the note; confirmed → the score with `Confirmed` (or `Confirmed
  automatically`); voided → `The club removed this result` (+ `Record the result` if the window is
  open). `?result=record|confirm` opens the matching sheet on load (the mail's link).
- **`ResultSheet`** (Sheet on phones, Dialog above 640 px): `Best of 5 | Best of 3` toggle-group;
  the two sides as avatar pickers pre-filled from `default_sides` with a `Swap sides` button;
  game rows of two numeric steppers (inputmode numeric, 44 px targets), a game row added as the
  previous one completes and removed once the match is decided; **live validation from
  `lib/playScore.ts`** — the same corpus as the server — the error under the row as typed
  (`A game is won at 11, or by two clear after 10–all.` · `Past 11 a game ends the moment someone
  leads by two.` · `A game can't end level.`), the running match score in the header
  (`2–1 · one more game`), and the submit disabled with the reason stated until the match is
  complete. Submit: `Record result`; dismiss `Cancel`. Server refusals map to the same messages.
- **Confirm sheet**: the score read-only; `Confirm result` (primary) and `Something's wrong`, which
  opens a note field (`What's wrong? Optional — the club sees this.`, 280) and `Send to the club`.

### 9.3 Celebration overlay (`CelebrationOverlay`, mounted in `AppShell`)

- Fetches `GET /me/play/celebrations` on sign-in, on returning to the foreground
  (`visibilitychange`) and on every `notification` SSE frame. Shows **one at a time**, oldest
  first; more than three waiting collapse into one (`3 new badges`) linking to `/profile#my-game`.
- **Never over `/my-code`, `/j/*`, `/invites/*` or any auth page, and never while a sheet or dialog
  is open** — the pass card at the court must never be covered. It waits for the next route.
- A Dialog (focus trapped and restored, close ×): the badge's icon in a medallion, `New badge` /
  `Monthly goal reached`, the name and description; primary `Keep playing`, secondary `See my game`.
  Acknowledged (`POST …/seen`) on either button or close — never on display alone, so a member who
  never saw it (tab in the background) still gets it.
- **Motion — CSS only, existing tokens**: the medallion uses `animate-pop-in` over `duration-settle`,
  the ring fill a `stroke-dashoffset` transition over `duration-count`, the scrim `overlay-in`; a
  single `breathe` glow on the medallion. No new keyframes, no numeric durations, no JS animation
  library. **`prefers-reduced-motion`**: every one carries `motion-reduce:animate-none` /
  `motion-reduce:transition-none` — the overlay appears at rest with its content intact. The
  dialog's title is its accessible name, so the moment is announced either way.

### 9.4 Admin

- **Nav**: a new item in the **People** group, after Groups — `id: "results"`, label `Match
  results`, path `/admin/results`, icon `Trophy`, badge key `"disputes"` (new `AdminBadgeKey`,
  source `GET /admin/play/results/disputed/count` in `lib/adminAttention.ts`), description
  `Disputed match results, and removing a result that is wrong.`
- **`/admin/results`** (`pages/admin/AdminResults.tsx`): tabs `Disputed` (default) · `Waiting` ·
  `Confirmed` · `Removed`; each row: when, court, lineup, score, who recorded, who disputed and the
  note; actions `Remove result` (danger, reason required, confirm dialog — dismiss `Keep it`) and,
  on a disputed row, `Keep result` (uphold, reason required). The change record names both.
- **Member detail**: a **Play card on the Overview tab** (`MemberPlayCard`), not a new tab — the
  tab row is already six long and a summary is five numbers: sessions, this month's court time,
  current streak, match record, open disputes (linking to `/admin/results`). No partners, no
  opponents, no badge list.

### 9.5 Routes

| Route | Page | Title |
| --- | --- | --- |
| `/profile` (+ `#my-game`) | `Profile` with `MyGameSection` first | Profile |
| `/profile/results` | `ProfileResults` — paged match history | My results |
| `/bookings/:bookingId?result=record\|confirm` | `BookingDetail` + `ResultCard`/`ResultSheet` | (unchanged) |
| `/admin/results` | `AdminResults` | Match results |

## 10. Security and privacy — the rules tests pin

- All stats, the streak, the ring, badges and celebrations are **the member's own**: every
  `/me/play*` route reads the caller only; there is no route that takes another member's id
  except the admin summary.
- A result is visible to the players of its booking and to admins; opponents see the match
  result on the shared booking and nothing of each other's stats.
- Nothing is public, nothing enters the directory, no webhook carries a play event (a webhook
  would hand private records to a third party), and `show_in_leaderboards` / `share_results` stay
  reserved.
- Cross-tenant: a result, badge, celebration, pause or profile of another club is invisible and
  unactionable (404) on every route, and the worker never evaluates across clubs.

## 11. Test plan

**Unit (no database):**
- `SquashScoreTests` — every vector in `squash-scores.json`; plus a generated sweep of all
  `0 ≤ a, b ≤ 30` against an independent oracle.
- `ClubWeekTests` — Monday keys for London spring/autumn (examples A/B), `America/New_York`,
  `Australia/Lord_Howe` (30-minute DST), `Antarctica/Troll` (2-hour shift), Johannesburg, UTC; the
  2026-W53 year boundary and 2025-12-29 (example C); every key is a Monday and `date − key ∈ 0..6`.
- `StreakMathTests` — examples A–D as tables; rest off (`K = 0`), pause off (`Y = 0`), attendance
  inside a paused week, the current week never breaking.
- `StreakPropertyTests` — seeded random histories (1,000 seeds in CI, `PLAY_PROPERTY_SEEDS` for
  more), checked against a separately written model: monotone in attendance and in pause weeks;
  `current ≤ longest ≤ |A|`; banked ≤ K; resumable from any intermediate state; paused
  not-attended weeks per year ≤ Y; invariant under shuffling input order; the club zone changes
  only the week assignment, never the walk.
- `BadgeRulesTests` — each badge's criteria and qualifying instant; none reads money (a test that
  `BadgeRules` has no reference to `LedgerEntry`); ordering ties.
- `PlaySettingsTests` — defaults, clamping, bounds messages.

**Postgres HTTP** (the parallel-class pattern, `decisions-test-running.md`:
`public sealed class XTests(PostgresFixture pg) : IClassFixture<PostgresFixture>`, never a
`[Collection]`, hosts configured with `UseSetting`, no process-global state, scope by tenant slug):
- `PlayResultsHttpTests` — record on a checked-in booking; `not_checked_in` (door scan only),
  `window_closed`, `not_enough_players`; lineup rules incl. singles on a 4-seat booking and a guest
  side; idempotent create replay; `result_exists`; edit restarts `ConfirmDueAt`; confirm, dispute,
  withdraw and their 403s; double-tap confirm → one confirmation; confirm vs sweep race; dispute
  after the deadline → `result_not_pending`; lazy auto-confirm on read; a removed seat can no
  longer confirm; S4 and reversed-no-show bookings are recordable, a no-show is not.
- `PlayStatsHttpTests` — attendance by own scan vs by the booking's check-in; played minutes after
  a release and after an S4 cancel; stats move on void; partners/opponents/form; `GET /me/play`
  for a member with nothing.
- `PlayStreakHttpTests` — a `Europe/London` club (`UseSetting` on the tenant's timezone) walking
  examples A and C through real bookings and check-ins; pause on/off/allowance errors.
- `PlayBadgesHttpTests` — the retro-award is silent (no celebration, no inbox line) for old
  history and loud for fresh; idempotent under two concurrent evaluations; catalogue version bump
  re-evaluates; goal set below progress celebrates nothing; celebrations disabled writes them seen.
- `PlayWorkerHttpTests` — `TickAsync` at stated instants: auto-confirm batch, the marker staged in
  the check-in's own transaction (a check-in whose hook never ran is still evaluated), guarded
  clear, the 5-minute push-back on failure.
- `PlayNotificationsHttpTests` — kinds, recipients, quiet hours on the one mailed kind, one mail
  per (booking, member) across edits and re-records, unread frame published.
- `PlayAdminHttpTests` — list/count by status; void and uphold with reason; change-log rows;
  non-admin 403; a void frees the booking for a new record.
- `PlayTenancyHttpTests` (cross-tenant, non-negotiable) and `PlayIdorHttpTests` — every route with
  another club's ids and with this club's ids for a booking the caller is not on: 404, and no row
  changed; `celebrations/seen` with another member's ids changes nothing.

**Frontend (vitest)**: `playScore.test.ts` (the shared corpus), `ResultSheet` live validation and
submit gating, `ResultCard` in every status and permission, `MyGameSection` (ring hidden without a
goal, streak strip states, badges earned/locked), `CelebrationOverlay` (queueing, collapse > 3,
never on `/my-code`, acknowledge on close only, reduced motion renders no animation class that
moves), `AdminResults` actions, `adminNav`/attention badge, route titles, axe in both themes.

**e2e-real** (`e2e-real/play.spec.ts`, after integration, headed walk): organiser and partner
book, check in through the device API, organiser records 3–1, the partner opens the MailHog link
and confirms, both see "First win"/"On the record" on Profile; a dispute appears on
`/admin/results` and is removed.

## 12. Lane partition — two agents, disjoint files

The contract is this document. Neither lane edits a file in the other's list; a change the other
side needs goes back through the orchestrator. Integration: backend lane merges first (the
migration), then frontend; then the headed walk.

**Backend lane** (`src/backend/**`, `src/contracts/play/**`):
- `Domain/Play.cs` (new: `MatchResult`, `MatchResultPlayer`, `MemberBadge`, `PlayCelebration`,
  `MemberPlayProfile`, `MemberStreakPause`, enums); `Domain/Booking.cs` (+`PlayRecomputeDueAt`)
- `Persistence/MainframeDbContext.Play.cs` (new: sets + model), `Persistence/MainframeDbContext.PlayStaging.cs` (new), `Persistence/MainframeDbContext.cs` (call the staging)
- `Migrations/*_AddPlay.cs` + Designer + `MainframeDbContextModelSnapshot.cs`
- `Services/Play/` (new): `SquashScore.cs`, `Lineup.cs`, `ClubWeek.cs`, `StreakMath.cs`,
  `PlayStats.cs`, `BadgeCatalogue.cs`, `BadgeRules.cs`, `AttendanceQuery.cs`, `ResultService.cs`,
  `PlayQuery.cs`, `PlayEvaluator.cs`, `PlayHook.cs`, `PlaySweep.cs`, `PlayNotices.cs`, `PlaySettings.cs`
- `Services/Players/MemberEventCatalogue.cs` (kinds, compose), `Email/EmailTemplatesPlay.cs` (new)
- `Services/AdminChangeActions.cs`, `Services/AdminChangeAreas.cs`
- `Endpoints/PlayEndpoints.cs`, `Endpoints/AdminPlayEndpoints.cs` (new), `Endpoints/AdminConfigEndpoints.cs` (the seven keys)
- `Workers/PlayWorker.cs` (new), `Workers/RetentionWorker.cs` (seen celebrations), `Program.cs`
- `src/contracts/play/squash-scores.json` (new, §4.3 verbatim)
- Tests: `src/backend/Crusaders.Mainframe.Tests/Play/*` (new)

**Frontend lane** (`src/frontend/**`, except reading the contract JSON):
- `lib/playApi.ts`, `lib/playCopy.ts`, `lib/playScore.ts` (+ tests)
- `components/play/` (new): `MyGameSection.tsx`, `CourtTimeRing.tsx`, `GoalSheet.tsx`,
  `StreakCard.tsx`, `StreakWeeks.tsx`, `PauseSwitch.tsx`, `StatsGrid.tsx`, `FormAndPeople.tsx`,
  `BadgeGrid.tsx`, `ResultCard.tsx`, `ResultSheet.tsx`, `ConfirmResultSheet.tsx`, `resultDraft.ts`,
  `useResult.ts`, `useMyGame.ts`, `CelebrationOverlay.tsx`, `useCelebrations.ts`,
  `admin/MemberPlayCard.tsx`, `admin/ResultRow.tsx`, `__tests__/*`
- `pages/Profile.tsx` (insert the section), `pages/ProfileResults.tsx` (new),
  `pages/BookingDetail.tsx` (insert `ResultCard`), `pages/admin/AdminResults.tsx` (new),
  `pages/admin/member/MemberOverview.tsx` (the card)
- `App.tsx` (routes), `components/shell/AppShell.tsx` (overlay), `components/admin/adminNav.ts`,
  `lib/adminAttention.ts`, `components/inbox/notificationKinds.ts` (+ kind words in `playCopy.ts`),
  `components/ui/icons.ts` (the new icons), `lib/routeAnnouncer.ts` (titles),
  `lib/settingsSchema.ts` (a "Play" settings section for §6.4), the change-record area label
- `e2e-real/play.spec.ts` (runs after integration)

**Neither lane** edits `docs/`, `memory/`, `CLAUDE.md` or `MEMORY.md` — the orchestrator closes out.

## 13. Where this will be enforced

| Rule | Code |
| --- | --- |
| Squash scoring | `Services/Play/SquashScore.cs` · `lib/playScore.ts` · corpus `src/contracts/play/squash-scores.json` |
| Lineup, recordability, state machine | `Services/Play/Lineup.cs`, `ResultService.cs` |
| Attendance for play | `Services/Play/AttendanceQuery.cs` (through `BookingPlayerQueries`) |
| Weeks, streak, pause | `Services/Play/ClubWeek.cs`, `StreakMath.cs` |
| Stats, ring | `Services/Play/PlayStats.cs`, `PlayQuery.cs` |
| Badges, celebrations | `Services/Play/BadgeCatalogue.cs`, `BadgeRules.cs`, `PlayEvaluator.cs` |
| Marker, worker, hook | `Persistence/MainframeDbContext.PlayStaging.cs`, `Workers/PlayWorker.cs`, `Services/Play/PlaySweep.cs`, `PlayHook.cs` |
| Notices | `Services/Play/PlayNotices.cs`, `MemberEventCatalogue.cs`, `Email/EmailTemplatesPlay.cs` |
| Routes | `Endpoints/PlayEndpoints.cs`, `Endpoints/AdminPlayEndpoints.cs` |

## 14. Founder questions (each with the default the build uses)

1. **Is "My game" on for every member, or opt-in like D13's social surfaces?** *Default: on.* It is
   private — nothing leaves the member — so D13's opt-in list (directory, leaderboards, rating,
   recap email) does not cover it; celebrations have their own switch, on by default, and nothing
   ever nags.
2. **May an unfinished match be recorded** (time ran out at 2–1 in a best of 5)? *Default: no —
   only complete best-of-3/5 matches.* An unfinished score has no winner, and "retired" is a
   second result type with its own stats rules; revisit if members ask.
3. **Should an admin see a member's match record (W–L) on the member's page?** *Default: yes —
   counts only, on the Overview card, not logged as a view.* Useful when a dispute lands; partners,
   opponents and badges stay the member's alone. The alternative is to show attendance figures only.
