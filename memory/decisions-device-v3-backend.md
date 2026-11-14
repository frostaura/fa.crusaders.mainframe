---
name: crusaders-mainframe-decisions-device-v3-backend
description: "How the backend implements device contract v3 (2026-11-13): snapshot pairing, money on box-made releases, key restore owner, PSK encryption, lifeline alternation, and what was deferred."
type: decision
last_verified: 2026-11-13
---

# Decisions — the backend half of device contract v3 (2026-11-13)

The contract and its why are `decisions-device-v3*.md` and `decisions-member-code-cutover.md`.
This topic is what the backend lane chose where the spec left room, each with its reason. Code:
`Endpoints/Device{Telemetry,Lifeline,SnapshotRestore}.cs`, `Services/Device{Settings,KeyRing,
Network*,Provision,BoardOverrides}.cs`; migration `DeviceContractV3` (edited in place when OTA left).

- **A release removes a booking from the snapshot only if it PAIRED** (receipt names the booking,
  outcome not `unpaired`/`implausible`) and its cause is `member` or absent. *Why:* an unpaired
  release names a booking only as a guess, and v2's "any release" darkened Mega-reset courts.
- **A `mega_reset` or `reconcile` release settles no money.** *Why:* the court is re-lit from the
  snapshot, so settling would refund minutes for time still played and the member's real
  release would settle the same booking twice.
- **`relight` is recorded only where the snapshot lists the same reference.** *Why:* a stale flash
  copy can name a booking the server has since dropped; the club must not be told it is restored.
- **A 2.x box's partial restore records only the relays its `relay_state` says are closed** (all
  only when the count matches) and files the shortfall (BD-6). The v2 one-shot is otherwise kept.
- **"In play" starts at `StartsAt − activation_cue_window_minutes` on both paths** (MCV1-05).
- **The lifeline-only body alternates by cadence parity of the server clock**, no stored state.
  *Why:* deterministic and testable; with today's fields it never fires.
- **"Owner" for *Restore a key* is a deployment inherent admin (`Admins:Emails`).** *Why:* the
  product has no owner role, and the person holding the secret backup is the deployment's owner.
  `Bootstrap:DeviceApiKey` applies only when the club has no key. *Why:* never overwrite live.
- **WiFi passwords: AES-GCM under a key HKDF'd from the member-code master key, tenant id as AAD.**
  *Why:* production already must hold that one secret; a second key is a second thing to lose.
  Caveat: changing the master key (itself a re-enrolment of every phone) also means re-saving
  the club network.
- *Superseded 2026-11-14:* firmware images in Postgres and the corpus OTA key's Development-only
  guard left with OTA (`decisions-device-v3.md`); `firmware_releases` and the device `Fw*`
  columns are gone from `DeviceContractV3`, and a test pins that no board is ever answered `ota`.
- **FC-8: the walk-up cap lowers stored button maps on save** (club and per-board) **and on
  emit**; `/extend` is bounded by the same cap (BD-12). *Why:* save makes the console truthful;
  emit covers maps written before this change.
- **A repeat activation is "lit here" when the light state is On for that booking with no device
  or this device.** *Why:* the online grant records its light with `DeviceId` null.
- **MCV1-10 wire:** a door's online replay refusal is its `unknown_scan` with `cause: "replayed"`
  (the v3 event field). *Why:* reuses the one additive field every v3 event already carries.
- **The kiosk spends a v1 code's court use** like a court box. *Why:* one acting use per class.
- **Gate v3 settings go only to a gate naming `key:1` or `net:1`** (`ota:1` unlocks nothing); a 1.x gate is
  byte-identical (§1), so the fault settings reach 1.x doors only after their flash.
- **Deferred, per spec §14:** a remote "switch this court off" (FA-9, BA-27). The remote levers a
  stuck or wrong box has today: *Back to compact*, per-board hw overrides, push network, key
  restore, disable (and the cut-over hold). A firmware fix is a cable flash.
- **Found, not fixed here:** the 2.x box settings (`lcd_*_seconds`, `scan_memory_seconds`,
  `clock_trust_minutes`, `device_fault_max_per_hour`) bind snake_case only on the settings PUT;
  a camelCase spelling is silently ignored (pre-existing). `v3-heartbeat-response-widest` writes
  `device_fault_max_per_hour` 1000, which the server can never send (bounds 1–120).
