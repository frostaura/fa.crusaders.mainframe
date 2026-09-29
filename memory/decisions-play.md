---
name: crusaders-mainframe-decisions-play
description: "D14 play MVP: results only on box-checked-in bookings with their own lineup, PAR-11 best of 3/5, confirm or 48 h silence; stats derived on read; weekly streak keyed by Monday date; badges never revoked; one mailed kind."
type: decision
last_verified: 2026-09-29
---

# Live decisions — play (D14 MVP)

Spec: `docs/specs/play.md` (P12, written 2026-09-29, not yet built). This is the why.

- **Attendance is `CheckedInAt`, never a door scan**: a member attended when their own seat was
  scanned, or the booking was checked in and they are a player of it. *Why:* one scan lights the
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
  the open week never breaks it.** Proved monotone in attendance by a seeded property test.
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
- **Open for Dean** (spec §14, defaults in use): My game on by default; unfinished matches not
  recordable; admin card shows the W–L record.
