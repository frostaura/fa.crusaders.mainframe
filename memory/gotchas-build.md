---
name: crusaders-mainframe-gotchas-build
description: "Toolchain traps in both trees: src/iot is several PlatformIO projects on one venv, every arduino/ tree is GENERATED, both cores force gnu++11, GCC under UBSan will not fold an object address in a constexpr — and on the .NET side make complexity is unrunnable as written, lizard mis-parses expression-bodied switch members into a file-spanning *global*, and a stale migration Designer snapshot makes every later migration re-add columns."
type: gotcha
last_verified: 2026-09-22
---

# Gotchas — the firmware toolchain

The gates that check this firmware have traps of their own:
[`gotchas-gates.md`](gotchas-gates.md); the shared JSON scanner has its own:
[`gotchas-json-scanner.md`](gotchas-json-scanner.md).

- **`pio` is always `-d <project>`, never `-d src/iot`** — several PlatformIO projects (`shared/`,
  `court-box/`) share one venv there. `IOT_PROJECTS` in the Makefile is the one place a third is
  registered and every gate derives from it; `ci.yml` still names board builds, the arduino-cli
  compile and the simulator smoke test per project by hand.
- **Every `arduino/` tree is generated and three gates have to know it.** `make arduino-export`
  writes it from BOTH `lib/` roots, `src/` and the `-D` flags; `make arduino-check` fails on a diff
  and, since round G2, names the untracked FILES rather than telling anyone to `git add` a
  directory full of iCloud duplicates. It holds machine-rewritten copies plus vendored libraries, so
  **the clang-format list must exclude it** (`:(exclude)src/iot/*/arduino/**`) — the Makefile does,
  the CI job duplicates it inline. A hand-edit there is deleted by the next export. The exporter
  **asserts every string rewrite**, so rewording a `secrets.h` `#error` fails the export instead of
  shipping an instruction pointing nowhere.
- **BOTH cores hard-code `-std=gnu++11` and the IDE cannot override it** — arduino:avr (verified on
  1.8.6 *and* 1.8.8: `platform.txt`, no sketch-level build-flag mechanism, no settable
  `extra_flags`) AND esp32:esp32, so `court_mega` and `door_gate` alike. The claim that the gate
  was exempt because it has no AVR half was wrong (corrected 2026-09-19), and the generator was
  still emitting it into the sketch README until round G2. `build_unflags = -std=gnu++11` is a
  PlatformIO mechanism the IDE never sees, so **anything a sketch links must be valid C++11 as well
  as C++17**: a multi-statement `constexpr` function is green under `pio run` and red under
  `arduino-cli` ("body of 'constexpr' function not a return-statement") — it cost `LockDriver.h`
  once — while `inline constexpr` VARIABLES survive as a GCC extension. **Only the arduino-cli
  compile in CI's `iot-build` catches this**, and it covers all three sketches.
- **The mirror image, on the PlatformIO side:** the AVR builder appends `-std=gnu++11` *after*
  `build_flags`, so `[common]`'s `-std=gnu++17` lost every time and nothing in `lib/` could compile
  for the Mega. `build_unflags = -std=gnu++11` in `[env:court_mega]` is what lets ours win. It
  stayed latent behind a broken coordinate — **one broken gate hides the next one behind it.**
- **A PlatformIO library coordinate is `owner/name`, and two owners can publish the same name at the
  same version.** `johnrickman/LiquidCrystal_I2C@1.1.4` is Arduino-Library-Manager-only and has
  never been in the PlatformIO registry; `marcoschwartz/...@1.1.4` is the registry one, same API.
  `pio pkg search <name>` is the check, and the reason sits in a comment beside the line.
- **arduino-cli cores are pinned to match the PlatformIO platforms** (`arduino:avr@1.8.6`,
  `esp8266:esp8266@3.1.2` behind the esp8266 index URL); only one version of a core installs at a
  time. `court_mega` is byte-identical between the two toolchains; the bridge differs by tens of
  bytes, from board defaults rather than our code.
- **PlatformIO compiles only the files inside each `test_<name>/` directory** — a shared helper in
  `test/support/` compiles and then fails to LINK, once per suite, which is why the corpus reader is
  header-only with everything `inline` — **and puts only a project's OWN `test_dir` on the include
  path**. The reader lives in `shared/test/support/` and every project reaches it by the identical
  `-I$PROJECT_DIR/../shared/test` line in `[strict_host]`, kept byte-identical even where it is
  redundant (2026-09-19).
- **GCC under `-fsanitize=undefined` will not fold an OBJECT'S ADDRESS in a constant expression**
  (2026-09-19, round G2), so `constexpr length(const char* s) { return s == nullptr ...; }` called
  as `length(kPathHeartbeat)` is "not a constant expression" and every `static_assert` built on it
  fails to COMPILE. **Apple clang folds it and is green**, so the class is invisible outside CI's
  `native_asan` job. Cure: no `== nullptr` branch in a `constexpr` helper that takes a literal or a
  `constexpr char[]` (it cannot be null there, and a null one is a dereference the compiler refuses
  — a better failure than the branch bought), and propagate grammar failure as an integer sentinel
  rather than as `nullptr`. `StaticText.h` and `ApiBaseUrl.h` carry the reasoning.
- **`build_unflags` removes EVERY matching token, including the environment's own.**
  `[env:door_gate]` unflags `-DFW_VERSION_MINOR=0` and then sets the identical token, so neither
  survives and `fwversion/Version.h`'s `#ifndef` fallback of 0 supplies it — verified on the real
  `pio run -v` line, which carries `-DFW_VERSION_MAJOR=1` and no MINOR or PATCH. 1.0.0 on both
  builds, by luck: the fallback equals the intended value. The exporter mirrors the rule and fails
  if a name survives twice with different values.

## The .NET gates — two traps that cost this lane hours

- **`make complexity` is unrunnable as written on this machine**: the target invokes
  `src/iot/.venv/bin/python`, which does not exist here. Run lizard directly with the SAME flags —
  `python3 -m lizard src/backend/Crusaders.Mainframe.Api -C 15 -L 200 -a 6 -W whitelizard.txt
  -x '*/Migrations/*' -x '*/bin/*' -x '*/obj/*' -w`. The baseline is genuinely **zero warnings**, so
  anything it reports is yours (verified against `~/src/.crusaders-merge-main`, 2026-09-22).

- **lizard's C# parser cannot follow an expression-bodied member whose value carries braces** —
  `=> x switch { … }`, `=> new { … }`, `=> new() { … }`. It loses scope and emits a `*global*`
  pseudo-function **spanning the whole FILE**, which then trips the `-L 200` FUNCTION-length gate on
  any file longer than 200 lines. The warning names no method, so it reads as "this file is too
  long" and invites a pointless split. **This is what every "Block body for the lizard reason in
  `memory/gotchas.md`" comment in this tree is actually about**; the mechanism had never been
  written down, so the workaround read as superstition and was reinvented by guessing. Cure: give
  such a member a block body and `return` the switch. Bisected 2026-09-22; a one-class file with no
  such member and 312 lines (`DoorAuditActions.cs`) is clean, and an otherwise identical one with a
  `=> … switch` is not.

- **The newest migration's `.Designer.cs` is the baseline every future migration diffs against, and
  a merge can leave it stale.** `20260921190452_AddDeviceEventReceiptBootId.Designer.cs` was written
  on a branch without `20260921185533_AddDoorTruthColumns`, so it was missing five columns and EVERY
  migration scaffolded after it proposed to ADD them a second time — a duplicate-column failure
  mid-chain on a fresh database, which only `ApiBoundaryTests.Migrations_apply_cleanly_to_a_fresh_database`
  catches. **Read a newly scaffolded migration before committing it**; if it contains operations you
  did not cause, delete those by hand. The drift ends at the first migration whose own designer
  snapshot is complete (2026-09-22).

- **`dotnet ef migrations add --no-build` scaffolds against the LAST BUILT assembly**, so it silently
  produces an empty migration when the model has changed since. Worse, `migrations remove` then
  rewrites the model snapshot from that same stale assembly. Never pass `--no-build` here.
