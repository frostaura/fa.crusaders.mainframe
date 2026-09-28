---
name: crusaders-mainframe-decisions-players-access
description: "Players access and consent: only a live seat shows a booking, link seats are claimed by link only, accept names the share seen, the invite loop is closed, tokens hashed, member mail rides R23."
type: decision
last_verified: 2026-09-28
---

# Live decisions — players: access, consent, invites and mail (D11–D13)

The spec is `docs/specs/players-and-splits.md` §4–§6; the money rules are in
`decisions-players.md`. Items dated 2026-09-28 came from the adversarial review, each pinned by a
test in `PlayersReviewHttpTests`.

- **Only a LIVE seat makes a member a player** (2026-09-28). A declined, withdrawn, removed or
  lapsed member reads the detail as a stranger (404). *Why:* a dead seat kept showing the game and
  its money to someone who is no longer in it.
- **A removed member cannot claim any seat of that booking again**, by open link or addressed one
  (`409 player_previously_removed`); only an admin's add puts them back. *Why:* removal is the
  organiser's word; a forwarded open link must not undo it.
- **An open link seat is claimed only through its link** (2026-09-28). The seat route answers an
  unclaimed seat 404. *Why:* participant ids are in every detail view; rotating a link revoked
  nothing while the id route accepted without it.
- **Accept names the share the partner was shown** — `expectedShareCredits`, required, asked only
  once the seat is theirs (strangers still get the 404); a risen share is `409 share_changed`, and
  a lost accept race is 200 only if the winner's consent still covers the share (2026-09-28).
  *Why:* consent is to the figure read, not to whatever the organiser typed between sheet and tap.
- **The invite loop is closed three ways** (2026-09-28): the organiser cannot re-invite a member
  who declined or was removed (admin can); `player_invites_per_booking` (8, 4–20) caps member
  invites + link seats per booking ever, admin exempt; an invite or removal repeated for one
  (booking, member) inside `share_reminder_hours` is inbox-only. *Why the reminder cadence as the
  window:* it is already the club's "how often may we mail a partner about a share", and the
  reminder mails a collapsed invite when the window ends — no new number.
- **Lapse notices only for a game that was on** (booked, completed, no-show); a cancelled or
  displaced game's invites lapse silently — its players were already told it was off.
- **Admin settle-outside needs an accepted seat** (`409 player_not_accepted`). *Why:* settling an
  unanswered invite placed the member on the game without a yes; accept-on-behalf is that, on its
  own record.
- **Invite tokens are shown once, hashed at rest; member invite mails link `/invites/{pid}`, never
  a token** — a token in an outbox payload would be a clear-text credential.
- **Member mail rides the R23 outbox with `Audience`/`RecipientUserId`** rather than a second
  outbox; quiet hours re-checked at delivery (a deferral hands back the attempt). Admin feed filters Audience = Admins.
- **Preferences: `findable` / `show_in_leaderboards` (P2 names) stay canonical**; D13's
  `findable_in_directory` / `show_on_leaderboards` are accepted aliases; `share_results` stored only.
