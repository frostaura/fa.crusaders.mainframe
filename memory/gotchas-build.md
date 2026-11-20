---
name: technologies-crusaders-squash-control-system-gotchas-build
description: "Firmware toolchain traps: src/iot is several PlatformIO projects on one venv, every arduino/ tree is GENERATED, both cores force gnu++11, build_unflags strips every match, UBSan will not fold an address."
type: gotcha
last_verified: 2026-11-20
---

# Gotchas — the firmware toolchain

Gate traps (lizard, `make complexity`): [`gotchas-gates.md`](gotchas-gates.md); the JSON scanner's:
[`gotchas-json-scanner.md`](gotchas-json-scanner.md); migration scaffolding: [`gotchas-migrations.md`](gotchas-migrations.md).

- **`pio` is always `-d <project>`, never `-d src/iot`** — the PlatformIO projects (`shared`, `court-box`,
  `door-gate`) share one venv there. `IOT_PROJECTS` (`Makefile:21`) is the one place a project is registered and every
  gate derives from it; `ci.yml` still names board builds, the arduino-cli compile and the simulator smoke test per
  project by hand.
- **Every `arduino/` tree is generated and three gates have to know it.** `make arduino-export` writes it from BOTH
  `lib/` roots, `src/` and the `-D` flags; `make arduino-check` fails on a diff and, since round G2, names the
  untracked FILES rather than telling anyone to `git add` a directory full of iCloud duplicates. It holds
  machine-rewritten copies plus vendored libraries, so **the clang-format list must exclude it**
  (`:(exclude)src/iot/*/arduino/**`) — the Makefile does, the CI job duplicates it inline. A hand-edit there is
  deleted by the next export. A HEADER edit, even a comment, changes the generated sketches' comment lines — re-export
  and commit them or `arduino-check` fails (`build_config.h` does not move). The exporter **asserts every string
  rewrite**, so rewording a `secrets.h` `#error` fails the export instead of shipping an instruction pointing nowhere.
- **BOTH cores hard-code `-std=gnu++11` and the IDE cannot override it** — arduino:avr (verified on 1.8.6 *and* 1.8.8:
  `platform.txt`, no sketch-level build-flag mechanism, no settable `extra_flags`) AND esp32:esp32, so `court_mega`
  and `door_gate` alike. The claim that the gate was exempt because it has no AVR half was wrong (corrected
  2026-09-19), and the generator was still emitting it into the sketch README until round G2. `build_unflags =
  -std=gnu++11` is a PlatformIO mechanism the IDE never sees, so **anything a sketch links must be valid C++11 as well
  as C++17**: a multi-statement `constexpr` function is green under `pio run` and red under `arduino-cli` ("body of
  'constexpr' function not a return-statement") — it cost `LockDriver.h` once — while `inline constexpr` VARIABLES
  survive as a GCC extension. **Only the arduino-cli compile in CI's `iot-build` catches this**, and it covers all
  three sketches.
- **The mirror image, on the PlatformIO side:** the AVR builder appends `-std=gnu++11` *after* `build_flags`, so
  `[common]`'s `-std=gnu++17` lost; `build_unflags = -std=gnu++11` in `[env:court_mega]` lets ours win. Latent behind
  a broken coordinate — **one broken gate hides the next.**
- **A PlatformIO coordinate is `owner/name`; two owners can publish one name at one version**
  (`johnrickman/LiquidCrystal_I2C` is Library-Manager-only; `marcoschwartz/...` is the registry one). `pio pkg search
  <name>` is the check.
- **arduino-cli cores are pinned to match the PlatformIO platforms** (`arduino:avr@1.8.6`, `esp8266:esp8266@3.1.2`
  behind the esp8266 index URL); only one version of a core installs at a time. `court_mega` is byte-identical between
  the two toolchains; the bridge differs by tens of bytes, from board defaults rather than our code.
- **PlatformIO compiles only the files inside each `test_<name>/` directory** — a shared helper in `test/support/`
  compiles and then fails to LINK, once per suite, which is why the corpus reader is header-only with everything
  `inline` — **and puts only a project's OWN `test_dir` on the include path**. The reader lives in
  `shared/test/support/` and every project reaches it by the identical `-I$PROJECT_DIR/../shared/test` line in
  `[strict_host]`, kept byte-identical even where it is redundant (2026-09-19).
- **GCC under `-fsanitize=undefined` will not fold an OBJECT'S ADDRESS in a constant expression** (2026-09-19, round
  G2), so `constexpr length(const char* s) { return s == nullptr ...; }` called as `length(kPathHeartbeat)` is "not a
  constant expression" and every `static_assert` built on it fails to COMPILE. **Apple clang folds it and is green**,
  so the class is invisible outside CI's `native_asan` job. Cure: no `== nullptr` branch in a `constexpr` helper that
  takes a literal or a `constexpr char[]` (it cannot be null there, and a null one is a dereference the compiler
  refuses — a better failure than the branch bought), and propagate grammar failure as an integer sentinel rather than
  as `nullptr`. `StaticText.h` and `ApiBaseUrl.h` carry the reasoning.
- **`build_unflags` removes EVERY matching token, including the environment's own.** Found on the gate:
  `[env:door_gate]` once unflagged `-DFW_VERSION_MINOR=0` and then set the identical token, so neither survived and
  `fwversion/Version.h`'s `#ifndef` fallback of 0 supplied it — 1.0.0 on both builds by luck. The gate now sets its
  version outright and inherits nothing (`door-gate/platformio.ini:241-243`), and `src/gate/main.cpp:105-113`
  `#error`s unless all three parts are defined and are the gate's own (the values:
  [`decisions-court-box.md`](decisions-court-box.md)); the court box unflags `[common]`'s `MAJOR=2` / `MINOR=0`
  and sets its own (a different token survives). The exporter mirrors the rule and fails if a name survives twice with
  different values.

- **Constant aggregates on the ESP8266 land in DRAM `.rodata`** (ironclad pass 2): a lizard split that passed constant
  `{key, lo, hi}` aggregates cost 48 B of a heap 72 B above the 24,576 B floor; bisected by file and replaced by a
  run-time `ConfigObject`. Tables go flash-resident (`FlashTable.h`, [`decisions-bridge.md`](decisions-bridge.md)).
