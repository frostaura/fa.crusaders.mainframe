---
name: crusaders-mainframe-gotchas-env
description: "This Mac and iCloud checkout: MSBuild denied copying appsettings, iCloud duplicates in generated sketches, hidden-flag worktrees, and sharded local runs exhausting one Postgres's max_connections."
type: gotcha
last_verified: 2026-09-19
---

# Gotchas — this machine and this iCloud checkout

- **Sharded local runs share ONE Postgres and its `max_connections` (100).** `make
  test-integration-sharded SHARDS=3` runs ~30 classes at once, each with its own database and pool;
  idle pools held the slots and tests failed `53300` → `503 service_busy`, reading as a product
  regression (R19). Test pools now drop idle connections after 3 s — raise toward ~10 s if the suite
  slows. CI is unaffected (one process per server). Detail: `decisions-backend-capacity.md`.
- **A checkout under a dot-directory boots the API with no `appsettings.json`, and re-breaks
  mid-run.** Every file in a `.claude/worktrees/<name>` worktree inherits the BSD `hidden` flag from
  `.claude/`, and .NET's `PhysicalFileProvider` silently excludes hidden files — so the API dies on
  "Jwt:Secret is required" with the file sitting right there. **`chflags -R nohidden` once is not
  enough:** MSBuild re-copies `appsettings*.json` into `bin/` on every build and iCloud re-marks
  them, so a suite goes unreadable *part-way through*, reading as broken tests rather than a missing
  file (rate-limit cases dying on a missing connection string; Postgres-backed HTTP suites dying on
  `IOException: Read-only file system : '/app'` as a storage path falls back to its container
  default). The same unchanged tree has given wildly different failure counts on successive runs —
  **a green run here is partly luck about timing.** What makes it deterministic: a keeper loop for
  the life of the suite (`while true; do chflags -R nohidden src/backend; sleep 1; done &`)
  **together with** exporting `Media__StoragePath` and `Biometric__TemplateStorePath` as environment
  variables, which no file provider can lose. (`RateLimits__*`/`Gateway__*` once turned a dozen
  tests red; the factory clears them and its `UseSetting` outranks them now.) The main checkout is
  unaffected because its files were never under a dot-directory.
- **A fresh worktree has no `node_modules` and no `src/iot/.venv`**, and the relative symlink used
  for the first has been one level short before now, so vitest resolved against the home directory
  and nothing frontend could run; without the venv the complexity gate exits 1 on "No such file or
  directory" and reads as a gate failure. Create **both as absolute symlinks** into the main
  checkout and verify. Never `npm ci` in a worktree — it fights iCloud, which fabricates a
  `node_modules 2` beside it.
- **iCloud fabricates numbered duplicates of files it has just seen written, and they are not always
  harmless.** Under `bin`/`obj` they are gitignored build output. Inside `src/iot/court-box/arduino/` they are
  not: an export once produced dozens of `Name 3.cpp` / `.hpp` copies **between the generator
  finishing and `git add`**, which committed them — and the Arduino IDE compiles every `.cpp` under
  `src/` recursively, so a stale duplicate is a second definition. `.gitignore` carries the
  load-bearing defence (the files appear after the generator has finished) and the exporter sweeps
  its own output. **Check `git status` for ` N.` names before any `git add` of a generated dir.**
  **They break the LINK too, not only the sketch** (2026-09-19): 564 accumulated under
  `src/iot/**/.pio/build` and the generated arduino tree, and every native suite then failed on
  `duplicate symbol _unityOutputFlush` — which reads as a broken test harness, not a filesystem
  artefact. `make sweep-icloud` now runs before `test-iot`, `test-iot-asan` and `build-iot`; it
  asks git for the tracked set first, refuses to delete anything in it, and fails outright if git
  cannot answer. By hand: `find src/iot -path src/iot/.venv -prune -o \( -name '* [0-9]' -o -name
  '* [0-9].*' \) -print`, delete, then wipe the affected `.pio/build/<env>`.
- **`dotnet test` fails MSB3021 "Access denied" copying `appsettings*.json` into `bin/`** on this
  iCloud path — the sources carry the protected `com.apple.provenance` xattr, and MSBuild's copy is
  denied on *create* but succeeds on *overwrite*. Recovery: `cp` the two files into each project's
  `bin/Debug/net10.0/` once, then rerun. Plain `cp` and CI on ubuntu are unaffected.
- **`make install` dies here on the system python** (below gcovr's 3.10 floor, Xcode's too): the venv
  is created, the requirements fail, no `pio`. Recovery: `rm -rf src/iot/.venv && uv venv --python
  3.12 src/iot/.venv`, then install the pinned requirements. CI (setup-python 3.12) is unaffected.
- **`strict_compile.sh` runs on macOS and still cannot PASS here**: Apple clang's
  `-Wunused-const-variable` is in its C++ `-Wall` where GCC's is not, so four untouched headers
  (`shared/lib/hal/{Button,Display,Relay,Store}.h`) fail `-Werror` on this Mac only. Discharge it by
  confirming those four and only those four fail; **the CI `iot` job on GCC is the real gate.** Do
  not "fix" the headers for clang — `make lint-iot` is red locally by design.
- **The Docker CLI on this Mac wedges and never returns** — `ps`, `system df` and `exec` all hang
  indefinitely and have cost several agents real time. Nothing needs it: a test Postgres listens
  directly on **5439** (homebrew `psql` reaches it) and a throwaway Python SMTP sink on 1025 stands
  in for MailHog. Kill a wedged `docker` process.
- **`node_modules` here loses rollup's native optional dependency** (missing `rollup/dist/native.js`): `rm -rf node_modules && npm ci`.
