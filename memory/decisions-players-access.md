---
name: crusaders-mainframe-decisions-players-access
description: "Players access and consent: findable on by default; only a live seat shows a booking, link claims by link only, accept names the share seen, the invite loop is closed, balance_credits always raw, member mail rides R23."
type: decision
last_verified: 2026-10-06
---

# Live decisions — players: access, consent, invites and mail (D11–D13)

Spec: `docs/specs/players-and-splits.md` §4–§6; money rules: `decisions-players.md`. Items dated
2026-09-28 came from the adversarial review, each pinned by a test in `PlayersReviewHttpTests`.

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
  reminder mails a collapsed invite when the window ends — no new number. So an invite is collapsed
  ONLY when that reminder will come (reminders on, first one before the deadline); else mailed.
  The cap is counted under the booking's advisory lock — two adds could both count under it.
- **A payer override at the box is ignored on any split booking** — `IsSplitAsync`: a live seat
  with a share OR any share row. *Why:* a partner who came off with a return pending left no live
  seat, and the override moved the court and that return onto the volunteer.
- **`balance_credits` is always the RAW balance**; `spendable_credits` and `held_credits` sit
  beside it wherever a spend is quoted; a refusal's `current_credits` is spendable. *Why:* one
  word meaning two figures on two screens is a support call.
- **Lapse notices only for a game that was on** (booked, completed, no-show); a cancelled or
  displaced game's invites lapse silently — its players were already told it was off.
- **Admin settle-outside needs an accepted seat** (`409 player_not_accepted`). *Why:* settling an
  unanswered invite placed the member on the game without a yes; accept-on-behalf is that, on its
  own record.
- **Invite tokens are shown once, hashed at rest; member invite mails link `/invites/{pid}`, never
  a token** — a token in an outbox payload would be a clear-text credential.
- **Member mail rides the R23 outbox with `Audience`/`RecipientUserId`** rather than a second
  outbox; quiet hours re-checked at delivery (a deferral hands back the attempt). Admin feed filters Audience = Admins.
- **Findable is ON by default, opt-out (Dean, 2026-10-06; supersedes D13's opt-in for this one flag).**
  The directory hides only an explicit `findable = false`; no preferences row reads as on; the column
  default is true and migration `FindableByDefault` set every stored false to true (the column never
  recorded whether a member chose, so choices could not be told from the old default). Admins are members
  and appear like anyone, with the same Profile switch; the onboarding step says "on, switch off here".
  Leaderboards, rating, recap, share_results stay opt-in. *Why:* partner search is useless when nobody is in it.
- **Preferences: `findable` / `show_in_leaderboards` (P2 names) stay canonical**; D13's
  `findable_in_directory` / `show_on_leaderboards` are accepted aliases; `share_results` stored only.
- **Review round 1 (2026-09-30), pinned in `R1PlayersHttpTests` / `R1MailHttpTests`:** an ACCEPTED
  partner's game is theirs — `GET /me/bookings/upcoming` lists it and the grid marks it `isMine`
  with `role: partner` (B2); every cancel answer (member, desk, bulk) names each partner's refund and the organiser's
  `net_credits`, from the share rule itself (B3); `unpaid_credits` counts an unclaimed link seat
  at its full share (B4); recent partners count only started, checked-in games (B11); a received
  share's mail says it is held and until when (B12); a club collect, a club add and an
  accept-on-behalf are told as the CLUB's doing (`players.club_seat`, B8). *Why:* each screen or
  mail said something the money did not.
- **A lost reply is read back, never called a refusal (R2 F2-1/F2-2, 2026-09-30):** an unanswered accept reads `GET /me/invites/{pid}`, an unanswered cancel on the booking page re-reads the booking. The UI also reads optional `resolved_at` (inbox) and `before_joining` (streak week) — owed by the backend. *Why:* "Couldn't accept" after the share was taken.
