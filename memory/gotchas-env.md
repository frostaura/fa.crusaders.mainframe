---
name: crusaders-mainframe-gotchas-env
description: "This Mac and its checkouts: hidden-flag worktrees lose appsettings mid-run, iCloud duplicates break generated sketches and the link, MSB3021 on appsettings, uv for make install, shared trees break each other's builds."
type: gotcha
last_verified: 2026-11-20
---

# Gotchas — this machine, its checkouts and shared working trees

Development happens in `~/src` clones and worktrees; the iCloud tree holds context files. Sharded local runs exhausting one
Postgres's `max_connections` are [`decisions-backend-capacity.md`](decisions-backend-capacity.md) (test pools drop idle
connections after 3 s — raise toward ~10 s if the suite slows). The test Postgres when Docker wedges, or in a fresh remote
session: [`gotchas-env-postgres.md`](gotchas-env-postgres.md).

- **A checkout under a dot-directory boots the API with no `appsettings.json`, and re-breaks mid-run.** Every file in a
  `.claude/worktrees/<name>` worktree inherits the BSD `hidden` flag from `.claude/`, and .NET's `PhysicalFileProvider`
  silently excludes hidden files — the API dies on "Jwt:Secret is required" with the file sitting there. `chflags -R
  nohidden` once is not enough: MSBuild re-copies `appsettings*.json` into `bin/` on every build and iCloud re-marks
  them, so a suite goes unreadable *part-way through* (rate-limit cases dying on a missing connection string; HTTP suites
  on `IOException: Read-only file system : '/app'` as a storage path falls back to its container default) — a green run
  there is partly luck. Deterministic: a keeper loop for the life of the suite (`while true; do chflags -R nohidden
  src/backend; sleep 1; done &`) **together with** exporting `Media__StoragePath` and `Biometric__TemplateStorePath` as
  environment variables, which no file provider can lose. (`RateLimits__*`/`Gateway__*` once turned a dozen tests red;
  the factory clears them and its `UseSetting` outranks them.) The main checkout is unaffected because its files were
  never under a dot-directory.
- **A fresh worktree has no `node_modules` and no `src/iot/.venv`**; a relative symlink for the first has been one level
  short (vitest resolved against the home directory), and without the venv the complexity gate exits 1 on "No such file or
  directory" and reads as a gate failure. Create **both as absolute symlinks** into the main checkout and verify. Never
  `npm ci` in a worktree — it fights iCloud, which fabricates a `node_modules 2`.
- **iCloud fabricates numbered duplicates of files it has just seen written, and they are not always harmless.** Under
  `bin`/`obj` they are gitignored. Inside a generated `arduino/` tree an export once produced dozens of `Name 3.cpp`
  copies between the generator finishing and `git add`, which committed them — and the Arduino IDE compiles every `.cpp`
  under `src/` recursively, so a stale duplicate is a second definition. **They break the LINK too** (2026-09-19): 564
  under `.pio/build` and the arduino trees made every native suite fail on `duplicate symbol _unityOutputFlush` — which
  reads as a broken test harness, not a filesystem artefact. `.gitignore` carries the load-bearing defence (the files
  appear after the generator has finished) and the exporter sweeps its own output; `make sweep-icloud` runs before
  `test-iot`, `test-iot-asan` and `build-iot`, asks git for the tracked set first, refuses to delete anything in it, and
  fails if git cannot answer. By hand: `find src/iot -path src/iot/.venv -prune -o \( -name '* [0-9]' -o -name
  '* [0-9].*' \) -print`, delete, wipe the affected `.pio/build/<env>`. **Check `git status` for ` N.` names before any
  `git add` of a generated dir.**
- **`dotnet test` fails MSB3021 "Access denied" copying `appsettings*.json` into `bin/`** on the iCloud path (the sources
  carry the protected `com.apple.provenance` xattr; MSBuild's copy is denied on *create* but succeeds on *overwrite*):
  `cp` the two files into each project's `bin/Debug/net10.0/` once, then rerun. Plain `cp` and CI on ubuntu are
  unaffected. `dotnet` here also needs
  `MSBuildEnableWorkloadResolver=false` (MSB4242; the Makefile's `TEST_DOTNET` sets it for the sharded run).
- **`make install` needs `uv`** (`Makefile:94-96`: `uv venv --python 3.12`, then the pinned requirements). *Superseded:*
  it used to die on the system python (below gcovr's 3.10 floor); CI uses setup-python 3.12.
- **`strict_compile.sh` runs and passes on macOS now** (`39d5fe9b`): under Apple clang it adds
  `-Wno-unused-const-variable` for headers only (`court-box/tools/strict_compile.sh:127-135`), because clang's `-Wall`
  carries the warning GCC's does not and four untouched `shared/lib/hal` headers failed `-Werror` on every Mac. The CI
  `iot` job on GCC is still the real gate. *Superseded:* "`make lint-iot` is red locally by design".
- **Shared working trees break each other**: with lanes in one tree a sibling's half-written test file breaks every build
  — run filtered suites in an rsync'd copy of `src/backend` (+ `docker-compose.yml`, `nginx/`, `docs/`, `whitelizard.txt`,
  which the repo-root tests look for); `git commit --amend` in a shared tree amends whoever committed last (another lane's
  commit was replaced once — never amend there); `test-results/` is shared (`--output=<own dir>`).
- **`node_modules` here loses rollup's native optional dependency** (missing `rollup/dist/native.js`): `rm -rf node_modules &&
  npm ci` in the main checkout (never in a worktree, above).
