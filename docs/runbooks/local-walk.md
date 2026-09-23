# Local walk — the real stack, a real browser, mail in MailHog

How to walk the product end to end on this machine against the **real** API, database and mail
path, by hand or with the repeatable Playwright suite in `src/frontend/e2e-real/`.

This is not the CI suite. `src/frontend/e2e/` (config `playwright.config.ts`) answers every `/api`
call from a route table and proves the screens; nothing about the server. The real-stack suite
(config `playwright.real.config.ts`, testDir `./e2e-real`) drives the production build behind the
gateway, the real API and Postgres, and reads the mail the API actually sent. CI never runs it —
there is no stack there to point it at — and the CI config cannot pick it up, because its
`testDir` is `./e2e`.

## 1. Bring the stack up in Development, with mail going to MailHog

`.env` (never committed, never pasted anywhere) must carry, at minimum:

```bash
ASPNETCORE_ENVIRONMENT=Development   # Seeder data + the dev admin sign-in endpoint
SMTP_HOST=mailhog                    # NOT the real relay .env.example ships with
SMTP_PORT=1025
```

`.env.example` names a real outbound relay for `SMTP_HOST`. A local walk registers throwaway
members, and a walk pointed at the real relay mails whatever address it was given. Point SMTP at
the `mailhog` service before the first walk, and only ever register `*.review.test` addresses
(the suite's helpers generate nothing else; `.test` can never resolve).

```bash
make up          # docker compose up --build -d
```

| What | Where |
| --- | --- |
| App (production build behind nginx, `/api` proxied to the API) | <http://localhost:8088> |
| Mail — every message the API sends | <http://localhost:8025> (UI) · `/api/v2/search?kind=to&query=<address>` (JSON) |
| Health | <http://localhost:8088/healthz> |

The seeded admin is signed in without a password through `POST /api/v1/auth/dev/admin-login`,
which answers **404 outside Development**. The "Sign in as seeded admin" button on the sign-in
page exists only in a Vite dev build (`import.meta.env.DEV`), so on `:8088` it is absent — use
the dev server below, or the suite's `devAdminSession()` helper.

## 2. Hot reload against the stack

Run Vite and proxy its `/api`, `/healthz` and `/uploads` to the gateway:

```bash
cd src/frontend
VITE_API_TARGET=http://localhost:8088 npm run dev -- --port 4173
```

Open <http://localhost:4173>. Edits reload live; the data is the stack's.

Links in mail are written with the API's `App:PublicBaseUrl` (default `http://localhost:8088`),
so a verify or welcome link opened by hand lands on the gateway build, not on Vite. Change the
host to `:4173` to stay on the dev server. The suite does this itself (`rehome()`).

## 3. Run the real-stack suite

From the repo root:

| Command | What it does |
| --- | --- |
| `make walk` | Headed, slowed (`SLOWMO=300`), both viewports — for a person to follow. `ARGS="--project=mobile"` narrows it. |
| `make walk-smoke` | Headless, both viewports — the quick "is the stack walkable" check. |
| `cd src/frontend && npm run e2e:real` | The same suite with your own flags. |

Environment the suite reads:

| Variable | Default | Meaning |
| --- | --- | --- |
| `E2E_REAL_BASE_URL` | `http://localhost:8088` | Where the app is. `http://localhost:4173` walks the Vite dev server instead. |
| `MAILHOG_URL` | `http://localhost:8025` | MailHog's API. |
| `HEADED` | unset | Any value runs headed. |
| `SLOWMO` | `250` headed, `0` headless | Milliseconds between actions. |
| `PLAYWRIGHT_CHROMIUM_PATH` | the Makefile finds the cached Chromium | Playwright refuses a revision it did not pin; this points it at the one on disk. |

A run starts by polling `/healthz` and stops with *"start the stack: make up"* if the gateway
does not answer, rather than timing out on a blank page. It runs one worker in order: the specs
share one database and one mailbox, and the auth routes allow ten anonymous calls a minute per
address — the helpers wait out a `429` instead of failing on it.

Failures keep a video and a trace under `src/frontend/test-results/real/`
(`npx playwright show-trace <trace.zip>`).

### Helpers for new specs (`e2e-real/support/`)

- `api.ts` — `devAdminSession`, `passwordSession`, `useSession` (plants a token before the page
  loads), `findMember`, `approveMember`, `adjustCredits` (goodwill, idempotent), `whoami`.
- `mailhog.ts` — `mailsTo`, `waitForMailMatch`, `verificationLink`, `rehome`. Parts are
  base64-decoded before matching.
- `webauthn.ts` — `addVirtualAuthenticator(page)`: a CDP virtual platform authenticator that
  answers passkey prompts itself.
- `ids.ts` — run-scoped `walk+<run>-<n>@signup.review.test` addresses, membership numbers, and a
  tiny PNG for the mandatory registration photo.

Select by role and label with regexes, and take copy from the app's own `src/lib/*Copy.ts`
modules: the screens are being redesigned and the journey is what must hold.

## 4. Reset the data

```bash
make walk-reset    # docker compose down -v && docker compose up --build -d
```

**This wipes all local data** — the Postgres, uploaded-photo and biometric-template volumes go, and the Seeder
starts again from nothing. Every member a walk registered, every booking and ledger row, is
gone. Walks do not need it: every run registers fresh, uniquely named members. Use it when the
database has drifted into a state you no longer trust.
