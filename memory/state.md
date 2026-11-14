---
name: crusaders-mainframe-state
description: "PR #15 (ironclad, cable-flash only) merged to main 2026-11-14; PR #16 (no hotspot, bridge scan flows, Mega taps) open. Mega 3.0.0, bridge 3.1.0, gate 2.0.0, flashed by cable with four secrets. Production last seen down (1033)."
type: state
last_verified: 2026-11-14
---

# Current state

Re-measured **2026-11-14** by hand (`ls-remote`, `gh pr view/checks`, `gh run list`); re-run, never inherit.

**The code.** The ironclad pre-go-live pass (Dean: "fix any and all, full e2e testing") and the
founder's OTA removal were integrated on `fix/ironclad` and **merged to `main` as PR #15 at
`4e4ee0db`** (Dean: "merge when green"). Dispositions: `https://claude.ai/artifact/DcXVM42d3H3nhxoztN8BPA`.
Integrations: [`decisions-ironclad-integration.md`](decisions-ironclad-integration.md),
[`decisions-ironclad-integration-pass2.md`](decisions-ironclad-integration-pass2.md); OTA's why in
[`decisions-device-v3.md`](decisions-device-v3.md). The `main` CI run that publishes images was
**in progress** at writing. The iCloud clone is still at `64ec7f43` (2026-10-22), untouched.

**Open: PR #16** (`fix/firmware-final` → `main`, head `79a2fe54`, not merged): no setup hotspot
([`decisions-device-v3.md`](decisions-device-v3.md)), the bridge scan flows
([`decisions-bridge-scan-flows.md`](decisions-bridge-scan-flows.md)), the Mega taps
([`decisions-court-box-v3-firmware.md`](decisions-court-box-v3-firmware.md)), the entrypoint deploy
fix ([`decisions-release-ops.md`](decisions-release-ops.md)).
**Gates.** PR #15: CI green before merge (21 checks pass); GitGuardian red only on the published
test vectors, which `.gitguardian.yaml` now ignores. Local gates on `firmware-final`, as reported
by the integrating lane (not re-run here): `test-iot` 177/418/178, `build-iot`, arduino-export no
diff, corpus-check, complexity, Linux gcc strict clean, 20k soak pass.

**Firmware on `fix/firmware-final`.** Mega **3.0.0**, bridge **3.1.0** (caps `codes:m1 hb:3 lcd:2
key:1 net:1`), gate **2.0.0** (`codes:m1 key:1 net:1`). **No OTA, no hotspot:** every change is
a cable flash taking exactly `WIFI_SSID`, `WIFI_PASSWORD`, `API_BASE_URL`, `DEVICE_API_KEY`; the
server's `net` and key rotation remain. Measured here at `79a2fe54` (`pio run`): bridge static RAM
54,256 B, heap **27,664 B, 3,088 B over** the 24,576 B floor; Mega 3,977 B. **No flash is recorded.**

**What only Dean can do, in this order** (`docs/go-live-checklist.md` has every step):
1. Redeploy on the Pi with the **existing** Portainer stack file (it works unchanged). Migrations
   run on start: PlatformTenantOnboarding, AddLedgerPurchaseId, AddLedgerReversesEntryId,
   DeviceContractV3. Delete any `OTA_PRIVATE_KEY` repository secret — nothing reads it.
2. **Manual step at that redeploy:** a stored PayFast passphrase that is blank or a placeholder
   reads as not configured. Enter it under Settings › Money › PayFast account.
3. Bring production back. It answered Cloudflare **1033** (no tunnel connector) on 2026-11-13.
4. After PR #16 merges: flash the Mega with 3.0.0, then the bridge with 3.1.0 (never 3.0.0), with
   the four secrets; the doors with gate 2.0.0. On the first box bench-check relay polarity, the LCD
   address and size, and FWM-11, and **watch its scan flows**: main.cpp's new wiring has host-test
   coverage only.

**Open** (none blocks a redeploy; bridge items each cost a cable flash of every box):
- `test_compat`'s executor (move main.cpp's adoption into bridgelogic first); the dead PayFor source;
  dead `net_src: "local"` handling in the console and backend (no board sends it now).
- FM-8 needs gateway SSI; BM-9: switch the readers first; FC-8's 1.x corner is the contract
  owner's; BA-17, BA-21 need a design decision. Offsite backup cron, branch protection, visibility: Dean's.
- **Founder decision open** (play.md §14 Q4, [`questions.md`](questions.md)): partners who walk in
  behind a scanning PLAYER still count as attended.
- Toasts never tried with a real screen reader ([`decisions-frontend-shell-r19.md`](decisions-frontend-shell-r19.md)).
- **Blueprint** `docs/system-blueprint.html`: fixed 2026-11-14, **not republished** (keep URL `https://claude.ai/code/artifact/45da513d-3977-4c49-9bed-9ac44c81ccb4`).

**Still outside code:** the relay safety question ([`safety-relays.md`](safety-relays.md)), Carl's
two lock facts ([`watch-doors.md`](watch-doors.md)), committee sign-off on charge-at-booking, and
supervised bench sessions with the real box and door.
