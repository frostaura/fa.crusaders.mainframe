---
name: crusaders-mainframe-decisions-mail-release
description: "Held member mail is re-derived from current state when it leaves (C8): dropped if obsolete, re-rendered otherwise, coalesced per member/booking/kind; released in the order it happened."
type: decision
last_verified: 2026-09-30
---

# Live decisions — what a held member mail says when it finally leaves (review round 2, C8)

Code: `Services/Players/MemberMailRelease.cs`, called from `AdminNotificationDispatcher`'s member
path. Tests: `R2MailReleaseHttpTests`. Spec: `players-and-splits.md` §6, `play.md` §8.

- **Judged at the SEND, not the staging, for every non-urgent member mail** — whatever held it
  (quiet hours or a backoff). *Why:* quiet hours froze 23:00's payload until 07:00, and the
  reviewer got a confirm link for a withdrawn 3–0, an invite to a game cancelled overnight and
  "share now 16.00" beside the 0.00 that replaced it.
- **Dropped when obsolete** — invite not open, game off, seat gone, result not pending or not
  the reader's to confirm, reminder's share paid, waiting return posted, removal undone by a
  re-add. The row finishes `Suppressed`, `LastError = "dropped: <reason>"`.
- **A dropped row frees its dedupe key** (`x:{id}:` prefix). *Why:* `play.result_to_confirm`
  mails once per (booking, member) by key; a withdrawn ask that never left would otherwise
  "use up" the booking and a fresh result would never be asked about.
- **Re-rendered otherwise** from today's booking, seat and result (court, start, share, score,
  deadline). Payloads carry `seat_id` since C8; older rows fall back to the path or the reader's
  latest seat on the booking.
- **Coalesced per (member, booking, kind)** for invite, club seat, reminder, share changed and
  result to confirm: a later pending OR sent row of the same key supersedes (`superseded`).
  **Deviation from the contract's letter, on purpose:** lapse and return-waiting are never
  coalesced — each names one partner, and an organiser with two partners' returns waiting must
  hear both. Receipts (urgent kinds: share moved, game cancelled) are never re-derived.
- **Released in the order it happened.** Claims order `DueAt, CreatedAt, Id`, and the order is
  re-imposed in C# after `RETURNING` (which promises none). *Why:* everything quiet hours hold
  falls due at one instant, and id order released a night's mail at random — a mutant ordering by
  id alone fails the five-invite test.
- **A cancellation never follows the invite it supersedes**: the cancellation is urgent (sent at
  once) and the held invite is dropped at release (`game_off`).
