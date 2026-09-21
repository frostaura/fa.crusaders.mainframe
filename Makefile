.PHONY: install install-iot lint lint-backend lint-frontend lint-iot format-iot build build-iot \
        sweep-icloud \
        test test-iot test-iot-asan test-integration test-e2e test-e2e-device complexity corpus-check \
        arduino-export arduino-check flash-mega flash-bridge monitor-bridge \
        virt-up virt-down ci-status up down down-reset clean

# ---------------------------------------------------------------------------
# IoT — one venv, several PlatformIO projects.
#
# src/iot holds ONE toolchain (src/iot/.venv, from src/iot/requirements.txt) and
# one directory per firmware project beside a `shared/` one that builds for no
# board at all and carries the device-agnostic libraries every firmware
# compiles. Each firmware project reaches those with `lib_extra_dirs =
# ../shared/lib`; nothing is packaged, versioned or copied.
#
# ADDING A THIRD PROJECT IS THE ONE LINE BELOW. Append its directory name to
# IOT_PROJECTS and every target here — lint, the purity and rollover gates, the
# host suites, ASAN, complexity — covers it. IOT_BUILD_PROJECTS is the subset
# that has boards to compile; `shared` has none, which is the whole point of it.
IOT_DIR = src/iot
IOT_PROJECTS = shared court-box door-gate
IOT_BUILD_PROJECTS = court-box door-gate
IOT_PROJECT_DIRS = $(addprefix $(IOT_DIR)/,$(IOT_PROJECTS))
IOT_LIB_DIRS = $(addsuffix /lib,$(IOT_PROJECT_DIRS))
IOT_SRC_DIRS = $(wildcard $(addsuffix /src,$(IOT_PROJECT_DIRS)))

# Tooling lives in one of two places, and which one says who it is FOR.
#
# $(IOT_TOOLS) — court-box/tools — is what the court box owns: gen_corpus.py
# writes that project's corpus header, and strict_compile.sh happens to live
# there for historical reasons while taking the project list and covering all of
# them.
#
# $(IOT_SHARED_TOOLS) — src/iot/tools — is project-neutral and takes --project.
# The Arduino exporter moved here when the door gate needed one: a court-box
# script that generated the gate's flashing route would have been a lie about
# who owns what, and "the gate can only be flashed from PlatformIO" was a
# go-live blocker precisely because nobody wanted to touch a court-box file to
# fix it.
IOT_TOOLS = $(IOT_DIR)/court-box/tools
IOT_SHARED_TOOLS = $(IOT_DIR)/tools

# Every project with a generated Arduino IDE sketch folder. Both of them: the
# court box's two sketches and the gate's one.
IOT_ARDUINO_PROJECTS = court-box door-gate
IOT_ARDUINO_DIRS = $(foreach p,$(IOT_ARDUINO_PROJECTS),$(IOT_DIR)/$(p)/arduino)

# IOT_VENV is overridable so `make install-iot` can be proven into a scratch
# path without disturbing the working one.
IOT_VENV ?= $(IOT_DIR)/.venv
PIO ?= $(IOT_VENV)/bin/pio
PY  ?= $(IOT_VENV)/bin/python
# Pinned via src/iot/requirements.txt: formatter output varies by version.
CLANG_FORMAT ?= $(IOT_VENV)/bin/clang-format

# The board's USB serial port. Overridable; otherwise the flash targets wait for
# one to appear. Bluetooth-Incoming-Port and debug-console are always present on
# a Mac and are never the box, so they are filtered out rather than picked.
UPLOAD_PORT ?=
FIND_PORT = ls /dev/cu.* 2>/dev/null | grep -v -e Bluetooth -e debug-console | head -1

# Waits up to 60 s for a port and leaves it in $$port. One line, because a make
# recipe is one shell per line and every flash target needs the same preamble.
WAIT_FOR_PORT = port="$(UPLOAD_PORT)"; \
	if [ -z "$$port" ]; then \
	  printf 'Waiting for a USB serial port (/dev/cu.*)'; \
	  for _ in $$(seq 1 60); do \
	    port=$$($(FIND_PORT)); \
	    if [ -n "$$port" ]; then break; fi; \
	    printf '.'; sleep 1; \
	  done; \
	  printf '\n'; \
	fi; \
	if [ -z "$$port" ]; then \
	  echo "No /dev/cu.* port appeared in 60s."; \
	  echo "  - is the box plugged in and powered?"; \
	  echo "  - if a port NEVER appears: brew install --cask wch-ch34x-usb-serial-driver, then replug"; \
	  echo "  - or name it yourself: UPLOAD_PORT=/dev/cu.usbserial-XXXX"; \
	  exit 1; \
	fi; \
	echo "Port: $$port"

# Install all dependencies
install: install-iot
	cd src/backend && dotnet restore Crusaders.Mainframe.Api/Crusaders.Mainframe.Api.csproj && dotnet restore Crusaders.Mainframe.Tests/Crusaders.Mainframe.Tests.csproj
	cd src/frontend && npm install

# Install the IoT toolchain into $(IOT_VENV).
#
# uv, not `python3 -m venv`: the system python3 on macOS is 3.9 and gcovr needs
# 3.10+, so the plain venv was created and then died half-installed, leaving no
# `pio` and a confusing error several screens up.
install-iot:
	@command -v uv >/dev/null || (echo "uv is required and is not installed. Run: brew install uv" && exit 1)
	uv venv --python 3.12 $(IOT_VENV)
	VIRTUAL_ENV=$$(cd $(IOT_VENV) && pwd) uv pip install --quiet -r $(IOT_DIR)/requirements.txt
	@echo "IoT toolchain ready in $(IOT_VENV)"

# Lint
lint: lint-backend lint-frontend lint-iot

lint-backend:
	cd src/backend && dotnet format --verify-no-changes --no-restore Crusaders.Mainframe.Api/Crusaders.Mainframe.Api.csproj || (echo "Run 'cd src/backend && dotnet format' to fix" && exit 1)

lint-frontend:
	cd src/frontend && npm run lint

# The formatter's file list. Every iot project's sources, generated sketches
# excluded: each project's arduino/ is written by `make arduino-export` and
# holds machine-rewritten copies of these same sources plus, for the court box,
# two vendored third-party libraries. Formatting generated output would either
# fight the generator or reformat code that is not ours, and the originals under
# each project's lib/ and src/ are already covered here. The exclude glob is
# per-project (`*/arduino/**`), so the gate's sketch folder was covered the day
# it appeared.
IOT_FORMAT_FILES = git ls-files -co --exclude-standard \
	'$(IOT_DIR)/**/*.cpp' '$(IOT_DIR)/**/*.h' ':(exclude)$(IOT_DIR)/*/arduino/**'

# Lint — IoT firmware. Formatting, the purity rule, and the strict compile gate.
# All three cover every project in IOT_PROJECTS: the HAL implementations are
# spread across all three project directories — arduino_hal under court-box/lib,
# posix_hal under shared/lib, esp32_hal and posix_gate_hal under door-gate/lib —
# and a gate that looked at one project would leave the shared libraries, the
# ones compiled into ALL the firmwares, checked by nothing.
#
# The purity exclusions are the HAL-IMPLEMENTATION directories, by name: one per
# board family plus one per SIMULATOR. `--exclude-dir` matches a whole directory
# name, so posix_gate_hal needs its own entry and is not covered by posix_hal's.
# A new firmware's HAL has to be added to this list AND to the same list in
# .github/workflows/ci.yml AND in court-box/tools/strict_compile.sh, or the gate
# fails on the one directory that is allowed to include what it includes.
#
# The header families are likewise per-board. ESP32 brought four the ESP8266
# never had — HTTPClient, Preferences, HardwareSerial and the whole esp_* IDF
# set — and a regex that only knew the 8266's would have let an esp_task_wdt.h
# into pure lib/ and broken the host build of every project at once.
lint-iot:
	$(CLANG_FORMAT) --dry-run -Werror $$($(IOT_FORMAT_FILES))
	$(IOT_TOOLS)/strict_compile.sh $(IOT_PROJECTS)
	@! grep -rn --include=*.h --include=*.cpp \
	    -E '#include *<(Arduino|WiFi|ESP8266|Wire|LiquidCrystal|HTTPClient|Preferences|HardwareSerial|EEPROM|SPI|esp_|driver/|soc/)' \
	    $(IOT_LIB_DIRS) --exclude-dir=arduino_hal --exclude-dir=posix_hal --exclude-dir=esp32_hal \
	    --exclude-dir=posix_gate_hal \
	  || (echo 'pure lib/ must not include Arduino headers' && exit 1)
	@! grep -rnE '(>=|<=|>|<) *[A-Za-z_]*([Dd]eadline|[Ee]xpires|[Aa]tMs)|millis\(\) *(>=|<=|>|<)|(>=|<=|>|<) *millis\(\)|(>=|<=|>|<) *[A-Za-z_][A-Za-z0-9_]*\.at\b' \
	    $(IOT_LIB_DIRS) $(IOT_SRC_DIRS) --include=*.cpp --include=*.h 2>/dev/null | grep -v 'lib/timebase' \
	  || (echo 'raw deadline comparison — use tb::reached / tb::Deadline' && exit 1)

format-iot:
	$(CLANG_FORMAT) -i $$($(IOT_FORMAT_FILES))

# Build
build: lint build-iot
	cd src/backend && dotnet build Crusaders.Mainframe.Api/Crusaders.Mainframe.Api.csproj --nologo -v q && dotnet build Crusaders.Mainframe.Tests/Crusaders.Mainframe.Tests.csproj --nologo -v q
	cd src/frontend && npm run build

# Build — IoT firmware for every target board plus the native simulator.
#
# Only IOT_BUILD_PROJECTS: `shared` compiles for no board by design, and asking
# PlatformIO to `run` it would be asking it to build nothing and say so.
#
# The ENVIRONMENTS are named per project rather than looped, because they are
# per project by nature — each board project has its boards AND its native
# simulator, and `pio run` with no `-e` would also build each project's test
# environments for nothing. A fourth project is a fourth line here.
#
# BOTH SIMULATORS ARE BUILT HERE, and both are needed by `make test-e2e-device`:
# the court box's is the Mega half of `scenario.py`, and the gate's is the real
# firmware in `door_evening.py`. Neither needs a secrets.h — a simulator takes
# its API base URL and device key at run time.
#
# Both board projects `#error` without their own src/common/secrets.h, which is
# gitignored. That is what stops an image being built with a blank in it; it also
# means this target cannot run on a fresh checkout until both exist.
build-iot: sweep-icloud
	$(PIO) run -d $(IOT_DIR)/court-box -e court_mega -e court_bridge -e simulator
	$(PIO) run -d $(IOT_DIR)/door-gate -e door_gate -e simulator

# Delete iCloud's fabricated `Name 2.h` / `program 3` copies from under src/iot.
#
# This is a prerequisite of the three targets that iCloud actually breaks rather
# than a chore somebody remembers, because the failure it causes does not look
# like a filesystem problem. 564 of these accumulated under .pio/build and the
# generated arduino tree, and every native suite then failed to LINK on
# `duplicate symbol _unityOutputFlush` — which reads as a broken test harness,
# and cost real time before anybody thought to run `find`.
#
# It CANNOT delete a tracked file: it asks git for the tracked set first and
# deletes nothing in it, and if git cannot answer it deletes nothing at all and
# fails. A duplicate that IS tracked fails the run rather than being swept — a
# committed `Foo 2.cpp` is a problem for a person, and 27 of them were committed
# once. See the script's header.
sweep-icloud:
	@$(PY) $(IOT_SHARED_TOOLS)/sweep_icloud_duplicates.py

# Tests — unit
test: test-iot
	cd src/backend && dotnet test Crusaders.Mainframe.Tests/Crusaders.Mainframe.Tests.csproj --nologo -v q
	cd src/frontend && npm run test -- --run

# Tests — IoT native unit/property/corpus suites, one per project in
# IOT_PROJECTS. Fails hard if pio is missing: the repo already carries two
# silent-pass escape hatches and must not gain a third.
#
# A `for` loop rather than one pio invocation because each project is its own
# PlatformIO project with its own platformio.ini. `set -e` inside the loop is
# what makes a red suite in the FIRST project fail the target — without it the
# loop runs on and the recipe reports the last project's status only.
test-iot: sweep-icloud
	@set -e; for p in $(IOT_PROJECTS); do \
	  echo "== $$p =="; $(PIO) test -d $(IOT_DIR)/$$p -e native; \
	done

test-iot-asan: sweep-icloud
	@set -e; for p in $(IOT_PROJECTS); do \
	  echo "== $$p =="; $(PIO) test -d $(IOT_DIR)/$$p -e native_asan; \
	done

# Tests — integration. Runs the WHOLE suite with Postgres reachable: the
# Postgres-backed classes gate themselves on API_BOUNDARY_TEST_CONNECTION_STRING,
# and a class-name filter here is how the postgres-http tier silently ran nowhere.
test-integration:
	cd src/backend && dotnet test Crusaders.Mainframe.Tests/Crusaders.Mainframe.Tests.csproj --nologo -v q

# Regenerate everything generated from the wire contract and fail if a committed
# copy is stale. Nothing else runs these generators, so an edited generator with
# a forgotten regeneration leaves both suites green against the old vectors.
#
# TWO generators, because the two families are generated in opposite directions.
# The court box's bakes cases.json into a C++ header, so the header is the
# derived file. The gate's WRITES cases.json and manifest.json from shapes in
# Python — the corpus itself is the derived file — and its C++ suite reads them
# at run time. This target covered only the first of the two for as long as the
# gate family has existed, so an edited gen_cases.py that nobody ran was a
# corpus that agreed with neither side.
#
# Both diffs are evaluated before the target fails, so one stale family does not
# hide the other.
CORPUS_GENERATED = $(IOT_DIR)/court-box/test/test_protocol/corpus_generated.h \
	src/contracts/device-protocol/gate/cases.json \
	src/contracts/device-protocol/gate/manifest.json

corpus-check:
	$(PY) $(IOT_TOOLS)/gen_corpus.py
	$(PY) src/contracts/device-protocol/gate/gen_cases.py
	@git diff --exit-code --stat -- $(CORPUS_GENERATED) \
	  || (echo "generated corpus files are stale — rerun the generators and commit" && exit 1)
	@untracked="$$(git ls-files --others --exclude-standard -- $(CORPUS_GENERATED))"; \
	if [ -n "$$untracked" ]; then \
	  echo "a generator produced files that are not committed:"; echo "$$untracked"; exit 1; \
	fi

# Regenerate the Arduino IDE sketch folders from the PlatformIO sources.
#
# The IDE is the DEPLOYMENT route for EVERY board this repo ships — open the
# sketch, pick the board and the port, Upload — and PlatformIO stays the tested
# build. The people who flash boards at the club do not have PlatformIO, so a
# firmware with no sketch folder is a firmware nobody at the club can put on a
# wall.
#
# Two builds of the same firmware only stay the same firmware if the second one
# is derived, so nothing under any arduino/ directory is ever hand-edited: each
# is regenerated from its project's lib/, the shared libraries in
# ../shared/lib/, its src/ and the -D flags in its platformio.ini — with
# build_unflags applied, which is what makes the gate report 1.0.0 rather than
# the 2.0.0 that [common] pins for the court box — and with third-party
# libraries copied out of .pio/libdeps so the IDE needs nothing from the Library
# Manager.
#
# No --project: the exporter does every project it knows about. Needs `make
# build-iot` first, because that is what resolves lib_deps. This target never
# reaches the network.
arduino-export: build-iot
	$(PY) $(IOT_SHARED_TOOLS)/arduino_export.py

# Regenerate and fail if the committed sketches are stale — same shape as
# corpus-check, for the same reason: nothing else runs the generator, so an
# edited platformio.ini or lib/ file with a forgotten export leaves a technician
# flashing last week's firmware from a folder that looks current.
#
# BOTH checks run for EVERY project before the target fails, so one stale tree
# does not hide another. The untracked check is not redundant with the diff:
# `git diff` says nothing about a file that has never been added, and a NEW
# generated file that nobody committed is exactly what a new sketch folder is
# made of.
arduino-check: arduino-export
	@failed=""; \
	for dir in $(IOT_ARDUINO_DIRS); do \
	  if ! git diff --exit-code --quiet -- "$$dir"; then \
	    echo "$$dir is stale — run 'make arduino-export' and commit:"; \
	    git diff --stat -- "$$dir"; \
	    failed="$$failed $$dir"; \
	  fi; \
	  untracked="$$(git ls-files --others --exclude-standard -- "$$dir")"; \
	  if [ -n "$$untracked" ]; then \
	    echo "$$dir gained generated files that are not committed."; \
	    echo "Stage these files BY PATH and commit them:"; \
	    echo "$$untracked" | sed 's/^/  /'; \
	    echo "Do NOT 'git add' the directory: on an iCloud checkout it holds"; \
	    echo "hundreds of fileprovider duplicates ('Name 2.h', 'program 3')"; \
	    echo "that 'make sweep-icloud' deletes and nothing should ever commit."; \
	    failed="$$failed $$dir"; \
	  fi; \
	done; \
	if [ -n "$$failed" ]; then exit 1; fi; \
	for dir in $(IOT_ARDUINO_DIRS); do echo "$$dir is up to date"; done

# Flash the ATmega2560 over USB.
#
# The DIP block routes ONE USB socket to one of the two chips, so every flash is
# a switch change first. The positions below are the project wiring sheet's and
# the hardware is fixed: nothing here is negotiable, and getting DIP 1/2 wrong
# means avrdude talks to the ESP8266 and times out looking like a dead board.
flash-mega:
	@echo "DIP switches for a MEGA upload:  1 OFF  2 OFF  3 ON  4 ON  5-8 OFF"
	@echo "Set them now, then leave the box powered."
	@$(WAIT_FOR_PORT); \
	$(PIO) run -d $(IOT_DIR)/court-box -e court_mega -t upload --upload-port "$$port"
	@echo ""
	@echo "Done. Restore the RUN positions:  1 ON  2 ON  3 ON  4 ON  5-8 OFF"

# Flash the ESP8266 over USB, then watch it.
#
# Refuses without secrets.h, rather than building an image with a blank in it —
# court_bridge/main.cpp #errors on a missing value and static_asserts on an
# empty one; this is the friendlier half of the same rule, before twenty seconds
# of compiler output.
flash-bridge:
	@test -f $(IOT_DIR)/court-box/src/common/secrets.h || ( \
	  echo "$(IOT_DIR)/court-box/src/common/secrets.h is missing."; \
	  echo "  cp $(IOT_DIR)/court-box/src/common/secrets.h.example $(IOT_DIR)/court-box/src/common/secrets.h"; \
	  echo "  then fill in all four values (it is gitignored):"; \
	  echo "    WIFI_SSID  WIFI_PASSWORD  API_BASE_URL  DEVICE_API_KEY"; \
	  exit 1)
	@echo "DIP switches for an ESP8266 upload:  1-4 OFF  5 ON  6 ON  7 ON  8 OFF"
	@echo "Set them now, then leave the box powered."
	@$(WAIT_FOR_PORT); \
	$(PIO) run -d $(IOT_DIR)/court-box -e court_bridge -t upload --upload-port "$$port"
	@echo ""
	@echo "Uploaded. Now set DIP  5 ON  6 ON  7 OFF  (1-4 OFF) to watch it boot;"
	@echo "the monitor opens next. Ctrl-C to leave it."
	@$(MAKE) monitor-bridge

# Watch the ESP8266's UART on the USB socket.
#
# 9600, from platformio.ini: that UART IS the Mega link and its baud is fixed by
# Pins.h. A monitor at 115200 shows framing garbage that reads as a dead board.
# In this DIP position the Mega is NOT on the other end, so the LCD shows
# nothing new until DIP 1 and 2 go back on.
monitor-bridge:
	@echo "DIP switches to monitor the ESP:  1-4 OFF  5 ON  6 ON  7 OFF  8 OFF"
	@$(WAIT_FOR_PORT); \
	$(PIO) device monitor -d $(IOT_DIR)/court-box -e court_bridge --port "$$port"

# Tests — Playwright e2e.
#
# PLAYWRIGHT_CHROMIUM_PATH lets a runner that already ships a browser be used instead
# of downloading a few hundred megabytes to get one that differs by a revision number.
# Unset, Playwright uses its own and a developer machine needs no setup.
test-e2e:
	cd src/frontend && npx playwright test

# Tests — end-to-end proof of the device chain without hardware. TWO scenarios.
#
# `scenario.py` is the COURT BOX: real API from source against a fresh Postgres
# database, the firmware's native simulator (the Mega half) over TCP, and the
# PayFast mountebank imposter — the script plays the ESP8266 bridge, the member's
# phone, the admin and PayFast.
#
# `door_evening.py` is the DOOR, and it is not a second copy of that: it reuses the
# same bootstrap and then reads every device response THE WAY THE BOARD DOES — a raw
# socket speaking HTTP/1.0 with `Connection: close`, plus a pass over HTTP/1.1 on a
# kept-open connection de-chunked by hand, and through the real `nginx` gateway where
# one is installed. That is the one thing no other suite here can see: round G3 found
# the API answering every device route `Transfer-Encoding: chunked` on a keep-alive
# connection, against which the firmware's reader timed out on EVERY call — no
# roster, and a door that refused everyone, with nothing red anywhere.
#
# AND ITS `DSIM` SECTION RUNS THE REAL DOOR FIRMWARE, which is why the gate's
# simulator is built on the line above it. `wire.py` reads the server the way a board
# would; the simulator IS a board — the same GateApp loop, the same GateFlow status
# table, the same ResponseBody de-chunker — over a real socket to the same API.
#
# Both print `finding-id -> assertion` and exit non-zero on any failed assertion. The
# door needs `psql` on PATH (it places bookings at hours the admin API will not) and
# it is run second, because it is the longer of the two and the shorter one failing
# first is the cheaper signal. What each does and does not prove:
# test/e2e-device/README.md.
#
# Postgres: whatever answers on E2E_PG_HOST:E2E_PG_PORT (default localhost:5439,
# the throwaway `crusaders-fixprog-pg` container, started via docker if absent). A
# fresh database is created per run and dropped on success. DOTNET, PIO and PY are
# overridable like everywhere else in this file. E2E_REQUIRE_GATEWAY=1 turns "no
# nginx on PATH" from a note into a failure — CI sets it, so the gateway pass cannot
# go quiet there.
test-e2e-device:
	"$(PIO)" run -d $(IOT_DIR)/court-box -e simulator
	DOTNET="$${DOTNET:-dotnet}" PIO="$(PIO)" "$(PY)" test/e2e-device/scenario.py
	"$(PIO)" run -d $(IOT_DIR)/door-gate -e simulator
	DOTNET="$${DOTNET:-dotnet}" "$(PY)" test/e2e-device/door_evening.py

# Service virtualization as plain processes.
#
# Deliberately NOT Docker-only. The daemon is unavailable in some CI setups and a
# suite that can only run under Docker is a suite that quietly stops running.
# docker-compose.test.yml offers the same two services as sidecars for machines that
# prefer them, reading the same imposter file.
virt-up: build-iot
	@command -v npx >/dev/null || (echo "npx is required for the PayFast imposter" && exit 1)
	npx --yes mountebank@2.9.1 start --configfile test/virtualization/payfast/imposter.json --pidfile /tmp/crusaders-mb.pid &
	$(IOT_DIR)/court-box/.pio/build/simulator/program --port $${SIMULATOR_PORT:-5555} & echo $$! > /tmp/crusaders-sim.pid
	@echo "PayFast imposter on :4545 (admin :2525) · device simulator on :$${SIMULATOR_PORT:-5555}"
	@echo "See test/virtualization/README.md for what each case is and how to provoke it."

virt-down:
	-@kill "$$(cat /tmp/crusaders-sim.pid 2>/dev/null)" 2>/dev/null || true
	-@npx --yes mountebank@2.9.1 stop --pidfile /tmp/crusaders-mb.pid 2>/dev/null || true
	-@rm -f /tmp/crusaders-sim.pid /tmp/crusaders-mb.pid

# Complexity — one tool, three languages. Thresholds are measured, not decreed.
complexity:
	$(PY) -m lizard $(IOT_LIB_DIRS) $(IOT_SRC_DIRS) src/backend/Crusaders.Mainframe.Api src/frontend/src \
	  -C 15 -L 200 -a 6 -W whitelizard.txt \
	  -x '*/Migrations/*' -x '*/node_modules/*' -x '*/.pio/*' -x '*/.venv/*' \
	  -x '*/bin/*' -x '*/obj/*' -x '*.test.tsx' -x '*.test.ts' -w

# CI status (latest workflow run)
ci-status:
	@gh auth status >/dev/null 2>&1 || (echo "gh is not authenticated. Run 'gh auth login' or set GH_TOKEN." && exit 1)
	@gh run list --workflow ci.yml --limit 1 --json databaseId,status,conclusion,headBranch,displayTitle,createdAt --template '{{range .}}{{printf "run=%v status=%v conclusion=%v branch=%v title=%q created=%v\n" .databaseId .status .conclusion .headBranch .displayTitle .createdAt}}{{end}}'

# Compose
up:
	docker compose up --build -d
	@echo "App at http://localhost:$${GATEWAY_PORT:-8088} · Mailhog at http://localhost:$${MAILHOG_UI_PORT:-8025}"

down:
	docker compose down

down-reset:
	docker compose down -v

# Clean build artifacts
clean:
	cd src/backend && dotnet clean --nologo -v q
	cd src/frontend && rm -rf dist node_modules/.cache
