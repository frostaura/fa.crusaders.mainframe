---
name: crusaders-mainframe-state
description: "Ironclad passes 1-2 plus the OTA removal on fix/ironclad, PR #15 open, not merged (2026-11-14). No OTA: Mega 3.0.0, bridge 3.1.0, gate 2.0.0, every firmware change a cable flash. Production last seen down (1033)."
type: state
last_verified: 2026-11-14
---

# Current state

Re-measured **2026-11-14** by hand (`ls-remote`, `rev-parse`, `status`); re-run, never inherit.

**The code.** The ironclad pre-go-live pass (Dean: "fix any and all, full e2e testing") ran its
fix lanes in `~/src/.crusaders-wt/` worktrees, in two passes, both integrated on **`fix/ironclad`**
(worktree `…/integration`) over `origin/main` = `a77a1d72`, **open as PR #15** (not merged; Auto-fix
is switched on from the PR bar). Dispositions: `https://claude.ai/artifact/DcXVM42d3H3nhxoztN8BPA`.
Integrations: [`decisions-ironclad-integration.md`](decisions-ironclad-integration.md) (pass 1,
nine lanes) and [`decisions-ironclad-integration-pass2.md`](decisions-ironclad-integration-pass2.md)
(bridge-ota, app-rest). Lanes' own decisions: `decisions-bridge-3-1`, `decisions-app-rest-pass2`,
`decisions-*-v3*`, `decisions-money-golive`, `decisions-platform-*`, `decisions-release-ops`,
`decisions-*-golive`. The iCloud clone is still at `64ec7f43` (2026-10-22), untouched.

**After the pass, 2026-11-14:** the founder removed signed OTA everywhere (`fix/no-ota-fw`,
`fix/no-ota-app`, merged into `fix/ironclad`; why in [`decisions-device-v3.md`](decisions-device-v3.md)).
The pre-removal tree is `99e9c5ee` — the tip `origin/fix/ironclad` still pointed at when this was
written, so the removal and the V-1 follow-up were local commits above it; re-run `ls-remote`.
V-1/V-2 were fixed and re-walked in Chrome; V-1 was then narrowed so a member row wraps only while
a confirm is armed (`1b9c4b9d`, not re-walked here).

**Gates after the OTA removal:** see the next commit.

**Firmware as integrated.** Mega **3.0.0** (the generic renderer and relay guard), bridge **3.1.0**
(key ring, runtime network, setup portal, supervisor, LittleFS persistence; caps `codes:m1 hb:3
lcd:2 key:1 net:1`), door gate **2.0.0** (`codes:m1 key:1 net:1`). **No board updates over the air:
every firmware change, to any chip, is a cable flash** (`docs/specs/device-api.md` §1, §7). The
bridge's heap is 26,536 B, 1,960 B above its 24,576 B floor. **No flash is recorded anywhere yet.**
**Running here:** the `crusaders-int` stack (`:8098`, MailHog `:8035`) runs `fix/ironclad` on its
own volumes (not checked since the removal); the shared `crusaders` stack (`:8088`) is untouched.

**What only Dean can do, in this order** (`docs/go-live-checklist.md` has every step):
1. Choose `SETUP_AP_PASSWORD` and label every enclosure with it. Delete any `OTA_PRIVATE_KEY`
   repository secret if one was set — nothing reads it.
2. Review and merge PR #15. Redeploy with the **new** `docker-compose.prod.yml`
   (sha-tagged images, `volume-init`, `backup`). Migrations run on start: PlatformTenantOnboarding,
   AddLedgerPurchaseId, AddLedgerReversesEntryId, DeviceContractV3.
3. **Manual step at that redeploy:** a club whose stored PayFast account has no passphrase, or a
   placeholder one, reads as not configured. Enter it under Settings › Money › PayFast account.
4. Bring production back. It answered Cloudflare **1033** (no tunnel connector) on 2026-11-13.
5. Flash the Mega with 3.0.0, then the bridge with 3.1.0 (never 3.0.0). Do the portal check on
   each box before sealing it (checklist §5).

**Open after the pass** (none blocks a redeploy; **the bridge ones now need a cable flash**, so
they are done before the first flash or each costs a visit to every box):
- `test_compat`'s executor (move main.cpp's adoption into bridgelogic first); the bridge halves
  of BR-08/09, DL-07, FSF-06, MCV1-02/06/08, BR-11, BR-14; the dead PayFor source.
- FM-8: the per-host static shell needs gateway SSI. BM-9: switch the readers first. FC-8's 1.x
  corner is the contract owner's call. BA-17 and BA-21 need a design decision.
- Offsite backup cron, branch protection and repo visibility (Dean's, per the release-ops topic).
- **Founder decision open** (play.md §14 Q4, [`questions.md`](questions.md)): partners who walk in
  behind a scanning PLAYER still count as attended.
- Toasts never tried with a real screen reader ([`decisions-frontend-shell-r19.md`](decisions-frontend-shell-r19.md)).

**Blueprint** `docs/system-blueprint.html`: fixed in place 2026-11-14, **not republished** (keep URL `https://claude.ai/code/artifact/45da513d-3977-4c49-9bed-9ac44c81ccb4`).

**Still outside code:** the relay safety question ([`safety-relays.md`](safety-relays.md)), Carl's
two lock facts ([`watch-doors.md`](watch-doors.md)), committee sign-off on charge-at-booking, and
supervised bench sessions with the real box and door.
