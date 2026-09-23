using System.Net;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Postgres-backed boundary tests: the real schema, the real HTTP pipeline.
///
/// <para>
/// CI has filtered for this class name since the pipeline was written, and until
/// now the class did not exist — so <c>backend-integration</c> matched nothing,
/// provisioned a Postgres container it never touched, and reported green
/// regardless. The <c>API_BOUNDARY_TEST_CONNECTION_STRING</c> variable it exports
/// was likewise read by no code.
/// </para>
///
/// <para>
/// Everything else in this suite runs on the EF in-memory provider, which does not
/// enforce unique indexes, does not apply migrations, and does not speak SQL. None
/// of it can catch a schema that fails to deploy — the exact defect that made a
/// production boot impossible before this was fixed.
/// </para>
/// </summary>
public sealed class PostgresFixture : IAsyncLifetime
{
    private const string EnvVar = "API_BOUNDARY_TEST_CONNECTION_STRING";

    public string? ConnectionString { get; private set; }
    public bool Available => ConnectionString is not null;

    private string? _databaseName;
    private string? _adminConnectionString;

    public async Task InitializeAsync()
    {
        var configured = Environment.GetEnvironmentVariable(EnvVar);

        // These tests must never silently skip in the job that exists to run them,
        // but they must skip cleanly everywhere else.
        //
        // Keying that on CI=true does not work: GitHub sets it in every job, including
        // `backend`, which deliberately provisions no Postgres. So the integration job
        // sets REQUIRE_BOUNDARY_TESTS explicitly — if that is on and the connection
        // string is missing, the pipeline is broken and should say so.
        if (string.IsNullOrWhiteSpace(configured))
        {
            var required = string.Equals(
                Environment.GetEnvironmentVariable("REQUIRE_BOUNDARY_TESTS"), "true",
                StringComparison.OrdinalIgnoreCase);

            if (required)
            {
                throw new InvalidOperationException(
                    $"REQUIRE_BOUNDARY_TESTS is set but {EnvVar} is not. These are the only " +
                    "tests that exercise real SQL and real migrations — they must not be skipped here.");
            }
            return;
        }

        // Each run gets its own database, so a failed run cannot poison the next.
        var builder = new NpgsqlConnectionStringBuilder(configured);
        _adminConnectionString = new NpgsqlConnectionStringBuilder(configured) { Database = "postgres" }.ConnectionString;
        _databaseName = $"boundary_{Guid.NewGuid():N}";

        await using (var admin = new NpgsqlConnection(_adminConnectionString))
        {
            await admin.OpenAsync();
            await using var cmd = admin.CreateCommand();
            cmd.CommandText = $"CREATE DATABASE \"{_databaseName}\"";
            await cmd.ExecuteNonQueryAsync();
        }

        builder.Database = _databaseName;
        ConnectionString = builder.ConnectionString;
    }

    public async Task DisposeAsync()
    {
        if (_databaseName is null || _adminConnectionString is null)
        {
            return;
        }

        NpgsqlConnection.ClearAllPools();
        await using var admin = new NpgsqlConnection(_adminConnectionString);
        await admin.OpenAsync();
        await using var cmd = admin.CreateCommand();
        cmd.CommandText = $"DROP DATABASE IF EXISTS \"{_databaseName}\" WITH (FORCE)";
        await cmd.ExecuteNonQueryAsync();
    }
}

[Collection(HttpTestCollection.Name)]
public sealed class ApiBoundaryTests
{
    private readonly PostgresFixture _pg;

    public ApiBoundaryTests(PostgresFixture pg) => _pg = pg;

    private TestWebAppFactory CreateFactory() =>
        new() { ConnectionString = _pg.ConnectionString };

    /// <summary>
    /// The deployability regression test.
    ///
    /// Before this landed, a production boot against a fresh database threw
    /// PendingModelChangesWarning, because the model snapshot was a hand-written
    /// 52-line stub listing fourteen entities by Id alone. Eight columns and the
    /// whole webauthn_credentials table existed only in a Development-only block
    /// of raw ALTER TABLE in the seeder.
    /// </summary>
    [SkippableFact]
    public async Task Migrations_apply_cleanly_to_a_fresh_database()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        await db.Database.MigrateAsync();

        var applied = (await db.Database.GetAppliedMigrationsAsync()).ToList();
        Assert.NotEmpty(applied);

        // If this is non-empty the model and the migrations have diverged, which is
        // precisely what made the schema undeployable.
        var pending = (await db.Database.GetPendingMigrationsAsync()).ToList();
        Assert.Empty(pending);
    }

    /// <summary>
    /// The eight columns that used to exist only on developer machines. Asserted
    /// against information_schema so this fails if someone re-adds them as raw DDL
    /// instead of as a migration.
    /// </summary>
    [SkippableTheory]
    [InlineData("bookings", "CheckedInAt")]
    [InlineData("bookings", "BookedByUserId")]
    [InlineData("bookings", "PaidByUserId")]
    [InlineData("bookings", "ChargedAt")]
    [InlineData("member_groups", "CreditsPerZar")]
    [InlineData("member_groups", "PeakPriority")]
    [InlineData("member_groups", "SystemKey")]
    [InlineData("pending_topups", "GroupId")]
    [InlineData("ledger_entries", "ZarPaid")]
    [InlineData("ledger_entries", "ConversionRate")]
    [InlineData("users", "PinHash")]
    public async Task Previously_orphaned_columns_are_in_the_migration(string table, string column)
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        await using var conn = new NpgsqlConnection(_pg.ConnectionString);
        await conn.OpenAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "SELECT COUNT(*) FROM information_schema.columns WHERE table_name = @t AND column_name = @c";
        cmd.Parameters.AddWithValue("t", table);
        cmd.Parameters.AddWithValue("c", column);

        var count = Convert.ToInt64(await cmd.ExecuteScalarAsync());
        Assert.True(count == 1, $"{table}.{column} is missing from the migrated schema");
    }

    /// <summary>
    /// webauthn_credentials existed only as a CREATE TABLE inside the seeder's
    /// Development-only block, so passkeys could never have worked in production.
    /// </summary>
    [SkippableFact]
    public async Task Webauthn_credentials_table_is_in_the_migration()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        await using var conn = new NpgsqlConnection(_pg.ConnectionString);
        await conn.OpenAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT to_regclass('public.webauthn_credentials') IS NOT NULL";
        Assert.True((bool)(await cmd.ExecuteScalarAsync())!);
    }

    /// <summary>
    /// The filtered unique index on ExternalReference is the only DB-level
    /// idempotency guarantee in the money model — a replayed payment callback or a
    /// re-flushed device event queue is rejected by Postgres rather than by luck.
    /// The in-memory provider does not enforce unique indexes, so this can only be
    /// proven here.
    /// </summary>
    [SkippableFact]
    public async Task Ledger_external_reference_is_unique_and_allows_many_nulls()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        await using var conn = new NpgsqlConnection(_pg.ConnectionString);
        await conn.OpenAsync();

        async Task InsertAsync(string? externalRef)
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                INSERT INTO ledger_entries
                    ("Id","TenantId","UserId","Type","AmountCredits","ActorUserId","Reason","ExternalReference","CreatedAt")
                VALUES
                    (@id, @tenant, @user, 0, 1.00, @actor, 'boundary test', @ext, now())
                """;
            cmd.Parameters.AddWithValue("id", Guid.NewGuid());
            cmd.Parameters.AddWithValue("tenant", Guid.NewGuid());
            cmd.Parameters.AddWithValue("user", Guid.NewGuid());
            cmd.Parameters.AddWithValue("actor", Guid.NewGuid());
            cmd.Parameters.AddWithValue("ext", (object?)externalRef ?? DBNull.Value);
            await cmd.ExecuteNonQueryAsync();
        }

        await InsertAsync("payfast:txn-1");
        await Assert.ThrowsAsync<PostgresException>(() => InsertAsync("payfast:txn-1"));

        // Filtered index: rows without an external reference are unconstrained.
        await InsertAsync(null);
        await InsertAsync(null);
    }

    /// <summary>
    /// One OPEN outage per box, enforced by the schema — the guard that makes
    /// <c>peripheral.unhealthy</c> fire once per outage rather than once per thirty-second
    /// sweep.
    ///
    /// <para>
    /// It has to be here for the same reason the ExternalReference index above does: the
    /// health sweep reads "is there an open outage?" and then writes one, and under READ
    /// COMMITTED a slow tick and its successor can both pass the read. The in-memory provider
    /// enforces no unique index, so every other test of this worker would pass with the
    /// constraint deleted.
    /// </para>
    ///
    /// <para>
    /// And the filter is the half that matters as much: closed outages must accumulate freely,
    /// because the history is what lets a no-show sweep waive a penalty for a window that has
    /// since recovered (<c>feature-spec.md</c> §6a, <c>settlement-model.md</c> S5a).
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_box_can_have_only_one_open_outage_and_any_number_of_closed_ones()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        await using var conn = new NpgsqlConnection(_pg.ConnectionString);
        await conn.OpenAsync();

        var tenantId = Guid.NewGuid();
        var deviceId = Guid.NewGuid();

        async Task InsertAsync(DateTimeOffset? endedAt)
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                INSERT INTO device_outages ("Id","TenantId","DeviceId","StartedAt","DetectedAt","EndedAt")
                VALUES (@id, @tenant, @device, now(), now(), @ended)
                """;
            cmd.Parameters.AddWithValue("id", Guid.NewGuid());
            cmd.Parameters.AddWithValue("tenant", tenantId);
            cmd.Parameters.AddWithValue("device", deviceId);
            cmd.Parameters.AddWithValue("ended", (object?)endedAt ?? DBNull.Value);
            await cmd.ExecuteNonQueryAsync();
        }

        await InsertAsync(null);
        await Assert.ThrowsAsync<PostgresException>(() => InsertAsync(null));

        // Closed rows are the history, and are unconstrained.
        await InsertAsync(DateTimeOffset.UtcNow);
        await InsertAsync(DateTimeOffset.UtcNow);
    }

    /// <summary>
    /// The double-booking race, closed in the only place it can be.
    ///
    /// <para>
    /// <c>BookingService.CreateAsync</c> checks for an overlap and then inserts, and under
    /// READ COMMITTED two requests can both pass the check before either commits. The
    /// in-memory provider enforces no exclusion constraint and speaks no SQL, so nothing in
    /// the rest of the suite can see this — the same blind spot that hid the ExternalReference
    /// index above.
    /// </para>
    ///
    /// <para>
    /// Four cases, because the constraint has to reject exactly one of them. Adjacency and
    /// cancel-then-rebook are the ways a too-eager constraint breaks the club: back-to-back
    /// bookings are the normal pattern on a busy evening, and a cancelled slot has to be
    /// rebookable or a cancellation costs the court its hour.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Overlapping_bookings_are_rejected_by_the_schema_and_adjacent_ones_are_not()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        await using var conn = new NpgsqlConnection(_pg.ConnectionString);
        await conn.OpenAsync();

        var tenantId = Guid.NewGuid();
        var courtId = Guid.NewGuid();
        var baseline = new DateTimeOffset(2026, 9, 1, 10, 0, 0, TimeSpan.Zero);

        async Task InsertAsync(Guid tenant, DateTimeOffset startsAt, DateTimeOffset endsAt, int status)
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                INSERT INTO bookings
                    ("Id","TenantId","CourtId","ActorUserId","StartsAt","EndsAt","SliceMinutes",
                     "SliceCount","AmountChargedCredits","Status","CancellationPenaltyWaived","CreatedAt")
                VALUES
                    (@id, @tenant, @court, @actor, @starts, @ends, 15, 2, 16.00, @status, false, now())
                """;
            cmd.Parameters.AddWithValue("id", Guid.NewGuid());
            cmd.Parameters.AddWithValue("tenant", tenant);
            cmd.Parameters.AddWithValue("court", courtId);
            cmd.Parameters.AddWithValue("actor", Guid.NewGuid());
            cmd.Parameters.AddWithValue("starts", startsAt);
            cmd.Parameters.AddWithValue("ends", endsAt);
            cmd.Parameters.AddWithValue("status", status);
            await cmd.ExecuteNonQueryAsync();
        }

        await InsertAsync(tenantId, baseline, baseline.AddMinutes(30), status: 0);

        // Overlaps by 15 minutes — the collision the constraint exists for.
        var clash = await Assert.ThrowsAsync<PostgresException>(
            () => InsertAsync(tenantId, baseline.AddMinutes(15), baseline.AddMinutes(45), status: 0));
        Assert.Equal("23P01", clash.SqlState);
        Assert.Equal("ck_bookings_no_overlapping_slot", clash.ConstraintName);

        // Adjacent, not overlapping: the range is half-open, so 10:30 is free.
        await InsertAsync(tenantId, baseline.AddMinutes(30), baseline.AddMinutes(45), status: 0);

        // Another club's court number is another club's court.
        await InsertAsync(Guid.NewGuid(), baseline, baseline.AddMinutes(30), status: 0);

        // Cancelled rows are kept for the audit trail but release the slot.
        await using (var cancel = conn.CreateCommand())
        {
            cancel.CommandText = @"UPDATE bookings SET ""Status"" = 1 WHERE ""TenantId"" = @t AND ""StartsAt"" = @s";
            cancel.Parameters.AddWithValue("t", tenantId);
            cancel.Parameters.AddWithValue("s", baseline);
            Assert.Equal(1, await cancel.ExecuteNonQueryAsync());
        }
        await InsertAsync(tenantId, baseline, baseline.AddMinutes(30), status: 0);
    }

    /// <summary>
    /// A liveness probe must not depend on the database. Asserted over real HTTP so
    /// routing and middleware order are exercised, not just the handler.
    /// </summary>
    [SkippableFact]
    public async Task Healthz_is_reachable_over_http_with_the_real_schema()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = CreateFactory();
        var client = factory.CreateClient();

        var response = await client.GetAsync("/healthz");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
