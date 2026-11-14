---
name: crusaders-mainframe-state
description: "Ironclad passes 1 and 2 on fix/ironclad over a77a1d72, pushed as PR #15, not merged (2026-11-14). Mega 3.0.0, bridge 3.1.0 (OTA-capable) and gate 2.0.0 are the last cable images. Production last seen down (1033)."
type: state
last_verified: 2026-11-14
---

# Current state

Re-measured **2026-11-14** by hand (`fetch`, `rev-list`, `ls-remote`, `status`); re-run, never inherit.

**The code.** The ironclad pre-go-live pass (Dean: "fix any and all, full e2e testing") ran its
fix lanes in `~/src/.crusaders-wt/` worktrees, in two passes, both integrated on **`fix/ironclad`**
(worktree `…/integration`): ahead of `origin/main` = `a77a1d72`, 0 behind, **pushed to
`origin/fix/ironclad` and open as PR #15** (not merged; Auto-fix is switched on from the PR bar).
Later commit: V-1/V-2 fixed, re-walked in Chrome. Dispositions: `https://claude.ai/artifact/DcXVM42d3H3nhxoztN8BPA`.
The iCloud clone of this repo is still at `64ec7f43` (2026-10-22), untouched. Integrations:
[`decisions-ironclad-integration.md`](decisions-ironclad-integration.md) (pass 1, nine lanes) and
[`decisions-ironclad-integration-pass2.md`](decisions-ironclad-integration-pass2.md) (bridge-ota,
app-rest). The lanes' own decisions are in `decisions-bridge-ota`, `decisions-app-rest-pass2`,
`decisions-*-v3*`, `decisions-money-golive`, `decisions-platform-*`, `decisions-release-ops` and
`decisions-*-golive`.

**Firmware as integrated — the last cable images.** Mega **3.0.0** (the generic renderer and
relay guard), bridge **3.1.0** (signed OTA with a prev.bin rollback, key ring, runtime network,
setup portal, supervisor, LittleFS persistence; caps `codes:m1 hb:3 lcd:2 ota:1 key:1 net:1`),
door gate **2.0.0**. The bridge's heap is 56 B above its 24,576 B floor. **No flash is recorded
anywhere yet**; the ESP8266 Updater/eboot is proven only on the chip (checklist §5: a bench OTA
round trip per box before sealing). **Running here:** the `crusaders-int` stack (`:8098`, MailHog
`:8035`) runs `fix/ironclad` on its own volumes; the shared `crusaders` stack (`:8088`) is untouched.

**What only Dean can do, in this order** (`docs/go-live-checklist.md` has every step):
1. Generate the release key with `src/iot/tools/ota_sign.py keygen`, and keep the private half in
   the password manager. Its modulus is both `OTA_PUBLIC_KEY_N` and `DeviceOta__PublicKeyModulus`.
   Choose `SETUP_AP_PASSWORD` and label every enclosure with it.
2. Review and merge PR #15. Redeploy with the **new** `docker-compose.prod.yml`
   (sha-tagged images, `volume-init`, `backup`). Migrations run on start: PlatformTenantOnboarding,
   AddLedgerPurchaseId, AddLedgerReversesEntryId, DeviceContractV3.
3. **Manual step at that redeploy:** a club whose stored PayFast account has no passphrase, or a
   placeholder one, reads as not configured. Enter it under Settings › Money › PayFast account.
4. Bring production back. It answered Cloudflare **1033** (no tunnel connector) on 2026-11-13.
5. Flash the Mega with 3.0.0, then the bridge with 3.1.0 (never 3.0.0). Do the bench OTA round
   trip and the portal check on each box before sealing it.

**Open after the pass** (none blocks a redeploy; all of the bridge ones ship over the air now):
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
