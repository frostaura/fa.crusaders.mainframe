---
name: technologies-crusaders-squash-control-system-watch
description: "Unpaid debts, worst first: live secrets in two unbacked .env files; no pullable image and CI disabled, so a redeploy waits on CI and a repointed stack; the runbook still describes deleted images; charge-at-booking unsigned."
type: watch
last_verified: 2026-11-20
---

# Watch list

Ordered by risk. [`safety-relays.md`](safety-relays.md) outranks all of these; the doors have their own list,
[`watch-doors.md`](watch-doors.md). Each item is expanded, with the consequence of skipping it, in
`docs/go-live-checklist.md`. Items 1, 2, 7 and 8 were re-checked late on 2026-11-20 (item 1 in its own topic; `ci.yml`, the
compose files, `gh workflow list`, Docker Hub); item 6 on 2026-09-29; the rest carry their dates.

1. **Live secrets sit unencrypted and unbacked-up on this Mac** — two gitignored `.env` files (dev clone and iCloud
   clone), four firmware `secrets.h`, PayFast credentials in clear in `tenant_settings`. Inventory by key name only,
   and what to delete: [`watch-secrets.md`](watch-secrets.md).
2. **The redeploy is manual.** Since 2026-11-13 it has a runbook (`docs/runbooks/redeploy-and-rollback.md`): backup,
   `make migrations-pending` against the club's database, the stored stack file read for `CHANGE-ME`, the gateway image
   and no `nginx.conf` bind, deploy by `sha-<commit>`. Those checks are made **by a person** — nothing refuses a bad
   stack; a stack that still binds `./nginx/nginx.conf` or names no gateway image keeps its OLD gateway config (every LAN
   member back in one rate-limit bucket) while looking deployed. The backup's offsite copy is a host cron nobody has
   installed. `ci.yml` stops at publish by decision (`deploy-portainer` removed 2026-09-19 on Dean's instruction; its four
   `PORTAINER_*` repo secrets recorded as removed with it, not re-checked against GitHub). Image jobs run only on `push` to
   `main`, so a green PR run says nothing about the release half. **CI is `disabled_manually` since 2026-11-20** (the
   founder's pause), so nothing builds or publishes, and **no image of the product exists on Docker Hub** — the
   hand-off is at the top of [`state.md`](state.md). Every job runs on unpinned `ubuntu-latest`, which broke the public
   site's Playwright install on 2026-11-20; expect the same here on re-enable. `main` has **no branch protection**,
   Dean's setting ([`decisions-release-ops.md`](decisions-release-ops.md)).
3. **Charge-at-booking has not been signed off by the committee.** The build debits at booking; blueprint A.9 says
   lights-on. Deviation **D-1** in `docs/specs/client-blueprint-deltas.md`. The blueprint is the customer's own word and
   outranks internal specs on economics, so **this is not the repo's decision to close** — [`decisions.md`](decisions.md).
4. **PayFast has never processed a real transaction.** Production credentials are unissued and the signature path has
   only run against the imposter in the harness; the MD5 parameter-string parity is what will break first against the
   live gateway. A stored blank passphrase now reads as "not configured" ([`decisions-payfast.md`](decisions-payfast.md)).
5. **A power cut during an offline window costs the club, silently.** Queued device events survive the WiFi going
   away, a router reboot and a two-day outage — and since the v3 images they are persisted per sealed entry to flash
   and re-uploaded under their own boot id, so a cut no longer loses them by design; **none of that has run on a
   chip** (LittleFS wear and the RTC epoch are provable only there, [`decisions-bridge.md`](decisions-bridge.md)). Where
   the court that was lit is still never reported, the settlement refunds that booking **in full** and stamps
   `peripheral_outage`: the club gives away a court whose lights ran and the ledger looks correct. It used to fall on the
   member, who would have complained; nobody will complain about this. Accepted knowingly — a half-built ring that
   replays a stale activation charges twice.
6. **Half of the frontend deviation is closed; Redux Toolkit is the half left.** The shadcn/ui half, as CLAUDE.md
   describes it, was verified 2026-09-29 after P10 (`components.json`, `lucide-react` deleted). State is still React
   context, **no Redux Toolkit**, unwaivered — **Owner: Dean** (a parent stack call held at division level); adopt or record a rationale.
7. **No architecture document exists for the backend.** The specs cover features and the iot READMEs the hardware;
   nothing describes the API's own shape but `Program.cs` and `Endpoints/` (no `docs/architecture/` at `7893321d`).
8. **Product files owe corrections** (a memory pass may not edit docs or code; owed by the next product change).
   - **Deleted images described as live.** `docs/runbooks/redeploy-and-rollback.md` §3, `docs/specs/deployment.md`
     and `docs/go-live-checklist.md` say a stack naming `crusaders-mainframe-*` "keeps redeploying the last pre-rename
     release" and that a rollback names the old images. Since those repositories were deleted such a stack cannot
     pull, and no pre-rename image exists. Rename residue besides: `.env.example`'s `SMTP_FROM=mainframe@frostaura.net`,
     and the unrepublished hosted blueprint ([`state.md`](state.md)); deliberate keeps are in
     [`decisions-release-ops.md`](decisions-release-ops.md).
   - **Renamed topics and superseded comments.** `docs/specs/multi-tenancy.md:79` cites `decisions-platform-pass.md`
     (now [`decisions-tenancy.md`](decisions-tenancy.md)) and is stale: a suspended club's boards already hear
     `403 club_suspended`. `docs/specs/device-api.md:144` and `Services/RelayRestorePlan.cs:71` cite
     `decisions-court-box-extend` (now [`decisions-court-box.md`](decisions-court-box.md)). `WalkUpServices.Clock`
     (`DeviceEventEndpoints.cs:2219-2221`) says `BookingService` reads the wall clock, not its injected `TimeProvider`;
     `ReverseNoShowAsync`'s doc says a booking-naming adjustment skips the money legs, which `SettledLegsAsync` nets.
   Delete each bullet when everything in it is fixed.
