---
name: crusaders-mainframe-state
description: "Product work on claude/e2e-fix-programme is pushed and its last CI run (2026-09-08) passed; the unpushed context tip deletes tracked docs. PR #2 is a draft, so the release half has never executed. No hardware, no deploy, no paying club."
type: state
last_verified: 2026-09-11
---

# Current state

Verified 2026-09-11 against the repository, `ci.yml`, `gh run list` and `gh secret list`. **Two
claims below decay on their own and must be re-measured, never inherited: the result of the latest
CI run on the branch, and the Actions secrets inventory.**

**The build.** All of it lives on `claude/e2e-fix-programme`, ahead-only against its own upstream
with a clean tree — no product work exists only on this Mac. **The unpushed tip is context work that
deletes tracked documents**: superseded review reports under `docs/reviews/`, plus memory topics
folded into this one — deliberate ([`decisions-method.md`](decisions-method.md)), but enumerate the
range with `git diff --name-status @{u}..HEAD` before assuming an empty one. `main` is far behind and
the outstanding act is the merge: **PR #2 is still a draft** (PR #1 merged 2026-08-24). Delivery is
one branch, one PR by founder decision.

**What the product does now.** The headline flow — book online, scan at the box, lights on —
exists end to end in code and is pinned by `make test-e2e-device`, which drives the real device API
and the Mega simulator's serial link. The device contract is **hobby grade**: one per-tenant API
key in `secrets.h`, a box auto-registers on its first heartbeat. OTA, image signing, HMAC device
auth, discovery, claim codes, per-device keys and the device clock are **gone from the tree**, not
merely disabled — no `lib/otacore`, no `lib/discovery`, no `Security/Discovery/`, and no OTA job or
`OTA_PRIVATE_KEY` in `ci.yml`. Why: [`decisions-device.md`](decisions-device.md).

**What the suites prove.** Backend, frontend, firmware host, ASAN/UBSAN, corpus, complexity, lint
and Arduino-compile gates are all real, and **the most recent CI run on the branch — 2026-09-08 —
passed every job**, device e2e and Playwright included. Nor is a green suite evidence the system
works: three adversarial passes each found live defects in already-green suites
([`decisions-method.md`](decisions-method.md)). **The suite is also flaky against the wall clock**
and cannot pass in the last half-hour of a UTC day ([`gotchas.md`](gotchas.md)) — but that is *not*
what the two red `Backend` runs on this branch were. Read from `gh run view <id> --log-failed` on
2026-09-11: the 2026-09-08 02:35Z run failed to compile at all (`error CS1513` in
`SettlementSpecPostureTests.cs`), and the 00:07Z run failed two named tests outside the midnight
window, with `-v q` suppressing the assertions — **that cause is unattributed**, and re-running it
needs `-v n`.

**Nothing has ever touched real hardware, nothing is deployed, and no money has moved through
PayFast in production.** Crusaders Squash Club is a named, committed pilot that **pays nothing** —
`docs/development-plan.md` records "Free for Crusaders, TBD for tenant 2", and no payment obligation
is written anywhere. Image-build and Portainer jobs are gated on `push` to `main`, so every
pull-request run skips them: **the release half of the chain has never executed once.** Docker Hub
credentials are set; the four Portainer secrets are not ([`watch.md`](watch.md)).

**The launch bar** — working set, agreed 2026-07-24 and never revised. Nothing instruments any of it yet:

- 100% of bookings through the system within 60 days of launch, with no parallel WhatsApp or paper
- ≥95% of lights-on events matching a valid booking, and <2% disputed penalties
- ≥70% of active members holding positive credit
- a second club onboarded end to end in under two operator-hours
- ≥99.5% uptime in club hours, degrading gracefully when biometrics are unavailable
- acceptance is social: *"the committee says 'this is now how we run the courts.'"*

**What stands between here and a lit court at Crusaders** is founder and committee work, not code: the relay safety
question ([`safety-relays.md`](safety-relays.md)), committee sign-off on charge-at-booking, PayFast production
credentials, the Portainer secrets, and one supervised bench session with the real box.
`docs/go-live-checklist.md` is that list in order, each item carrying the consequence of skipping it.

**`docs/system-blueprint.html`**, the one-page interactive design, was last **regenerated
2026-09-06**, after the 2026-09-05 headed-browser round that checked its device-facing claims
against the running API (a context pass edited one paragraph on 2026-09-11); it goes stale the
moment a spec or decision changes. The hosted copy is republished to the same URL so the link stays
stable: `https://claude.ai/code/artifact/45da513d-3977-4c49-9bed-9ac44c81ccb4`.
