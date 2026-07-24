.PHONY: install lint lint-backend lint-frontend build test test-integration test-e2e ci-status up down down-reset clean

# Install all dependencies
install:
	cd src/backend && dotnet restore Crusaders.Mainframe.Api/Crusaders.Mainframe.Api.csproj && dotnet restore Crusaders.Mainframe.Tests/Crusaders.Mainframe.Tests.csproj
	cd src/frontend && npm install

# Lint
lint: lint-backend lint-frontend

lint-backend:
	cd src/backend && dotnet format --verify-no-changes --no-restore Crusaders.Mainframe.Api/Crusaders.Mainframe.Api.csproj || (echo "Run 'cd src/backend && dotnet format' to fix" && exit 1)

lint-frontend:
	cd src/frontend && npm run lint

# Build
build: lint
	cd src/backend && dotnet build Crusaders.Mainframe.Api/Crusaders.Mainframe.Api.csproj --nologo -v q && dotnet build Crusaders.Mainframe.Tests/Crusaders.Mainframe.Tests.csproj --nologo -v q
	cd src/frontend && npm run build

# Tests — unit
test:
	cd src/backend && dotnet test Crusaders.Mainframe.Tests/Crusaders.Mainframe.Tests.csproj --nologo -v q
	cd src/frontend && npm run test -- --run

# Tests — integration (postgres-backed boundary tests)
test-integration:
	cd src/backend && dotnet test Crusaders.Mainframe.Tests/Crusaders.Mainframe.Tests.csproj --nologo -v q --filter "(FullyQualifiedName~ApiBoundaryTests|FullyQualifiedName~TenantIsolationTests)"

# Tests — Playwright e2e
test-e2e:
	cd src/frontend && npx playwright test

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
