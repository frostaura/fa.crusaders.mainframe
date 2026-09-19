---
name: crusaders-mainframe-gotchas-build
description: "Firmware toolchain traps: src/iot is several PlatformIO projects sharing one venv, every arduino/ tree is GENERATED and self-asserting, anything a sketch links must be valid C++11 as well as C++17, and a library coordinate is owner/name."
type: gotcha
last_verified: 2026-09-19
---

# Gotchas — the firmware toolchain

The gates that check this firmware have traps of their own:
[`gotchas-gates.md`](gotchas-gates.md); the shared JSON scanner has its own:
[`gotchas-json-scanner.md`](gotchas-json-scanner.md).

- **`pio` is always `-d <project>`, never `-d src/iot`** — several PlatformIO projects (`shared/`,
  `court-box/`) share one venv there. `IOT_PROJECTS` in the Makefile is the one place a third is
  registered and every gate derives from it; `ci.yml` still names board builds, the arduino-cli
  compile and the simulator smoke test per project by hand.
- **`src/iot/court-box/arduino/` is generated and three gates have to know it.** `make
  arduino-export` writes it from BOTH `lib/` roots, `src/` and the `-D` flags; `make arduino-check`
  fails on a diff. It holds machine-rewritten copies plus two vendored libraries, so **the
  clang-format list must exclude it** (`:(exclude)src/iot/*/arduino/**`) — the Makefile does, the CI
  job duplicates it inline. A hand-edit there is deleted by the next export, not flagged. The
  exporter **asserts every string rewrite it makes**, so rewording the bridge's `secrets.h` `#error`
  text fails the export instead of shipping an instruction pointing nowhere: fix the substitution.
- **The Arduino AVR core hard-codes `-std=gnu++11` and the IDE cannot override it** (verified on
  arduino:avr 1.8.6 *and* 1.8.8 — `platform.txt`, no sketch-level build-flag mechanism, no settable
  `extra_flags`). So the deployment route compiles both `lib/` roots at C++11 while PlatformIO
  compiles them at C++17, and **anything `court_mega` links must be valid in both.** `inline constexpr` variables are
  fine (GCC 7.3 accepts them in C++11 as an extension); a `constexpr` function with a loop is not.
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
- **PlatformIO compiles only the files inside each `test_<name>/` directory**, so a shared helper in
  `test/support/` compiles and then fails to link, once per suite — which is why the corpus reader is
  header-only with everything `inline`. **PlatformIO also puts only a project's OWN `test_dir` on
  the include path**, which is why `court-box/test/support/` was invisible to every other project.
  The reader now lives in `shared/test/support/` and every project reaches it by the same
  `-I$PROJECT_DIR/../shared/test` line in its `[strict_host]` block — that expression names the
  same directory from any of them, including from `shared` itself, where it is redundant and kept so
  the blocks stay byte-identical (2026-09-19).
- **The ESP32 core hard-codes `-std=gnu++11` too, so THE GATE'S `lib/` IS C++11-BOUND** — the
  claim that it was not, because there is no AVR half, was wrong (corrected 2026-09-19).
  `[env:door_gate]`'s `build_unflags = -std=gnu++11` is a PlatformIO mechanism the IDE never sees,
  and the IDE is the deployment route. A multi-statement `constexpr` function in `LockDriver.h`
  was green under `pio run` and red under `arduino-cli` ("body of 'constexpr' function not a
  return-statement"); `inline constexpr` VARIABLES survive as a GCC extension. **Only the
  arduino-cli compile in CI's `iot-build` catches this**, and it now covers all three sketches.
- **`build_unflags` removes EVERY matching token, including the environment's own.**
  `[env:door_gate]` unflags `-DFW_VERSION_MINOR=0` and then sets the identical token, so neither
  survives and `fwversion/Version.h`'s `#ifndef` fallback of 0 supplies it — verified on the real
  `pio run -v` line, which carries `-DFW_VERSION_MAJOR=1` and no MINOR or PATCH. 1.0.0 on both
  builds, by luck: the fallback equals the intended value. The exporter mirrors the rule and fails
  if a name survives twice with different values.
