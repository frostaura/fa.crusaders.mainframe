---
name: crusaders-mainframe-watch
description: "Unpaid debts, worst first: .env holds live JWT, database and SMTP secrets unencrypted and unbacked-up; the redeploy is a manual runbook nothing enforces; charge-at-booking is unsigned-off."
type: watch
last_verified: 2026-09-29
---

# Watch list

Ordered by risk. [`safety-relays.md`](safety-relays.md) outranks all of these; the doors have
their own list, [`watch-doors.md`](watch-doors.md). Each item is expanded, with the consequence
of skipping it, in `docs/go-live-checklist.md`. Items 1 and 2 were re-checked on 2026-11-13
(key names; `ci.yml` and the compose files) and item 6 on 2026-09-29; the rest carry their dates.

1. **`.env` holds several classes of live secret, not just the mailbox password.** Re-read
   2026-11-13, **variable names only**. It populates `JWT_SECRET`, `POSTGRES_PASSWORD` and a real
   mailbox in both spellings (`SMTP_*` and `Smtp__*`; the flat names win). The retired
   `BOOTSTRAP_SLICE_PRICE_CREDITS` is still in it (read by nothing; Dean deletes it). The
   2026-09-16 entries `MASTER_SECRETS_ENCRYPTION_KEY` and `LIGHTS_CONTROLLER_DEFAULT_SECRET` are
   gone. PayFast merchant credentials sit **in clear** in `tenant_settings`
   (`Services/TenantSecretsAccessor.cs`). Gitignored and untracked; unencrypted and backed up
   nowhere, so losing this Mac loses it. Production's secrets are in the Portainer stack file
   only — the password-manager list is `docs/go-live-checklist.md` §2b.
2. **The redeploy is manual.** Since 2026-11-13 it has a runbook
   (`docs/runbooks/redeploy-and-rollback.md`): backup, `make migrations-pending` against the club's
   database, the stored stack file read for `CHANGE-ME`, the gateway image and no `nginx.conf`
   bind, deploy by `sha-<commit>`. Those checks are still made **by a person** — nothing refuses a
   bad stack — and the backup's offsite copy is a host cron nobody has installed yet. The repository
   is public and `main` unprotected; both are Dean's settings
   ([`decisions-release-ops.md`](decisions-release-ops.md)).
3. **Charge-at-booking has not been signed off by the committee.** The build debits at booking;
   blueprint A.9 says lights-on. Deviation **D-1** in `docs/specs/client-blueprint-deltas.md`.
   The blueprint is the customer's own word and outranks internal specs on economics, so
   **this is not the repo's decision to close** — [`decisions.md`](decisions.md).
4. **PayFast has never processed a real transaction.** Production credentials are unissued and the
   signature path has only ever run against the imposter in the harness; the MD5 parameter-string
   parity is what will break first against the live gateway.
5. **A power cut during an offline window now costs the club, silently.** Queued device events
   live in RAM and survive the WiFi going away, a router reboot and a two-day outage — but not a
   power cut, and the court that was lit is then never reported. What changed direction is *who
   pays*: under the current settlement model that booking is refunded **in full** and stamped
   `peripheral_outage`, so the club gives away a court whose lights ran and the ledger looks
   correct. It used to fall on the member, who would have complained; nobody will complain about
   this. Accepted knowingly — a half-built ring that replays a stale activation charges twice.
6. **Half of the frontend deviation is closed; Redux Toolkit is the half left.** Verified
   2026-09-29 after P10: `components.json` exists, primitives are shadcn/ui (new-york) on the
   unified `radix-ui` package in `components/ui/`, icons are Phosphor through one barrel, and the
   P1 compat shims and `lucide-react` are deleted — the shadcn/Radix half of the mandate is met.
   State is still React context, **no Redux Toolkit**, unwaivered — **Owner: Dean** (a parent
   stack call held at division level); adopt or record a rationale. The division's table ([`../../../memory/frontend-fracture.md`](../../../memory/frontend-fracture.md))
   still shows this repo with no Radix and is owed a re-measure.
7. **No architecture document exists for the backend.** The specs cover features and the iot
   READMEs the hardware; nothing describes the API's own shape but `Program.cs` and `Endpoints/`.
