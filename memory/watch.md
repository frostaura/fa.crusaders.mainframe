---
name: crusaders-mainframe-watch
description: "Unpaid debts, worst first: .env holds live JWT, database, SMTP and device secrets unencrypted and unbacked-up; the Portainer secrets are unset so the release chain has never run; charge-at-booking is unsigned-off."
type: watch
last_verified: 2026-09-11
---

# Watch list

Ordered by risk. The safety item that outranks all of these is
[`safety-relays.md`](safety-relays.md). Each go-live item is expanded, with the consequence of
skipping it, in `docs/go-live-checklist.md`.

1. **`.env` holds several classes of live secret, not just the mailbox password.** Re-read
   2026-09-16, **variable names only** — never transcribe a value into a file, a report or a commit
   message. Alongside `SMTP_USER`/`SMTP_PASSWORD` (a real `@frostaura.net` mailbox, not a test
   fixture) it populates `JWT_SECRET` — the token-signing key this checkout actually boots on, via
   compose's `Jwt__Secret` — and `POSTGRES_PASSWORD`. It also populates
   `MASTER_SECRETS_ENCRYPTION_KEY` and `LIGHTS_CONTROLLER_DEFAULT_SECRET`, which **do not reach the
   API at all today**: the compose `backend.environment` block is an allow-list of `Section__Key`
   names and neither flat name appears in it. Do not read the master key's presence as evidence that tenant
   secrets are encrypted — PayFast merchant credentials sit **in clear** in the `tenant_settings`
   JSON document (`Services/TenantSecretsAccessor.cs`), whose own comment defers the master KEK to
   unbuilt Phase-7 work. The file is gitignored and **not tracked** (`.gitignore:54`), which closes
   the commit risk and nothing else: it is unencrypted on disk and backed up nowhere, so losing this
   Mac loses all of it at once. A stale `PEACH_PAYMENTS_BASE_URL` also survives there, read by
   nothing since PayFast replaced PeachPayments.
2. **The Portainer secrets are unset, so the release chain has never executed.**
   `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` were set 2026-09-05; `PORTAINER_URL`,
   `PORTAINER_TOKEN`, `PORTAINER_ENDPOINT_ID` and `PORTAINER_STACK_ID` are not. The image-build and
   deploy jobs are gated on `push` to `main`, so **every pull-request run skips them and
   `workflow_dispatch` cannot trigger a deploy** — a green CI run on this branch says nothing about
   the release half. The chain stays unproven until the four secrets are set *and* one real push to
   `main` has completed. Cheapest unblock available on this project by a wide margin. The
   **main-branch gating is re-verified 2026-09-16** (seven jobs carry it in `ci.yml`); the *secrets
   inventory* is a `gh secret list` reading from 2026-09-11 that was not re-run — re-measure it
   before acting on it.
3. **Charge-at-booking has not been signed off by the committee.** The build debits at booking;
   blueprint A.9 says lights-on. Recorded as deviation **D-1** in
   `docs/specs/client-blueprint-deltas.md`. The blueprint is the customer's own word and outranks
   internal specs on economics, so **this is not the repo's decision to close** — see
   [`decisions.md`](decisions.md).
4. **PayFast has never processed a real transaction.** Production credentials are unissued and the
   signature path has only ever been exercised against the imposter in the test harness. The MD5
   parameter-string parity is the part most likely to break first against the live gateway.
5. **A power cut during an offline window now costs the club, silently.** Queued device events live
   in RAM and survive the WiFi going away, a router reboot and a two-day outage — but not a power
   cut, and the court that was lit is then never reported. What changed direction is *who pays*:
   under the current settlement model that booking is refunded **in full** and stamped
   `peripheral_outage`, so the club gives away a court whose lights ran and the ledger looks
   correct. It used to fall on the member, who would have complained. Nobody will complain about
   this one. Accepted knowingly — the port could hold an event, so it is unbuilt work rather than a
   hard limit, and a half-built ring that replays a stale activation charges a member twice.
6. **The frontend deviation is still unwaivered.** Re-verified 2026-09-16: no `components.json`, no
   `@radix-ui/*` dependency, no Redux Toolkit — every primitive is hand-rolled, against the parent
   mandate. **Owner: Dean** — a parent-controlled stack call held at division level, not this
   repo's to close; the measured cross-repo table is
   [`../../../memory/frontend-fracture.md`](../../../memory/frontend-fracture.md). Either adopt or
   record a rationale. The primitives now have tests, which
   is a mitigation and not a waiver; those tests found two accessibility defects a library would
   have shipped correct.
7. **No architecture document exists for the backend.** The hardware split is covered thoroughly by
   the iot README and the specs cover features, but nothing describes the API's own shape — so the
   only way to learn it is to read `Program.cs` and the endpoint folders.
