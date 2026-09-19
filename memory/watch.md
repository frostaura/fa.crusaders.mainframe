---
name: crusaders-mainframe-watch
description: "Unpaid debts, worst first: .env holds live JWT, database, SMTP and device secrets unencrypted and unbacked-up; the redeploy is manual and nothing checks the stack before it; charge-at-booking is unsigned-off."
type: watch
last_verified: 2026-09-11
---

# Watch list

Ordered by risk. [`safety-relays.md`](safety-relays.md) outranks all of these; the doors have
their own list, [`watch-doors.md`](watch-doors.md). Each item is expanded, with the consequence
of skipping it, in `docs/go-live-checklist.md`. Item 2 was re-checked against `ci.yml` on
2026-09-19; the rest carry the dates written into them.

1. **`.env` holds several classes of live secret, not just the mailbox password.** Re-read
   2026-09-16, **variable names only** — never transcribe a value into a file, a report or a
   commit message. Alongside `SMTP_USER`/`SMTP_PASSWORD` (a real `@frostaura.net` mailbox, not a
   test fixture) it populates `JWT_SECRET` — the token-signing key this checkout actually boots
   on, via compose's `Jwt__Secret` — and `POSTGRES_PASSWORD`. `MASTER_SECRETS_ENCRYPTION_KEY` and
   `LIGHTS_CONTROLLER_DEFAULT_SECRET` are there too and **do not reach the API at all**: the
   compose `backend.environment` block is an allow-list of `Section__Key` names and neither flat
   name appears in it. Do not read the master key's presence as evidence that tenant secrets are
   encrypted — PayFast merchant credentials sit **in clear** in the `tenant_settings` JSON
   document (`Services/TenantSecretsAccessor.cs`), whose comment defers the master KEK to unbuilt
   Phase-7 work. The file is gitignored and **not tracked**, which closes the commit risk and
   nothing else: it is unencrypted on disk and backed up nowhere, so losing this Mac loses it all.
2. **The redeploy is manual, and nothing checks the stack before it.** `deploy-portainer` was
   removed 2026-09-19 on Dean's instruction; CI stops at the Docker Hub push, and `ci.yml` and
   `README.md` now say so. The publish half is not a debt ([`state.md`](state.md)). What the
   removal **cost** is the only check anyone had: that job **refused to deploy** a stack that did
   not name `<user>/crusaders-mainframe-gateway`, or that still bind-mounted `./nginx/nginx.conf`.
   A redeploy re-pulls the images the stack *names*, so a stack in either state keeps its **old
   gateway config** — every LAN member back in one rate-limit bucket — while looking deployed, and
   **nothing else in the system can see it**. Whoever redeploys checks both by hand, every time
   (`docs/go-live-checklist.md` §2). The four `PORTAINER_*` secrets are now read by nothing and
   should be deleted. Image jobs stay gated on `push` to `main`, so a green PR run still says
   nothing about the release half.
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
6. **The frontend deviation is still unwaivered.** Re-verified 2026-09-16: no `components.json`,
   no `@radix-ui/*`, no Redux Toolkit — every primitive is hand-rolled, against the parent
   mandate. **Owner: Dean** — a parent-controlled stack call held at division level, not this
   repo's to close; the measured cross-repo table is
   [`../../../memory/frontend-fracture.md`](../../../memory/frontend-fracture.md). Adopt or record
   a rationale; the primitives having tests is a mitigation and not a waiver.
7. **No architecture document exists for the backend.** The specs cover features and the iot
   READMEs the hardware; nothing describes the API's own shape but `Program.cs` and `Endpoints/`.
