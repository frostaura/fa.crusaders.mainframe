---
name: crusaders-mainframe-gotchas-build
description: "Firmware and gate traps: src/iot/arduino/ is GENERATED and anything court_mega links must be valid C++11 as well as C++17; a PlatformIO coordinate is owner/name; several gates report a red run as green."
type: gotcha
last_verified: 2026-09-11
---

# Gotchas — firmware toolchain and the quality gates

- **`src/iot/arduino/` is generated output and three gates have to know it.** `make arduino-export`
  writes it from `lib/`, `src/` and `platformio.ini`'s `-D` flags; `make arduino-check` regenerates
  and fails on a diff. It holds machine-rewritten copies of `lib/` plus two vendored libraries, so
  **the clang-format file list must exclude it** — the Makefile does, and the CI job duplicates that
  list inline and needs the same. A hand-edit there is not flagged, just deleted by the next export.
- **The Arduino AVR core hard-codes `-std=gnu++11` and the IDE cannot override it** (verified on
  arduino:avr 1.8.6 *and* 1.8.8 — `platform.txt`, no sketch-level build-flag mechanism, no settable
  `extra_flags`). So the deployment route compiles `lib/` at C++11 while PlatformIO compiles it at
  C++17, and **anything `court_mega` links must be valid in both.** `inline constexpr` variables are
  fine (GCC 7.3 accepts them in C++11 as an extension); a `constexpr` function with a loop is not.
- **The mirror image, on the PlatformIO side:** the AVR builder appends `-std=gnu++11` *after*
  `build_flags` are processed, so `[common]`'s `-std=gnu++17` lost every time and nothing in `lib/`
  could compile for the Mega. `build_unflags = -std=gnu++11` in `[env:court_mega]` is what lets ours
  win. It stayed latent because a broken library coordinate stopped `pio run` getting that far —
  **one broken gate hides the next one behind it.**
- **A PlatformIO library coordinate is `owner/name`, and two owners can publish the same name at the
  same version.** `johnrickman/LiquidCrystal_I2C@1.1.4` exists only in the Arduino Library Manager
  index and has never been in the PlatformIO registry; `marcoschwartz/...@1.1.4` is the registry
  one, same API, identical version. `pio pkg search <name>` is the check, and the reason sits in a
  comment beside the line so nobody "corrects" the owner back.
- **arduino-cli cores are pinned to match the PlatformIO platforms** (`arduino:avr@1.8.6`,
  `esp8266:esp8266@3.1.2` behind the esp8266 index URL). Only one version of a core installs at a
  time, so checking a second replaces the first. `court_mega` comes out byte-identical between the
  two toolchains; the bridge differs by tens of bytes, from the generic board's default lwIP/SSL
  menu selections rather than from our code.
- **`make complexity` prints its warning to stdout and exits 1** — piping it through `tail` loses
  the exit code and reports a red gate as green. That is how a failing gate reached CI. Read `$?`.
- **lizard's `.tsx` lexer desyncs three ways** — a bare `<` in an object literal, an odd number of
  bare apostrophes in JSX text, or an inline object type inside a generic argument — each reporting
  a function nobody wrote at a length nobody wrote; the tell is that the *enclosing* component stops
  being reported at all. The cure is the text, not the code: name the type, reword the sentence,
  hoist the literal. It also measures a `.tsx` function by what it last scoped, so extracting a
  component into the *same* file can leave the number unchanged.
- **lizard's C# parser mis-scopes any expression-bodied member whose body contains braces**
  (`=> new { … }`, `=> x switch { … }`, a property pattern), dumping the rest of the file into a
  `*global*` pseudo-function whose length is the whole file — the gate trips naming no real function
  at line 0. The fix is a block body, not a whitelist entry; a method placed directly *after* an
  expression-bodied private constructor misfiles identically. Placement, not content.
- **The rollover grep gate keys on identifier NAMES and has a hole:** it catches `now >=
  expiresAtMs` but not `now >= until_[i].at`, and `at` is the deadline type's public field, so the
  naive comparison is reachable through any deadline named otherwise. The tests are the real gate.
- **`git ls-files` only matches tracked files**, so a lint target built on it silently passes on new
  work (the iot target uses `-co --exclude-standard`), and **`clang-format` output varies by
  version**, so it is pinned — an OS-provided formatter lets CI reject correctly-formatted code.
- **`-Wswitch-enum` is not satisfied by a `default:` label.** Adding one silences the single warning
  that catches a newly-added enum member; name every case and put the fallback after the brace.
- **PlatformIO compiles only the files inside each `test_<name>/` directory**, so a shared helper in
  `test/support/` compiles and then fails to link, once per suite — which is why the corpus reader is
  header-only with everything `inline`.
- **A migration file with a UTF-8 BOM fails `dotnet format` with `error CHARSET`.** `dotnet ef
  migrations add` writes one and the `.Designer.cs` keeps it; a hand-edited `.cs` must not have one.
