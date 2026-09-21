# `src/iot` — the firmware tree

Crusaders firmware is more than one device, so this directory is more than one
PlatformIO project. Each subdirectory is a project in its own right with its own
`platformio.ini`; they share one toolchain and one set of device-agnostic
libraries, and nothing else.

| Directory | What it is |
|---|---|
| [`tools/`](tools/) | Project-neutral firmware tooling: the Arduino IDE exporter (`--project`, or every project) and the iCloud duplicate sweep. Nothing here knows about one board. |
| [`shared/`](shared/) | The libraries every Crusaders device needs and no device owns: rollover-safe time, the HAL ports and their fakes, hex, the firmware-version string, the device API client, the event queue, the roster cache, and `devlink` — the heartbeat body, the event-upload body, the roster push and the API circuit breaker. Builds for **no board at all**; its `platformio.ini` carries host test environments only. |
| [`court-box/`](court-box/) | The **court light box**: WeMos Mega 2560 + onboard ESP8266, four court-light relays, an LCD, a button panel and a QR scanner — plus the native simulator and the generated Arduino IDE sketches that are the flashing route. Everything here is true of *this* hardware. Start at [`court-box/README.md`](court-box/README.md). |
| [`door-gate/`](door-gate/) | The **door gate**: one ESP32 per door, a QR scanner on `Serial2`, one relay on the lock and one LED — plus its own native simulator and the generated Arduino IDE sketch that is its flashing route. Pull-only, online-first with a roster fallback, and a lock asserted LOCKED before its pin is ever an output. Start at [`door-gate/README.md`](door-gate/README.md). |

**Both board projects have a native simulator**, and the two exist for the same
reason: a stub only ever agrees with itself, because both ends of the
conversation get written from one reading of the spec. The court box's is the
Mega half behind a TCP socket; the gate's is the whole board, making real HTTP
calls to a real API. `test/e2e-device/` drives both.

A firmware project reaches the shared libraries with one line in its own
`platformio.ini`:

```ini
[env]
lib_extra_dirs = ../shared/lib
```

PlatformIO's library dependency finder then treats `../shared/lib` exactly like
the project's own `lib/`, compiling each module from source into whichever
target includes it. There is no package, no version pin and no copy — one source
of truth, compiled once per target.

## Which directory does a module go in?

**`shared/lib` if a second, unrelated Crusaders device would still want it.**
A module that knows about a relay, a DIP switch, a court, or the Mega↔ESP serial
dialect belongs to the firmware project that owns that hardware, however
reusable it looks. The test is not "could this be shared" — almost anything
could — it is "would a device with different hardware want this *unchanged*".

Where a shared module and a device-specific one genuinely have to agree about
something, the assertion lives on the **device** side, which knows about both.
`court-box/lib/bridgelogic/RosterTokenFits.h` is the worked example: the roster's
token length must fit a `!SCAN` argument, `roster/` must not depend on the
protocol to state its own limit, and `devlink/` must not drag one box's codec
into every firmware — so the `static_assert` sits in the court box's own library
and is compiled by its board build and its host suite.

## One toolchain for all of them

`src/iot/.venv` (Python 3.12, from [`requirements.txt`](requirements.txt)) holds
`pio`, `lizard`, `gcovr` and the pinned `clang-format` for **every** project
here. It is created once:

```bash
brew install uv       # the installer make install-iot uses
make install-iot      # creates src/iot/.venv from src/iot/requirements.txt
```

Every `Makefile` variable — `PIO`, `PY`, `CLANG_FORMAT` — points into that one
venv, and every `make` target below drives whichever projects it needs.

## The targets, from the repository root

```bash
make test-iot        # every project's Unity suite on the host — no board needed
make test-iot-asan   # the same suites under ASAN + UBSAN
make lint-iot        # clang-format, strict compile, purity + rollover gates — ALL projects
make build-iot       # compile every target board plus the native simulator
make complexity      # cyclomatic complexity, all three languages
make corpus-check    # regenerate the corpus-baked headers, fail if stale
make arduino-export  # regenerate EVERY project's arduino/ from the sources
make arduino-check   # regenerate and fail if the committed sketches are stale
```

Flashing, the wiring, the DIP block and everything else about the court box is
in [`court-box/README.md`](court-box/README.md); the gate's equivalent is in
[`door-gate/README.md`](door-gate/README.md). Each project's **generated**
`arduino/README.md` is the one to hand somebody who is standing at the club with
a screwdriver — it is written for them and for the board in front of them.

## Adding a fourth firmware project

1. Create `src/iot/<name>/` with its own `platformio.ini` (copy `door-gate`'s
   `[platformio]`, `[common]`, `[strict_host]` and `[env]` blocks — `[env]` is
   the `lib_extra_dirs` line). `[common]` and `[strict_host]` are kept
   **byte-identical across every project**: the shared libraries are compiled by
   all of them, and a flag that differs between them is a library that behaves
   differently depending on which suite ran it. A firmware with its own version
   number unflags `[common]`'s `FW_VERSION_*` in its BOARD environment rather
   than editing that block — see `door-gate`'s `[env:door_gate]`.
2. Add `src/`, `lib/` and `test/`.
3. Append `<name>` to **`IOT_PROJECTS`** in the repository `Makefile`, and to
   `IOT_BUILD_PROJECTS` if it compiles for a board. That covers lint, every host
   suite, the purity and rollover gates and the complexity gate, which all follow
   the list — but NOT `build-iot`, whose environments are named per project
   because they are per project by nature.
4. Add its steps to `.github/workflows/ci.yml` where one names a project
   directly: the board build, the throwaway `secrets.h`, the purity, rollover and
   complexity path lists, the Arduino core install and compile, and the simulator
   smoke test. The host-test and lint steps follow the Makefile's list and need
   nothing.
5. If it is flashed from the Arduino IDE — which it is, unless nobody at the
   club will ever flash it — give it an entry in `tools/arduino_export.py`'s
   `PROJECTS` table and add its directory name to the Makefile's
   `IOT_ARDUINO_PROJECTS`. See *The Arduino IDE export covers every board*
   below.
6. If it has a HAL-implementation directory, add that directory's NAME to the
   purity exclusions in **three** places — `Makefile`'s `lint-iot`,
   `ci.yml`'s purity step, and `court-box/tools/strict_compile.sh` — and extend
   the forbidden-include regex with any header family the new board brings.
   ESP32 brought `HTTPClient`, `Preferences`, `HardwareSerial` and the whole
   `esp_*` / `driver/` / `soc/` IDF set, none of which the ESP8266 pattern knew.

The purity rule (no Arduino headers anywhere under any `lib/` except the HAL
implementations named above) and the rollover rule (never compare `millis()`
values directly — use `tb::reached` or `tb::Deadline`) apply to every project in
this tree and are gated for all of them at once.

### The Arduino IDE export covers every board

`make arduino-export` generates a sketch folder for **every** firmware project
that has one — `court-box/arduino/` (two sketches) and `door-gate/arduino/`
(one) — and `make arduino-check` regenerates both and fails on a diff or on an
uncommitted generated file. The IDE is the deployment route for all of them,
because the people who flash boards at the club do not have PlatformIO.

The generator is [`tools/arduino_export.py`](tools/), **not** a court-box file:
it takes `--project` (repeatable; no flag means every project) and keeps
everything project-specific — the target list, the secrets rewrite tables, the
core pins, the board index URL and the README template — in the one
`project_configs()` table. Its mechanical half is shared: the `platformio.ini`
reader, the `#include` closure across both library roots, the include rewriting,
the `lib_deps` vendoring, the `build_config.h` emitter and the iCloud duplicate
sweep.

**Adding a fourth project's sketch** is one entry in that table — targets (env,
`src/` subdirectory, sketch name, secrets rewrites, FQBN), the core pin beside
its PlatformIO platform, the board index URL, and a README renderer — plus its
directory name in the Makefile's `IOT_ARDUINO_PROJECTS` and an `arduino-cli
core install` and `compile` line in `ci.yml`'s `iot-build` job.

Two rules the generator enforces rather than documents:

- **`build_unflags` is applied by exact token, exactly as PlatformIO applies
  it**, and a name left defined twice with different values fails the export.
  That is what makes the gate's `build_config.h` say `FW_VERSION_MAJOR 1` while
  `[common]` pins 2 for the court box. It also means a flag whose unflag token
  matches it exactly is removed *entirely* — the gate's `FW_VERSION_MINOR=0` and
  `FW_VERSION_PATCH=0` are unflagged and re-set to the same value, so neither
  reaches the compiler on either build and `fwversion/Version.h`'s `#ifndef`
  fallback of 0 supplies both. Verified against the real `pio run -v` compile
  line, which carries `-DFW_VERSION_MAJOR=1` and neither of the other two.
- **The forbidden host-only libraries (`posix_hal`, `posix_gate_hal`,
  `hal_fakes`) fail the export from any project**, not only from the one whose
  `lib/` owns them. Their include namespaces are derived by scanning every
  project under `src/iot`, because `posix_hal` used to live in `court-box/lib`
  and was therefore invisible to the gate's closure — an `#include
  "posix_hal/…"` there was silently not vendored rather than refused, and
  surfaced later as a missing header from `arduino-cli`. `posix_hal` is in
  `shared/lib` now and `posix_gate_hal` is in `door-gate/lib`, so the scan is
  still what makes the rule fire from either direction.
