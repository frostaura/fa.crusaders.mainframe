.PHONY: install lint lint-backend lint-frontend lint-iot format-iot build build-iot \
        test test-iot test-iot-asan test-integration test-e2e complexity hooks \
        ci-status up down down-reset clean

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
	@! grep -rnE '(>=|<=|>|<) *[A-Za-z_]*([Dd]eadline|[Ee]xpires|[Aa]tMs)' \
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
test-iot:
	$(PIO) test -d src/iot -e native

test-iot-asan:
	$(PIO) test -d src/iot -e native_asan

# Tests — integration (postgres-backed boundary tests)
test-integration:
	cd src/backend && dotnet test Crusaders.Mainframe.Tests/Crusaders.Mainframe.Tests.csproj --nologo -v q --filter "(FullyQualifiedName~ApiBoundaryTests|FullyQualifiedName~TenantIsolationTests)"

# Tests — Playwright e2e
test-e2e:
	cd src/frontend && npx playwright test

# Complexity — one tool, three languages. Thresholds are measured, not decreed.
complexity:
	$(PY) -m lizard src/iot/lib src/iot/src src/backend/Crusaders.Mainframe.Api src/frontend/src \
	  -C 15 -L 200 -a 6 -W whitelizard.txt \
	  -x '*/Migrations/*' -x '*/node_modules/*' -x '*/.pio/*' -x '*/.venv/*' \
	  -x '*/bin/*' -x '*/obj/*' -x '*.test.tsx' -x '*.test.ts' -w

# Opt-in git hooks. Documented, not mandatory: hooks people bypass are theatre,
# and CI enforces the same gates anyway.
hooks:
	$(PY) -m pip install --quiet pre-commit && src/iot/.venv/bin/pre-commit install

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
