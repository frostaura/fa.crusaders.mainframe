---
name: crusaders-mainframe-state
description: "Product work on claude/e2e-fix-programme is pushed and its last CI run (2026-09-08) passed; the unpushed tip deletes four tracked docs. PR #2 is a draft, so the release half has never executed. No hardware, no deploy, no paying club."
type: state
last_verified: 2026-09-11
---

# Current state

Verified 2026-09-11 against the repository, `ci.yml`, the GitHub run history and the repo's Actions secrets. Anything dated older than ~60 days deserves re-checking.

**The build.** All of it lives on `claude/e2e-fix-programme`, ahead-only against its own upstream
with a clean tree — no product work exists only on this Mac. **The unpushed tip is context work and
it deletes four tracked documents**: three superseded review reports under `docs/reviews/` and the
`system-blueprint` memory topic. All four are deliberate ([`decisions-method.md`](decisions-method.md)),
but read the range before pushing rather than assuming an empty one. `main` is far behind and the
outstanding act is the merge: **PR #2 is still a draft** (PR #1 merged 2026-08-24). Delivery is one
branch, one PR by founder decision.

**What the product does now.** The headline flow — book online, scan at the box, lights on —
exists end to end in code and is pinned by `make test-e2e-device`, which drives the real device API
and the Mega simulator's serial link. The device contract is **hobby grade**: one per-tenant API
key in `secrets.h`, a box auto-registers on its first heartbeat. OTA, image signing, HMAC device
auth, discovery, claim codes, per-device keys and the device clock are **gone from the tree**, not
merely disabled — no `lib/otacore`, no `lib/discovery`, no `Security/Discovery/`, and no OTA job or
`OTA_PRIVATE_KEY` in `ci.yml`. Why: [`decisions-device.md`](decisions-device.md).

**What the suites prove.** Backend, frontend, firmware host, ASAN/UBSAN, corpus, complexity, lint
and Arduino-compile gates are all real, and **the most recent CI run on the branch — 2026-09-08 —
passed every job**, including the device e2e chain and Playwright. That is a dated fact, not a
standing property: re-read the run history rather than inheriting it. Nor is a green suite evidence
the system works — three adversarial passes have each found live defects in already-green suites
([`decisions-method.md`](decisions-method.md)). **The suite is also flaky against the wall clock**
and cannot pass in the last half-hour of a UTC day, which is what the intermittent red `Backend`
jobs are; see [`gotchas.md`](gotchas.md) before re-running anything.

**Nothing has ever touched real hardware, and nothing is deployed.** No club is using it and no
money has moved through PayFast in production. Crusaders Squash Club is a named, committed pilot
that **pays nothing** — `docs/development-plan.md` records "Free for Crusaders, TBD for tenant 2",
and no payment obligation is written anywhere. Image-build and Portainer jobs are gated on `push`
to `main`, so every pull-request run skips them: **the release half of the chain has never executed
once.** Docker Hub credentials are set; the four Portainer secrets are not ([`watch.md`](watch.md)).

**The launch bar (working set, agreed 2026-07-24 and never revised).** 100% of bookings through the
system within 60 days of launch, no parallel WhatsApp or paper · ≥95% of lights-on events matching
a valid booking, <2% disputed penalties · ≥70% of active members holding positive credit · a second
club onboarded end to end in under 2 operator-hours · ≥99.5% uptime in club hours with graceful
biometric degradation. Acceptance is social: *"the committee says 'this is now how we run the
courts.'"* Nothing instruments any of it yet.

**What stands between here and a lit court at Crusaders:** the relay safety question
([`safety-relays.md`](safety-relays.md)), committee sign-off on charge-at-booking, PayFast
production credentials, the Portainer secrets, and one supervised bench session with the real box —
founder and committee work, not code.

**Reference artefacts.** `docs/go-live-checklist.md` is the ordered list with the consequence of
skipping each item. `docs/system-blueprint.html` was regenerated 2026-09-05 against this branch
with its device-facing sections checked against the running API, so it post-dates the
simplification; it goes stale the moment a spec or decision changes, and the hosted copy is
republished to the same artifact URL so the link stays stable.
