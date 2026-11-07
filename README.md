# Crusaders Mainframe

Multi-tenant SaaS for racquet-sport clubs: court-light scheduling on a minutes-based booking model. Players buy minute packages in ZAR via PayFast; at the court a biometric, PIN or QR peripheral identifies them and a controller switches the lights on. First customer: **Crusaders Squash Club**.

Rules and invariants: [`CLAUDE.md`](./CLAUDE.md). Specs, charter and design system: [`docs/`](./docs/).

## Stack
- **Backend:** ASP.NET Core 10, EF Core, PostgreSQL 16, JWT + passkeys
- **Frontend:** React 19, TypeScript, Vite, Tailwind, shadcn/ui; light and dark themes ([design system](./docs/specs/design-system.md))
- **Payments:** PayFast with per-tenant merchant credentials ([spec](./docs/specs/payments-payfast.md))
- **Biometrics:** abstracted behind `IBiometricDevice` ([spec](./docs/specs/biometric-abstraction.md))
- **Court lights:** WeMos Mega 2560 + ESP8266 box driving a relay board on the club LAN ([README](./src/iot/court-box/README.md))
- **Doors:** one ESP32 per door with a QR scanner and lock relay ([README](./src/iot/door-gate/README.md))
- **Deploy:** GitHub Actions builds multi-arch images to Docker Hub and stops there. Pulling `:latest` onto the club machine is manual; members connect through a Cloudflared tunnel ([deployment](./docs/specs/deployment.md), [go-live checklist](./docs/go-live-checklist.md) §2)

## Quick start
```bash
cp .env.example .env   # edit secrets
make install
make up                # backend, frontend, postgres, mailhog, gateway
```
App: http://localhost:8088 · Mailhog: http://localhost:8025

## Common tasks
The `Makefile` is the entry point for everything.
```bash
make build             # lint + build backend, frontend, firmware
make test              # unit tests: backend, frontend, firmware
make test-integration  # Postgres-backed boundary tests
make test-iot-asan     # firmware suite under ASAN + UBSAN
make test-e2e          # Playwright, mobile and desktop
make complexity        # cyclomatic complexity (C++, C#, TypeScript)
make virt-up           # fake PayFast + device simulator
make down              # stop the stack (down-reset also clears volumes)
```
`make test-integration` needs `API_BOUNDARY_TEST_CONNECTION_STRING`; without it those tests skip (see `REQUIRE_BOUNDARY_TESTS`).

## Layout
```
src/backend/    .NET 10 API and tests
src/frontend/   React app
src/iot/        Firmware: court-box/, door-gate/, shared/
src/contracts/  Wire-protocol and PayFast fixture corpora
test/           e2e-device/ (hardware-free end-to-end) and virtualization/
docs/           Charter and specs
nginx/          Gateway config and Dockerfile
```

## Before go-live
All phases are built and the suites are green, but that is not "done": adversarial review has repeatedly found real defects in passing code ([`docs/reviews/adversarial-e2e-review.md`](./docs/reviews/adversarial-e2e-review.md)). What remains needs physical access, live credentials or a human decision, including a **safety** question — whether the relays switch a contactor or the lighting load directly — that gates everything else. See [`docs/go-live-checklist.md`](./docs/go-live-checklist.md), ordered by what blocks go-live first.

## License
[MIT](./LICENSE) © FrostAura Global (Pty) Ltd.
