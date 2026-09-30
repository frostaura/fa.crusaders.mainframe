---
name: crusaders-mainframe-decisions-member-reads
description: "Review round 1 member-facing reads: an anonymous invite preview keyed on the link token alone, a member's own seat in any state, obsolete result asks retired, and one club date format for mail and ledger comments."
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
  actionable asks about results that no longer existed. The headline is the recorder's side in
  first names ("Cara recorded a 2–1 win over Bongani").
- **`GET /bookings/{id}/result` already answers 200 `{result: null}` to a player** — the 404s the
  console saw are non-players (`booking_not_found`); unchanged.
- **One club date format** (`Services/ClubDate`): `Thu 1 Oct, 10:00` in the club zone for every
  mail date and new ledger comment (`Booking Court 1 · Thu 1 Oct, 10:00`); the receipt adds the
  year. *Why:* one booking read three ways (`Thu 01 Oct`, ISO, the screens'). Historical ledger
  rows keep the ISO text they were written with — a comment is part of the record.
