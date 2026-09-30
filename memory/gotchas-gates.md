---
name: crusaders-mainframe-gotchas-gates
description: "Gates that report a red run as green or trip on a function nobody wrote: complexity exits 1 on stdout, lizard's C# and .tsx lexers mis-scope (one form of it no single member causes — split the file), ls-files misses untracked work."
type: gotcha
last_verified: 2026-10-01
---

# Gotchas — the quality gates and their lint tooling

Firmware toolchain traps: [`gotchas-build.md`](gotchas-build.md). Machine- and checkout-specific
gate failures: [`gotchas-env.md`](gotchas-env.md).

- **`make complexity` prints its warning to stdout and exits 1** — piping it through `tail` loses
  the exit code and reports a red gate as green. That is how a failing gate reached CI. Read `$?`.
- **lizard's `.tsx` lexer desyncs** on: a bare `<` in an object literal, odd bare apostrophes in JSX
  text, an inline object type in a generic argument, a `//` or `data-x=""` after a braced JSX prop,
  a JSX spread prop, a component whose name recurs as a closing tag, and (R4) a quote or `[…]` class
  in a REGEX literal, a `/` or apostrophe in a TEMPLATE literal, backticks in a JSX comment — scoring
  a function nobody wrote (tell: one "grows" to the file's end). Cure the text: `new RegExp` from
  strings (`String.fromCharCode(34)`), a Set for a class, name the type; for the closing-tag form
  **move the component to its own file**. Round 2's five "grown" functions were four desyncs.
- **lizard's C# parser mis-scopes any expression-bodied member whose body contains braces**
  (`=> new { … }`, `=> x switch { … }`, a property pattern), dumping the rest of the file into a
  `*global*` pseudo-function the length of the file — the gate trips naming no real function at line
  0. The fix is a block body, not a whitelist entry; a method directly *after* an expression-bodied
  private constructor misfiles identically. Placement, not content. **It is latent under 200 lines**
  (the `*global*` length is the file's), so it trips on whoever grows the file — round 3's webhook
  edit. A positional `record` with generic parameters counts each type argument as a parameter.
- **The same `*global*` warning also has a form no single member causes.** `EmailChrome.cs` — 490
  lines, mostly raw string literals full of markup — lost its class partway down and reported
  `*global*` at 491 lines with five of ~20 members found. **Removing any one member does not fix
  it** (a bisect deleting each in turn leaves it standing): it is the *density* of raw strings,
  not one construct. The fix is **smaller files** — split into three `partial` files of ~150
  lines and it went. Try a block body first; if the warning survives every block body in the
  file, stop bisecting and split it.
- **The rollover grep gate keys on identifier NAMES and has a hole:** it catches `now >=
  expiresAtMs` but not `now >= until_[i].at`, and `at` is the deadline type's public field, so the
  naive comparison is reachable through any deadline named otherwise. The tests are the real gate.
- **`git ls-files` only matches tracked files**, so a lint target built on it silently passes on new
  work (the iot target uses `-co --exclude-standard`); **`clang-format` is pinned** because its
  output varies by version and an OS build lets CI reject correctly-formatted code.
- **`-Wswitch-enum` is not satisfied by a `default:` label** — it silences the one warning that
  catches a new enum member; name every case and put the fallback after the brace.
- **`dotnet format` runs in CI since P10** (a migration's BOM is `error CHARSET`; strip it). Locally
  run it as CI does — `--no-restore`: a failed restore also exits non-zero with NO finding, so a red
  run proves nothing until you read the output. API project only (Tests has ~700 findings).
- **A *fresh remote* session has no `dotnet` and no `pio`** — install the .NET 10 SDK and the pinned
  iot requirements first. Postgres starts without Docker from the distro's `postgresql/16/bin`;
  the local superuser is **`crusaders`**, and `pg_ctl` refuses to run as root.
- **The purity gate's exclusions are HAL directory NAMES, in three places.** `arduino_hal`,
  `posix_hal`, `esp32_hal` and now `posix_gate_hal` are listed in the Makefile's `lint-iot`, in
  `ci.yml`'s purity step AND in `court-box/tools/strict_compile.sh` — each runs in a context the
  others cannot read, so a new firmware's HAL has to be added to all three. **The names are matched
  whole**: `--exclude-dir=posix_hal` does not cover `posix_gate_hal`, and in `strict_compile.sh` the
  exclusion also governs the include path, so a HAL left in `SOURCES` but off the path fails to find
  its own headers. **The forbidden-include regex is per board family
  too**: ESP32 brought `HTTPClient`, `Preferences`, `HardwareSerial` and the whole `esp_*` /
  `driver/` / `soc/` IDF set, none of which the ESP8266 pattern matched — without extending it an
  `esp_task_wdt.h` in pure `lib/` would have broken the host build of every project at once with the
  gate green.
