# Deployment Specification

Follows the FrostAura standard pattern as far as the registry (GitHub Actions → multi-arch images → Docker Hub), and stops there by decision: **CI publishes, it does not deploy.** Redeploying the club stack is a manual step in Portainer, pinned to an immutable `sha-<commit>` release — [`../runbooks/redeploy-and-rollback.md`](../runbooks/redeploy-and-rollback.md) — and the stack's own cloudflared fronts it. The project-specific consideration is that the deploy target is the **same on-premises machine the court boxes reach over the club LAN**, and that those boxes speak plain HTTP only — which is why the gateway is published on a LAN port and why nothing hands a box an `https` URL.

## Topology
```
Internet
  │
  ▼
Cloudflare (DNS crusaders.frostaura.net + tunnel ingress)
  │
  ▼  outbound tunnel, dialled from inside the stack
The club's server (Portainer stack, docker-compose.prod.yml)
  │
  ├── cloudflared   (cloudflare/cloudflared, pinned) → gateway:80 by service name
  ├── gateway       (nginx image, published on :8088 for the LAN)
  │     ├── /api/, /uploads/, /healthz, /readyz → backend:5000
  │     └── /                                    → frontend:80
  ├── frontend      (nginx + React build)
  ├── backend       (.NET 10, :5000; its entrypoint hands the media/biometric volumes to uid 1654
  │                  and drops to it; migrates on start)
  ├── postgres      (16-alpine)
  └── backup        (daily pg_dump + photos to a HOST directory, retention, restore)
  │
  └── Club LAN, DHCP: court boxes and door gates, plain HTTP to http://<server>:8088
```

`docker-compose.yml` is the developer's base stack, built from source (backend on the compose bridge, `expose: 5000`, gateway published on `${GATEWAY_PORT:-8088}`, all of it on a **pinned ipam subnet `172.29.83.0/24`**). `docker-compose.prod.yml` is the club's stack and pins **`10.83.29.0/24`** instead, outside docker's default pool so a busy host cannot allocate it to something else — see *Trusted proxies and the hop count* below for why both are fixed rather than left to docker.

`docker-compose.onprem.yml` is an optional overlay. It existed because a UDP discovery listener needed the LAN's broadcast domain, which a docker bridge does not carry; **there is no discovery any more**, so what it still buys is hardening rather than connectivity — Postgres and MailHog bound to the host loopback instead of published, and Kestrel bound to loopback plus the one address `backend:host-gateway` resolves to (`172.17.0.1` on a stock daemon; `BACKEND_BIND_ADDRESS` overrides it) rather than to every interface. **The boxes are unaffected either way:** `:8088` is the only port this topology gives them. The overlay also carries the production backup service (`extends`, not a copy), rotates every container's log, and leaves mail where `.env` points it — it used to force the flat `SMTP_HOST` to MailHog, which the API reads before `Smtp__Host`, so a club's real relay was silently replaced. It needs Docker Compose 2.24.4 or later (`!override`).

### The box on the LAN

The box and the backend sit on the same club LAN, and the box reaches the API at the gateway's LAN address and port: the `API_BASE_URL` compiled into `secrets.h` is the **first-boot default**, which device contract v3 lets the club change without a cable (*The boards' own configuration* below). **Give the server a DHCP reservation** (or a hostname the club router resolves): a server that comes back from a power cut on a different address is a fleet that cannot find it. The public surface exists so members can book from their phones and so the admin can run the club remotely; the SPA calls the API through that same Cloudflare tunnel, which means `/api/v1/device/*` is internet-reachable. That is precisely why the device API key exists rather than a bare LAN trust assumption. Nothing here assumes the box is ever off the LAN, and nothing assumes the API is LAN-only.

## Build & deploy pipeline
`.github/workflows/ci.yml` runs on every push to `main`, every pull request against it, and `workflow_dispatch`. It is this repository's own chain and the reference to keep in sync — it is not mirrored from any other repo.

Gates, all of which must be green before an image is built:

- `backend` — restore, build, `dotnet test`. **No coverage threshold here**: this job has no Postgres, so every database-backed test skips itself.
- `frontend` — `npm run lint`, `npm run build`, vitest.
- `e2e` — the built frontend in a real browser (Playwright), API intercepted.
- `backend-integration` — the Postgres-backed tier against a real `postgres:16-alpine` service, in five shards with a union proof; **the 70 % line-coverage gate is applied here**, to the merged report of every shard (a missing report fails rather than passes).
- `iot` — clang-format, strict pedantic compile, the purity gate (pure `lib/` must not include Arduino headers), the rollover gate, "generated corpus headers are current", host unit tests, the same under ASAN + UBSAN, and the complexity gate for C++, C# and TypeScript.
- `iot-build` — `court_mega`, `court_bridge`, the simulator and the door gate's `door_gate` all compile; the simulator starts and binds; and every generated Arduino sketch (both court-box sketches and the gate's) is compiled with `arduino-cli`, which is the only step that catches code the IDE's forced `gnu++11` rejects. It writes a **throwaway `secrets.h`** per project first: `court_bridge` and `door_gate` both `#error` without one, the real file is gitignored because it holds a WiFi password and the club's API key, and CI needs neither — the four values only have to exist for the preprocessor, and nobody flashes a runner build. It then rebuilds `court_bridge` and `door_gate` with GCC's stack reports and holds them to `src/iot/tools/stack_budget.json` — the `loop()` frame, the largest frame of ours, and on the ESP8266 the deepest call path from `loop()` — a ratchet that only shrinks, because the bridge's 4 KB `cont` stack had a few hundred bytes of margin and nothing watched it.
- `e2e-device` (`needs: backend, iot-build`) — the hardware-free end-to-end proof: the real API from source against a fresh Postgres, the firmware's native simulator as the Mega half over TCP, the PayFast mountebank imposter, with `test/e2e-device/scenario.py` playing the ESP8266 bridge, the member's phone, the admin and PayFast. Every review finding it pins is printed as `finding-id -> assertion`; any failed assertion fails the job. Locally: `make test-e2e-device`.
- `security` — `npm audit` (high) + `dotnet list package --vulnerable`.
- `infra` (*Release & operations*) — `actionlint` (pinned) over this workflow, and `make test-infra`: the compose files as `docker compose config` merges them (pinned images, log rotation, one release tag, the on-prem mail and port rules, non-root backend), the publish/promote rules of `ci.yml` (the promote script is executed against a stubbed registry and a real git history), the pending-migrations check, and the production backup service run for real — backup, a simulated total loss, restore, retention.

Then, **only on a push to `main`**: `build-backend-{amd64,arm64}`, `build-frontend-{amd64,arm64}` and `build-gateway-{amd64,arm64}` (each `needs:` every gate above), each pushing **only** `sha-<commit>-<arch>` and labelling the image `org.opencontainers.image.revision=<commit>` (plus `BUILD_SHA` in its environment); then **`publish-release`**, once all six have passed, joins the three `sha-<commit>` multi-arch manifests together; then **`promote-latest`** moves `:latest` for all three images or none, and only **forward** — it reads the revision `:latest` carries and promotes only to a descendant of it, inside one never-cancelled concurrency group. There is no deploy job. A green run on a branch or a PR builds nothing.

**Why the release is built this way.** Until 2026-11-13 each image wrote its own `:latest` the moment its own two builds passed and nothing named a release. One failed build left a new backend behind an old gateway under `:latest`; an older run finishing after a newer one put old code back; and what the club ran could not be named, so neither the owed migrations nor a rollback could be worked out. The workflow also carries a concurrency group that cancels a superseded **pull-request** run (main runs are keyed on their own run id and never queue).

**Three images, not two.** The gateway used to be stock `nginx:alpine` with `nginx/nginx.conf` bind-mounted from a checkout on the host. The deploy chain moves images and nothing else, so that config was a file the release could not deliver: a club merging a gateway fix got a new backend behind the *old* config, with every LAN member back in one rate-limit bucket, and the dashboard reporting a successful deploy. `nginx/Dockerfile` bakes the config in, so it ships by the same path as the code it belongs to.

**Check the stack by hand before every redeploy.** A redeploy re-pulls the images the stack *names*, so a stack that does not name `<user>/crusaders-mainframe-gateway`, or that still bind-mounts `./nginx/nginx.conf`, keeps its old gateway config while reporting a successful deploy. CI used to refuse a stack in either state; with the deploy job removed, nothing checks it — and nothing else can, because the tests exercise the API given forwarded headers and cannot tell a stale deployed gateway from a fresh one. The whole pre-redeploy routine — a backup, `make migrations-pending` against the club's database, the stored stack file read for placeholders — is [`../runbooks/redeploy-and-rollback.md`](../runbooks/redeploy-and-rollback.md).

## Required GitHub secrets
| Secret | Purpose |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub account |
| `DOCKERHUB_TOKEN` | Docker Hub access token |

**Two, not six.** The four `PORTAINER_*` secrets were read only by the deploy job, which is gone; a repository that still has them set should delete them. The same goes for `OTA_PRIVATE_KEY`, which held the PEM of a firmware signing key back when over-the-air updates existed; the boards have none now. A secret nothing reads is a credential nobody is watching.

## The boards' own configuration

Device contract v3 (`docs/specs/device-api.md`) has **no remote firmware update**: every firmware change, to any chip, is a cable flash at the board (`device-api.md` §7). So **nothing an operator does may need one**. What `secrets.h` carries is therefore only what a board needs to reach the server the first time; everything else is held by the server and delivered in the heartbeat.

| Compiled into `secrets.h` | What it is afterwards |
| --- | --- |
| `WIFI_SSID`, `WIFI_PASSWORD` | the first-boot network. Afterwards the club's device network (two WiFi profiles and the base URL, Devices → network) is sent to every board in the heartbeat and kept in its flash, with the previous set as the fallback; a board the server cannot reach is re-pointed through its **setup portal** (court box: hold courts A and D together for 5 s within 60 s of power-on; gate: the BOOT button). §8 |
| `API_BASE_URL` | the first-boot server, `http://<server's LAN address>:8088` — **`http`, never `https`**: the boards have no TLS. Changeable the same way. |
| `DEVICE_API_KEY` | the club's key when the board was flashed. Afterwards keys **rotate** with an overlap window (`device_key_grace_hours`) delivered over the heartbeat, and a known key can be **restored** after a database loss. *Regenerate*, which killed the old key on the next request, is gone. §6 |
| `SETUP_AP_PASSWORD` | the setup portal's WPA2 password, printed on a label inside the enclosure. |

**A firmware update is a USB flash, for every chip.** Nothing is offered in the heartbeat, nothing is downloaded and the server holds no image or signing key (`device-api.md` §7). The Mega is a generic renderer and relay guard the bridge steers, so most changes need only the bridge flashed. Getting a box onto a court is the flash order in `docs/go-live-checklist.md` §5 (**Mega 3.0.0 first, then bridge 3.0.0**; door gates 2.0.0). **It appears on the Devices page by itself** on its first heartbeat, named `box-<last six hex of its MAC>`, badged as unchecked until an admin confirms the court numbers. There is no discovery listener, no claim code and no per-device key.

**What 2026-08 removed, and v3 deliberately did not bring back:** a UDP discovery listener, claim codes, per-device keys derived from a master KEK, and an RSA image trailer signed by a key held in a repository secret (`OTA_PRIVATE_KEY`) by an `iot-sign` CI job. v3 briefly carried a signed OTA of its own, removed on 2026-11-14; there is no signing job, no signing secret and no signing key anywhere.

## Trusted proxies and the forwarded host

**nginx forwards `X-Forwarded-Host: $http_host`** — host *and port* exactly as the caller sent them — because `$host` strips the port, and the API composes absolute URLs (verification links, PayFast return URLs) from what it believes the request arrived on. The API honours `X-Forwarded-For` / `-Proto` / `-Host` **only from a proxy in `Gateway:TrustedProxies`**; anything else could forge its own client address and escape the rate limiter, or forge a `Host` and be handed a URL pointing somewhere else.

### The trust list and the hop count

`Gateway:TrustedProxies` defaults to `127.0.0.1`, `::1`, `172.29.83.0/24` — loopback plus **the ipam subnet `docker-compose.yml` pins for the compose bridge**, which is where the gateway stands in the developer's stack and under the on-prem overlay. `docker-compose.prod.yml` pins `10.83.29.0/24` instead and sets `Gateway__TrustedProxies` to match in the same file. It used to be `172.16.0.0/12`, the whole docker pool: a million addresses, and on a club whose LAN happens to sit in that range, every laptop was a trusted proxy able to forge its own client address. Changing the developer subnet means changing four places together — the compose file, `Gateway.TrustedProxies` in `appsettings.json`, `GatewayTrust.ComposeBridgeNetwork`, and the note in `.env.example`; changing production's means its two lines in `docker-compose.prod.yml`.

It is a **comma-delimited string**, not a JSON array, and that is load-bearing: .NET configuration merges arrays *by index*, so with the old three-entry array default, setting `Gateway__TrustedProxies__0` replaced entry 0 and went on trusting `::1` and the `/12` underneath — a deployment could add a proxy but never remove one. A scalar is replaced whole. Set `GATEWAY_TRUSTED_PROXIES` in `.env` (compose forwards it as `Gateway__TrustedProxies`); the indexed form still works because there are no array children in the file to merge with. The API logs a warning at startup for a range broader than `/16`, for an entry that is not an address or CIDR at all, and for a trusted network that contains this host's own address while Kestrel is bound to every interface.

**`Gateway:ForwardLimit` is 2**, one hop for the gateway and one for cloudflared. The production internet path is Cloudflare → the stack's own cloudflared → `gateway:80` over the pinned bridge, so a remote member's request reaches nginx already carrying `X-Forwarded-For: <visitor>` and `$proxy_add_x_forwarded_for` leaves it as `<visitor>, <cloudflared>`, both hops inside the trusted `/24`. At the default of 1 the API stopped at cloudflared's one bridge address, so **the entire remote membership shared a single ten-a-minute auth bucket** and any one outsider could lock every remote member out of login with ten POSTs a minute. Raising it is safe because the middleware re-checks trust at each hop: it consumes a second entry only when the address it resolved from the first is itself a trusted proxy, so a LAN client forging a header still gets its own address. A deployment with a third hop in front sets `Gateway__ForwardLimit`.

## Capacity — the database pool and the gateway's upstreams (R18)

**The API's connection pool sits under PostgreSQL's.** Npgsql's default `Maximum Pool Size` (100) equals the default `max_connections` of the stack's `postgres:16-alpine` (100), so the API alone could take every slot, and the server then refused migrations, an operator's `psql` and a second replica with `53300 too many clients`. The pool is bounded at startup (`Persistence/DatabasePool.Bound`): a `ConnectionStrings__DefaultConnection` that names its own `Maximum Pool Size` (any of Npgsql's spellings) keeps it — that is a deliberate deployment choice — else `Database:MaxPoolSize` (`Database__MaxPoolSize`), else **40**, so two replicas, a migration and an operator still fit. Raising it past the server's `max_connections` less those brings the refusals back. A request that gets no connection in the pool's wait is `503 service_busy` with `Retry-After: 2`, never 500 (`door-gate.md`, the error contract). Stream-side reads take at most a fifth of the pool (`StreamDbGate`, never fewer than two); an open stream itself holds none. *Trap:* Npgsql keys pools by the WHOLE connection string, so clearing "the pool for X" must clear the bounded string's pool too (`PostgresFixture.ClearPools`).

### The gateway's upstreams

`nginx/nginx.conf` proxies through **named upstreams with `keepalive`** — `backend_api` (64 idle connections, `keepalive_requests 10000`, `keepalive_timeout 60s`) and `frontend_spa` (16) — and every proxied location, `/healthz` included, sets `proxy_http_version 1.1` and `proxy_set_header Connection ""`. Without both, nginx sends `Connection: close`, every request parks a port in `TIME_WAIT` for 60 s, and one court box flooding `/device/events` exhausted the container's ~28k ports (errno 99) and took every member's request, sign-in included, to 502. With them the flood is answered `429` by the API's per-board limiter while members stay served. `keepalive_timeout 60s` sits under Kestrel's own idle keep-alive (130 s), so nginx always closes first. Server-Sent Events are unchanged (buffering off, same timeouts). Pinned by `GatewayKeepalivePostureTests`.

**No nginx `limit_req` on `/device/` — decided.** Behind cloudflared and the club's NAT every board shares one `$remote_addr`, and every board shares the club's one device key, so neither can key a per-board limit at the gateway; it would throttle the whole fleet together. The per-board limit is the API's (`door-gate.md`, the device rate limit).

## Health, logs and knowing what runs (IO-05, IO-07, IO-16)

- **`/healthz` is liveness** — the process answers; it touches nothing. **`/readyz` is readiness** — `SELECT 1` on the database within 2 s; `200 {status: "ready"}` or `503 {status: "not_ready", database: "unreachable"|"timeout"}`, never the detail. Both carry `version` and `revision` (the commit). The backend container's healthcheck in both compose files uses `/readyz`, so Portainer shows an outage as an unhealthy backend; an external uptime monitor (the launch bar's ≥99.5 %) should poll `https://<club host>/readyz` — that monitor is an ops step, not in this repository.
- **The revision is stamped at build**: `src/backend/Dockerfile` takes `ARG BUILD_SHA` into `SourceRevisionId`, and CI passes `github.sha` to both backend image builds. A build without it reports `"unknown"`. Images are tagged `sha-<commit>` (below), and `docs/runbooks/redeploy-and-rollback.md` covers deploy by sha and rollback.
- **Log levels.** The base `appsettings.json` keeps `Microsoft.EntityFrameworkCore` and `Microsoft.AspNetCore` (request lines included) at `Warning`; Production used to log every SQL command at Information, ~35 KB a minute with nobody using the stack. Raise one category for a diagnosis with `Logging__LogLevel__<category>=Information` on the backend service, and take it back out.
- **Log rotation.** Every service in both compose files logs through the `x-logging` anchor (`x-capped-log` in the development file): `json-file`, `max-size: 10m`, `max-file: 5` — 50 MB a service at most on the Pi's SD card, where a full disk stops Postgres writes. `docker compose logs` and Portainer read the same files.
- **No credential in a log.** The gateway's access log is the `crusaders_redacted` format (`nginx/nginx.conf`): `?ticket=` and the token segment of `/verify-email`, `/reset-password`, `/welcome`, `/magic-link`, `/j` and `/invites` are written as `REDACTED`, and no referrer is logged.

## A second club (BP-07)

`docker compose exec backend dotnet Crusaders.Mainframe.Api.dll tenant create --slug <slug> --name "<club>" --admin-email <address>` — see `multi-tenancy.md`. The club is then reached at the deployment's host with its slug as the first label (`https://<slug>.frostaura.net` for a deployment at `https://crusaders.frostaura.net`), so that host needs a DNS record and a public hostname on the tunnel; `tenant set-url` records a different address when the club uses one. `App__PublicBaseUrl` stays the deployment's (the default club's) address.

## Image names and tags
- `frostaura/crusaders-mainframe-backend`
- `frostaura/crusaders-mainframe-frontend`
- `frostaura/crusaders-mainframe-gateway`

Each carries `sha-<commit>` (immutable, multi-arch, the tag to deploy), `sha-<commit>-amd64` / `-arm64` (the per-arch halves), and `:latest` (the newest release that passed, moved forward only). `docker-compose.prod.yml` selects all three with one variable, `CRUSADERS_IMAGE_TAG` (default `latest`). What a running container is: `docker inspect <container> --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'`. Images published before 2026-11-13 carry no revision label and only the three `latest*` tags.

Third-party images are pinned too — `postgres:16-alpine`, `cloudflare/cloudflared:2026.10.7`, the `nginx:1.31.8-alpine` base of the frontend and gateway, `jcalonso/mailhog:v1.0.1` in development — so a redeploy changes only what this repository changed. Bump them deliberately.

## Compose files
`docker-compose.yml` (base) carries five services: `postgres` (16-alpine, `expose: 5432`), `mailhog`, `backend` (built from `src/backend/Dockerfile`, `expose: 5000`, env from the variables below), `frontend`, and `gateway` (built from `nginx/Dockerfile`, `${GATEWAY_PORT:-8088}:80`, with `nginx.conf` **baked in** as an envsubst template rather than bind-mounted — see *Three images, not two* above). Its network is a pinned `172.29.83.0/24`. Biometric peripheral passthrough on the backend service is commented out until a real driver is selected; the USB device path goes under `devices:` (or `privileged: true` as a last resort). **The API runs as uid 1654, not root**, so a passed-through device node also needs its group under `group_add:`; `volume-init` chowns the two data volumes to 1654 before the backend starts, which is what lets a volume a root backend created keep working.

`docker-compose.onprem.yml` (overlay, optional) moves the backend to `network_mode: host`, points Postgres and MailHog at loopback, binds Kestrel to two addresses rather than all of them, gives the gateway `extra_hosts: backend:host-gateway`, adds the backup service and log rotation, and sends mail to the relay `.env` names. The header of that file is the operational note for whoever applies it, including why it is now a choice rather than a requirement.

## Two compose files, and what configures each

`docker-compose.yml` builds from source and reads `.env` (`.env.example` is the template). It is for a developer's machine and `make up`.

`docker-compose.prod.yml` is **the Portainer stack, verbatim**. It pulls the three published images and carries every value inline — a Portainer stack has no `.env` behind it, and the founder's rule is that the file itself holds the minimum a running club needs. The lines marked `CHANGE-ME` are edited once when the stack is created and kept in the password manager: the **database password** (twice — `POSTGRES_PASSWORD`, which the backup service reads through a YAML anchor, and the backend's connection string), the **JWT secret**, the **member-code master key** (`MemberCodes__MasterKey`, `openssl rand -base64 48`; the API refuses a placeholder, and changing it after members enrol changes every member's code), the **bootstrap admin password**, the **mailbox password** and the **cloudflared tunnel token**. Besides those, `CRUSADERS_IMAGE_TAG` and optionally `CRUSADERS_BACKUP_DIR` are set in Portainer's environment-variables panel. It publishes one port, `8088`, which the court boxes and doors dial on the LAN; members arrive through the in-stack cloudflared.

**Every service rotates its log** (json-file, 5 × 10 MB) and the backend logs EF Core at `Warning`. Docker keeps a container's log forever by default, and at `Information` the backend wrote every SQL command — 35 KB a minute with nobody using the club — onto the Pi's SD card; a full disk stops Postgres writing, which stops bookings and the ledger.

**Names must be the ones the API reads.** .NET configuration maps `Section__Key` to `Section:Key` and nothing else: `Jwt__Secret`, `App__PublicBaseUrl`, `Cors__AllowedOrigins__0`, `Smtp__Host`, `Media__StoragePath`, `Biometric__TemplateStorePath`, `Gateway__TrustedProxies`, `Admins__Emails__0`. Until 2026-09-05 both compose files forwarded flat names — `JWT_SECRET`, `APP_FRONTEND_URL`, `CORS_ALLOWED_ORIGINS`, `MASTER_SECRETS_ENCRYPTION_KEY`, `MEDIA_STORAGE_PATH`, `BIOMETRIC_DRIVER` — that no line of the API reads, while insisting on values for them; the API booted on the `appsettings.json` placeholders, dev JWT secret included. The three exceptions that do accept flat names, because their readers say so, are `SMTP_*` (`SmtpEmailService`, which reads them **before** `Smtp:*` — so a compose file that sets a flat `SMTP_HOST` overrides whatever relay `Smtp__Host` names) and `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ORIGIN` (`Program.cs`). When adding a variable, find the `Configuration[...]` read first.

PayFast merchant credentials are **per-tenant settings** in the database (`tenant_settings.payfast`, sandbox/live chosen per tenant), not environment. Tenant branding and webhook secrets likewise live in the database.

## Inherent administrators — `Admins__Emails__n`

The deployment's own administrators, as opposed to the clubs'. An address on this list holds **club-admin rights in every club where that address already has a user account**, applied at sign-in rather than at boot — so an address added later, or a person who registers next month, is covered without a restart.

It is **deployment-owned, not club-owned**, which is why it is configuration rather than a `tenant_settings` key, and a declared exception to the rule that every configurable value is one: a club editing the list of people who can administer every club is the thing the list exists to be independent of. A club's own admins are appointed from Admin → Members and are untouched by this key.

What it grants is one bit — `User.IsAdmin` — and it is applied as the last step of a sign-in that has already passed every other check, so it **cannot** substitute for a password, skip email verification, or admit a member the club has suspended, rejected or not yet approved. It also never creates rows: somebody with accounts at two clubs is an admin at both, somebody with an account at neither is an admin at neither, and no membership is invented anywhere. `Services/InherentAdmins.cs` and `Services/InherentAdminService.cs` carry the full reasoning.

- **Shape.** Indexed, one address per entry: `Admins__Emails__0`, `Admins__Emails__1`, … Entries are trimmed, lower-cased and de-duplicated; blanks and malformed addresses are discarded and **named in a startup warning**, because an address that silently matches nobody looks exactly like the feature working. The accepted count is logged at Information and the accepted addresses are not — a container log is read by everyone who can see the stack.
- **Empty is valid.** An absent or empty list is an ordinary configuration in production: the clubs run on the admins they appointed themselves, and no code path behaves differently from before the key existed.
- **Removal does not revoke.** Taking an address off the list leaves an account that already holds the rights exactly as it is, and logs a warning naming it. Stripping the flag would make a typo, a rename or a dropped variable a lockout — if that account is a club's only admin there is no way back that does not involve editing the database. Rights are removed in Admin → Members, by a person.
- **Not a secret, but security-relevant.** Nothing here is a credential and there is nothing to leak, so it lives inline in the compose file like the rest of the stack. Editing it nevertheless changes who administers every club on the deployment, so it belongs with the lines an operator reviews rather than the ones they skim.
- **The `docker-compose.yml` entry carries the `appsettings.json` default explicitly** rather than `${ADMINS_EMAILS_0:-}`, for the same reason `Gateway__TrustedProxies` does: an empty environment variable does not mean "absent" to .NET configuration, it shadows the file value with `""` — and `""` is exactly what this list discards.

## Cloudflared tunnel
- Hostname: `crusaders.frostaura.net` (the stack's `App__PublicBaseUrl`, `Cors__AllowedOrigins__0` and `WEBAUTHN_*` name it).
- The tunnel is a **service of the production stack** (since 2026-09-19), run with `tunnel run --token <the tunnel token>`. Its ingress is configured in the Cloudflare dashboard and must target **`http://gateway:80`** — the service name on the stack's bridge, not `localhost:8088`, which is what the old host-systemd tunnel used and which, from inside the cloudflared container, is that container itself. A tunnel with no running connector answers Cloudflare error **1033**. The court boxes never use the tunnel — they reach the gateway on the LAN over plain HTTP — but the tunnel does put `/api/v1/device/*` on the internet, which is why those endpoints are key-authenticated rather than trusted for being on the LAN.

## Backups
- The production stack's `backup` service writes a verified `pg_dump` and a tarball of the photos **daily** to `CRUSADERS_BACKUP_DIR` on the host, prunes after `BACKUP_KEEP_DAYS` (14) but never below the newest `BACKUP_KEEP_MIN` (3), and turns unhealthy when the newest dump is over 26 h old. `crusaders-backup predeploy` takes one on demand; `crusaders-restore <dump> <database>` puts a club back.
- **Off the host is a host-level job** — an encrypted copy to a second machine or bucket from the host's crontab; the stack cannot hold that destination's credential.
- Keep in the password manager, off the host: the database password, `Jwt__Secret`, `MemberCodes__MasterKey`, the tunnel token, the **device API key** (a rebuilt database mints a different one; v3 can restore a known key), the backup encryption passphrase, and the firmware signing key.
- Procedure, the weekly check and the restore drill: [`../runbooks/backup-and-restore.md`](../runbooks/backup-and-restore.md). The drill was run on 2026-11-13 against a throwaway copy of the production stack; `make test-infra` replays its mechanical half on every CI run.

## Local development
The `Makefile` is the entry point; there is no `scripts/` directory.

- `make up` — `docker compose up --build -d`; app on `http://localhost:${GATEWAY_PORT:-8088}`, MailHog on `:8025`. The Development environment runs the biometric simulator (`Biometric:Driver` = `Null` in `appsettings.Development.json`), so no hardware is required; outside Development and Testing the simulator is never used (BP-09) and the API runs with no reader at all. `make down` / `make down-reset` (drops volumes).
- `make virt-up` / `make virt-down` — the PayFast mountebank imposter and the firmware's native simulator as plain processes.
- `make test-e2e-device` — the same device end-to-end proof CI runs, against whatever Postgres answers on `E2E_PG_HOST:E2E_PG_PORT` (default a throwaway container on `localhost:5439`).
- `make test`, `make test-iot`, `make test-iot-asan`, `make test-integration`, `make test-e2e`, `make corpus-check`, `make complexity`, `make test-infra` — the individual gates. `make test-infra` needs Python 3 with PyYAML and, for the backup tier, a Docker daemon (it skips that tier without one unless `INFRA_REQUIRE_DOCKER=1`).
- `make migrations-pending REF=<commit> PSQL="<command that runs psql against the target>"` — which migrations a redeploy of `<commit>` would apply to that database, data-changing ones flagged.

Seeding: in the `Development` environment the API runs `Seeder.SeedAsync` on startup; there is no separate seed target.
