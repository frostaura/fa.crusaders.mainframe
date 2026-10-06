using Crusaders.Mainframe.Api.Persistence;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// R19 BE19L — a test class's idle pooled connections give their server slots back.
///
/// <para>
/// <b>Found in the sharded run</b> (<c>make test-integration-sharded SHARDS=3</c>): three test
/// processes, each running ~10 classes at once, every class with its own database and so its own
/// Npgsql pool, all against ONE PostgreSQL whose <c>max_connections</c> is 100. Npgsql keeps a
/// pooled connection open for <c>Connection Idle Lifetime</c> (300 s by default) after its last use,
/// so the server filled with idle sessions nobody would use again — sampled at 99 sessions, 68 of
/// them idle — and the next burst (a class needing 33 at once) was refused <c>53300 too many
/// clients</c>, answered <c>503 service_busy</c>. The product's pool bound (R18,
/// <see cref="DatabasePool"/>) is per pool; it says nothing about forty pools on one server.
/// </para>
///
/// <para>
/// Each test database's connection string therefore releases an idle connection within seconds
/// (<see cref="PostgresDatabases.ConnectionStringFor"/>), and so does the API host's pool over it,
/// which is the bounded copy of that string.
/// </para>
/// </summary>
public sealed class R19TestServerSlotsTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    /// <summary>How long a released burst may keep its server slots: a few pruning passes.</summary>
    private static readonly TimeSpan GiveBackWithin = TimeSpan.FromSeconds(15);

    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_burst_of_pooled_connections_gives_its_server_slots_back_once_idle(bool apiBoundPool)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var pooled = apiBoundPool ? DatabasePool.Bound(pg.ConnectionString!, null) : pg.ConnectionString!;
        var database = new NpgsqlConnectionStringBuilder(pooled).Database!;

        // A burst: ten sessions at once, then all of them returned to the pool.
        var burst = new List<NpgsqlConnection>();
        for (var i = 0; i < 10; i++)
        {
            var c = new NpgsqlConnection(pooled);
            await c.OpenAsync();
            burst.Add(c);
        }
        Assert.True(await SessionsOnAsync(database) >= 10);
        foreach (var c in burst) await c.DisposeAsync();

        var deadline = DateTime.UtcNow + GiveBackWithin;
        long held;
        while ((held = await SessionsOnAsync(database)) > 0 && DateTime.UtcNow < deadline)
        {
            await Task.Delay(250);
        }

        Assert.True(held == 0,
            $"{held} idle pooled sessions still hold server slots on {database} {GiveBackWithin.TotalSeconds} s after the burst — " +
            "forty such pools fill a 100-slot server (R19 BE19L)");
    }

    /// <summary>Client sessions on <paramref name="database"/>, read from a connection outside every pool.</summary>
    private async Task<long> SessionsOnAsync(string database)
    {
        var observer = new NpgsqlConnectionStringBuilder(pg.ConnectionString!) { Database = "postgres", Pooling = false };
        await using var conn = new NpgsqlConnection(observer.ConnectionString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(
            "SELECT count(*) FROM pg_stat_activity WHERE datname = @d AND backend_type = 'client backend'", conn);
        cmd.Parameters.AddWithValue("d", database);
        return (long)(await cmd.ExecuteScalarAsync())!;
    }
}
