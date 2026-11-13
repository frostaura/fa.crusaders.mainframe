---
name: crusaders-mainframe-gotchas-ops
description: "Release and operations traps (2026-11-13): container filters need the project too, an empty host dumps at once, externally created volumes survive down -v, GCC 8 .su paths are basenames, root-owned backup files on Linux."
type: gotcha
last_verified: 2026-11-13
---

# Gotchas — the stack, the release and the tools around them

- **Filter containers by project AND service.** `docker ps --filter
  label=com.docker.compose.service=backend` also returns the shared `crusaders` dev stack's backend
  on a machine running more than one stack; a runbook command built on it would stop the wrong API.
  Add `--filter label=com.docker.compose.project=<stack>`.
- **The backup service dumps at once on a host with no backup.** A test that starts it before
  seeding gets a dump of an empty database and passes a "restore" of nothing. Seed, then start it.
- **`docker compose down -v` removes only volumes compose created.** A volume made by hand with the
  project's name (to plant root-owned files, say) survives it; remove it explicitly.
- **The production file pins `10.83.29.0/24`.** Two projects from it on one host collide; a test or
  drill overrides `networks.default.ipam.config` with `!override` (Compose 2.24.4+).
- **On a Linux runner the backup container's files are root-owned** and the test cannot delete its
  own temp dir; clean it through a container. Docker Desktop on macOS hides this.
- **The ESP32's GCC 8 writes bare basenames into `.su`** (`main.cpp`, `WiFi.cpp`) and has no
  `-fcallgraph-info`, so "is this frame ours" is decided by where the `.su` sits in
  `.pio/build/<env>/` (`src/`, or `lib<hash>/<our library>/`), never by the path inside it.
- **`PLATFORMIO_BUILD_FLAGS` rebuilds the whole environment** in place. The CI stack-budget step
  rebuilds only `court_bridge` and `door_gate`; nothing after it may use those images as release
  artifacts.
- **A migration's SQL is often not inside `Up()`**: helpers, constants and raw strings hold it.
  Read every literal outside `Down()` — see `decisions-release-ops.md`.
- **Images published before 2026-11-13 have no revision label** and only `latest*` tags; for those,
  what runs is knowable only from the database's newest migration.
