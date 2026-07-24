# Crusaders Mainframe

Multi-tenant SaaS for racquet-sport club court-light scheduling on a credit + on-court biometric model. First customer: **Crusaders Squash Club**.

A FrostAura Technologies project. Strategic context, charter, feature spec, design system, biometric/lights/payments specs, and deploy story all live in [`CLAUDE.md`](./CLAUDE.md) and [`docs/`](./docs/).

## Stack
- **Backend:** ASP.NET Core 10, EF Core, PostgreSQL 16, JWT + Passkeys
- **Frontend:** React 19 + TypeScript + Vite + Tailwind + shadcn/ui (Figtree, soft palette per [`docs/specs/design-system.md`](./docs/specs/design-system.md))
- **Payments:** PeachPayments (ZAR) — see [`docs/specs/payments-peachpayments.md`](./docs/specs/payments-peachpayments.md)
- **Biometric peripheral:** abstracted via `IBiometricDevice` — see [`docs/specs/biometric-abstraction.md`](./docs/specs/biometric-abstraction.md)
- **Lights:** Arduino + 6-channel relay reachable via templated webhooks — see [`docs/specs/lights-controller.md`](./docs/specs/lights-controller.md)
- **Deploy:** GitHub Actions → Docker Hub → Portainer re-pull → Cloudflared tunnel — see [`docs/specs/deployment.md`](./docs/specs/deployment.md)

## Quick start (local dev)
```bash
cp .env.example .env       # then edit secrets
make install               # restore backend + npm install frontend
make up                    # docker compose: backend + frontend + postgres + mailhog + gateway
```

App: http://localhost:8088 · Mailhog: http://localhost:8025

## Common tasks
```bash
make build           # lint + build backend and frontend
make test            # run unit tests
make test-integration # postgres-backed integration tests
make down            # stop stack
make down-reset      # stop and clear volumes
```

## Layout
```
src/backend/    .NET 10 solution (Api + Tests)
src/frontend/   React + Vite + Tailwind + shadcn
src/firmware/   Arduino lights-controller firmware (added when hardware is selected)
docs/           Charter + specs (canonical reference)
.claude/        Project-local Claude / Gaia agents + skills + constitution
.github/        CI workflow + agents + skills mirror
nginx/          Reverse-proxy template for the compose gateway
scripts/        Lint / build / compose helper scripts
```

## License
[MIT](./LICENSE) · © FrostAura Global (Pty) Ltd.
