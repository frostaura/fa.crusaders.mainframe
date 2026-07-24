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
3. On `main` push (after gates green), build amd64 + arm64 images for both backend and frontend, push to Docker Hub, merge multi-arch manifest.
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
