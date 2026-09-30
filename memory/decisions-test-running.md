---
name: crusaders-mainframe-decisions-test-running
description: "How the backend suite runs: a cloned database AND one shared host per class, giant classes split, CI sharded 5 ways by measured class time with a union proof. 17.5 min became ~6; the rules new tests keep."
type: decision
last_verified: 2026-09-30
---

# Live decisions — how the test suites run

**Measured on this Mac, one Postgres (`crusaders-test-pg`, :5440).** 2026-09-28: serial 30m10s →
parallel classes 6-9 min. 2026-09-30, before this round (r3 trx, normal load): **17.5 min wall,
160 min summed test time, 3032 tests, 243 MB of console output in the trx.** After, same suite:
**6m19s wall at load 13-26, 33 min summed, 12.7 CPU-minutes, trx 20 MB**; 12m15s at load 20-48
when `PlayersPropertyHttpTests` (ONE property test, another lane's stress work) alone took 734 s —
it is the floor now, nothing else is over 90 s. The three split classes: 295 tests in 15-22 s
(were 654 + 442 + 258 s summed). CI not yet measured on the sharded path.

**Why a test cost ~5 s: host boots and logging, not the database.** The test process sat at
~1.2 cores of 10. Each test booted its own `WebApplicationFactory` host — ~0.8 s CPU (DI, 200
endpoint delegates, the first request), ~2,100 boots a run — and every EF command was logged at
Information to the console (2.2 M lines). Real `Task.Delay`s total seconds; not the cause.

**The backend design, and why.**
- Each Postgres-backed class is `IClassFixture<PostgresFixture>`, in NO `[Collection]`: its own
  xUnit collection, its own `CREATE DATABASE … TEMPLATE` clone of one template migrated once per
  process through the real startup path. `PostgresDatabases.CreateEmptyAsync()` for migration tests.
- **`pg.SharedHost` — one plain host per class**, disposed with the fixture; a test's
  `await using` of it is a no-op. Tests in a class already shared the database and seed their own
  club. A test needing a differently configured host (rate limits, proxy trust, replaced services,
  pinned clock) builds its own or uses `WithWebHostBuilder`. Never mutate a shared host's singletons.
- Test hosts log Warning+ to the console; configure hosts with `UseSetting`, never env vars
  (`TestWebAppFactoryIsolationTests`). TieredPGO off, server GC, no reload watchers.
- **Giant classes are split by theme into nested classes** in partial files
  (`AdminSettingsHttpTests+RoundTrip`, …): helpers stay on the abstract outer class, nested
  classes reach its privates. A class is serial, so the biggest one is the floor — split past ~60 s.
- `LongestClassFirst` orders by `src/backend/tools/test-timings.json` (measured), estimating only
  unknown classes. Regenerate after big changes: `python3 src/backend/tools/test_shards.py timings <trx>`.

**CI:** `backend-integration-shard` × 5, each its own runner + Postgres, classes planned by
`test_shards.py` from the BUILT assembly (an untimed class goes to the lightest shard); the
`backend-integration` job (same name, so `needs:` unchanged) proves every class ran in exactly one
shard, merges Cobertura (`tools/merge_coverage.py`, equal to coverlet on a combined run) and gates
70% on the merge. Why classes, not tests: a class shares one database; splitting it would not.

**Locally:** `make test-integration` (one process), `make test-integration-sharded SHARDS=4`
(4 processes, prefixes `<prefix>_s<i>`, union proof; 815 s at load ~130, three shards done in
~3 min, the fourth held by `PlayersPropertyHttpTests`), `make test-classes CLASSES="A B+C"`.
`dotnet` needs `MSBuildEnableWorkloadResolver=false` here (MSB4242). **A build with
`--artifacts-path` outside `bin/` breaks the source-reading tests** (`DeploymentPostureTests`,
`DoorAuditActionsTests` find the repo relative to the binary) — measure from a normal build.

**Rules for a new Postgres-backed test class:**
1. `public sealed class FooTests(PostgresFixture pg) : IClassFixture<PostgresFixture>`; no `[Collection]`.
2. `pg.SharedHost` for a plain host; never `Environment.SetEnvironmentVariable` to configure one.
3. Never `NpgsqlConnection.ClearAllPools()` — `ClearPool` your own connection string.
4. Nothing process-global: no mutable statics, Console redirection or culture changes.
5. A test that creates its own database uses `CreateEmptyAsync()`/`CloneTemplateAsync()` and disposes it.

**Real-stack play walk:** books 15 s ahead, both viewports at once — ~30 min per viewport became
~2.5 for both when courts are free ([`gotchas-real-stack.md`](gotchas-real-stack.md), [`gotchas-clock.md`](gotchas-clock.md)).
