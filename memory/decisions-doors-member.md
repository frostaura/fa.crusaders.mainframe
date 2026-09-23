---
name: crusaders-mainframe-decisions-doors-member
description: "A member's door history lives on /me/door and, since D9 (2026-09-23), on an audited admin read of one named member; the club log stays unsearchable by person; filtered by tenant AND subject; door rows deleted past retention."
type: decision
last_verified: 2026-09-23
---

# Live decisions — the member's doors, and what is deleted

The admin side is [`decisions-doors-console.md`](decisions-doors-console.md); the oracle for
both is `docs/specs/door-gate.md` §13.

- **A member's door history exists BECAUSE the club log refuses to hold one.** P3's first half
  stands: the club's log filters by door, time and outcome and never by a person, and that is
  only defensible because the person can read their own rows at `GET /api/v1/me/door/history`.
- **D9 (decided by Dean, 2026-09-23) REVERSES P3's second half: admins get a member's full door
  history.** `GET /api/v1/admin/members/{userId}/doors` (+ `.csv`). *Why:* a disputed no-show
  or safeguarding question needs "when did this person come and go", and without a route the
  desk rebuilds it from the club log by hand — same surveillance, no record of who looked.
  *What makes it acceptable:* **every read is audited** (`audit_log` `member.door_history_viewed`,
  admin as actor, member as subject, range and row count, page and export alike); the member is
  a PATH SEGMENT, so it cannot widen into a searchable log; it adds one predicate on top of
  `DoorLogQuery`, not a field, so the club log stays unsearchable by person
  (`No_parameter_named_after_a_member_changes_anything` still holds, deliberately unflipped).
  Default range: the whole door retention. **Owed:** the same read in the undeletable
  `admin_change_log` (needs a new `AdminChangeActions` entry).
- **Filtered by tenant AND by subject, and neither substitutes for the other.** The tenant query
  filter cannot separate two members of one club; the subject comparison cannot separate two
  clubs that happen to hold the same guid. Both cases are driven by tests, including another
  club writing a row that names this club's member at this club's door id.
- **One endpoint, not two** (A3.2): two would be two failure states and two clocks for one card.
- **120 seconds is a FETCH window, not a display window.** What the page does with a decision it
  has already fetched is the page's business. Short because the card's claim is "this just
  happened to you"; long enough that a phone waking from sleep still catches the scan.
- **Only `too_early` carries an instant to count down to**, and it comes from
  `BookingCodeWindow` — the same function the door decides with. *Why:* the horizon is built
  from three club settings that are not on a member's API surface and should not be, so a page
  computing its own copy is how a member watches a clock reach zero at a door that still refuses
  them. Every other refusal is about the credential or the membership and is not a matter of
  waiting.
- **`is_club_admin` is on the wire because under `booking_window` it is the difference between
  a page saying "you need a booking" and a door that opens anyway.** Pinned against the REAL
  decision at the real device route for both an admin and a member holding ident codes and no
  bookings — a flag that disagreed with the building is worse than no flag.
- **`membership` is three-valued and `membership_detail` carries the club's recorded status
  beside it.** "Your membership is suspended" and "your application has not been approved yet"
  are two different things for a person outside a building to do next. There is deliberately no
  `expired`: nothing in this product produces one, and a value no door will ever act on is worse
  than the gap.
- **Nothing of the trail's own shape crosses this boundary** — no fingerprint, no device id, no
  MAC, no device code, no raw details, and never another member's anything. Pinned by grepping
  the whole serialised response.
- **The door trail is DELETED past `door_log_retention_days`, not anonymised**, closing the
  residual §6 wrote down. *Why:* anonymising is enough for a booking and is not enough for a
  door — the row still says which door at what minute, and a club's membership is small enough
  that a pattern is a person. Receipts outlive the rows by `max(that, MaxEventAge)`, because a
  purged receipt turns an ordinary re-upload into a second row for one scan. What is still
  unpurged, and why, is [`watch-doors.md`](watch-doors.md) item 4.
- **Delete this topic** if a member's own door history is removed: the club log's missing
  member filter would need re-arguing from scratch.
