---
name: technologies-crusaders-squash-control-system-state
description: "Code tip 7893321d (PR #16, 2026-11-14, CI green); later main commits are memory-only. v3 images are a cable flash, none flashed. Production 530/1033 (tunnel down) 2026-11-20. Redeploy, flash, relays: Dean's."
type: state
last_verified: 2026-11-20
---

# Current state

Re-measured **2026-11-20** by command (`git log`/`rev-parse`, `gh pr list/view`, `gh run list`, `gh repo view`, `curl`);
clones, `origin/main` and production re-checked after a `git fetch` that evening. Re-run before relying on any of it.

**The code.** Product tip **`7893321d`** — later `main` commits touch only `CLAUDE.md`, `MEMORY.md` and `memory/`
(`git diff --name-only 7893321d origin/main`). It is "Merge pull request #16 from frostaura/fix/firmware-final"
(2026-11-14 11:02 +0200); its `main` CI run **succeeded** (the image jobs publish `sha-7893321d` manifests and promote
`:latest`; nothing redeploys). PR #15 (`fix/ironclad`, Dean: "fix any and all, full e2e testing" / "merge when green")
merged first at `4e4ee0db`; that commit's own `main` run failed and PR #16's run is the green one. Dispositions:
`https://claude.ai/artifact/DcXVM42d3H3nhxoztN8BPA`. **No PR is open.** PR #4 ("Pay what you can + split what's left")
is CLOSED unmerged, but its commit `877c1cf4` reached `main`
([`decisions-players-acts.md`](decisions-players-acts.md)). Larger passes have landed as PRs merged when green since
PR #12, not straight onto `main` ([`questions.md`](questions.md)).

**Firmware at the tip:** the versions and the Mega-first order are in [`decisions-court-box.md`](decisions-court-box.md).
Caps: bridge `codes:m1 hb:3 lcd:2 key:1 net:1`, gate `codes:m1 key:1 net:1`. **No OTA, no hotspot:** every change is a
cable flash taking exactly `WIFI_SSID`, `WIFI_PASSWORD`, `API_BASE_URL`, `DEVICE_API_KEY`; the server's `net` and key
rotation remain ([`decisions-device-v3.md`](decisions-device-v3.md)).
Measured at `79a2fe54` (`pio run`; no firmware changed between it and the tip): bridge static RAM 54,256 B, heap
**27,664 B, 3,088 B over** the 24,576 B floor; Mega 3,977 B. Lane-reported gates (not re-run): `test-iot` 177/418/178,
build, export, corpus, complexity, Linux gcc strict, 20k soak. **No flash of any image is recorded anywhere.**

**Production.** `crusaders.frostaura.net` answered **HTTP 530** from Cloudflare to `HEAD` and `GET` on `/`,
`/api/health`, `/health` and `/healthz` at 2026-11-20 22:56 SAST, body `error code: 1033` — no tunnel connector, as on
2026-11-13 (on 2026-10-14 the SPA served while every `/api` and `/healthz` 502'd). What the Pi runs is unknown from outside ([`gotchas-ops.md`](gotchas-ops.md)).

**What only Dean can do, in this order** (`docs/go-live-checklist.md` has every step):
1. **Bring production back** and read why it stopped (the tunnel connector first, then the backend's log — a missing
   `MemberCodes__MasterKey` refuses start).
2. **Redeploy** on the Pi with the **existing** Portainer stack file (it works unchanged; the image hands itself its
   volumes), pinning `CRUSADERS_IMAGE_TAG=sha-7893321d`, by `docs/runbooks/redeploy-and-rollback.md`: backup first,
   `make migrations-pending` against the club's database (at least PlatformTenantOnboarding, AddLedgerPurchaseId,
   AddLedgerReversesEntryId and DeviceContractV3 are new since the last known deploy), set `MemberCodes__MasterKey`
   ([`decisions-member-code-rollout.md`](decisions-member-code-rollout.md)). Delete any `OTA_PRIVATE_KEY` repository
   secret — nothing reads it.
3. **Manual step at that redeploy:** a stored PayFast passphrase that is blank or a placeholder now reads as not
   configured — enter it under Settings › Money & packages › PayFast account ([`decisions-payfast.md`](decisions-payfast.md)).
4. **Flash** each Mega, then its bridge, then the doors, with the four secrets, at the versions and in the order of
   [`decisions-court-box.md`](decisions-court-box.md) (who flashes: [`questions.md`](questions.md)). On the first box
   bench-check relay polarity, the LCD address and size, the bootloader across a watchdog reset (FWM-11), and **watch
   its scan flows**: `main.cpp`'s new wiring has host-test coverage only.

**Open** (none blocks a redeploy; bridge items each cost a cable flash of every box): `test_compat`'s court-box executor
(move `main.cpp`'s adoption into bridgelogic first); the dead PayFor source; dead `net_src: "local"` handling in console
and backend; FM-8 (gateway SSI), BM-9, BA-21, and FC-8's 1.x corner and BA-17, both recorded as decided and as open
([`decisions-admin-console.md`](decisions-admin-console.md)); toasts never tried with a real screen reader; the
walk-behind attendance ruling ([`questions.md`](questions.md)). Dean's settings: the offsite backup cron (not installed),
the repo's visibility (**PUBLIC**), branch protection on `main` (**none**) ([`decisions-release-ops.md`](decisions-release-ops.md)).

**Founder-facing pages** `docs/system-blueprint.html` and `docs/court-lights-flows.html` last changed 2026-11-14 (`c95bb782`,
`407fb05f`); the blueprint was **not republished** — keep `https://claude.ai/code/artifact/45da513d-3977-4c49-9bed-9ac44c81ccb4`.

**Renamed 2026-11-20 (founder):** `fa.crusaders.mainframe` → `technologies.crusaders.squash-control-system` (the repo;
GitHub redirects the old URL; the directory was `crusaders.mainframe`), product *Crusaders Mainframe* → **Crusaders Squash
Control System**; old product strings: [`watch-rename.md`](watch-rename.md). **Clones — two, on `main`, level with `origin/main`:**
`~/src/technologies.crusaders.squash-control-system` (no other worktree; late 2026-11-20 it held uncommitted product edits, a rename in flight that is not this store's) and the iCloud copy (ignored `.env`, four `secrets.h`, build output; [`watch-secrets.md`](watch-secrets.md)).

**Still outside code:** the relay safety question ([`safety-relays.md`](safety-relays.md)), Carl's two lock facts
([`watch-doors.md`](watch-doors.md)), committee sign-off on charge-at-booking, supervised bench sessions with box and door.
