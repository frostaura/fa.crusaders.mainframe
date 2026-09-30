---
name: crusaders-mainframe-decisions-member-lost-replies
description: "Review round 3 lane F2: every member players/play write reads the club's record back after a lost reply; the booking page re-reads itself at start/end, on return, on wallet moves and on a live poll."
type: decision
last_verified: 2026-09-30
---

# Live decisions — member writes after a lost reply, and a page that keeps up (R3, lane F2)

The admin side is `decisions-admin-lost-replies.md`; this is the member side (players, play, inbox).

- **One helper, `lib/lostReply.writeOrReadBack(write, readBack)`** (copy: `lib/lostReplyCopy.ts`).
  A 5xx/timeout/dropped connection reads the record back: the proof → said with the screen's own
  sentence + "the reply didn't arrive, so we checked its record"; `null` → `UnsureOutcome(checked)`,
  "nothing changed"; the look fails → `UnsureOutcome(unchecked)`, "can't tell, refresh". A 4xx is
  re-thrown untouched. **Never a silent re-send** — pressing again is the member's call.
- **Each read-back names what THIS press would leave**, never "something exists": record = a new
  result submitted by me; edit = same result, higher version, these games; confirm/dispute/withdraw
  = that status on that result id; remove = seat gone or removed; add = a seat not there before for
  this pick; split = mode + every partner seat's previewed share; leave/decline = my own seat
  (`GET /me/invites/{pid}`) withdrawn/declined; admin seat acts judged off the seat; pause/goal/
  celebrations off `GET /me/play`; star off favourites; privacy off preferences; inbox marks off
  the unread count / newest page; admin void/uphold off Match results under the new status.
- **Nothing to read back → "not known"**: a reminder (nudge) and a new share link (its token lived
  only in the lost reply). An open seat found by a read-back offers "make a new link" (path null).
- **`ConfirmDialog` can only word a refusal** (it calls `describeFailure`), so an unknown outcome
  from inside one (result withdraw, admin void/uphold) is caught, the dialog closes and the
  sentence is said beside the card / on the row. Owed upstream: a `describe` prop on ConfirmDialog.
- **The booking page keeps up** (`useDetailLiveness`): re-read at start and end (the door's
  `useBoundaryRefresh`, only instants AFTER the last read — a past one would fire on every load),
  on return to view when the read is >10 s old, when the wallet stream's balance/unread moves
  (ignoring the wallet's first load), and every 30 s from 30 min before start to end while nobody
  is checked in. **Why the poll:** a check-in moves no money for the viewer and sends no notice,
  and the box's cue window is a club setting the page does not read. The result card follows
  every booking read (`freshAt`), so Record appears at the start with no reload.
- **Celebrations**: the frontend has no local trigger; B awards only on confirmation. A queued
  badge can still open over an unrelated pending result, so a badge moment says "Earned <date>".
- **Onboarding names no code period and no menu position** (`CODE_KEEPS_CHANGING`): the step is a
  club setting and the menu is a bottom tab bar on a phone.

## Traps met

- **Test stubs: among equal prefixes the FIRST declared answers.** `detailKit.serve` and the
  Inbox test now put a test's own routes first; before, a test could not answer the result route.
- **`min-width` beats `max-width`**: a flex item with `max-w-full` still sat at its min-content
  (a long email) and pushed the card. `min-w-0` (or `break-all`) is the fix, not more max-width.
- **A rem `min-w-*` on text is a 200 % bug** (12rem = 384 px). Use a flex *basis* that may shrink
  (`grow basis-48 min-w-0`); the theme-vocabulary guard refuses arbitrary `min-w-[min(...)]`.
- **Proving red** here means copying the HEAD version of only the changed component over the
  file, running the new test, and copying the fix back — zsh does not word-split `$FILES`; use an
  array, or a failed `cp` leaves nothing to restore.
