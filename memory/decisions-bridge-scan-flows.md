---
name: crusaders-mainframe-decisions-bridge-scan-flows
description: "Bridge scan-flow fixes before the first cable flash (2026-11-14): busy vs not-recognised, prompts capped by the scan, whole-call HTTP budget, designed verdict screens, extending your own lit court."
type: decision
last_verified: 2026-11-14
---

# Decisions — bridge scan flows, before the first cable flash

Branch `fix/bridge-flows`. Closes the bridge halves of BR-08/09/11/14, DL-07, FSF-06/11,
MCV1-02/06/08 and ESPR-8 that `state.md` listed as owed. Bridge only: the Mega image and the
serial protocol are unchanged.

- **A scan the server did not decide is never NOT RECOGNISED** when it may be a member
  (`ScanFlow::explainNoDecision`, `OnlineMiss`). Offline or unreachable: `NO CONNECTION /
  BOOKINGS ONLY`; 429, 5xx or an unreadable 2xx: `BUSY / SCAN AGAIN`; the box refused (401…):
  `SEE THE DESK`. Applies to a legacy token the roster does not hold and to a verified v1 code
  with nothing booked or no key (`MemberScanResult::couldBeMember`). *Why:* the roster fallback
  told valid walk-up members their code was bad. A wrong v1 code, a replay, a throttle and a
  stale roster keep their own words. Nothing arms.
- **Every press-inviting screen is held to the scan's remaining life** (`invitesPress`: court
  or duration cells), and the court press that puts CHOOSE TIME / EXTEND:PICK TIME up re-arms
  the Mega's window for exactly that long (`AuthPolicy::coverScan`); under a second left it
  paints SCAN AGAIN. *Why:* the duration prompts counted 20 s past the scan and every black
  button was refused (BR-09, DL-07); a lost `!AUTH` stranded the walk-up after `no_booking`
  (ESPR-8).
- **One 4 s budget per HTTP call, retry included** (`CallBudget`): each phase gets half of what
  is left, the body read stops at the deadline, a 401 retry needs 750 ms. *Why:* per-phase
  timeouts let a stalled server hold the loop ~12 s, past the 6 s wait screen and the Mega
  receive ring (BR-11). The heartbeat shares the budget.
- **Scan outcomes paint their designed 4-row screens** (`verdictScreen`: Grant and the
  refusals whose words name a screen); TOO EARLY, WRONG COURT, BUSY and a stale roster keep their
  two lines, which are the safe subset (BR-14).
- **An online re-grant onto a court this box already had lit keeps the scan** and goes to
  EXTEND:PICK TIME with the court pre-selected (`regrantsLitCourt`, `WalkUpPad::select`).
  *Why:* the rescan spent the scan and the court press looped on SCAN TO EXTEND (FSF-06,
  MCV1-02). For v1 codes this relies on the server's MCV1-02 rule (a repeat activation claims no
  court use). The spec's "skip /activate for a proved REF" optimisation is not built.
- **A press the pad ignores is answered** — PICK A COURT with a scan, SCAN YOUR CODE without —
  instead of the Mega's ONE MOMENT hint (FSF-11).
- **MCV1-06 needed no code**: every path already goes through MegaTx; `test_bridgev3` pins the
  v1 sequences. Residue: an offline v1 grant commits its replay step when `!ON` is queued, so
  an `!ON` the Mega never acknowledges leaves CODE USED for the rest of that 30 s step.

Static RAM 55,524 B: heap 26,396 B, 1,820 B above the 24,576 B floor (was 26,536).
