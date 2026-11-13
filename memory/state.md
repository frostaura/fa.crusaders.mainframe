---
name: crusaders-mainframe-state
description: "Ironclad pass integrated on fix/ironclad over a77a1d72, not pushed (2026-11-14). Mega 3.0.0 and gate 2.0.0 are final; bridge 3.0.0 is not OTA-capable yet. Production last seen down (1033)."
type: state
last_verified: 2026-11-14
---

# Current state

Re-measured **2026-11-14** by hand (`git fetch`, `rev-list --left-right --count`, `ls-remote`,
`status --porcelain`). Git claims decay fastest — re-run them, never inherit them.

**The code.** The ironclad pre-go-live pass (Dean: "fix any and all, full e2e testing") ran nine
fix lanes in worktrees under `~/src/.crusaders-wt/` and was integrated on branch
**`fix/ironclad`** (worktree `~/src/.crusaders-wt/integration`): ahead of `origin/main` =
`a77a1d72` by the nine lanes plus the integration, 0 behind, **not pushed** — pushing is Dean's
call. Re-count with `git rev-list --left-right --count origin/main...fix/ironclad`. What the
integration found and decided: [`decisions-ironclad-integration.md`](decisions-ironclad-integration.md).
The lanes' own decisions are in the `decisions-*-v3*`, `decisions-money-golive`,
`decisions-platform-*`, `decisions-release-ops` and `decisions-*-golive` topics.

**Firmware as integrated.** Mega **3.0.0** (complete, its last flash), bridge **3.0.0 phase A**
(snapshot reconcile, v3 serial, layouts — but **no signed OTA, key rotation, runtime network,
setup portal or flash persistence**: caps `codes:m1 hb:3 lcd:2`), door gate **2.0.0** (signed OTA,
key ring, runtime network, portal, NVS persistence). **No flash is recorded anywhere yet.**

**What only Dean can do, in this order** (`docs/go-live-checklist.md` has every step):
1. Decide whether the court boxes wait for **bridge phase B** before their last flash (the
   checklist's §2c/§5 say do not seal an enclosure until the bridge reports `ota:1 key:1 net:1`).
2. Generate the release key with `src/iot/tools/ota_sign.py keygen`; keep the private half in the
   password manager; its modulus is `OTA_PUBLIC_KEY_N` and `DeviceOta__PublicKeyModulus`.
3. Review and push `fix/ironclad`, then redeploy with the **new** `docker-compose.prod.yml`
   (sha-tagged images, `volume-init`, `backup`). Migrations run on start:
   PlatformTenantOnboarding, AddLedgerPurchaseId, AddLedgerReversesEntryId, DeviceContractV3.
4. **Manual step at that redeploy:** a club whose stored PayFast account has no passphrase or a
   placeholder reads as not configured — enter it under Settings › Money › PayFast account.
5. Bring production back: it answered Cloudflare **1033** (no tunnel connector) on 2026-11-13.

**Open after the pass** (none blocks a redeploy):
- The device e2e harness lags the firmware: `scenario.py`'s landing/E-LCD steps assert the Mega
  2.1.0 screen, and `door_evening.py`'s DSIM offline legs scan a legacy booking code that a
  codes:m1 door's v1 roster (MCV1-04) no longer carries. Every other step passes.
- The court-box soak at 20,000 sequences finds 6 "owed court dark 5 s after a Mega reset"
  (seed 50511693); 1,000 sequences are clean. In the bridge, so a phase-B fix.
- Bridge phase B (above), and the box halves of FC-11 (a fraction in a config value reports no
  drift), MCV1-07 (the bridge's key ring is 24, the server sends up to 64) and `test_compat`.
- BM-9 (one key case per reply) needs the frontend reads switched first.
- Offsite backup cron, branch protection and repo visibility (Dean's, per the release-ops topic).
- **Founder decision open** (play.md §14 Q4, [`questions.md`](questions.md)): partners who walk in
  behind a scanning PLAYER still count as attended.
- Toast announcements were never tried with a real screen reader
  ([`decisions-frontend-shell-r19.md`](decisions-frontend-shell-r19.md)).

**The blueprint** `docs/system-blueprint.html` was corrected in place on 2026-11-14 (relay drive,
versions) but **not republished**; its stable URL is
`https://claude.ai/code/artifact/45da513d-3977-4c49-9bed-9ac44c81ccb4` — keep it on every republish.

**Still outside code:** the relay safety question ([`safety-relays.md`](safety-relays.md)), Carl's
two lock facts ([`watch-doors.md`](watch-doors.md)), committee sign-off on charge-at-booking, and
supervised bench sessions with the real box and door.
