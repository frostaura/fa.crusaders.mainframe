using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The promise the whole admin change record rests on, proven against real Postgres: a
/// <c>DELETE</c>, an <c>UPDATE</c> or a <c>TRUNCATE</c> on <c>admin_change_log</c> FAILS, loudly.
///
/// <para>
/// <b>This can only be proven here.</b> The EF in-memory provider does not speak SQL, runs no
/// migrations and has no concept of a trigger, so every one of these assertions would pass
/// against it with no protection in place at all. The club's own screen says "Nobody can delete
/// these from the app, including admins", and that sentence is either true at the database or it
/// is marketing.
/// </para>
///
/// <para>
/// <b>What it does NOT prove, stated here so nobody reads more into it.</b> A database OWNER can
/// still <c>ALTER TABLE … DISABLE TRIGGER</c>, and today the application runs its own migrations
/// and therefore almost certainly connects as the owner. The fourth layer — a
/// <c>crusaders_app</c> runtime role with no <c>DELETE</c> on this table — is a deployment
/// decision, and the residual is recorded rather than engineered around.
/// </para>
/// </summary>
public sealed class AdminChangeLogBoundaryTests : IClassFixture<PostgresFixture>
{
    /// <summary>Postgres' own code for insufficient privilege, which is what the function raises with.</summary>
    private const string InsufficientPrivilege = "42501";

    private readonly PostgresFixture _pg;

    public AdminChangeLogBoundaryTests(PostgresFixture pg) => _pg = pg;

    private async Task<NpgsqlConnection> MigratedConnectionAsync()
    {
        await using (var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString })
        {
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            await db.Database.MigrateAsync();
        }

        var conn = new NpgsqlConnection(_pg.ConnectionString);
        await conn.OpenAsync();
        return conn;
    }

    private static async Task<Guid> InsertAsync(NpgsqlConnection conn, Guid tenantId)
    {
        var id = Guid.NewGuid();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO admin_change_log
                ("Id","TenantId","OccurredAt","ActorUserId","ActorName","Area","Action")
            VALUES (@id, @tenant, now(), @actor, 'Boundary Admin', 'booking', 'bookings.bulk_cancelled')
            """;
        cmd.Parameters.AddWithValue("id", id);
        cmd.Parameters.AddWithValue("tenant", tenantId);
        cmd.Parameters.AddWithValue("actor", Guid.NewGuid());
        await cmd.ExecuteNonQueryAsync();
        return id;
    }

    /// <summary>
    /// A raw <c>DELETE</c> against the real table raises, and the row is still there afterwards.
    ///
    /// <para>
    /// Asserting the row survives as well as that the statement threw is the point: a
    /// <c>RULE … DO INSTEAD NOTHING</c> would have made the delete report zero rows and
    /// <i>succeed</i>, so an operator believes they deleted something and the application
    /// believes it worked. Both halves of that failure are covered by these two assertions.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_raw_delete_fails_and_the_row_survives()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var conn = await MigratedConnectionAsync();
        var tenantId = Guid.NewGuid();
        var id = await InsertAsync(conn, tenantId);

        var failure = await Assert.ThrowsAsync<PostgresException>(async () =>
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = @"DELETE FROM admin_change_log WHERE ""Id"" = @id";
            cmd.Parameters.AddWithValue("id", id);
            await cmd.ExecuteNonQueryAsync();
        });

        Assert.Equal(InsufficientPrivilege, failure.SqlState);
        Assert.Contains("append-only", failure.MessageText, StringComparison.OrdinalIgnoreCase);

        await using var check = conn.CreateCommand();
        check.CommandText = @"SELECT COUNT(*) FROM admin_change_log WHERE ""Id"" = @id";
        check.Parameters.AddWithValue("id", id);
        Assert.Equal(1L, Convert.ToInt64(await check.ExecuteScalarAsync()));
    }

    /// <summary>
    /// A raw <c>UPDATE</c> raises too, and the stored words are unchanged.
    ///
    /// <para>
    /// Append-only means the record cannot be EDITED either. A reason quietly rewritten six
    /// months later is a worse failure than a row deleted, because the row still looks like
    /// evidence.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_raw_update_fails_and_the_words_are_unchanged()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var conn = await MigratedConnectionAsync();
        var id = await InsertAsync(conn, Guid.NewGuid());

        var failure = await Assert.ThrowsAsync<PostgresException>(async () =>
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = @"UPDATE admin_change_log SET ""ActorName"" = 'Somebody Else' WHERE ""Id"" = @id";
            cmd.Parameters.AddWithValue("id", id);
            await cmd.ExecuteNonQueryAsync();
        });

        Assert.Equal(InsufficientPrivilege, failure.SqlState);

        await using var check = conn.CreateCommand();
        check.CommandText = @"SELECT ""ActorName"" FROM admin_change_log WHERE ""Id"" = @id";
        check.Parameters.AddWithValue("id", id);
        Assert.Equal("Boundary Admin", (string)(await check.ExecuteScalarAsync())!);
    }

    /// <summary>
    /// <c>TRUNCATE</c> raises — the statement-level trigger, which is the only kind Postgres
    /// allows for this operation and the reason there are two triggers rather than one.
    ///
    /// <para>
    /// A row-level trigger does not fire on <c>TRUNCATE</c> at all, so a table protected only
    /// by the <c>DELETE</c>/<c>UPDATE</c> trigger can still be emptied in one statement.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_truncate_fails_and_the_table_is_intact()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var conn = await MigratedConnectionAsync();
        await InsertAsync(conn, Guid.NewGuid());

        var failure = await Assert.ThrowsAsync<PostgresException>(async () =>
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = "TRUNCATE admin_change_log";
            await cmd.ExecuteNonQueryAsync();
        });

        Assert.Equal(InsufficientPrivilege, failure.SqlState);

        await using var check = conn.CreateCommand();
        check.CommandText = "SELECT COUNT(*) FROM admin_change_log";
        Assert.True(Convert.ToInt64(await check.ExecuteScalarAsync()) >= 1L);
    }

    /// <summary>
    /// Inserting still works. A protection that also blocked the writes would be found by the
    /// first admin action rather than by a test, and "append-only" means append.
    /// </summary>
    [SkippableFact]
    public async Task Inserting_still_works()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var conn = await MigratedConnectionAsync();
        var tenantId = Guid.NewGuid();
        await InsertAsync(conn, tenantId);
        await InsertAsync(conn, tenantId);

        await using var check = conn.CreateCommand();
        check.CommandText = @"SELECT COUNT(*) FROM admin_change_log WHERE ""TenantId"" = @t";
        check.Parameters.AddWithValue("t", tenantId);
        Assert.Equal(2L, Convert.ToInt64(await check.ExecuteScalarAsync()));
    }
}
