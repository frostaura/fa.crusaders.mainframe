---
name: crusaders-mainframe-decisions-test-running
description: "How the backend suite runs since 2026-09-28: every Postgres-backed class on its own clone of one migrated template, classes in parallel, hosts configured per host with UseSetting. 30 min became 6-9; the rules new tests must keep."
type: decision
last_verified: 2026-09-29
---

# Live decisions — how the test suites run

**Measured 2026-09-28 on this Mac, one database server, 2623 tests:** the old serial path took
**30m10s**; the parallel path **6m15s-6m22s** with the machine at load ~5 and **7m54s-8m54s** at
load 10-20 from other agents. Green twice in a row, and green fully serial (`TEST_PARALLEL=1`,
20m28s), so nothing leans on the parallelism. Vitest: ~120 s either way, green under load ~30
where it had failed 8 cases at load ~19. CI has not been measured on the new path yet.

**The backend design (`PostgresFixture.cs`), and why.**
- Each Postgres-backed class is `IClassFixture<PostgresFixture>` and in NO `[Collection]`, so it
  is its own xUnit collection and collections run in parallel (`xunit.runner.json`, one thread
  per core). The old single `postgres-http` collection is deleted.
- One template database is migrated once per test process **through the real startup path**
  (a factory boot with AutoMigrate on), then each class gets `CREATE DATABASE … TEMPLATE` of it
  (~20 ms) and drops it at the end. A test that needs an EMPTY database — anything about the
  migrations themselves — calls `PostgresDatabases.CreateEmptyAsync()`. A broken migration
  fails every Postgres-backed test, because the template build is cached including its fault.
- Only the server/user/password of `API_BOUNDARY_TEST_CONNECTION_STRING` are used; the database
  it names is never touched. `TEST_DB_PREFIX` (default `boundary`) names the databases;
  `make test-integration TEST_PARALLEL=n` caps the parallelism; the Makefile target sets
  `REQUIRE_BOUNDARY_TESTS=true`. Sessions run `synchronous_commit=off` — per session, never
  server-wide.
- **`TestWebAppFactory` configures each host with `UseSetting`, never an environment variable.**
  Env vars are process-wide, and that race is the whole reason the suite was serial. Verified:
  a UseSetting value reaches `Program.cs` before its first read (the registered DbContext
  carries it) and outranks appsettings.json AND the environment. `TestWebAppFactoryIsolationTests`
  boots 16 factories at once and reads back what each got.
- The test host runs with **TieredPGO off and server GC** (the test assembly's runtimeconfig
  only) and with **no appsettings reload watchers**: warm host boot 145 → 95 ms; the Door*
  subset 143 → 63 s. `LongestClassFirst` starts the biggest classes first; the run is
  throughput-bound, so `AdminSettingsHttpTests` (129 tests) is the tail.

**Rules for a new Postgres-backed test class (P11's 13 were converted at the 2026-09-29 merge):**
1. `public sealed class FooTests(PostgresFixture pg) : IClassFixture<PostgresFixture>` — never
   `[Collection(...)]`; a class that joins a collection shares its fixture and runs serially.
2. Never `Environment.SetEnvironmentVariable` to configure a host — add a `TestWebAppFactory`
   property that calls `builder.UseSetting`, or `WithWebHostBuilder(b => b.UseSetting(...))`.
3. Never `NpgsqlConnection.ClearAllPools()` — `ClearPool` your own connection string.
4. Nothing process-global: no mutable statics shared across classes, no Console redirection,
   no culture changes. Within a class, tests still share one database — scope by tenant/slug.
5. A test that creates its own database uses `PostgresDatabases.CreateEmptyAsync()` or
   `CloneTemplateAsync()` and disposes it.

**Seen during the lane and NOT caused by parallelism**, fixed 2026-09-29 by pinning the clock
(`gotchas-clock.md`): the cut-over test's two keys before Johannesburg midnight, the code-step
races (`Racing_payers…`, the ±1 window) and the MemberCode walk-ups' pro-rata price at 23:48.
Frontend flakes fixed 2026-09-29: MyCode's order test now awaits the QR's own draw; AdminSchedules
pins `Date` (it would have broken after 2026-10-06); `statusRef` in `auth.tsx` is set in a layout
effect so a cross-tab sign-out can't land first. See [`gotchas-clock.md`](gotchas-clock.md).
**Locally `dotnet` needs `MSBuildEnableWorkloadResolver=false`** or builds die on MSB4242.
