---
name: crusaders-mainframe-decisions-member-code-rollout
description: "The member-code rollout: keys and v1 rosters reach every acknowledged codes:m1 board in every phase, only acknowledged boards vote, unacknowledged court boxes block cut-over, a manual rollback holds, and the master key refuses placeholders."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the member-code rollout phases and the cut-over

Phases: `legacy` → `v1` → `v1_only` (`Services/MemberCodeSettings.cs`). Oracle `docs/specs/member-code.md` §3.8,
§5.2–5.4, §6.5, §8, §10, §13; `device-api.md` §3, §4, §9. The 2026-11-13 items come from the MCV1-01…11 gap report,
taken by the orchestrator under Dean's go-ahead; the math was cross-checked on ~17,000 generated cases with zero
disagreements and is safe to freeze.

- **What each phase governs** (`MemberCodeSettings.cs:62-75`): per-booking codes are MINTED only in `legacy`
  (`MintsBookingCodes`), legacy codes are ACCEPTED in every phase but `v1_only` (`LegacyAccepted`, plus
  `LegacyAcceptedAt` for scans before the cut-off). From `v1_only` legacy is refused everywhere — kiosk QR match,
  biometric payer override and legacy evidence (judged at the scan) included — and the cut-off expires every access
  code. *Why:* a code nobody will show is a live credential. Per-booking codes are therefore NOT dead code while a club
  can be in or roll back to a phase that honours them ([`decisions-backend-hygiene.md`](decisions-backend-hygiene.md)).
- **Keys and v1 roster elements go to every acknowledged `codes:m1` board in every phase** (MCV1-04). *Why:* the phone
  has shown only v1 codes since `42d3990d`, while legacy-phase rosters carried legacy entries and no keys — before
  cut-over no member held a code any board could check offline. The phase now governs only what a legacy code is still
  accepted for. The courtside kiosk accepts v1 and spends a v1 code's court use like a court box.
- **Only ACKNOWLEDGED enabled boards vote on the cut-over** (a court box acknowledged by an admin, a door with a
  `gate_key` — the same test that decides who gets keys). *Why:* auto-registration admits any MAC holding the club's
  device key; counted, a bench spare on old firmware blocked the club for ever, and a stranger flashing `codes:m1` could
  cast the deciding vote.
- **An enabled, unacknowledged court box heard in the last seven days blocks cut-over without voting; cut-over also
  waits for every acknowledged box to have taken keys in the last hour** (MCV1-03). *Why:* one named door cut a club over
  while all nine court boxes were unacknowledged and held no keys. Blocking-without-voting keeps the voting rule's point
  — a stranger's board or a bench spare never decides — and an unplugged spare stops blocking after a week.
- **A manual BACKWARD phase move sets `member_code_manual_hold` (+ by, at); the heartbeat never moves forward while it is
  set**, and only a forward move by hand (or clearing it) lifts it (`AdminConfigEndpoints.cs:1064-1065,1610`). Back to
  `v1` restamps the cut-over and clears the cut-off; a rollback out of `v1_only` gives back the legacy codes the cut-off
  ended (still in date). *Why:* every board still speaks `codes:m1` after a rollback, so the next heartbeat undid it
  within a minute, an old cut-over date re-fired the cut-off at once, and the legacy codes are the fallback the club
  rolled back to.
- **An automatic move raises `member_code.phase_moved`** (MCV1-09, once per move, `AdminEventCatalogue.cs:129`); the
  legacy phase's console words no longer claim phones show the old code. The console's Member codes › Rollout reads
  the server's state (held / blocked / clear), never infers it ([`decisions-admin-boards.md`](decisions-admin-boards.md)).
- **The master key**: lenient only in Development; everything else refuses published keys (dev, the test host's old
  constant, the corpus fixture key — pinned to `derivation.json` by a test), keys with fewer than 16 distinct bytes, and
  a placeholder (production's compose held `CHANGE-ME`; it still does, `docker-compose.prod.yml:151`, so a redeploy
  without `MemberCodes__MasterKey` will not start). The test host injects a random key per process. *Why:* each
  published key passes every length rule, a rule the test host is exempt from is a rule no test proves, and a key changed
  after enrolment rotates every member secret (and the club WiFi password's encryption key with it).
- **Before any production redeploy that turns codes on:** set the master key once, record each board's
  `running_version` and caps, acknowledge the court boxes, hold the rollout until the flash is verified.
- **"v1-shaped" is 19 characters and a leading `1` on every side** (MCV1-11); a door's online replay is uploaded as
  `unknown_scan` with `cause: "replayed"` (MCV1-10).
