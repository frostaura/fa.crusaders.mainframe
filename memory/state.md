---
name: crusaders-mainframe-state
description: "Up at crusaders.frostaura.net since 2026-09-19, no flash recorded; P10 hardening stopped after round 19 (0 of 2 quiet rounds), all fixes pushed at abe6e1b5. Dean owes a flash (bridge 2.2.9, gate 1.1.2) and a redeploy."
type: state
last_verified: 2026-10-06
---

# Current state

Re-measured **2026-10-06** by command (`git fetch`, `rev-list --left-right --count`, `ls-remote`,
`status --porcelain`). Git claims decay fastest — re-run them, never inherit them.

**The code.** Work goes straight onto `main` by founder decision (2026-09-23) — no branch, no PR.
The integration checkout `~/src/.crusaders-merge-main` (branch `main-work`) sat at `abe6e1b5`,
equal to `origin/main` (`0 0`, `ls-remote` agreeing), clean tree. CI publishes `:latest`
multi-arch images on every push to `main` and **stops**: nothing redeploys automatically, and a
failing job SKIPS every job behind it ([`gotchas-ci-jobs.md`](gotchas-ci-jobs.md)).

**Production.** A production stack has been **up at `crusaders.frostaura.net` since 2026-09-19**:
`f987f6b5` (that day) records it answering `tenant_not_found` until `ProductionBootstrap` gave it a
first tenant, and `29284e14` stopped CI at the Docker Hub push after run `35434498116` published
every image. Redeploys are manual and none is recorded in the repo, so whether the running stack
carries any P10 fix is unknown. **No hardware run or flash is recorded anywhere.**

**P10 (adversarial hardening) ended after round 19, at Dean's request** ("wrap up after this
round"), with **0 of the 2 consecutive quiet rounds** the method asks for
([`decisions-method.md`](decisions-method.md)). Highs/mediums per round: R16 H1 M8 · R17 H0 M7 ·
R18 H1 M5 · R19 H0 M4 (members counts, restore flood, payer attendance, accept race) plus ~30
LOW. Every R19 finding is fixed and pushed (`abe6e1b5`); **no fresh review has verified the R19
fixes.** Decisions are in the per-lane `decisions-*` topics.

**What only Dean can do, in this order:**
1. **Flash bridge 2.2.9** (not 2.2.8) on each court box's ESP8266 and **gate 1.1.2** on each door
   ESP32. **Never the Mega** (stays 2.0.0). 2.2.9 now sends every LCD row, blank ones too, to the
   Mega — untested on hardware: on the first flash check that ONE MOMENT, BUSY and the PAY screens
   show no leftover lines ([`decisions-firmware-r19.md`](decisions-firmware-r19.md)).
2. **Redeploy backend, frontend and gateway** from `:latest`. The backend runs migration
   `AddDeviceRestoreServedBootAt` (`devices.RestoreServedBootAt`) on start. Check by hand that the
   stack names the gateway image and binds no `./nginx/nginx.conf` ([`watch.md`](watch.md) item 2).
3. **Set `MemberCodes__MasterKey` in the Portainer stack** — the prod compose carries a CHANGE-ME
   placeholder and the API refuses published or weak keys outside Development
   ([`decisions-member-code-rotation.md`](decisions-member-code-rotation.md)).

**Open after P10** (none blocks the redeploy):
- The Mega holds a legacy two-line `!LCD` (TOO LONG / TRY LESS TIME) for a fixed 10 s; a club
  setting the choice window under 10 s gets a line that outlasts the box's hold. No money effect;
  the Mega is off-limits.
- **Founder decision open** (play.md §14 Q4, [`questions.md`](questions.md)): partners who walk in
  behind a scanning PLAYER still count as attended; a pay-for payer's scan no longer counts (E19-3).
- Toast announcements were rebuilt for NVDA/JAWS (one persistent polite region) and never tried
  with a real screen reader ([`decisions-frontend-shell-r19.md`](decisions-frontend-shell-r19.md)).
- The entry chunk is **495.9 of its 500 kB budget**; the next copy added to it must move something
  out ([`decisions-frontend-bundle.md`](decisions-frontend-bundle.md)).
- Optional: the cancel quote could carry `checked_in_by` (`decisions-frontend-sheets-r19.md`).
- Local only: three test shards on one Postgres crowd `max_connections`; test pools drop idle
  connections after 3 s — raise toward ~10 s if the suite slows ([`gotchas-env.md`](gotchas-env.md)).
- Two real races the R19 load investigation found are fixed (`c1d12904`): a false CODE USED, and a
  code buying a second walk-up after a busy retry ([`decisions-member-code-backend.md`](decisions-member-code-backend.md)).

**The blueprint** `docs/system-blueprint.html` was **republished 2026-10-06** to its stable URL
`https://claude.ai/code/artifact/45da513d-3977-4c49-9bed-9ac44c81ccb4` — keep it on every republish.

**Still outside code:** the relay safety question ([`safety-relays.md`](safety-relays.md)), Carl's
two lock facts ([`watch-doors.md`](watch-doors.md)), committee sign-off on charge-at-booking, and
supervised bench sessions with the real box and door. `docs/go-live-checklist.md` lists them in
order; none was re-verified this session.
