# Deployment Specification

Follows the FrostAura standard pattern as far as the registry (GitHub Actions → multi-arch images → Docker Hub), and stops there by decision: **CI publishes, it does not deploy.** Redeploying the club stack from the published `:latest` manifests is a manual step, and Cloudflared fronts it as before. The project-specific consideration is that the deploy target is the **same on-premises machine the court boxes reach over the club LAN**, and that those boxes speak plain HTTP only — which is why the gateway is published on a LAN port and why nothing hands a box an `https` URL.

## Topology
```
Internet
  │
  ▼
Cloudflare (DNS + Cloudflared tunnel ingress)
  │
  ▼  cloudflared tunnel
Local Machine (on-premises at the club, or Dean's office for dev)
  │
  ├── Docker / Portainer
  │     ├── gateway   (nginx, published on :8088 — the only port members and boxes use)
  │     │     ├── /api/, /graphql, /uploads/, /healthz → backend:5000
  │     │     └── /                                    → frontend:80
  │     ├── crusaders-mainframe-frontend  (nginx + React build)
  │     ├── crusaders-mainframe-backend   (.NET 10 ASP.NET Core, :5000)
  │     ├── postgres:16-alpine
  │     └── mailhog (dev only)
  │
  └── Club LAN, DHCP everywhere: court boxes (ESP8266 + Mega), plain HTTP to :8088
```

`docker-compose.yml` is the base stack (backend on the compose bridge, `expose: 5000`, gateway published on `${GATEWAY_PORT:-8088}`, all of it on a **pinned ipam subnet `172.29.83.0/24`** — see *Trusted proxies and the hop count* below for why the subnet is fixed rather than left to docker's pool). It is sufficient at a club on its own.

`docker-compose.onprem.yml` is an optional overlay. It existed because a UDP discovery listener needed the LAN's broadcast domain, which a docker bridge does not carry; **there is no discovery any more**, so what it still buys is hardening rather than connectivity — Postgres and MailHog bound to the host loopback instead of published, and Kestrel bound to loopback plus the one address `backend:host-gateway` resolves to (`172.17.0.1` on a stock daemon; `BACKEND_BIND_ADDRESS` overrides it) rather than to every interface. **The boxes are unaffected either way:** `:8088` is the address in their `secrets.h` and the only one this topology gives them.

### The box on the LAN

The box and the backend sit on the same club LAN, and the box reaches the API by the `API_BASE_URL` compiled into its `secrets.h` — the gateway's LAN address and port. The public surface exists so members can book from their phones and so the admin can run the club remotely; the SPA calls the API through that same Cloudflare tunnel, which means `/api/v1/device/*` is internet-reachable. That is precisely why the device API key exists rather than a bare LAN trust assumption. Nothing here assumes the box is ever off the LAN, and nothing assumes the API is LAN-only.

## Build & deploy pipeline
`.github/workflows/ci.yml` runs on every push to `main`, every pull request against it, and `workflow_dispatch`. It is this repository's own chain and the reference to keep in sync — it is not mirrored from any other repo.

Gates, all of which must be green before an image is built:

- `backend` — restore, build, `dotnet test` with coverage, coverage threshold enforced (70 % line rate; a missing report fails rather than passes).
- `frontend` — `npm run lint`, `npm run build`, vitest.
- `e2e` — the built frontend in a real browser (Playwright), API intercepted.
- `backend-integration` — the Postgres-backed tier against a real `postgres:16-alpine` service.
- `iot` — clang-format, strict pedantic compile, the purity gate (pure `lib/` must not include Arduino headers), the rollover gate, "generated corpus headers are current", host unit tests, the same under ASAN + UBSAN, and the complexity gate for C++, C# and TypeScript.
- `iot-build` — `court_mega`, `court_bridge`, the simulator and the door gate's `door_gate` all compile; the simulator starts and binds; and every generated Arduino sketch (both court-box sketches and the gate's) is compiled with `arduino-cli`, which is the only step that catches code the IDE's forced `gnu++11` rejects. It writes a **throwaway `secrets.h`** per project first: `court_bridge` and `door_gate` both `#error` without one, the real file is gitignored because it holds a WiFi password and the club's API key, and CI needs neither — the four values only have to exist for the preprocessor, and nobody flashes a runner build.
- `e2e-device` (`needs: backend, iot-build`) — the hardware-free end-to-end proof: the real API from source against a fresh Postgres, the firmware's native simulator as the Mega half over TCP, the PayFast mountebank imposter, with `test/e2e-device/scenario.py` playing the ESP8266 bridge, the member's phone, the admin and PayFast. Every review finding it pins is printed as `finding-id -> assertion`; any failed assertion fails the job. Locally: `make test-e2e-device`.
- `security` — `npm audit` (high) + `dotnet list package --vulnerable`.

Then, **only on a push to `main`**: `build-backend-{amd64,arm64}`, `build-frontend-{amd64,arm64}` and `build-gateway-{amd64,arm64}` (each `needs:` every gate above), and the three `merge-*-manifests` jobs, which are the last jobs in the workflow. There is no deploy job. A green run on a branch or a PR builds nothing.

**Three images, not two.** The gateway used to be stock `nginx:alpine` with `nginx/nginx.conf` bind-mounted from a checkout on the host. The deploy chain moves images and nothing else, so that config was a file the release could not deliver: a club merging a gateway fix got a new backend behind the *old* config, with every LAN member back in one rate-limit bucket, and the dashboard reporting a successful deploy. `nginx/Dockerfile` bakes the config in, so it ships by the same path as the code it belongs to.

**Check the stack by hand before every redeploy.** A redeploy re-pulls the images the stack *names*, so a stack that does not name `<user>/crusaders-mainframe-gateway`, or that still bind-mounts `./nginx/nginx.conf`, keeps its old gateway config while reporting a successful deploy. CI used to refuse a stack in either state; with the deploy job removed, nothing checks it — and nothing else can, because the tests exercise the API given forwarded headers and cannot tell a stale deployed gateway from a fresh one.

## Required GitHub secrets
| Secret | Purpose |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub account |
| `DOCKERHUB_TOKEN` | Docker Hub access token |

**Two, not six.** The four `PORTAINER_*` secrets were read only by the deploy job, which is gone; a repository that still has them set should delete them. The same goes for `OTA_PRIVATE_KEY`, which held the PEM of a firmware signing key back when over-the-air updates existed. A secret nothing reads is a credential nobody is watching.

## The court box's own configuration

There is nothing to sign, package or serve. A box carries four values, compiled in from `src/iot/court-box/src/common/secrets.h` (copied from `secrets.h.example`, gitignored, all four mandatory — the build `#error`s without them):

| Value | What it is |
| --- | --- |
| `WIFI_SSID` | the club network |
| `WIFI_PASSWORD` | its password |
| `API_BASE_URL` | the gateway on the club LAN, e.g. `http://192.168.1.10:8088` — **`http`, never `https`**: the box has a plain `WiFiClient` and no heap for a TLS context |
| `DEVICE_API_KEY` | the club's device API key, copied from the Devices page |

Getting a box onto a court is: read the key off the Devices page, paste it into `secrets.h` beside the bridge sketch, open `src/iot/court-box/arduino/court_mega` and then `src/iot/court-box/arduino/court_bridge` in the Arduino IDE and press Upload for each (board settings and DIP positions in [`src/iot/court-box/README.md`](../../src/iot/court-box/README.md); `make flash-*` is the developer alternative), screw the box to the wall. **It appears on the Devices page by itself** on its first heartbeat, named `box-<last six hex of its MAC>`, driving the club's courts in ascending order up to the four the relay bank has, and badged as unchecked until an admin confirms the court numbers. There is no discovery listener, no claim code, no per-device key and no provisioning step.

Regenerating the key on the Devices page invalidates the old one on the very next request, so every box has to be reflashed. That is the trade this contract makes, and it is why the page says so.

What this replaced: a UDP discovery listener on 48653 that needed host networking to hear a broadcast, a claim code read off the box's LCD, a commitment hash, a provisioning grant, a one-shot per-device key derived from a master KEK, key rotation, reclaim and revoke, an RSA-2048 image trailer, a signing key in a repository secret, an `iot-sign` job, a `/firmware/` static route with its own rate limiter, and an `Ota:*` override with a startup fail-fast. One club with one box and a USB cable needed none of it, and each link could strand a board in a cupboard.

## Trusted proxies and the forwarded host

**nginx forwards `X-Forwarded-Host: $http_host`** — host *and port* exactly as the caller sent them — because `$host` strips the port, and the API composes absolute URLs (verification links, PayFast return URLs) from what it believes the request arrived on. The API honours `X-Forwarded-For` / `-Proto` / `-Host` **only from a proxy in `Gateway:TrustedProxies`**; anything else could forge its own client address and escape the rate limiter, or forge a `Host` and be handed a URL pointing somewhere else.

### The trust list and the hop count

`Gateway:TrustedProxies` defaults to `127.0.0.1`, `::1`, `172.29.83.0/24` — loopback plus **the ipam subnet `docker-compose.yml` pins for the compose bridge**, which is where the gateway container stands in both compose files. It used to be `172.16.0.0/12`, the whole docker pool: a million addresses, and on a club whose LAN happens to sit in that range, every laptop was a trusted proxy able to forge its own client address. Changing the subnet means changing four places together — the compose file, `Gateway.TrustedProxies` in `appsettings.json`, `GatewayTrust.ComposeBridgeNetwork`, and the note in `.env.example`.

It is a **comma-delimited string**, not a JSON array, and that is load-bearing: .NET configuration merges arrays *by index*, so with the old three-entry array default, setting `Gateway__TrustedProxies__0` replaced entry 0 and went on trusting `::1` and the `/12` underneath — a deployment could add a proxy but never remove one. A scalar is replaced whole. Set `GATEWAY_TRUSTED_PROXIES` in `.env` (compose forwards it as `Gateway__TrustedProxies`); the indexed form still works because there are no array children in the file to merge with. The API logs a warning at startup for a range broader than `/16`, for an entry that is not an address or CIDR at all, and for a trusted network that contains this host's own address while Kestrel is bound to every interface.

**`Gateway:ForwardLimit` is 2**, one hop for the gateway and one for cloudflared. The documented internet path is Cloudflare → cloudflared on the club's own host → the published gateway port, so a remote member's request reaches nginx already carrying `X-Forwarded-For: <visitor>` and `$proxy_add_x_forwarded_for` leaves it as `<visitor>, <cloudflared>`. At the default of 1 the API stopped at cloudflared's one bridge address, so **the entire remote membership shared a single ten-a-minute auth bucket** and any one outsider could lock every remote member out of login with ten POSTs a minute. Raising it is safe because the middleware re-checks trust at each hop: it consumes a second entry only when the address it resolved from the first is itself a trusted proxy, so a LAN client forging a header still gets its own address. A deployment with a third hop in front sets `Gateway__ForwardLimit`.

## Capacity — the database pool and the gateway's upstreams (R18)

**The API's connection pool sits under PostgreSQL's.** Npgsql's default `Maximum Pool Size` (100) equals the default `max_connections` of the stack's `postgres:16-alpine` (100), so the API alone could take every slot, and the server then refused migrations, an operator's `psql` and a second replica with `53300 too many clients`. The pool is bounded at startup (`Persistence/DatabasePool.Bound`): a `ConnectionStrings__DefaultConnection` that names its own `Maximum Pool Size` (any of Npgsql's spellings) keeps it — that is a deliberate deployment choice — else `Database:MaxPoolSize` (`Database__MaxPoolSize`), else **40**, so two replicas, a migration and an operator still fit. Raising it past the server's `max_connections` less those brings the refusals back. A request that gets no connection in the pool's wait is `503 service_busy` with `Retry-After: 2`, never 500 (`door-gate.md`, the error contract). Stream-side reads take at most a fifth of the pool (`StreamDbGate`, never fewer than two); an open stream itself holds none. *Trap:* Npgsql keys pools by the WHOLE connection string, so clearing "the pool for X" must clear the bounded string's pool too (`PostgresFixture.ClearPools`).

### The gateway's upstreams

`nginx/nginx.conf` proxies through **named upstreams with `keepalive`** — `backend_api` (64 idle connections, `keepalive_requests 10000`, `keepalive_timeout 60s`) and `frontend_spa` (16) — and every proxied location, `/healthz` included, sets `proxy_http_version 1.1` and `proxy_set_header Connection ""`. Without both, nginx sends `Connection: close`, every request parks a port in `TIME_WAIT` for 60 s, and one court box flooding `/device/events` exhausted the container's ~28k ports (errno 99) and took every member's request, sign-in included, to 502. With them the flood is answered `429` by the API's per-board limiter while members stay served. `keepalive_timeout 60s` sits under Kestrel's own idle keep-alive (130 s), so nginx always closes first. Server-Sent Events are unchanged (buffering off, same timeouts). Pinned by `GatewayKeepalivePostureTests`.

**No nginx `limit_req` on `/device/` — decided.** Behind cloudflared and the club's NAT every board shares one `$remote_addr`, and every board shares the club's one device key, so neither can key a per-board limit at the gateway; it would throttle the whole fleet together. The per-board limit is the API's (`door-gate.md`, the device rate limit).

## Image names
- `frostaura/crusaders-mainframe-backend:latest`
- `frostaura/crusaders-mainframe-frontend:latest`
- `frostaura/crusaders-mainframe-gateway:latest`

(Adjust the org name if the user's Docker Hub account namespace differs — confirm before first push.)

## Compose files
`docker-compose.yml` (base) carries five services: `postgres` (16-alpine, `expose: 5432`), `mailhog`, `backend` (built from `src/backend/Dockerfile`, `expose: 5000`, env from the variables below), `frontend`, and `gateway` (built from `nginx/Dockerfile`, `${GATEWAY_PORT:-8088}:80`, with `nginx.conf` **baked in** as an envsubst template rather than bind-mounted — see *Three images, not two* above). Its network is a pinned `172.29.83.0/24`. Biometric peripheral passthrough on the backend service is commented out until a real driver is selected; the USB device path goes under `devices:` (or `privileged: true` as a last resort).

`docker-compose.onprem.yml` (overlay, optional) moves the backend to `network_mode: host`, points Postgres and MailHog at loopback, binds Kestrel to two addresses rather than all of them, and gives the gateway `extra_hosts: backend:host-gateway`. The header of that file is the operational note for whoever applies it, including why it is now a choice rather than a requirement.

## Two compose files, and what configures each

`docker-compose.yml` builds from source and reads `.env` (`.env.example` is the template). It is for a developer's machine and `make up`.

`docker-compose.prod.yml` is **the Portainer stack, verbatim**. It pulls the three published images and carries every value inline — a Portainer stack has no `.env` behind it, and the founder's rule is that the file itself holds the minimum a running club needs. The lines marked `CHANGE-ME` (database password, JWT secret, public hostname, mailbox password) are edited once when the stack is created; nothing else is configuration. It publishes one port, `8088`, which cloudflared dials for members and the court box dials on the LAN.

**Names must be the ones the API reads.** .NET configuration maps `Section__Key` to `Section:Key` and nothing else: `Jwt__Secret`, `App__PublicBaseUrl`, `Cors__AllowedOrigins__0`, `Smtp__Host`, `Media__StoragePath`, `Biometric__TemplateStorePath`, `Gateway__TrustedProxies`, `Admins__Emails__0`. Until 2026-09-05 both compose files forwarded flat names — `JWT_SECRET`, `APP_FRONTEND_URL`, `CORS_ALLOWED_ORIGINS`, `MASTER_SECRETS_ENCRYPTION_KEY`, `MEDIA_STORAGE_PATH`, `BIOMETRIC_DRIVER` — that no line of the API reads, while insisting on values for them; the API booted on the `appsettings.json` placeholders, dev JWT secret included. The three exceptions that do accept flat names, because their readers say so, are `SMTP_*` (`SmtpEmailService`) and `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` / `WEBAUTHN_ORIGIN` (`Program.cs`). When adding a variable, find the `Configuration[...]` read first.

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
- Hostname: TBD per tenant or per-platform (e.g. `*.mainframe.crusadersapp.co.za` wildcard CNAME → tunnel).
- The tunnel runs as a systemd service on the same host, with a single ingress route to the gateway's published port. Its config is host-side and is not in this repository. The court boxes never use the tunnel — they reach the gateway on the LAN over plain HTTP — but the tunnel does put `/api/v1/device/*` on the internet, which is why those endpoints are key-authenticated rather than trusted for being on the LAN.

## Backups
- Postgres: `pg_dump` nightly via a cron container, encrypted, uploaded to a tenant-agnostic offsite bucket (Backblaze B2 or equivalent).
- Tenant-secret unwrapping requires the `MASTER_SECRETS_ENCRYPTION_KEY` — store the key in a password manager outside the host so a host loss doesn't lose the key.
- Restore drill: documented and run quarterly.

## Local development
The `Makefile` is the entry point; there is no `scripts/` directory.

- `make up` — `docker compose up --build -d`; app on `http://localhost:${GATEWAY_PORT:-8088}`, MailHog on `:8025`. `BIOMETRIC_DRIVER=Null` by default, so no hardware is required. `make down` / `make down-reset` (drops volumes).
- `make virt-up` / `make virt-down` — the PayFast mountebank imposter and the firmware's native simulator as plain processes.
- `make test-e2e-device` — the same device end-to-end proof CI runs, against whatever Postgres answers on `E2E_PG_HOST:E2E_PG_PORT` (default a throwaway container on `localhost:5439`).
- `make test`, `make test-iot`, `make test-iot-asan`, `make test-integration`, `make test-e2e`, `make corpus-check`, `make complexity` — the individual gates.

Seeding: in the `Development` environment the API runs `Seeder.SeedAsync` on startup; there is no separate seed target.
