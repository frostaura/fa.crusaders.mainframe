---
name: crusaders-mainframe-decisions-play
description: "D14 play MVP: results only on box-checked-in bookings with their own lineup, PAR-11 best of 3/5, confirm or 48 h silence; stats derived on read; weekly streak keyed by Monday date; badges never revoked; one mailed kind."
type: decision
last_verified: 2026-09-30
---

# Live decisions — play (D14 MVP)

Spec: `docs/specs/play.md` (P12). Built by two lanes and merged on `main-work` 2026-09-29.
This is the why.

- **Attendance is `CheckedInAt`, never a door scan**: a member attended when their own seat was
  scanned, or the booking was checked in BY A PLAYER and they are a player of it (R19 E19-3: a
  pay-for payer's scan is nobody's attendance; R17 J17-5: a cancelled booking is never attended —
  [`decisions-attendance-r19.md`](decisions-attendance-r19.md)). *Why:* one scan lights the
  court for everybody; requiring each partner to scan would punish the ones who walked in behind.
- **A result carries its own lineup (1v1 or 2v2), frozen per result.** *Why:* P11 seats a singles
  partner on seat 2 — team A — so seat teams would record team-mates playing each other.
- **PAR-11, win by two after 10–all; best of 3 or 5, default 5; complete matches only.** One
  corpus (`src/contracts/play/squash-scores.json`) read by C# and vitest so the sheet's live
  validation agrees with the server to the reason.
- **Confirm by the other side, or by 48 h of silence; the deadline is the instant.** Any read or
  act past `ConfirmDueAt` confirms first, so a dispute a second late is refused however recently
  the sweep ran. An edit restarts the clock — silence consents to the score shown.
- **Only confirmed results count; badges are never revoked.** *Why:* stats are derived, so a void
  drops at once; revoking a private, already-celebrated badge is a new path for a harmless case.
- **Stats, streak and ring are derived on read; only badges and celebrations are stored.** *Why:*
  a reversal, void or seat change shows up with no sweep to forget (the `ShareHolds` lesson).
- **Week key = the Monday's club-local date**, via `ClubClock.DateOf` then `DateOnly` arithmetic.
  *Why:* never instant + 168 h (DST weeks are 167/169 h) and never (year, ISO week) — 2026 has
  a W53 running into 2027.
- **Streak counts attended weeks; rest weeks are earned (1 per 4, cap 2) and spent silently;
  the open week never breaks it.** Progress towards a rest week accrues **only below the cap**
  (2026-09-29, the coordinator's ruling after P12 found the defect). *Why:* a member who plays
  more must never see a shorter streak. The first rule earned at `streak % 4 == 0` and lost an
  earn to the cap depending on where the run began, so one extra early week could end a streak
  the same history without it kept. As credit `c = bank·E + progress` the rule is attend →
  `min(c+1, K·E)`, miss → `c−E` or broken — monotone by construction; a 2,000-seed property
  test (rest weeks on) and the X/Y regression test hold it.
- **Injury pause is a yearly allowance (8 weeks), not a per-pause maximum**, and never backdated.
  *Why:* a maximum is defeated by toggling off and on; nothing is public, so no anti-cheat.
- **Recompute is staged with the change** (`bookings.PlayRecomputeDueAt` set in the save that
  moves a check-in, a seat or a result) and drained by `PlayWorker`. *Why:* P11 round 8 — a rule
  each call site must remember is one a call site forgets. No cron: an in-process worker.
- **Retro-award is silent**: badges whose qualifying instant is older than 14 days are inserted
  with no celebration and no inbox line. *Why:* first launch must not open twelve overlays.
- **Only `play.result_to_confirm` is mailed**, once per (booking, member). *Why:* the one kind
  asking for action by a deadline; results move no money or access (`players.response` precedent).
- **Everything is private**: no public profile, no webhook for play events, admin sees counts
  only. `show_in_leaderboards` / `share_results` stay reserved for the future programme.
- **Celebrations never cover `/my-code`** or an open sheet; acknowledged on dismissal, not display.
- **The result card tells two 404s apart.** `booking_not_found` (a non-player, e.g. an admin
  looking in) hides the card; `result_not_found` reads as "no result yet". *Why:* the backend
  lane added the second code, and one 404 rule would hide a member's own card.
- **A result is recordable, and a session attended, from the court time's start or the check-in,
  whichever is later** (B15; attendance: review round 2 B-11). A booking not yet started is not
  attended; the check-in's recompute marker is staged for `max(now, StartsAt)`, so badges come —
  and are dated — at the start. *Why:* "First court" at 06:24 for a 06:30 court. The own-seat-scan
  rule B15 also asked for is still **not done** (it reverses the partner rule; escalated to Dean).
- **Open for Dean** (spec §14, defaults in use): My game on by default; unfinished matches not
  recordable; admin card shows the W–L record; B15's own-scan badge rule (above).
