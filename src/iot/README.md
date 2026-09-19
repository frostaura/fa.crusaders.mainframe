# `src/iot` — the firmware tree

Crusaders firmware is more than one device, so this directory is more than one
PlatformIO project. Each subdirectory is a project in its own right with its own
`platformio.ini`; they share one toolchain and one set of device-agnostic
libraries, and nothing else.

| Directory | What it is |
|---|---|
| [`shared/`](shared/) | The libraries every Crusaders device needs and no device owns: rollover-safe time, the HAL ports and their fakes, hex, the firmware-version string, the device API client, the event queue, the roster cache, and `devlink` — the heartbeat body, the event-upload body, the roster push and the API circuit breaker. Builds for **no board at all**; its `platformio.ini` carries host test environments only. |
| [`court-box/`](court-box/) | The **court light box**: WeMos Mega 2560 + onboard ESP8266, four court-light relays, an LCD, a button panel and a QR scanner — plus the native simulator and the generated Arduino IDE sketches that are the flashing route. Everything here is true of *this* hardware. Start at [`court-box/README.md`](court-box/README.md). |

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
make arduino-export  # regenerate court-box/arduino/ from the sources
make arduino-check   # regenerate and fail if the committed sketches are stale
```

Flashing, the wiring, the DIP block and everything else about the court box is
in [`court-box/README.md`](court-box/README.md).

## Adding a third firmware project

1. Create `src/iot/<name>/` with its own `platformio.ini` (copy `court-box`'s
   `[platformio]`, `[common]`, `[strict_host]` and `[env]` blocks — `[env]` is
   the `lib_extra_dirs` line), plus `src/`, `lib/` and `test/`.
2. Append `<name>` to **`IOT_PROJECTS`** in the repository `Makefile`, and to
   `IOT_BUILD_PROJECTS` if it compiles for a board. That is the whole of it:
   lint, both host suites, the purity and rollover gates and the complexity
   gate all follow the list.
3. Add its jobs' paths to `.github/workflows/ci.yml` where a step names a
   project directly — the board build, the Arduino compile and the simulator
   smoke test are per-project by nature; the host-test and lint steps are not.

The purity rule (no Arduino headers anywhere under any `lib/` except
`arduino_hal/` and `posix_hal/`) and the rollover rule (never compare `millis()`
values directly — use `tb::reached` or `tb::Deadline`) apply to every project in
this tree and are gated for all of them at once.
