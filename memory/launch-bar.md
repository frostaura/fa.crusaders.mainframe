---
name: crusaders-mainframe-launch-bar
description: "The working set of conditions agreed on 2026-07-24 for calling Crusaders launched — bookings, lights-on match rate, positive balances, second-club onboarding time, uptime — and the fact that nothing instruments any of them."
type: decision
last_verified: 2026-09-19
---

# The launch bar

Agreed **2026-07-24** and never revised. Split out of the state topic on 2026-09-19 unchanged,
because it is a standing commitment rather than a fact about today, and it was being carried
along by a file that is re-measured every session.

- 100% of bookings through the system within 60 days of launch, with no parallel WhatsApp or paper
- ≥95% of lights-on events matching a valid booking, and <2% disputed penalties
- ≥70% of active members holding positive credit
- a second club onboarded end to end in under two operator-hours
- ≥99.5% uptime in club hours, degrading gracefully when biometrics are unavailable
- acceptance is social: *"the committee says 'this is now how we run the courts.'"*

**Nothing instruments any of it.** There is no report, no dashboard and no query behind a single
one of these numbers, so on the day somebody asks how launch is going the answer would have to be
assembled by hand from the ledger and the audit trail. That was a deliberate gap while nothing
was live — a scoreboard for a system nobody used would be re-done. A production stack has been up
since 2026-09-19 ([`state.md`](state.md)), so it is now a debt: the kind discovered late, when the
number is wanted this week.

**A door gate contributes to none of these.** Walking through a door is not attendance
([`decisions-gate.md`](decisions-gate.md)), so entry traffic can never appear in the lights-on
match rate; the `gate.opened` audit rows are the only entry statistics there are or will be.
