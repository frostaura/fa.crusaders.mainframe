---
name: crusaders-mainframe-decisions-frontend-unknown-outcomes
description: "A write whose answer is lost or unsure is read back, never re-sent and never called a refusal; its words name the cause (silent, busy, clash, error); a passing 503 is busy, not down; a proven write says what the answer was."
type: decision
last_verified: 2026-11-20
---

# Live decisions — unknown outcomes and the words for them (member side)

The admin console's read-backs are [`decisions-admin-lost-replies.md`](decisions-admin-lost-replies.md); the server's
503s are [`decisions-booking-races.md`](decisions-booking-races.md) and [`decisions-backend-capacity.md`](decisions-backend-capacity.md).

- **One helper, `lib/lostReply.writeOrReadBack(write, readBack)`** (`lostReply.ts:50`; copy `lib/lostReplyCopy.ts`).
  A 5xx, timeout or dropped connection reads the record back: the proof → said with the screen's own sentence; `null` →
  `UnsureOutcome(checked)`, "nothing changed"; the look fails → `UnsureOutcome(unchecked)`, "can't tell, refresh". A 4xx
  is re-thrown untouched. **Never a silent re-send** — pressing again is the member's call.
- **Each read-back names what THIS press would leave**, never "something exists": record = a new result submitted by me;
  edit = same result, higher version, these games; confirm/dispute/withdraw = that status on that result id; remove =
  seat gone or removed; add = a seat not there before for this pick; split = mode + every partner seat's previewed share;
  leave/decline = my own seat (`GET /me/invites/{pid}`); admin seat acts judged off the seat; pause/goal/celebrations off
  `GET /me/play`; star off favourites; privacy off preferences; inbox marks off the unread count / newest page; admin
  void/uphold off Match results. **Nothing to read back → "not known"**: a reminder (nudge) and a new share link (its
  token lived only in the lost reply); an open seat found by a read-back offers "make a new link".
- **An unknown outcome inside a `ConfirmDialog` is said by its `describe` prop**; the dialog stays open with the typed
  reason (closing it lost the admin's reason and put the alert between the row's two buttons); a withdraw known not to
  have landed does not re-read the card.
- **The cause is named — four of them** (R19 X19-2, `lostReply.unsureReasonOf` / `answerReasonOf`, `:96,104`;
  `unsureCauseOf` is retired): **busy** (`503 service_busy`, 429) → "The club's system was too busy to take this just
  now … in a moment", never "didn't answer"; **conflict** (`503 conflict_retry`) → "Someone else was changing … at the same
  moment, so we checked: … Try again now" (R17 X17-1) — still an unknown outcome (a batch may land items before the one
  that gave way, so the look is owed), but never worded as silence, because the club DID answer and the clash is over;
  **error** (a plain 500 — any 5xx but 502, 504, a code-less 503) → "the club's system hit an error", never promising "a
  minute", and "tell the club committee if it keeps happening"; **silent** (NetworkError, abort, 502, 504, a code-less
  503) → the lost-reply words. `unsureWords` builds every pair; a hand-written pair falls back to
  `LOST_REPLY.conflictGeneric` / `errorGeneric`. Booking sheets, the hold lift, bulk-cancel rows, the star, the reminder,
  a share link, invite accept/decline and the privacy switch all go through it; the error constants are
  `lib/errors.ts` `CONFLICT_RETRY_CAUSE` (ends "Try again now.") and `SERVICE_BUSY_CAUSE`.
- **A passing 503 is the club answering busy, not down** (R18–R19): `PASSING_CAUSES` (`conflict_retry`,
  `service_busy`) are not deployment faults, so Try again stays; on the session check they take ConnectionLost's busy
  title like a 429; the door card's `ReadFailure` is `network | server | busy | clash` ("not your phone, it passes in a
  moment", never "an error"). A 503 with no code (a restart) stays unreachable / an error.
- **A proven write says what the answer was** (R19): `Landed.answered` / `ProvenBy` reach `LOST_REPLY.proven(done,
  why)` — "…hit an error, but we checked its record: it went through"; only silence says "the reply didn't arrive, so we
  checked its record". *Why:* once a 500 is an answer, the old proven sentence denied it.
- **A failed READ names its cause too** (R19 L19-7): Upcoming/Recent games keep the read's error and `GamesReadFailed`
  says the lead then `describeFailure(error)`; the booking page's READ uses `PLAYERS_READ_REFUSAL` (read codes only) —
  the write map's clash said "The page has the latest" about a page that never loaded.
- **The booking page keeps up** (R3, `useDetailLiveness`): re-read at start and end (`useBoundaryRefresh`, only
  instants AFTER the last read), on return to view when the read is >10 s old, when the wallet stream's balance/unread
  moves (ignoring its first load), and every 30 s from 30 min before start to end while nobody is checked in. *Why the
  poll:* a check-in moves no money for the viewer and sends no notice, and the cue window is a club setting the page
  does not read. The result card follows every booking read (`freshAt`), so Record appears at the start.
- **Traps:** among equal stub prefixes the FIRST declared answers (`detailKit.serve` and the Inbox test put a test's own
  routes first); proving red means copying the HEAD version of only the changed component over the file, running the
  new test, and copying the fix back — zsh does not word-split `$FILES`, use an array or a failed `cp` leaves nothing to
  restore.
