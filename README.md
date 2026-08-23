# Crusaders Mainframe

Multi-tenant SaaS for racquet-sport club court-light scheduling on a credit + on-court biometric model. First customer: **Crusaders Squash Club**.

A FrostAura Technologies project. Strategic context, charter, feature spec, design system, biometric/lights/payments specs, and deploy story all live in [`CLAUDE.md`](./CLAUDE.md) and [`docs/`](./docs/).

## Stack
- **Backend:** ASP.NET Core 10, EF Core, PostgreSQL 16, JWT + Passkeys
- **Frontend:** React 19 + TypeScript + Vite + Tailwind, with hand-rolled component primitives (Figtree, soft palette per [`docs/specs/design-system.md`](./docs/specs/design-system.md)). Note: **not** shadcn/ui — see `CLAUDE.md` § Known deviations
- **Payments:** PayFast (ZAR) — see [`docs/specs/payments-peachpayments.md`](./docs/specs/payments-peachpayments.md)
- **Biometric peripheral:** abstracted via `IBiometricDevice` — see [`docs/specs/biometric-abstraction.md`](./docs/specs/biometric-abstraction.md)
- **Lights:** WeMos Mega 2560 + ESP8266 court box driving a 4-channel relay board on the club LAN — see [`src/iot/README.md`](./src/iot/README.md)
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
src/frontend/   React + Vite + Tailwind, hand-rolled component primitives
src/iot/        Court-control firmware (ATmega2560 + ESP8266), PlatformIO
src/contracts/  Wire-protocol corpus shared by the firmware and backend tests
docs/           Charter + specs (canonical reference)
.github/        CI workflow
nginx/          Reverse-proxy template for the compose gateway
Makefile        The entry point for every task — there is no scripts/ directory
```

## License
[MIT](./LICENSE) · © FrostAura Global (Pty) Ltd.
