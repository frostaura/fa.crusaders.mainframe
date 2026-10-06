using System.Diagnostics;
using System.Net;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 18, scalability lane (BE18s): what an open wallet stream costs the database, and
/// what the API answers when the database has no connection to give.
///
/// <para>
/// A reviewer held ~333 member wallet streams open and PostgreSQL reached its 100-connection limit.
/// Measured in isolation: a held stream pins no connection (500 held → at most 8 busy), but a burst
/// of streams opening at once grew Npgsql's pool — 100 by default, the same as the server's
/// <c>max_connections</c> — to 99 connections, and the server refused everything else with
/// <c>53300 too many clients</c>. A request that then could not get a connection was a 500.
/// </para>
///
/// <para>
/// Now the pool is bounded below the server (<see cref="DatabasePool"/>), stream-side reads share a
/// fifth of it (<see cref="StreamDbGate"/>), and a request that cannot get a connection is
/// <c>503 service_busy</c> with <c>Retry-After</c>.
/// </para>
/// </summary>
public sealed class R18StreamCapacityHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    /// <summary>
    /// The finding: a storm of streams opening at once, with members using the app in the middle of
    /// it. Every stream opens, every member's read is answered, and the API never holds more database
    /// connections than its pool is configured for. Varied: a pool of 6 and of 12.
    /// </summary>
    [SkippableTheory]
    [InlineData(6, 90)]
    [InlineData(12, 120)]
    public async Task A_storm_of_wallet_streams_stays_inside_the_pool_and_members_are_still_served(int pool, int streams)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);

        // Pools outlive the hosts that made them (Npgsql keeps them per connection string, for the
        // process): the idle connections an earlier test in this class left on this database would
        // otherwise be counted against this host's pool.
        ClearThisClassesPools(pg.ConnectionString!);
        await using var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService())
            .WithWebHostBuilder(b => b.UseSetting(DatabasePool.MaxPoolSizeKey, pool.ToString()));
        var club = await MemberCodeClub.SeedAsync(app, "r18storm");
        var members = await MembersAsync(app, club, streams);
        var database = new NpgsqlConnectionStringBuilder(pg.ConnectionString).Database!;

        await using var sampler = await SamplerAsync(pg.ConnectionString!);
        using var stop = new CancellationTokenSource();
        var peak = 0;
        var sampling = Task.Run(async () =>
        {
            while (!stop.IsCancellationRequested)
            {
                peak = Math.Max(peak, await ConnectionsAsync(sampler, database));
                await Task.Delay(20);
            }
        });

        var jwt = app.Services.GetRequiredService<IJwtIssuer>();
        var opens = members.Select(m => OpenStreamAsync(app, jwt, club, m, stop.Token)).ToList();
        var reads = members.Take(30).Select(async m => (await club.Member(app, m).GetAsync("/api/v1/wallet?limit=1")).StatusCode).ToList();
        var opened = await Task.WhenAll(opens);
        var answered = await Task.WhenAll(reads);

        await stop.CancelAsync();
        await sampling;
        foreach (var stream in opened) stream?.Dispose();

        Assert.Equal(streams, opened.Count(s => s is not null));
        Assert.All(answered, status => Assert.Equal(HttpStatusCode.OK, status));
        Assert.True(peak <= pool, $"the API held {peak} connections with a pool of {pool}");
    }

    /// <summary>
    /// When no connection frees up within the pool's wait, the request is the server being busy — not
    /// broken: 503 <c>service_busy</c> with <c>Retry-After</c>, never a 500. Varied: a member's read
    /// and a member's write.
    /// </summary>
    [SkippableTheory]
    [InlineData("GET", "/api/v1/wallet")]
    [InlineData("PUT", "/api/v1/me/preferences")]
    public async Task A_request_that_cannot_get_a_connection_is_503_service_busy_with_retry_after(string method, string path)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var oneConnection = OneConnection(pg.ConnectionString!);
        await using var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService())
            .WithWebHostBuilder(b => b.UseSetting("ConnectionStrings:DefaultConnection", oneConnection));
        var club = await MemberCodeClub.SeedAsync(app, "r18busy");

        // Somebody else holds the only connection for the whole of the request's wait.
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.OpenConnectionAsync();

        var request = new HttpRequestMessage(new HttpMethod(method), path);
        if (method != "GET") request.Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");
        var response = await club.Member(app, club.Olga).SendAsync(request);
        await db.Database.CloseConnectionAsync();

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal(DatabasePool.ServiceBusy, (await MemberCodeClub.JsonAsync(response)).GetProperty("error").GetString());
        Assert.NotNull(response.Headers.RetryAfter);
    }

    /// <summary>The bound: a connection string's own wins; otherwise the configured one; otherwise the default.</summary>
    [Theory]
    [InlineData("Host=db;Database=x;Username=u", null, DatabasePool.DefaultMaxPoolSize)]
    [InlineData("Host=db;Database=x;Username=u", 25, 25)]
    [InlineData("Host=db;Database=x;Username=u;Maximum Pool Size=7", 25, 7)]
    [InlineData("Host=db;Database=x;Username=u;MaxPoolSize=9", null, 9)]
    public void The_pool_is_bounded_below_the_servers_default_unless_the_deployment_chose(string cs, int? configured, int expected)
    {
        Assert.Equal(expected, DatabasePool.MaxPoolSizeOf(DatabasePool.Bound(cs, configured)));
        Assert.True(DatabasePool.DefaultMaxPoolSize < 100, "the default must sit under PostgreSQL's default max_connections");
    }

    /// <summary>Every way of not getting a connection is 503 service_busy, wrapped by EF or bare; a real fault is still 500.</summary>
    [Fact]
    public void Not_getting_a_connection_is_classified_busy_and_nothing_else_is()
    {
        var ctx = new DefaultHttpContext();
        ctx.Request.Path = "/api/v1/wallet";
        var exhausted = new NpgsqlException("The connection pool has been exhausted, either raise 'Max Pool Size' (currently 1) or 'Timeout' (currently 1 seconds) in your connection string.", new TimeoutException());
        var full = new PostgresException("sorry, too many clients already", "FATAL", "FATAL", "53300");
        var starting = new PostgresException("the database system is starting up", "FATAL", "FATAL", "57P03");

        foreach (var e in new Exception[] { exhausted, full, starting, new InvalidOperationException("transient", exhausted) })
        {
            Assert.Equal((503, DatabasePool.ServiceBusy), InternalErrors.Classify(e, ctx.Request));
        }

        Assert.Equal((500, InternalErrors.Code), InternalErrors.Classify(new NpgsqlException("boom", new IOException()), ctx.Request));
        // R18 J18-2 (BE18b): a unique violation is a lost race now (503 conflict_retry) — a check violation is still a fault.
        Assert.Equal((500, InternalErrors.Code), InternalErrors.Classify(new PostgresException("x", "ERROR", "ERROR", "23514"), ctx.Request));
    }

    /// <summary>The gate never lets more stream-side reads run at once than it has permits, however many streams ask.</summary>
    [Theory]
    [InlineData(2, 40)]
    [InlineData(8, 200)]
    public async Task The_stream_gate_never_runs_more_reads_at_once_than_its_permits(int permits, int callers)
    {
        var gate = new StreamDbGate(permits);
        var running = 0;
        var peak = 0;
        await Task.WhenAll(Enumerable.Range(0, callers).Select(_ => gate.RunAsync(async ct =>
        {
            var now = Interlocked.Increment(ref running);
            InterlockedMax(ref peak, now);
            await Task.Delay(5, ct);
            Interlocked.Decrement(ref running);
            return true;
        }, CancellationToken.None)));

        Assert.Equal(permits, peak);
        Assert.Equal(8, StreamDbGate.PermitsFor(DatabasePool.DefaultMaxPoolSize));
        Assert.Equal(2, StreamDbGate.PermitsFor(1));
    }

    // ---- The rig -------------------------------------------------------------------------------------

    private static readonly int[] StormPools = [6, 12];

    private static string OneConnection(string connectionString)
    {
        return new NpgsqlConnectionStringBuilder(connectionString) { MaxPoolSize = 1, Timeout = 1 }.ConnectionString;
    }

    /// <summary>Closes the idle connections of every pool a host in this class opens on its database — and only those.</summary>
    private static void ClearThisClassesPools(string connectionString)
    {
        var strings = StormPools.Select(size => DatabasePool.Bound(connectionString, size))
            .Append(DatabasePool.Bound(connectionString, null))
            .Append(OneConnection(connectionString));
        foreach (var s in strings) NpgsqlConnection.ClearPool(new NpgsqlConnection(s));
    }

    private static void InterlockedMax(ref int target, int value)
    {
        int seen;
        while ((seen = Volatile.Read(ref target)) < value && Interlocked.CompareExchange(ref target, value, seen) != seen)
        {
        }
    }

    /// <summary>Opens one wallet stream and reads its opening frame; null when it was refused or broke.</summary>
    private static async Task<HttpResponseMessage?> OpenStreamAsync(
        WebApplicationFactory<Program> app, IJwtIssuer jwt, MemberCodeClub club, Guid member, CancellationToken ct)
    {
        var ticket = jwt.IssueOneTime(member, club.TenantId, club.Slug,
            new TicketScope(TokenPurposes.WalletStream, TokenPurposes.WalletStreamTicketTtl), 0);
        var client = app.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(60);
        var response = await client.GetAsync($"/api/v1/wallet/stream?ticket={ticket}", HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.StatusCode != HttpStatusCode.OK)
        {
            response.Dispose();
            return null;
        }

        var body = await response.Content.ReadAsStreamAsync(ct);
        var first = new byte[64];
        return await body.ReadAtLeastAsync(first, 1, throwOnEndOfStream: false, ct) > 0 ? response : null;
    }

    private static async Task<List<Guid>> MembersAsync(WebApplicationFactory<Program> app, MemberCodeClub club, int count)
    {
        var ids = new List<Guid>();
        var hash = new Pbkdf2PasswordHasher().Hash("OldPass!123");
        await club.WriteAsync(app, db =>
        {
            for (var i = 0; i < count; i++)
            {
                var user = new User { TenantId = club.TenantId, Email = $"s{i}-{club.Slug}@test.local", PasswordHash = hash, EmailVerified = true };
                db.Users.Add(user);
                db.Memberships.Add(new Membership
                {
                    TenantId = club.TenantId,
                    UserId = user.Id,
                    FullName = $"Streamer {i}",
                    MembershipNumber = $"s{i}-{club.Slug}",
                    Status = MembershipStatus.Active,
                });
                ids.Add(user.Id);
            }
            return Task.CompletedTask;
        });
        return ids;
    }

    /// <summary>An unpooled connection of the test's own, opened before the storm so the count never competes for a slot.</summary>
    private static async Task<NpgsqlConnection> SamplerAsync(string connectionString)
    {
        var connection = new NpgsqlConnection(new NpgsqlConnectionStringBuilder(connectionString) { Pooling = false, Database = "postgres" }.ConnectionString);
        await connection.OpenAsync();
        return connection;
    }

    private static async Task<int> ConnectionsAsync(NpgsqlConnection sampler, string database)
    {
        await using var command = new NpgsqlCommand("SELECT count(*) FROM pg_stat_activity WHERE datname = @d", sampler);
        command.Parameters.AddWithValue("d", database);
        return Convert.ToInt32(await command.ExecuteScalarAsync());
    }
}
