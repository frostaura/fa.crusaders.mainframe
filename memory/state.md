---
name: crusaders-mainframe-state
description: "All three PRs are MERGED and main carries everything; origin has one branch and no open PRs. The last CI run on main is the one claim here that decays on its own — re-run it. Nothing deployed, nothing on hardware."
type: state
last_verified: 2026-09-23
---

# Current state

Re-measured **2026-09-23** by command — `git status --porcelain`, `git branch -r`,
`git rev-list --left-right --count`, `gh pr list --state all`, `gh run view`, `git worktree
list`. **Two claims below decay on their own and must be re-run, never inherited:** the result
of the latest run on `main`, and the Actions secrets inventory, unchecked since 2026-09-11.

**The branches, and there is now only one.** **PR #3 merged into `main` on 2026-09-23**, and its
remote branch was deleted. **All three PRs are MERGED and none is open.** `origin` carries
`main` and nothing else; the lane branches and worktrees of that era were removed after
`git branch --no-merged origin/main` returned **zero**.

**Work goes directly onto `main` by founder decision (2026-09-23)** — no branch, no PR — so
every push runs the release half of CI as well as the gates. `git rev-list --left-right --count
origin/main...HEAD` answering `0 0` is the check before claiming anything is safe. **Integration
line `main-work` (local, UNPUSHED)**: P7, P11 and the parallel test path reached `origin/main`
(76b5815); on top of it, 2026-09-29, **P12 play** — both lanes merged, the contract aligned,
every gate green — ahead of `origin/main` and not pushed (checked by `git rev-list` that day).

**What CI does on `main`.** Every gate runs **and the release half runs too**: the six image
jobs and three manifest steps are gated on a push to `main`, so unlike a pull request they are
live. They publish `:latest` multi-arch images to Docker Hub **and stop** — the Portainer
redeploy job was removed 2026-09-19, so nothing is redeployed automatically.
**A failing job SKIPS every job behind it**, which for several runs hid the state of
`backend-integration`, `e2e-device` and Security Scan entirely — count the skips before reading
a run as mostly-passing, and see [`gotchas-ci-jobs.md`](gotchas-ci-jobs.md) for why a timeout
reports as *cancelled*. Take the current answer from `gh run list --branch main`.

**What the product does now.** The court-light headline flow — book online, scan at the box,
lights on — exists end to end and is pinned by `make test-e2e-device`. **The door gate now exists
in code on PR #3**: one pull-only ESP32 per door on the same club key, `POST /api/v1/device/gate`,
a gate's own roster, and **no EF migration** — see [`decisions-gate.md`](decisions-gate.md) and
[`decisions-door-gate.md`](decisions-door-gate.md). The device contract stays **hobby grade**: one
per-tenant API key in `secrets.h`, a board auto-registers on its first heartbeat, and OTA, image
signing, HMAC device auth, discovery, claim codes and the device clock are gone from the tree
([`decisions-device.md`](decisions-device.md)).

**Nothing is deployed, nothing has ever run on hardware, and no money has moved through PayFast
in production.** The publish half is proven: run `35434498116` (2026-09-19) pushed all three
multi-arch manifests. Redeploying the club stack is a **manual step** and has lost the checks
the removed Portainer job carried ([`watch.md`](watch.md)). Crusaders Squash Club is a named,
committed pilot that **pays nothing**.

**The two founder-facing pages** — `docs/system-blueprint.html` and `docs/court-lights-flows.html`
— were regenerated **2026-09-19** on `claude/gate-g2-docs` for the door gate, after the G1 and G2
decisions. **Republishing the blueprint to its hosted artifact is owed and has not been done:**
the stable URL is `https://claude.ai/code/artifact/45da513d-3977-4c49-9bed-9ac44c81ccb4`, and the
copy behind it is the 2026-09-06 revision that knows nothing about doors. Whoever republishes
keeps that URL so the link the founder holds stays good.

**What stands between here and a lit court** is founder and committee work, not code:
the relay safety question ([`safety-relays.md`](safety-relays.md)), Carl's two facts about the
door lock, committee sign-off on charge-at-booking, PayFast production credentials, one manual
redeploy, and supervised bench sessions with the real box and the first real door.
`docs/go-live-checklist.md` is that list in order; §12 is the door's.
