---
name: technologies-crusaders-squash-control-system-gotchas-env-postgres
description: "The test Postgres instances are Docker containers, and Docker on this Mac wedges: which container is on which port, a private Homebrew cluster without Docker, and what a fresh remote session must install first."
type: gotcha
last_verified: 2026-11-20
---

# Gotchas — the test Postgres when Docker will not answer

Split from [`gotchas-env.md`](gotchas-env.md), which holds the rest of this machine's checkout traps.

- **The Docker CLI on this Mac has wedged and never returned** (`ps`, `system df`, `exec` hung for agents) and Docker
  Desktop has died under load (~257, `crusaders-test-pg` going into recovery mid-run). The test Postgres instances ARE
  Docker containers — `crusaders-test-pg` on 5440 (`make test-integration`'s usual server; `docker start` it if down) and
  `crusaders-fixprog-pg` on 5439, which `test/e2e-device/scenario.py` starts itself. Without Docker: a private Homebrew
  `postgresql@15` cluster on another port (`initdb --locale=C`, `unix_socket_directories=''` — a scratchpad path is past
  the 103-byte socket limit; `btree_gist` is the only extension needed; it ran the whole suite green), and a throwaway
  Python SMTP sink on 1025 stands in for MailHog. Kill a wedged `docker` process.
- **A *fresh remote* session has no `dotnet` and no `pio`** — install the .NET 10 SDK and the pinned iot requirements
  first. Postgres starts without Docker from the distro's `postgresql/16/bin`; the local superuser is **`crusaders`**,
  and `pg_ctl` refuses to run as root.
