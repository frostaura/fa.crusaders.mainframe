---
name: crusaders-mainframe-watch
description: "Unpaid debts, worst first: three gitignored .env files hold live JWT, database, SMTP, admin-bootstrap and Portainer secrets, unencrypted and unbacked-up; the redeploy is a manual runbook nothing enforces; charge-at-booking is unsigned-off."
type: watch
last_verified: 2026-11-20
---

# Watch list

Ordered by risk. [`safety-relays.md`](safety-relays.md) outranks all of these; the doors have their own list,
[`watch-doors.md`](watch-doors.md). Each item is expanded, with the consequence of skipping it, in
`docs/go-live-checklist.md`. Items 1, 2, 7 and 8 were re-checked on 2026-11-20 (key names only; `ci.yml`, the compose files,
`gh repo view`); item 6 on 2026-09-29; the rest carry their dates.

1. **Three gitignored `.env` files hold several classes of live secret** — read by **variable names only**, never
   transcribe a value. The `~/src/fa.crusaders.mainframe` clone's populates `JWT_SECRET`, `POSTGRES_PASSWORD`,
   `BOOTSTRAP_ADMIN_PASSWORD` and a real mailbox in both spellings (`SMTP_*` and `Smtp__*`; the flat names win), plus the
   retired `BOOTSTRAP_SLICE_PRICE_CREDITS` (read by nothing; Dean deletes it). `~/src/.crusaders-merge-main/.env` has its
   own JWT, SMTP and bootstrap-admin values. The iCloud copy's still holds `MASTER_SECRETS_ENCRYPTION_KEY`,
   `LIGHTS_CONTROLLER_DEFAULT_SECRET`, `ConnectionStrings__DefaultConnection` (the database password again), the dead
   `PEACH_PAYMENTS_BASE_URL` and all four `PORTAINER_*` values — **`PORTAINER_TOKEN` a live stack-control credential that
   nothing reads any more; delete those four.** All are untracked, which closes the commit risk and nothing else: they are
   unencrypted, the `~/src` copies live on this disk alone and the iCloud copy is only *synced* (a deletion is mirrored, so
   it is not a backup). PayFast merchant credentials sit **in clear** in `tenant_settings`
   (`Services/TenantSecretsAccessor.cs`, whose comment defers a master KEK to unbuilt work). Production's secrets are in
   the Portainer stack file only — the password-manager list is the last item of `docs/go-live-checklist.md` §2b.
2. **The redeploy is manual.** Since 2026-11-13 it has a runbook (`docs/runbooks/redeploy-and-rollback.md`): backup,
   `make migrations-pending` against the club's database, the stored stack file read for `CHANGE-ME`, the gateway image
   and no `nginx.conf` bind, deploy by `sha-<commit>`. Those checks are made **by a person** — nothing refuses a bad
   stack; a stack that still binds `./nginx/nginx.conf` or names no gateway image keeps its OLD gateway config (every LAN
   member back in one rate-limit bucket) while looking deployed. The backup's offsite copy is a host cron nobody has
   installed. `ci.yml` stops at publish by decision (`deploy-portainer` removed 2026-09-19 on Dean's instruction; its four
   `PORTAINER_*` repo secrets recorded as removed with it, not re-checked against GitHub). Image jobs run only on `push` to
   `main`, so a green PR run says nothing about the release half. The repository is **public** and `main` has **no
   branch protection** — both Dean's settings ([`decisions-release-ops.md`](decisions-release-ops.md)).
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
8. **Product files cite renamed topics or say superseded things** (a memory pass may not edit docs or code; owed by
   the next product change). `docs/specs/multi-tenancy.md:79` cites `decisions-platform-pass.md` (now
   [`decisions-tenancy.md`](decisions-tenancy.md)) and is stale: a suspended club's boards already hear
   `403 club_suspended` (`DeviceAuthenticationHandler.cs:80-92`). `docs/specs/device-api.md:144` and
   `Services/RelayRestorePlan.cs:71` cite `decisions-court-box-extend` (now [`decisions-court-box.md`](decisions-court-box.md)).
   Comments: `WalkUpServices.Clock` (`DeviceEventEndpoints.cs:2219-2221`) says `BookingService` reads the wall clock,
   not the injected `TimeProvider` it reads (`BookingService.cs:71,399`); `ReverseNoShowAsync`'s doc
   (`BookingService.cs:1817-1821`) says a booking-naming adjustment skips the money legs, which `SettledLegsAsync`
   nets (`decisions-settlement.md`). Delete when all five are fixed.
