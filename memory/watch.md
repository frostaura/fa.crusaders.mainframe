---
name: crusaders-mainframe-watch
description: "Unpaid debts, worst first: .env holds live JWT, database, SMTP and device secrets unencrypted and unbacked-up; the redeploy is now manual and nothing checks the stack before it; charge-at-booking is unsigned-off."
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
2. **The redeploy is manual now, and nothing checks the stack before it.** `deploy-portainer` was
   **removed 2026-09-19 on Dean's instruction** — CI stops at the Docker Hub push, by decision. The
   publish half is no longer a debt: run `35434498116` on 2026-09-19 pushed all three multi-arch
   manifests green ([`state.md`](state.md)). What the removal *cost* is the only check anyone had.
   The job **refused to deploy** a stack that did not name `<user>/crusaders-mainframe-gateway`, or
   that still bind-mounted `./nginx/nginx.conf`. A redeploy re-pulls the images the stack *names*, so
   a stack in either state keeps its **old gateway config** — every LAN member back in one
   rate-limit bucket — while reporting a successful deploy. **Nothing else in the system can see
   this**: the tests exercise the API given forwarded headers and cannot tell a stale deployed
   gateway from a fresh one. Whoever redeploys checks both by hand, every time
   (`docs/go-live-checklist.md` §2). Housekeeping: the four `PORTAINER_*` secrets are read by nothing
   now and should be deleted from the repository. Image-build jobs remain gated on `push` to `main`,
   so a green PR run still says nothing about the release half.
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
