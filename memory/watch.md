---
name: crusaders-mainframe-watch
description: "Unpaid debts, worst first: .env holds live SMTP credentials unencrypted and unbacked-up; the Portainer secrets are unset so the release chain has never run; charge-at-booking is unsigned-off; a power cut now costs the CLUB silently."
type: watch
last_verified: 2026-09-11
---

# Watch list

Ordered by risk. The safety item that outranks all of these is
[`safety-relays.md`](safety-relays.md). Each go-live item is expanded, with the consequence of
skipping it, in `docs/go-live-checklist.md`.

1. **`.env` holds live SMTP credentials for a real FrostAura mailbox.** Verified 2026-09-11: it is
   gitignored and **not tracked**, which closes the commit risk and nothing else. It is still
   **unencrypted on disk and backed up nowhere** — losing this Mac loses the credential, and
   anything that reads the working tree reads the password. Never commit it; the sending account is
   a live third-party mailbox, not a test fixture.
2. **The Portainer secrets are unset, so the release chain has never executed.**
   `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` were set 2026-09-05; `PORTAINER_URL`,
   `PORTAINER_TOKEN`, `PORTAINER_ENDPOINT_ID` and `PORTAINER_STACK_ID` are not. The image-build and
   deploy jobs are gated on `push` to `main`, so **every pull-request run skips them and
   `workflow_dispatch` cannot trigger a deploy** — a green CI run on this branch says nothing about
   the release half. The chain stays unproven until the four secrets are set *and* one real push to
   `main` has completed. Cheapest unblock available on this project by a wide margin.
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
6. **The frontend deviation is still unwaivered.** Verified 2026-09-11: no `components.json`, no
   `@radix-ui/*` dependency, no Redux Toolkit — every primitive is hand-rolled, against the parent
   mandate. Either adopt or record a rationale with an owner. The primitives now have tests, which
   is a mitigation and not a waiver; those tests found two accessibility defects a library would
   have shipped correct.
7. **No architecture document exists for the backend.** The hardware split is covered thoroughly by
   the iot README and the specs cover features, but nothing describes the API's own shape — so the
   only way to learn it is to read `Program.cs` and the endpoint folders.
