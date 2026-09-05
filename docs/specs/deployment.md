# Deployment Specification

Follows the FrostAura standard pattern (GitHub Actions → multi-arch images → Docker Hub → Portainer → Cloudflared). The project-specific considerations are that the deploy target is the **same on-premises machine the court boxes reach over the club LAN**, and that those boxes speak plain HTTP only — which shapes the gateway, the discovery listener and every URL the API hands a box.

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
  │     │     ├── /api/, /graphql, /firmware/, /uploads/, /healthz → backend:5000
  │     │     └── /                                               → frontend:80
  │     ├── crusaders-mainframe-frontend  (nginx + React build)
  │     ├── crusaders-mainframe-backend   (.NET 10 ASP.NET Core, :5000)
  │     │     └── on-prem: network_mode host, so the UDP discovery listener on
  │     │         48653 hears the boxes' broadcasts (docker-compose.onprem.yml)
  │     ├── postgres:16-alpine
  │     └── mailhog (dev only)
  │
  └── Club LAN, DHCP everywhere: court boxes (ESP8266 + Mega), plain HTTP to :8088
```

`docker-compose.yml` is the base stack (backend on the compose bridge, `expose: 5000`, gateway published on `${GATEWAY_PORT:-8088}`, all of it on a **pinned ipam subnet `172.29.83.0/24`** — see *the gateway and the forwarded host* below for why the subnet is fixed rather than left to docker's pool). `docker-compose.onprem.yml` is the overlay applied at the club: the backend moves to host networking so the discovery listener is on the LAN's broadcast domain, and nginx reaches it through `extra_hosts: backend:host-gateway`.

Host networking used to put the API on `:5000` on **every** host interface, the club LAN included. The overlay now binds Kestrel explicitly — loopback plus the one address `backend:host-gateway` resolves to (`172.17.0.1` on a stock daemon; `BACKEND_BIND_ADDRESS` overrides it) — so the LAN reaches the API only through the gateway on `:8088`. **The boxes are unaffected:** `:8088` is the port the discovery OFFER advertises and the only one this topology gives them. Direct `:5000` from the LAN was a side effect of host networking, never a path the system hands out, and combined with the old `172.16.0.0/12` trusted-proxy default it was a way for any laptop on a `172.16.x.x` LAN to forge `X-Forwarded-For` past every rate limit.

## Build & deploy pipeline
`.github/workflows/ci.yml` runs on every push to `main`, every pull request against it, and `workflow_dispatch`. It is this repository's own chain and the reference to keep in sync — it is not mirrored from any other repo.

Gates, all of which must be green before an image is built:

- `backend` — restore, build, `dotnet test` with coverage, coverage threshold enforced (70 % line rate; a missing report fails rather than passes).
- `frontend` — `npm run lint`, `npm run build`, vitest.
- `e2e` — the built frontend in a real browser (Playwright), API intercepted.
- `backend-integration` — the Postgres-backed tier against a real `postgres:16-alpine` service.
- `iot` — clang-format, strict pedantic compile, the purity gate (pure `lib/` must not include Arduino headers), the rollover gate, an OTA signer roundtrip, "generated corpus headers are current", host unit tests, the same under ASAN + UBSAN, and the complexity gate for C++, C# and TypeScript.
- `iot-build` — `court_mega`, `court_bridge` and the simulator all compile; the simulator starts and binds.
- `iot-sign` (`needs: iot-build`) — signs and packages the court-box image (below).
- `e2e-device` (`needs: backend, iot-build`) — the hardware-free end-to-end proof: the real API from source against a fresh Postgres, the firmware's native simulator as the Mega half over TCP, the PayFast mountebank imposter, with `test/e2e-device/scenario.py` playing the ESP8266 bridge, the member's phone, the admin and PayFast. Every review finding it pins is printed as `finding-id -> assertion`; any failed assertion fails the job. Locally: `make test-e2e-device`.
- `security` — `npm audit` (high) + `dotnet list package --vulnerable`.

Then, **only on a push to `main`**: `build-backend-{amd64,arm64}`, `build-frontend-{amd64,arm64}` and `build-gateway-{amd64,arm64}` (each `needs:` every gate above; the backend pair also `needs: iot-sign`, for the firmware artifact it bakes), the three `merge-*-manifests` jobs, and `deploy-portainer`, which waits 30 s for Docker Hub propagation and calls Portainer's stack endpoint with `pullImage: true`. A green run on a branch or a PR builds nothing.

**Three images, not two.** The gateway used to be stock `nginx:alpine` with `nginx/nginx.conf` bind-mounted from a checkout on the host. The deploy chain moves images and nothing else, so that config was a file the release could not deliver: a club merging a gateway fix got a new backend behind the *old* config — `/firmware/` falling through to the SPA so every box loops UPDATING / UPDATE FAILED, `api_base_url` and OTA URLs on `:80` where nothing listens, and every LAN member back in one rate-limit bucket — with the dashboard reporting a successful deploy. `nginx/Dockerfile` bakes the config in, so it ships by the same path as the code it belongs to.

`deploy-portainer` **refuses to deploy** a Portainer stack that does not name `<user>/crusaders-mainframe-gateway`, or that still bind-mounts `./nginx/nginx.conf`. The deploy re-PUTs the stack Portainer already holds and re-pulls the images that stack *names*, so neither mistake is visible any other way: the tests exercise the API given forwarded headers and cannot tell a stale deployed gateway from a fresh one.

## Required GitHub secrets
| Secret | Purpose |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub account |
| `DOCKERHUB_TOKEN` | Docker Hub access token |
| `PORTAINER_URL` | e.g. `https://portainer.crusaders.local/` |
| `PORTAINER_TOKEN` | Portainer API key |
| `PORTAINER_ENDPOINT_ID` | Numeric endpoint ID in Portainer |
| `PORTAINER_STACK_ID` | Numeric stack ID for crusaders.mainframe |
| `OTA_PRIVATE_KEY` | The **PEM content** (not a path) of the RSA-2048 firmware signing key minted by `src/iot/tools/generate_ota_keys.sh` (go-live checklist item 6). Optional for CI to go green; required for any build a court box will accept over the air. |

The first six are consumed by the build/deploy jobs. The seventh is consumed only by `iot-sign`; that job writes the content to a file under `$RUNNER_TEMP` (mode 0600, wiped with the job) because the signing hook takes a path. The private key exists in exactly two places — the secret and the operator's secure store — and is never committed (`*.pem` is gitignored).

## Firmware signing and packaging (`iot-sign`)
OTA for the court box is asymmetric: the ESP8266 image carries a trailer signed with the private key and the board verifies it against the public key compiled into the firmware (`src/iot/tools/sign_firmware.py` documents the trailer). The CI job that produces the installable image:

1. `iot-sign` (`needs: iot-build`) restores the same PlatformIO boards cache, materializes `OTA_PRIVATE_KEY` to a temp file, and runs `pio run -d src/iot -e court_bridge` with `$OTA_PRIVATE_KEY` pointing at it. The post-build hook (`src/iot/tools/pio_sign_post.py`) then writes `firmware.signed.bin` beside `firmware.bin`.
2. The version is read from the three `-DFW_VERSION_{MAJOR,MINOR,PATCH}` flags in `src/iot/platformio.ini` `[common]` — the same values the firmware reports on heartbeat. A missing flag fails the job.
3. **The signed image is verified against the committed public key before it is packaged.** `sign_firmware.py --verify <signed.bin> <OtaPublicKey.h>` runs the board's own check — the PEM is extracted from `src/iot/lib/otacore/include/otacore/OtaPublicKey.h` and the RSA trailer verified against it — and the job fails on a mismatch, or when the header is missing, empty or a placeholder. Materializing the secret only ever proved it *parsed* as a key, never that it was the other half of the committed one, and setting the secret and committing the regenerated header are two separate operator acts (checklist item 6), so a mismatch was the default outcome of doing them out of order. What it produces is a valid image every board rejects: each one paints UPDATING / DO NOT POWER OFF, downloads ~400 KB, fails the BearSSL verify, paints UPDATE FAILED, and repeats **on every heartbeat until somebody reverts the image**. The Devices page cannot explain it, because a box in that loop is heartbeating happily and never reports a failed version.
4. The job uploads a `firmware` artifact (90-day retention) containing **one of**:
   - `court_bridge.signed.bin` + `firmware.manifest.json` = `{"version":"<major.minor.patch>","url":"/firmware/court_bridge.signed.bin","sizeBytes":<n>}`, or
   - `README.txt` stating the build is **UNSIGNED**, when the secret is unset. This is deliberate: an unsigned build is allowed (PRs, forks, pre-go-live) but never silent — the job also emits a workflow warning titled *OTA unsigned*.
5. `build-backend-amd64` / `build-backend-arm64` download that artifact into `firmware-payload/` and the backend `Dockerfile` copies it to **`/app/firmware/`** in the runtime image. The directory is always present in the repository with a placeholder `README.txt` so a local `docker compose build` works with no artifact; CI clears the placeholder before the download so the image holds exactly what `iot-sign` produced.

**The CI image carries no WiFi credential, by design.** `secrets.h` is gitignored and absent on the runner; `court_bridge/main.cpp` defaults `WIFI_SSID`/`WIFI_PASSWORD` to empty and reads the credential from the box's own flash store instead (`bridgelogic::CredentialStore`). A box that has joined the club network once — from a `secrets.h` build at the bench, or from a `!WIFI,<ssid>,<pass>` line typed over USB — has persisted that credential (CRC-trailed; password written before SSID so a torn write reads as absent), and every OTA image after inherits it. Do not try to bake a credential into the CI image; it is the wrong place, and the empty default is what makes a runner build safe to offer to the fleet.

### Serving it — the gateway and the forwarded host
The API serves the payload directory at **`/firmware/`** — anonymous and pull-only, because the box fetches with `ESPhttpUpdate`, a plain GET carrying `x-ESP8266-*` headers and no device signature, and the RSA trailer verified on the board is the integrity anchor rather than transport auth. Only `.bin` and `.json` are served (an unsigned README is a 404, not a document), there is no directory listing, and `..` is refused by the file provider. The branch is **rate-limited per client address** (`RateLimits:FirmwarePerMinute`, default 10) — a box fetches one image per release, and nothing else has a reason to. The directory is `Firmware:PayloadPath` (`Firmware__PayloadPath`), resolved in one place (`FirmwarePayload.ResolvePath`): the configured value if set, else `/app/firmware` when it exists (the image), else the checkout's `firmware-payload/`.

**The gateway proxies `/firmware/`** (`nginx/nginx.conf`) to the backend, unbuffered, so a 400 KB image is streamed rather than spooled. Without that block the request fell through to the SPA, which answered `index.html` with a 200 that the updater rejected on its magic-byte peek — every heartbeat then looped UPDATING / UPDATE FAILED on the LCD.

**Every URL handed to a box is absolute and gateway-true.** The manifest's `url` is relative (`/firmware/...`) and the ESP8266 core's `HTTPClient::begin` refuses a URL without a scheme, so `OtaCatalogue` resolves a relative URL — from the manifest *or* from `Ota:*:Url` — against a base chosen in the same order provisioning uses for `api_base_url`:

1. `Discovery:AdvertisedBaseUrl`, when set;
2. else the scheme and host **of the request that is asking** — the heartbeat, or the provisioning call — which is by construction an address that works from where the box stands;
3. else `App:PublicBaseUrl`.

Rule 2 is only true because of two things in the gateway path. nginx forwards **`X-Forwarded-Host: $http_host`** — host *and port* exactly as the box sent them — because `$host` strips the port, and a box reaching `http://<ip>:8088` was otherwise handed URLs on port 80, where nothing listens. And the API honours `X-Forwarded-For` / `-Proto` / `-Host` **only from a proxy in `Gateway:TrustedProxies`**. Through the gateway a box gets `http://<ip>:8088/...`.

### Trusted proxies and the hop count

`Gateway:TrustedProxies` defaults to `127.0.0.1`, `::1`, `172.29.83.0/24` — loopback plus **the ipam subnet `docker-compose.yml` pins for the compose bridge**, which is where the gateway container stands in both compose files. It used to be `172.16.0.0/12`, the whole docker pool: a million addresses, and on a club whose LAN happens to sit in that range, every laptop was a trusted proxy able to forge its own client address. Changing the subnet means changing four places together — the compose file, `Gateway.TrustedProxies` in `appsettings.json`, `GatewayTrust.ComposeBridgeNetwork`, and the note in `.env.example`.

It is a **comma-delimited string**, not a JSON array, and that is load-bearing: .NET configuration merges arrays *by index*, so with the old three-entry array default, setting `Gateway__TrustedProxies__0` replaced entry 0 and went on trusting `::1` and the `/12` underneath — a deployment could add a proxy but never remove one. A scalar is replaced whole. Set `GATEWAY_TRUSTED_PROXIES` in `.env` (compose forwards it as `Gateway__TrustedProxies`); the indexed form still works because there are no array children in the file to merge with. The API logs a warning at startup for a range broader than `/16`, for an entry that is not an address or CIDR at all, and for a trusted network that contains this host's own address while Kestrel is bound to every interface.

**`Gateway:ForwardLimit` is 2**, one hop for the gateway and one for cloudflared. The documented internet path is Cloudflare → cloudflared on the club's own host → the published gateway port, so a remote member's request reaches nginx already carrying `X-Forwarded-For: <visitor>` and `$proxy_add_x_forwarded_for` leaves it as `<visitor>, <cloudflared>`. At the default of 1 the API stopped at cloudflared's one bridge address, so **the entire remote membership shared a single ten-a-minute auth bucket** and any one outsider could lock every remote member out of login with ten POSTs a minute. Raising it is safe because the middleware re-checks trust at each hop: it consumes a second entry only when the address it resolved from the first is itself a trusted proxy, so a LAN client forging a header still gets its own address. A deployment with a third hop in front sets `Gateway__ForwardLimit`.

**Two configurations refuse to start** rather than hand the fleet a URL it cannot open:

- An **`https`** `Discovery:AdvertisedBaseUrl` or `Ota:*:Url`. The box fetches with a plain `WiFiClient` and has no heap for a TLS context, so every provisioning and OTA URL derived from an https base is unreachable. `Discovery:DowngradeHttpsAdvertisedBaseUrl=true` has the scheme rewritten to `http` instead, logged as a warning at startup.
- A **partial `Ota:Stable` or `Ota:Canary` section**. `Ota:*:{Version,Url,SizeBytes}` are all three or none, with a positive `SizeBytes` (`wc -c < court_bridge.signed.bin`). A half-configured override used to be discarded silently and the fleet was offered the baked image the override existed to hold back.

`OtaCatalogue` reads `firmware.manifest.json` from the payload directory as the `Ota:Stable` default; a fully configured `Ota__Stable__*` override always wins over it, which is how a deployment pins the fleet to an image other than the one in its own container (see `.env.example`).

## Image names
- `frostaura/crusaders-mainframe-backend:latest`
- `frostaura/crusaders-mainframe-frontend:latest`

(Adjust the org name if the user's Docker Hub account namespace differs — confirm before first push.)

## Compose files
`docker-compose.yml` (base) carries five services: `postgres` (16-alpine, `expose: 5432`), `mailhog`, `backend` (built from `src/backend/Dockerfile`, `expose: 5000`, env from the variables below), `frontend`, and `gateway` (built from `nginx/Dockerfile`, `${GATEWAY_PORT:-8088}:80`, with `nginx.conf` **baked in** as an envsubst template rather than bind-mounted — see *Three images, not two* above). Its network is a pinned `172.29.83.0/24`. Biometric peripheral passthrough on the backend service is commented out until a real driver is selected; the USB device path goes under `devices:` (or `privileged: true` as a last resort).

`docker-compose.onprem.yml` (overlay) moves the backend to `network_mode: host`, points Postgres and MailHog at loopback, sets `Discovery__Enabled`, `Discovery__Port` and `Discovery__AdvertisedPort: ${GATEWAY_PORT:-8088}`, leaves `Discovery__AdvertisedBaseUrl` empty on purpose (the OFFER then carries the address of whichever local interface reaches the announcing board), and gives the gateway `extra_hosts: backend:host-gateway`. The header of that file is the operational note for whoever applies it, including how to confirm the discovery listener is actually hearing boards.

## .env / .env.example
The keys a deploy actually sets. `.env.example` is the authoritative template, and every name below is one `docker-compose.yml` genuinely forwards — the service `environment:` map is an **allow-list**, so a name absent from it reaches the API not at all. Five keys were documented here as settable and were doing nothing until the compose file was corrected: the gateway trust settings, the firmware rate limit, the https-downgrade flag, and the whole `Ota__*` override block.

- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` — `POSTGRES_PASSWORD` random.
- `JWT_SECRET` (≥ 32 chars; the API reads it as `Jwt:Secret` and refuses to start without it), `JWT_ISSUER`, `JWT_AUDIENCE`, token lifetimes.
- `MASTER_SECRETS_ENCRYPTION_KEY` — wraps per-tenant `tenant_secrets` data keys; required.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_FROM_NAME` — email delivery.
- `APP_PUBLIC_BASE_URL`, `APP_FRONTEND_URL`, `CORS_ALLOWED_ORIGINS`, `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`.
- `GATEWAY_PORT` (8088), `NGINX_BACKEND_PORT`, `NGINX_FRONTEND_PORT`, `NGINX_CLIENT_MAX_BODY_SIZE`.
- `GATEWAY_TRUSTED_PROXIES` (→ `Gateway__TrustedProxies`, comma-delimited) — only when something other than the compose gateway fronts the API. `GATEWAY_FORWARD_LIMIT` (→ `Gateway__ForwardLimit`) — only with a third proxy hop.
- `BACKEND_BIND_ADDRESS` — on-prem only: the address `backend:host-gateway` resolves to on this host. `docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'`; default `172.17.0.1`.
- `RATELIMITS_FIRMWARE_PER_MINUTE` (→ `RateLimits__FirmwarePerMinute`) — per-address ceiling on `/firmware/`.
- `DISCOVERY_DOWNGRADE_HTTPS_ADVERTISED_BASE_URL` (→ `Discovery__DowngradeHttpsAdvertisedBaseUrl`), `DISCOVERY_ADVERTISED_BASE_URL` — see above; leave the base URL empty on-prem.
- `OTA_STABLE_{VERSION,URL,SIZE_BYTES}`, `OTA_CANARY_*` (→ `Ota__Stable__*` / `Ota__Canary__*`) — all three of a section or none; only to override the baked manifest. Compose forwards the whole block together, because forwarding some and not others would manufacture the partial-section startup refusal described above.
- `BIOMETRIC_DRIVER` (`Null` until a driver exists), `BIOMETRIC_TEMPLATE_STORE_PATH`, `MEDIA_STORAGE_PATH`.
- `PORTAINER_*` — read by CI only.

PayFast merchant credentials are **per-tenant settings** in the database (`tenant_settings.payfast`, sandbox/live chosen per tenant), not environment. There is no platform-level payment URL. Tenant branding and webhook secrets likewise live in the database. The only truly project-specific config a deploy needs are the two image-name slugs in the Portainer stack file; everything else is org-wide secrets in Portainer or per-tenant DB rows.

## Cloudflared tunnel
- Hostname: TBD per tenant or per-platform (e.g. `*.mainframe.crusadersapp.co.za` wildcard CNAME → tunnel).
- The tunnel runs as a systemd service on the same host, with a single ingress route to the gateway's published port. Its config is host-side and is not in this repository. The court boxes never use the tunnel — they reach the gateway on the LAN over plain HTTP.

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
