.PHONY: install lint lint-backend lint-frontend lint-iot format-iot build build-iot \
        test test-iot test-iot-asan test-integration test-e2e complexity corpus-check \
        virt-up virt-down ci-status up down down-reset clean

# IoT toolchain lives in a venv so `pio` and `lizard` are pinned per-checkout
PIO ?= src/iot/.venv/bin/pio
PY  ?= src/iot/.venv/bin/python
# Pinned via src/iot/requirements.txt: formatter output varies by version.
CLANG_FORMAT ?= src/iot/.venv/bin/clang-format

# Install all dependencies
install:
	cd src/backend && dotnet restore Crusaders.Mainframe.Api/Crusaders.Mainframe.Api.csproj && dotnet restore Crusaders.Mainframe.Tests/Crusaders.Mainframe.Tests.csproj
	cd src/frontend && npm install
	python3 -m venv src/iot/.venv
	$(PY) -m pip install --quiet --upgrade pip
	$(PY) -m pip install --quiet -r src/iot/requirements.txt

# Lint
lint: lint-backend lint-frontend lint-iot

lint-backend:
	cd src/backend && dotnet format --verify-no-changes --no-restore Crusaders.Mainframe.Api/Crusaders.Mainframe.Api.csproj || (echo "Run 'cd src/backend && dotnet format' to fix" && exit 1)

lint-frontend:
	cd src/frontend && npm run lint

# Lint — IoT firmware. Formatting, the purity rule, and the strict compile gate.
lint-iot:
	$(CLANG_FORMAT) --dry-run -Werror $$(git ls-files -co --exclude-standard 'src/iot/**/*.cpp' 'src/iot/**/*.h')
	src/iot/tools/strict_compile.sh
	@! grep -rn --include=*.h --include=*.cpp -E '#include *<(Arduino|WiFi|ESP8266|Wire|LiquidCrystal)' \
	    src/iot/lib --exclude-dir=arduino_hal --exclude-dir=posix_hal \
	  || (echo 'pure lib/ must not include Arduino headers' && exit 1)
	@! grep -rnE '(>=|<=|>|<) *[A-Za-z_]*([Dd]eadline|[Ee]xpires|[Aa]tMs)|millis\(\) *(>=|<=|>|<)|(>=|<=|>|<) *millis\(\)|(>=|<=|>|<) *[A-Za-z_][A-Za-z0-9_]*\.at\b' \
	    src/iot/lib src/iot/src --include=*.cpp --include=*.h 2>/dev/null | grep -v 'lib/timebase' \
	  || (echo 'raw deadline comparison — use tb::reached / tb::Deadline' && exit 1)

format-iot:
	$(CLANG_FORMAT) -i $$(git ls-files -co --exclude-standard 'src/iot/**/*.cpp' 'src/iot/**/*.h')

# Build
build: lint build-iot
	cd src/backend && dotnet build Crusaders.Mainframe.Api/Crusaders.Mainframe.Api.csproj --nologo -v q && dotnet build Crusaders.Mainframe.Tests/Crusaders.Mainframe.Tests.csproj --nologo -v q
	cd src/frontend && npm run build

# Build — IoT firmware for every target board plus the native simulator.
build-iot:
	$(PIO) run -d src/iot -e court_mega -e court_bridge -e simulator

# Tests — unit
test: test-iot
	cd src/backend && dotnet test Crusaders.Mainframe.Tests/Crusaders.Mainframe.Tests.csproj --nologo -v q
	cd src/frontend && npm run test -- --run

# Tests — IoT native unit/property/corpus suite. Fails hard if pio is missing:
# the repo already carries two silent-pass escape hatches and must not gain a third.
# The OTA signer selftest runs first: the release-signing step is what a board's
# signature check trusts, so it is a gate, not a helper script.
test-iot:
	python3 src/iot/tools/sign_firmware.py --selftest
	$(PIO) test -d src/iot -e native

test-iot-asan:
	$(PIO) test -d src/iot -e native_asan

# Tests — integration. Runs the WHOLE suite with Postgres reachable: the
# Postgres-backed classes gate themselves on API_BOUNDARY_TEST_CONNECTION_STRING,
# and a class-name filter here is how the postgres-http tier silently ran nowhere.
test-integration:
	cd src/backend && dotnet test Crusaders.Mainframe.Tests/Crusaders.Mainframe.Tests.csproj --nologo -v q

# Regenerate the corpus-baked headers and fail if the committed copies are stale.
# Nothing else runs the generators, so an edited cases.json with a forgotten
# regeneration leaves the C++ suite green against the old vectors.
corpus-check:
	$(PY) src/iot/tools/gen_corpus.py
	$(PY) src/iot/tools/gen_discovery_corpus.py
	git diff --exit-code -- src/iot/test/test_protocol/corpus_generated.h src/iot/test/test_discovery/corpus_generated.h \
	  || (echo "generated corpus headers are stale — rerun the generators and commit" && exit 1)

# Tests — Playwright e2e.
#
# PLAYWRIGHT_CHROMIUM_PATH lets a runner that already ships a browser be used instead
# of downloading a few hundred megabytes to get one that differs by a revision number.
# Unset, Playwright uses its own and a developer machine needs no setup.
test-e2e:
	cd src/frontend && npx playwright test

# Service virtualization as plain processes.
#
# Deliberately NOT Docker-only. The daemon is unavailable in some CI setups and a
# suite that can only run under Docker is a suite that quietly stops running.
# docker-compose.test.yml offers the same two services as sidecars for machines that
# prefer them, reading the same imposter file.
virt-up: build-iot
	@command -v npx >/dev/null || (echo "npx is required for the PayFast imposter" && exit 1)
	npx --yes mountebank@2.9.1 start --configfile test/virtualization/payfast/imposter.json --pidfile /tmp/crusaders-mb.pid &
	src/iot/.pio/build/simulator/program --port $${SIMULATOR_PORT:-5555} & echo $$! > /tmp/crusaders-sim.pid
	@echo "PayFast imposter on :4545 (admin :2525) · device simulator on :$${SIMULATOR_PORT:-5555}"
	@echo "See test/virtualization/README.md for what each case is and how to provoke it."

virt-down:
	-@kill "$$(cat /tmp/crusaders-sim.pid 2>/dev/null)" 2>/dev/null || true
	-@npx --yes mountebank@2.9.1 stop --pidfile /tmp/crusaders-mb.pid 2>/dev/null || true
	-@rm -f /tmp/crusaders-sim.pid /tmp/crusaders-mb.pid

# Complexity — one tool, three languages. Thresholds are measured, not decreed.
complexity:
	$(PY) -m lizard src/iot/lib src/iot/src src/backend/Crusaders.Mainframe.Api src/frontend/src \
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
