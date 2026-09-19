---
name: crusaders-mainframe-decisions-doors-member
description: "A member's own door history is P3's other half and lives only on /me/door, filtered by tenant AND subject because neither catches what the other does; and the door trail is now deleted past the club's retention rather than anonymised."
type: decision
last_verified: 2026-09-19
---

# Live decisions — the member's doors, and what is deleted

The admin side is [`decisions-doors-console.md`](decisions-doors-console.md); the oracle for
both is `docs/specs/door-gate.md` §13.

- **A member's door history exists BECAUSE the admin log refuses to hold one.** P3 has two
  halves: the club's log filters by door, time and outcome and never by a person, and that is
  only defensible because the person can read their own rows. `GET /api/v1/me/door/history` is
  where they belong, and nowhere else in the product may render them.
- **Filtered by tenant AND by subject, and neither substitutes for the other.** The tenant query
  filter cannot separate two members of one club; the subject comparison cannot separate two
  clubs that happen to hold the same guid. Both cases are driven by tests, including another
  club writing a row that names this club's member at this club's door id.
- **One endpoint, not two** (A3.2). The page polls while visible; two endpoints would be two
  failure states for one card and two clocks disagreeing about which answer is newer.
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
- **Delete this topic** if a member's own door history is ever removed from the product, because
  the admin log's missing member filter would then need re-arguing from scratch.
