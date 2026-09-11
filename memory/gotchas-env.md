---
name: crusaders-mainframe-gotchas-env
description: "This checkout sits on iCloud: MSBuild is denied copying appsettings into bin, iCloud fabricates numbered duplicates inside generated sketches, and a worktree under .claude/ inherits a hidden flag that makes .NET ignore appsettings.json."
type: gotcha
last_verified: 2026-09-11
---

# Gotchas — this machine and this iCloud checkout

Verified on the founder's Mac 2026-09-11: system `python3` is 3.9.6, `/bin/bash` is 3.2, `uv` and a system `dotnet` are present, and `src/iot/.venv/bin/pio` exists.
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
  variables, which no file provider can lose. Do **not** also export `RateLimits__*` or `Gateway__*`
  — those outrank what those tests inject and turn a dozen of them red. The main checkout is
  unaffected because its files were never under a dot-directory.
- **A fresh worktree has no `node_modules` and no `src/iot/.venv`**, and the relative symlink used
  for the first has been one level short before now, so vitest resolved against the home directory
  and nothing frontend could run; without the venv the complexity gate exits 1 on "No such file or
  directory" and reads as a gate failure. Create **both as absolute symlinks** into the main
  checkout and verify. Never `npm ci` in a worktree — it fights iCloud, which fabricates a
  `node_modules 2` beside it.
- **iCloud fabricates numbered duplicates of files it has just seen written, and they are not always
  harmless.** Under `bin`/`obj` they are gitignored build output. Inside `src/iot/arduino/` they are
  not: an export once produced dozens of `Name 3.cpp` / `.hpp` copies **between the generator
  finishing and `git add`**, which committed them — and the Arduino IDE compiles every `.cpp` under
  `src/` recursively, so a stale duplicate is a second definition. `.gitignore` carries the
  load-bearing defence (the files appear after the generator has finished) and the exporter sweeps
  its own output. **Check `git status` for ` N.` names before any `git add` of a generated dir.**
- **`dotnet test` fails MSB3021 "Access denied" copying `appsettings*.json` into `bin/`** on this
  iCloud path — the sources carry the protected `com.apple.provenance` xattr, and MSBuild's copy is
  denied on *create* but succeeds on *overwrite*. Recovery: `cp` the two files into each project's
  `bin/Debug/net10.0/` once, then rerun. Plain `cp` and CI on ubuntu are unaffected.
- **`make install` dies here on the system python.** `gcovr` needs ≥3.10 and system `python3` is 3.9
  (so is Xcode's), so the venv is created and the requirements install fails, leaving no `pio`.
  Recovery: `rm -rf src/iot/.venv && uv venv --python 3.12 src/iot/.venv`, then install the pinned
  requirements into it. CI uses setup-python 3.12 and is unaffected.
- **`tools/strict_compile.sh` cannot run on macOS at all** — `/bin/bash` is 3.2 (no `mapfile`) and
  Apple clang flags dozens of *untouched* headers the GNU-calibrated gate does not. Discharge it by
  hand-compiling each touched `lib/` file with the script's exact flag set; **the CI `iot` job is
  the real gate.** Do not "fix" it for clang — that is still not the compiler it was calibrated on.
- **The Docker CLI on this Mac wedges and never returns** — `ps`, `system df` and `exec` all hang
  indefinitely and have cost several agents real time. Nothing needs it: a test Postgres listens
  directly on **5439** (homebrew `psql` reaches it) and a throwaway Python SMTP sink on 1025 stands
  in for MailHog. Kill a wedged `docker` process rather than waiting on it.
- **Frontend `node_modules` on this path loses rollup's native optional dependency** (the build
  fails on a missing `rollup/dist/native.js`). Recovery: `rm -rf node_modules && npm ci`.
