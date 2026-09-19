---
name: crusaders-mainframe-gotchas-gates
description: "Several quality gates report a red run as green or trip on a function nobody wrote: complexity exits 1 on stdout, lizard's C# and .tsx lexers mis-scope, the rollover grep keys on names, and ls-files misses untracked work."
type: gotcha
last_verified: 2026-09-19
---

# Gotchas — the quality gates and their lint tooling

The firmware toolchain underneath these has traps of its own:
[`gotchas-build.md`](gotchas-build.md). Machine- and checkout-specific gate
failures are in [`gotchas-env.md`](gotchas-env.md).

- **`make complexity` prints its warning to stdout and exits 1** — piping it through `tail` loses
  the exit code and reports a red gate as green. That is how a failing gate reached CI. Read `$?`.
- **lizard's `.tsx` lexer desyncs three ways** — a bare `<` in an object literal, an odd number of
  bare apostrophes in JSX text, or an inline object type inside a generic argument — each reporting a
  function nobody wrote; the tell is that the *enclosing* component stops being reported at all. The
  cure is the text, not the code: name the type, reword the sentence, hoist the literal.
- **lizard's C# parser mis-scopes any expression-bodied member whose body contains braces**
  (`=> new { … }`, `=> x switch { … }`, a property pattern), dumping the rest of the file into a
  `*global*` pseudo-function the length of the file — the gate trips naming no real function at line
  0. The fix is a block body, not a whitelist entry; a method directly *after* an expression-bodied
  private constructor misfiles identically. Placement, not content.
- **The rollover grep gate keys on identifier NAMES and has a hole:** it catches `now >=
  expiresAtMs` but not `now >= until_[i].at`, and `at` is the deadline type's public field, so the
  naive comparison is reachable through any deadline named otherwise. The tests are the real gate.
- **`git ls-files` only matches tracked files**, so a lint target built on it silently passes on new
  work (the iot target uses `-co --exclude-standard`); **`clang-format` is pinned** because its
  output varies by version and an OS build lets CI reject correctly-formatted code.
- **`-Wswitch-enum` is not satisfied by a `default:` label.** Adding one silences the single warning
  that catches a newly-added enum member; name every case and put the fallback after the brace.
- **A migration file with a UTF-8 BOM fails `dotnet format` with `error CHARSET`.** `dotnet ef
  migrations add` writes one and the `.Designer.cs` keeps it; a hand-edited `.cs` must not have one.
- **A *fresh remote* session has no `dotnet` and no `pio`** — install the .NET 10 SDK and the pinned
  iot requirements before trusting any gate result there. Postgres starts without Docker from the
  distro's `postgresql/16/bin`; the superuser on a locally-initialised cluster is **`crusaders`**,
  and `pg_ctl` refuses to run as root.
- **The purity gate's exclusions are HAL directory NAMES, in three places.** `arduino_hal`,
  `posix_hal` and now `esp32_hal` are listed in the Makefile's `lint-iot`, in `ci.yml`'s purity step
  AND in `court-box/tools/strict_compile.sh` — each runs in a context the others cannot read, so a
  new firmware's HAL has to be added to all three. **The forbidden-include regex is per board family
  too**: ESP32 brought `HTTPClient`, `Preferences`, `HardwareSerial` and the whole `esp_*` /
  `driver/` / `soc/` IDF set, none of which the ESP8266 pattern matched — without extending it an
  `esp_task_wdt.h` in pure `lib/` would have broken the host build of every project at once with the
  gate green.
