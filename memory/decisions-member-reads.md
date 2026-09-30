---
name: crusaders-mainframe-decisions-member-reads
description: "Member and desk reads from review rounds 1-3: anonymous invite preview, own seat in any state, one club date, recent games, held parts, what a game cost you, inbox read state for answered asks and own receipts."
type: decision
last_verified: 2026-09-30
---

# Live decisions — what a member (or a stranger with a link) may read (review round 1)

Asked by the frontend lanes; built in lane B. Tests: `R1PlayersHttpTests`, `R1MailHttpTests`,
`PlayNotificationsHttpTests`. Spec: `players-and-splits.md` endpoint table, `play.md` §8.

- **`GET /api/v1/invites/{token}/preview` is anonymous and shows six facts** — organiser's first
  name, court, start, end, share, club zone. *Why anonymous is safe:* the token is 256 random
  bits, stored hashed and handed only to the people the organiser sent it to — holding it proves
  you were sent it, and it shows no more than the invite mail. One `404 invite_not_found` for
  unknown, other club's, answered, off or closed — the route says nothing about which.
  `/api/v1/invites/` joined the anonymous tenant-scoped prefixes; a signed-in JWT still wins.
- **`GET /api/v1/me/invites/{participantId}` returns the caller's own seat in ANY state** with the
  booking's status, so a mail deep link can say "you're in / it was cancelled / you're off it".
  Anybody else's seat — the organiser included — is 404: a participant id proves nothing.
- **The PWA asks both instead of inferring (R1 integration):** `/j/:token` signed out shows the
  preview's facts (404 → "no longer open", no Join); `/invites/:id` reads its fate from the seat
  (cancelled / accepted → in / anything else → off). *Why:* the inbox search missed old notices.
- **An "Is it right?" line is retired by whatever answers or replaces it** (confirm, dispute,
  edit, withdraw, void, keep, auto-confirm): marked read in that act's save. *Why:* the inbox kept
  actionable asks about results that no longer existed. Round 3 (M-5): the retired line's headline
  says what happened — "Olive said they won 3–0 — withdrawn" (confirmed, disputed, removed by the
  club, since changed) — never the instruction it can no longer take.
- **`GET /bookings/{id}/result` already answers 200 `{result: null}` to a player** — the 404s the
  console saw are non-players (`booking_not_found`); unchanged.
- **One club date format** (`Services/ClubDate`): `Thu 1 Oct, 10:00` in the club zone for every
  mail date and new ledger comment (`Booking Court 1 · Thu 1 Oct, 10:00`); the receipt adds the
  year. *Why:* one booking read three ways (`Thu 01 Oct`, ISO, the screens'). Historical ledger
  rows keep the ISO text they were written with — a comment is part of the record.
- **Review round 2 (lane B), pinned in `R2*HttpTests`:** `GET /me/bookings/recent` (C3) lists
  games that ENDED within `result_record_days` (organiser or accepted partner, newest first, cap
  50) with `result_status` and `can_record` — the upcoming list omits both; `held_parts
  [{credits, until}]` (C4) splits held credit per share deadline, soonest first, `held_until` kept;
  a `ShareTransfer` ledger row carries `counterparty_name`/`_user_id` (C5, the twin row's owner;
  membership name only, never an address) and reads member to member; the admin member record
  includes accepted partner games with `role` and `organiser {user_id, name, is_self}` (C6).
  *Why:* each screen had no honest way to show it. Schedule response shapes are pinned server-side
  too (`R2ScheduleResponseShapeHttpTests`, C7) — change it with `serverContract.ts`.
- **A cancellation mail names court AND time** (`CancelledSlot`, B-7); a club collect or removal
  is told as the club's, with the admin's reason (B-8).
- **Asked by F2 after round 2:** `/me/notifications` items carry `resolved_at`, stamped when a
  result ask is retired (confirm, dispute, edit, withdraw, void, keep) even if already read —
  migration `AddMemberNotificationResolvedAt`; the ask speaks TO the reader ("Sam says they won
  3–0 — confirm or dispute", "… say you and Jo won …"), never naming them; streak weeks before
  the join week (earliest `member.approved` audit row, else membership creation) are
  `before_joining`; each detail seat carries `returned_credits` (a cancelled game read "paid 0").
- **Round 3 (lane B):** upcoming/recent items carry `my_paid_credits` (the caller's own wallet on
  the game, net; settled-outside counts as paid) and `my_owing_credits` (a partner's unpaid open
  share); the organiser's `my_share_credits` counts ACCEPTED partners only (M-3 — an unanswered
  invite had it say "your share 25" of a court they had paid 50 for). Answering an invite marks its
  invite/reminder lines read+resolved; a receipt of your own move is born read (I-9).
- **Round 4 (lane B1):** "own move" now covers the organiser's remove, split change and CANCEL
  (`ReconcileOptions.OwnActionBy`, the request's user via `ShareHookHttp`; ledger actor unchanged),
  and a cancelled game's `returned_credits` counts only returns from `CancelledAt` on (M4-4).
