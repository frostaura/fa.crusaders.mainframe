---
name: crusaders-mainframe-state
description: "PR #2 is merged and main publishes three images; PR #3, the door gates, is an OPEN DRAFT from claude/gate-controller whose branch run is red on the firmware host job and on GitGuardian. Nothing deployed, nothing on hardware."
type: state
last_verified: 2026-09-19
---

# Current state

Re-measured **2026-09-19** by command — `git status --porcelain`, `git branch -a`,
`git rev-list --left-right --count`, `gh pr list --state all`, `gh pr checks 3`,
`gh run view`. **Three claims below decay on their own and must be re-run, never inherited:**
the result of the latest run on `main`, the result of the latest run on `claude/gate-controller`,
and the Actions secrets inventory, which has not been re-checked since 2026-09-11.

**The branches.** **PR #2 merged into `main` on 2026-09-19** (`36b96ad`), carrying the whole
`claude/e2e-fix-programme` history; its remote branch was deleted on merge. **PR #3 —
the door gates — is OPEN as a DRAFT from `claude/gate-controller`**, which is ahead of
`origin/main`, not behind it, and level with its own remote: nothing on it is unpushed.
PR #1 merged 2026-08-24. Delivery is one branch, one PR by founder decision.

**What CI does on that branch.** Every gate runs; **no image is built.** The six image jobs and
the three manifest steps are gated on a *push to `main`*, so on a pull request they report as
skipped — a green run on this branch says nothing whatever about the release half. At the branch
head (`854ba10`, run `35448643445`, 2026-09-19) backend, backend-integration, frontend, both
e2e jobs, `iot-build` and Security Scan passed, and **two jobs were red**: *IoT Firmware (native
tests + lint)*, where the ASAN/UBSAN build refused `gatelogic`'s `static_assert` over a
`constexpr` string length the plain build accepts — **`2a57f9c` landed on the branch after that
run and is that fix**, so the job has not been re-measured since — and **GitGuardian**, a probable
false positive on a shared corpus fixture ([`watch-doors.md`](watch-doors.md)). Take the current
answer from `gh pr checks 3`, never from this paragraph.

**What the product does now.** The court-light headline flow — book online, scan at the box,
lights on — exists end to end and is pinned by `make test-e2e-device`. **The door gate now exists
in code on PR #3**: one pull-only ESP32 per door on the same club key, `POST /api/v1/device/gate`,
a gate's own roster, and **no EF migration** — see [`decisions-gate.md`](decisions-gate.md) and
[`decisions-door-gate.md`](decisions-door-gate.md). The device contract stays **hobby grade**: one
per-tenant API key in `secrets.h`, a board auto-registers on its first heartbeat, and OTA, image
signing, HMAC device auth, discovery, claim codes and the device clock are gone from the tree
([`decisions-device.md`](decisions-device.md)).

**Nothing is deployed, nothing has ever run on hardware, and no money has moved through PayFast
in production.** The publish half is proven: run `35434498116` on 2026-09-19 pushed all three
multi-arch manifests, and the next push, `35435320324`, was the first fully green run in this
repository's history. The Portainer deploy job was removed the same day, so **redeploying the club
stack is a manual step** and has lost the stack checks that job carried ([`watch.md`](watch.md)).
Crusaders Squash Club is a named, committed pilot that **pays nothing**.

**The two founder-facing pages** — `docs/system-blueprint.html` and `docs/court-lights-flows.html`
— were regenerated **2026-09-19** on `claude/gate-g2-docs` for the door gate, after the G1 and G2
decisions. **Republishing the blueprint to its hosted artifact is owed and has not been done:**
the stable URL is `https://claude.ai/code/artifact/45da513d-3977-4c49-9bed-9ac44c81ccb4`, and the
copy behind it is the 2026-09-06 revision that knows nothing about doors. Whoever republishes
keeps that URL so the link the founder holds stays good.

**What stands between here and a lit court at Crusaders** is founder and committee work, not code:
the relay safety question ([`safety-relays.md`](safety-relays.md)), Carl's two facts about the
door lock, committee sign-off on charge-at-booking, PayFast production credentials, one manual
redeploy, and supervised bench sessions with the real box and the first real door.
`docs/go-live-checklist.md` is that list in order; §12 is the door's.
