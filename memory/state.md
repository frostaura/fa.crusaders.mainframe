---
name: technologies-crusaders-squash-control-system-state
description: "REDEPLOY HAND-OFF: no pullable image exists (old names deleted, new names unpublished, CI disabled); the Pi's stack must be repointed. Code tip e15b3f9f, the rename, never green. Production 530/1033. Dean's."
type: state
last_verified: 2026-11-20
---

# Current state

Re-measured **late 2026-11-20** (`git fetch`/`rev-list`, `gh run`/`workflow list`, `gh repo view`, Docker Hub's
repository API, `curl`). Re-run before relying on any of it.

## Redeploy hand-off — read before touching production
1. **No image of this product can be pulled from Docker Hub.** The pre-rename
   `frostaura/crusaders-mainframe-{backend,frontend,gateway}` repositories were **deleted** on 2026-11-20 by founder
   instruction (all three 404), so **no rollback image exists** — nothing earlier than the next build, apart from
   whatever the Pi still has cached locally. The new `frostaura/technologies.crusaders.squash-control-system-*`
   repositories also 404: the rename commit's only run was cancelled, and the workflow is `disabled_manually`.
2. **CI first.** Nothing publishes until Dean runs `gh workflow enable CI -R frostaura/technologies.crusaders.squash-control-system`
   and a `main` run goes green (images publish only on `push` to `main`). Deploy that run's `sha-<commit>`.
3. **Repoint the Pi's Portainer stack.** All three image names change to the new names in the same edit that pins
   `CRUSADERS_IMAGE_TAG`. A stack still naming `crusaders-mainframe-*` cannot pull at all now. The runbook, the deployment
   spec and the go-live checklist still say such a stack "keeps redeploying the last pre-rename release" and that a
   rollback uses the old names — both untrue since the deletion ([`watch.md`](watch.md) item 8).
4. **Then the runbook**: backup, `make migrations-pending` (at least PlatformTenantOnboarding, AddLedgerPurchaseId,
   AddLedgerReversesEntryId, DeviceContractV3 are new since the last known deploy), set `MemberCodes__MasterKey`
   ([`decisions-member-code-rollout.md`](decisions-member-code-rollout.md)), re-enter a blank PayFast passphrase
   ([`decisions-payfast.md`](decisions-payfast.md)). Health's `service` is now the repo name; fix any probe matching it.

## The code
**Product tip `e15b3f9f`** (2026-11-20), the product rename across 44 files (what it kept:
[`decisions-release-ops.md`](decisions-release-ops.md)). Its only CI run was **cancelled** after
`DeviceContractV3HttpTests.Activating_then_extending_with_one_v1_code_extends` failed in integration shard 3/5 (not
re-run; flaky or real is unknown). The last green product run is `7893321d` (PR #16, 2026-11-14); its images went
with the deleted repositories. **No PR is open** ([`questions.md`](questions.md) on PRs versus `main`).

**Firmware** is unchanged since `7893321d` (the rename left `src/iot` and `src/contracts` alone); versions and the
Mega-first order are in [`decisions-court-box.md`](decisions-court-box.md). No OTA, no hotspot: every change is a cable
flash ([`decisions-device-v3.md`](decisions-device-v3.md)). Bridge heap 27,664 B at `79a2fe54`, 3,088 B over the
24,576 B floor. **No flash of any image is recorded.**

**Production.** `crusaders.frostaura.net` answers **HTTP 530** (no tunnel connector), re-probed late 2026-11-20, as on
2026-11-13. What the Pi runs is unknown from outside ([`gotchas-ops.md`](gotchas-ops.md)). **Dean, in order**
(`docs/go-live-checklist.md`): bring the tunnel back and read why it stopped (a missing `MemberCodes__MasterKey`
refuses start); the redeploy above; delete any `OTA_PRIVATE_KEY` repository secret; then **flash** each Mega, its
bridge, then the doors (who flashes: [`questions.md`](questions.md)), bench-checking relay polarity, the LCD, the
bootloader across a watchdog reset (FWM-11) and the scan flows on the first box.

**Open** (none blocks a redeploy): `test_compat`'s court-box executor; the dead PayFor source; dead `net_src: "local"`
handling; FM-8, BM-9, BA-21, FC-8's 1.x corner, BA-17 ([`decisions-admin-console.md`](decisions-admin-console.md));
toasts with a real screen reader; walk-behind attendance. Dean's settings: the offsite backup cron (not installed),
branch protection on `main` (none). The repo is **public**, by the founder's 2026-11-20 decision ([`decisions.md`](decisions.md)).
The hosted blueprint `https://claude.ai/code/artifact/45da513d-3977-4c49-9bed-9ac44c81ccb4` was **not republished**
after `e15b3f9f` renamed both founder-facing pages in the repo, so it still shows the old name.

**Clones — two, on `main`, level with `origin/main`, clean:** `~/src/technologies.crusaders.squash-control-system`
and the iCloud copy (ignored `.env`, four `secrets.h`, build output; [`watch-secrets.md`](watch-secrets.md)). Until
2026-11-20 the repo was `fa.crusaders.mainframe`, the product *Crusaders Mainframe*; GitHub redirects the old URL.
**Outside code:** the relay question ([`safety-relays.md`](safety-relays.md)), Carl's two lock facts
([`watch-doors.md`](watch-doors.md)), committee sign-off on charge-at-booking, supervised bench sessions.
