---
name: crusaders-mainframe-state
description: "Branch claude/e2e-fix-programme is fully pushed and green on its last CI run; PR #2 is still a draft, so main is far behind and the release half of the chain has never executed. Never run on real hardware, nothing deployed, no paying club."
type: state
last_verified: 2026-09-11
---

# Current state

Verified 2026-09-11 by inspection of the repository, `ci.yml`, the GitHub run history and the
repo's Actions secrets. Anything below dated older than ~60 days deserves re-checking.

**The build.** All of it lives on `claude/e2e-fix-programme`, which is **fully pushed to its own
upstream — nothing exists only on this Mac.** `main` is far behind it and the outstanding act is
the merge: **PR #2 is still a draft** (PR #1 merged 2026-08-22). Delivery is one branch, one PR by
founder decision — see [`decisions-method.md`](decisions-method.md).

**What the product does now.** The headline flow — book online, scan at the box, lights on —
exists end to end in code and is pinned by `make test-e2e-device`, which drives the real device API
and the Mega simulator's serial link. The device contract is **hobby grade**: one per-tenant API
key in `secrets.h`, a box auto-registers on its first heartbeat. OTA, image signing, HMAC device
auth, discovery, claim codes, per-device keys and the device clock are **gone from the tree**, not
merely disabled — no `lib/otacore`, no `lib/discovery`, no `Security/Discovery/`, and no OTA job or
`OTA_PRIVATE_KEY` in `ci.yml`. Why: [`decisions-device.md`](decisions-device.md).

**What the suites prove.** Backend, frontend, firmware host, ASAN/UBSAN, corpus, complexity, lint
and Arduino-compile gates are all real and all green — the last CI run on the branch passed every
job, including the device e2e chain and Playwright. They are not evidence the system works: three
adversarial passes have each found live defects in suites that were already green
([`decisions-method.md`](decisions-method.md)). **The suite is also flaky against the wall clock**
and cannot pass in the last half-hour of a UTC day — the intermittent red `Backend` jobs in the run
history are that, not a regression; see [`gotchas.md`](gotchas.md) before re-running anything.

**Nothing has ever touched real hardware, and nothing is deployed.** No club is using it, no money
has moved through PayFast in production. The image-build and Portainer jobs are gated on
`push` to `main`, so every pull-request run skips them: **the release half of the chain has never
executed once.** Docker Hub credentials are set; the four Portainer secrets are not
([`watch.md`](watch.md)).

**What stands between here and a lit court at Crusaders:** the relay safety question
([`safety-relays.md`](safety-relays.md)), committee sign-off on charge-at-booking, PayFast
production credentials, the Portainer secrets, and one supervised bench session with the real box.
All of it is founder or committee work, not code.

**Reference artefacts.** `docs/go-live-checklist.md` is the ordered list with the consequence of
skipping each item. `docs/system-blueprint.html` was last regenerated 2026-09-05 against this
branch and its device-facing sections were checked against the running API, so it post-dates the
simplification; it is stale the moment a spec or decision changes, and the hosted copy is
republished to the same artifact URL so the link stays stable.
