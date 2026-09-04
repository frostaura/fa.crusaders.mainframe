# Deployment Specification

Follows the FrostAura standard pattern (memory: `frostaura_deploy_pattern`). The only project-specific consideration is that the deploy target is the **same physical machine that has the biometric peripherals attached**.

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
  │     ├── crusaders-mainframe-frontend  (nginx + React build)
  │     ├── crusaders-mainframe-backend   (.NET 10 ASP.NET Core)
  │     ├── postgres:16-alpine
  │     └── (optionally) reverse proxy (Caddy / nginx)
  │
  └── USB / serial: biometric peripherals (one per court)
```

## Build & deploy pipeline
1. `git push origin main`
2. GitHub Action `ci.yml` runs (mirrored from `Technologies/Projects/fa.startup/.github/workflows/ci.yml`):
   - Backend: lint, build, unit + integration tests, Postgres-backed boundary tests, coverage gate.
   - Frontend: lint, build, unit, Playwright e2e, bundle-size gate.
   - Security: `npm audit` + `dotnet list package --vulnerable`.
   - IoT: host unit tests + lint (`iot`), every board target compiles (`iot-build`), then the court-box image is signed and packaged (`iot-sign`, below).
3. On `main` push (after gates green), build amd64 + arm64 images for both backend and frontend, push to Docker Hub, merge multi-arch manifest. The backend image build waits on `iot-sign` and bakes its artifact in (below).
4. Deploy job calls Portainer's REST API: `PUT /api/stacks/{stack_id}?endpointId={endpoint_id}` with `pullImage: true`.
5. Portainer re-pulls the manifests, recreates containers, the new build is live.

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
3. The job uploads a `firmware` artifact (90-day retention) containing **one of**:
   - `court_bridge.signed.bin` + `firmware.manifest.json` = `{"version":"<major.minor.patch>","url":"/firmware/court_bridge.signed.bin","sizeBytes":<n>}`, or
   - `README.txt` stating the build is **UNSIGNED**, when the secret is unset. This is deliberate: an unsigned build is allowed (PRs, forks, pre-go-live) but never silent — the job also emits a workflow warning titled *OTA unsigned*.
4. `build-backend-amd64` / `build-backend-arm64` download that artifact into `firmware-payload/` and the backend `Dockerfile` copies it to **`/app/firmware/`** in the runtime image. The directory is always present in the repository with a placeholder `README.txt` so a local `docker compose build` works with no artifact; CI clears the placeholder before the download so the image holds exactly what `iot-sign` produced.

Serving it (Phase 5b): the API serves the payload directory at **`/firmware/`** — anonymous and pull-only, because the box fetches with `ESPhttpUpdate`, a plain GET carrying `x-ESP8266-*` headers and no device signature, and the RSA trailer verified on the board is the integrity anchor rather than transport auth. Only `.bin` and `.json` are served (an unsigned README is a 404, not a document), there is no directory listing, and `..` is refused by the file provider. The directory is `Firmware:PayloadPath` (`Firmware__PayloadPath`), resolved in one place (`FirmwarePayload.ResolvePath`): the configured value if set, else `/app/firmware` when it exists (the image), else the checkout's `firmware-payload/`. `OtaCatalogue` reads `firmware.manifest.json` from that same directory as the `Ota:Stable` fallback whenever `Ota:Stable:{Version,Url,SizeBytes}` is not fully configured — re-parsed only when the file changes, and logged as a warning when present but unusable. **The URL handed to a box is made absolute**: the manifest's `url` is relative (`/firmware/...`), and the ESP8266 core's `HTTPClient::begin` refuses a URL without a scheme before a byte leaves the board, so the catalogue resolves a relative URL — from the manifest *or* from `Ota:*:Url` — against `Discovery:AdvertisedBaseUrl` when set, else the scheme and host of the heartbeat request that is asking (the same rule provisioning uses for `api_base_url`: an address the box demonstrably reaches), else `App:PublicBaseUrl`. Explicit `Ota__Stable__*` environment variables always win over the baked manifest, which is how a deployment pins the fleet to an image other than the one in its own container (see `.env.example`).

## Image names
- `frostaura/crusaders-mainframe-backend:latest`
- `frostaura/crusaders-mainframe-frontend:latest`

(Adjust the org name if the user's Docker Hub account namespace differs — confirm before first push.)

## docker-compose.yml shape (target)
```yaml
services:
  frontend:
    image: frostaura/crusaders-mainframe-frontend:latest
    restart: unless-stopped
    ports:
      - "8080:80"
    depends_on:
      - backend

  backend:
    image: frostaura/crusaders-mainframe-backend:latest
    restart: unless-stopped
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
    devices:
      # Updated once the biometric SDK is selected. Example for a fingerprint reader on USB:
      # - "/dev/bus/usb/001/004:/dev/bus/usb/001/004"
      []
    # privileged: true  # only as a last resort if device path is dynamic

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: crusaders
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: crusaders_mainframe
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U crusaders"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  postgres-data:
```

## .env / .env.example
- `POSTGRES_PASSWORD` — random
- `JWT_SIGNING_KEY` — random, ≥256 bits
- `MASTER_SECRETS_ENCRYPTION_KEY` — wraps per-tenant `tenant_secrets` data keys
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — email delivery
- `PEACH_PAYMENTS_BASE_URL` — `https://test.oppwa.com` or `https://oppwa.com`
- `PUBLIC_BASE_URL` — e.g. `https://crusaders.mainframe.app` — used in email links

(Tenant-specific PeachPayments creds, branding, etc. live in the database, not env. Per the user's "2 env vars" guidance, the only truly project-specific config a deploy needs are the two image-name slugs in the Portainer stack file. Everything else is org-wide secrets in Portainer or per-tenant DB rows.)

## Cloudflared tunnel
- Hostname: TBD per tenant or per-platform (e.g. `*.mainframe.crusadersapp.co.za` wildcard CNAME → tunnel).
- The tunnel runs as a systemd service on the same host; `cloudflared.yml` references the tunnel ID and a single ingress route to the frontend container's port.

## Backups
- Postgres: `pg_dump` nightly via a cron container, encrypted, uploaded to a tenant-agnostic offsite bucket (Backblaze B2 or equivalent).
- Tenant-secret unwrapping requires the `MASTER_SECRETS_ENCRYPTION_KEY` — store the key in a password manager outside the host so a host loss doesn't lose the key.
- Restore drill: documented and run quarterly.

## Local development
- `make up` boots a docker-compose dev stack with `NullBiometricDevice` injected — no hardware required.
- `make seed` creates a Crusaders tenant, an admin, two players, and three days of bookings.
- `make logs` tails all services.
