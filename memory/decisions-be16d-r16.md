---
name: crusaders-mainframe-decisions-be16d-r16
description: "R16 triage lane BE16d: the six red sharded-run tests were a UTC date sent as a club ?day= (00:00-02:00 SAST) and two mail tests stale after E16-5. No production defect."
type: decision
last_verified: 2026-10-06
---

# R16 BE16d — triage of the six red sharded-run tests

**Four Night tests were red from 00:00 to 02:00 club time every day; production was right.**
`MemberCodePhotoReuseHttpTests` (three) and `PlayersMemberCodeSeamHttpTests` (partner's own code)
seed a Johannesburg club and asked the Night for `?day={clock.Now:yyyy-MM-dd}`, which is the
UTC date. The trace endpoint reads `?day=` as a CLUB date (`DoorPeriod.Day` in the club's zone),
so in the first two club hours it asked for yesterday and found none of today's rows (count 0,
`Assert.Single` empty). The audit rows themselves were always written, which is why the
assertions before the Night passed. Reproduced at 00:23 SAST on HEAD c2618322 (4 red), green at
00:23 after the fix.

- **Fix:** `MemberCodeClub.DayOf(at)` formats the club-local date via `DoorClock.LocalDateOf`; the
  four call sites use it. The fixture keeps Johannesburg on purpose — a non-UTC zone is the case
  that proves the Night's day is the club's.
- **Rule:** a test that sends a club date (`?day=`, `?date=`, an occurrence date) must derive it in
  the club's zone, never by formatting a UTC instant. Clubs seeded at `"UTC"` (PlayersClub,
  TestHost) are immune by construction, which is why the same pattern elsewhere stays green.

**`R1MailHttpTests` collect and `R2MailWordingHttpTests` collect were stale, not broken.** BE16b's
E16-5 (`56018952`) retitled the organiser's collect mail "The club collected <Name>'s share —
Court N"; the tests still looked for "paid their share". Updated to the intended subject, and R1
now also asserts the organiser gets no "paid their share" mail — stronger than before, not looser.
BE16c's "also red at earlier HEADs" was the same clock window for the four, and post-`56018952`
HEADs for the two mail tests.
