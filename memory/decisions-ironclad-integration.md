---
name: crusaders-mainframe-decisions-ironclad-integration
description: "Ironclad pass integration (2026-11-14, fix/ironclad): nine lanes merged, a linear migration chain, the cross-lane wire mismatches found and pinned, a bridge stack overflow fixed; bridge phase B was owed to pass 2."
type: decision
last_verified: 2026-11-14
---

# The ironclad integration (`fix/ironclad`, pass 1)

Nine lane branches merged in order (contract, backend-device, money, platform, court-box,
door-gate, infra, member, admin). Conflicts were small (compose logging anchors, ci.yml image
jobs, two spec files, one C# list). **Migrations:** four new ones in timestamp order
(PlatformTenantOnboarding, AddLedgerPurchaseId, AddLedgerReversesEntryId, DeviceContractV3);
a probe migration came out empty, so the merged snapshot is the model. A fresh database and a
database seeded at `a77a1d72`'s last migration (with devices and a member-owned webhook) both
migrate to schemas identical by `pg_dump --schema-only`.

**Lanes that built against a spec rather than each other disagreed, every time.** Found and
fixed, each with a test that reads the other side's source or real replies:
- console vs API on v3 devices: `restore` vs `restore_report`, `device_id` vs
  `rollout_device_id`, release board counts, the rollout's per-board `keys` (never served)
  and `blocks` (unread), and the retire/restore dialogs typing a key id / `RESTORE` where the
  API compares `retire the old key` / `restore this key` — `deviceV3Wire.contract.test.ts`.
  **Why a source-reading test:** stubbed vitest suites were green on all five.
- the door's replay refusal: `reason` (gate) vs `cause` (server). One wire, `cause`, pinned by
  `gate/` vector `gate-events-request-replayed` on both sides.
- `net_fallback` filed `unknown`; the emitter's `key_next`/`net` objects vs the gate's
  `*_id` vocabulary; court-box `test_server_replies` never written. `make device-replay-check`
  now runs end to end and is a CI job every image build waits for.
- platform's register/verify contract vs the member screens; money's PayFast admin route with
  no console (Settings › Money now has the panel — without it payments are off after redeploy).

**Bridge loop() overflowed its 4 KB stack** (4,144 B deepest path) through two 960-byte
screen encode buffers the court-box lane added; sized from the frames now (3,136 B). The gate's
whole-image temporaries moved off the stack (RSA's too, until OTA left on 2026-11-14). **Why it
matters:** this would have crashed on the wall on the first chained screen, and no host test can
see a stack.

**29 functions over the lizard gate**, all from the v3 firmware lanes, split behaviour for
behaviour. Codec's argument grammar stays a switch: a table would land in the Mega's RAM.

**Decided:** a suspended club's boards hear `403 club_suspended`, which the firmware reads as
out of service (door commits an empty roster). That is what suspending a club means, and it
is declared the one other 403 source in `DeviceForbiddenMeansOutOfServiceTests`.

**Owed after pass 1, delivered in pass 2:** bridge phase B (bridge 3.1.0, `key:1 net:1`;
[`decisions-bridge-3-1.md`](decisions-bridge-3-1.md)) and the box halves of FC-11 and MCV1-07
(64-key ring). Merged and gated in
[`decisions-ironclad-integration-pass2.md`](decisions-ironclad-integration-pass2.md);
`test_compat` is still owed.

**Pass 1's gates on its integrated tree:** backend 4,501/4,501 on Postgres; vitest 6,638 + 2 expected
fail; Playwright 2,376 passed (1 large-text flake, green on rerun); firmware native and ASAN
188/386/183; corpus-check, arduino-check, complexity, stack budgets, device-replay-check and
infra 71/71 green. Device e2e: everything but the two harness gaps in the state topic.

