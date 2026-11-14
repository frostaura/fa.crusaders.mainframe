---
name: crusaders-mainframe-decisions-member-code-cutover
description: "Member code v1 end to end (2026-11-13): keys reach acknowledged boards in every phase, unacknowledged court boxes block cut-over, a repeat activation claims no court use, ages never wrap."
type: decision
last_verified: 2026-11-13
---

# Decisions — member code v1 end to end and the cut-over (2026-11-13)

From the MCV1-01…11 gap report, taken by the orchestrator under Dean's go-ahead. The math itself
was cross-checked on ~17,000 generated cases with zero disagreements and is safe to freeze. Spec:
`docs/specs/member-code.md` §3.8, §5.2–5.4, §6.5, §8, §13; `device-api.md` §3, §4, §9.

- **Keys and v1 roster elements go to every acknowledged `codes:m1` board in every phase.** *Why:*
  the phone has shown only v1 codes since `42d3990d`, while legacy-phase rosters carried legacy
  entries and no keys — before cut-over no member held a code any board could check offline
  (MCV1-04). The phase now governs only what a legacy code is still accepted for.
- **An enabled, unacknowledged court box heard in the last seven days blocks cut-over without
  voting; cut-over also waits for every acknowledged box to have taken keys in the last hour.**
  *Why:* one named door cut a club over while all nine court boxes were unacknowledged and held no
  keys (MCV1-03). Blocking-without-voting keeps the 2026-10 rule's point — a stranger's board or a
  bench spare can never decide for the club — and an unplugged spare stops blocking after a week.
- **A repeat `/activate` of the session already lit on that device and court claims no court use;
  a 3.0.0 bridge skips `/activate` for a proved REF that holds the lit court.** *Why:* the re-grant
  spent the court use and `/extend` then answered 409 `code_used`, so extending your own lit court
  with a v1 code was impossible (MCV1-02). Safe: at the victim's own lit court an unused step can
  already buy an extension, so no new purchase opens to a photo.
- **The snapshot's "in play" starts at `StartsAt − cue`.** *Why:* a booking lit in its cue window
  was missing from the restore and stayed dark after a power cut (MCV1-05).
- **Ages never go negative on the bridge, and the server never pairs a release longer than 721
  minutes.** *Why:* the first online activation after a boot emitted a release of 4294967272 ms
  and the server dropped the court from the restore (MCV1-01, 2 of 3 boots).
- **Offline, `no_key` and "verified but not booked here" read `NO CONNECTION` / `BOOKINGS ONLY`.**
  *Why:* `NOT RECOGNISED` told a valid member their code was bad (MCV1-08).
- **"v1-shaped" is 19 characters and a leading `1` on every side** (MCV1-11); the courtside kiosk
  accepts v1 (MCV1-04); a door's online replay is uploaded as `replayed` (MCV1-10).
- **A placeholder master key refuses to start outside Development.** *Why:* production's compose
  held `CHANGE-ME`, and a key changed after enrolment rotates every member secret (MCV1-09). Before
  any production redeploy: set it once, record each board's `running_version` and caps,
  acknowledge the court boxes, hold the rollout until the last flash is verified. Since pass 2 an
  automatic move also raises `member_code.phase_moved` the day it happens.
