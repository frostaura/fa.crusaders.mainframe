using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The suite runs its test classes in parallel, and most of them boot
/// <see cref="TestWebAppFactory"/> hosts. The factory once configured those hosts through
/// PROCESS-WIDE environment variables, and two booted at once read each other's values with
/// nothing failing where the mistake was made. These tests hold the per-host configuration
/// (<c>UseSetting</c>) that replaced them.
/// </summary>
public sealed class TestWebAppFactoryIsolationTests
{
    [Fact]
    public async Task Factories_booted_concurrently_each_read_their_own_configuration()
    {
        const int count = 16;
        var factories = Enumerable.Range(0, count)
            .Select(i => new TestWebAppFactory
            {
                RateLimits = new Dictionary<string, int> { ["AuthPerMinute"] = 1_000 + i },
                ForwardLimit = 10 + i,
                TrustedProxies = $"10.0.{i}.0/24",
            })
            .ToList();

        try
        {
            using var start = new ManualResetEventSlim();
            var boots = factories
                .Select(f => Task.Run(() =>
                {
                    start.Wait();
                    _ = f.Services;
                }))
                .ToList();
            start.Set();
            await Task.WhenAll(boots);

            for (var i = 0; i < count; i++)
            {
                var config = factories[i].Services.GetRequiredService<IConfiguration>();
                Assert.Equal((1_000 + i).ToString(), config["RateLimits:AuthPerMinute"]);
                Assert.Equal((10 + i).ToString(), config["Gateway:ForwardLimit"]);
                Assert.Equal($"10.0.{i}.0/24", config["Gateway:TrustedProxies"]);
            }
        }
        finally
        {
            foreach (var factory in factories)
            {
                await factory.DisposeAsync();
            }
        }
    }

    /// <summary>
    /// The connection string is the one value Program.cs captures before the host is built
    /// (at <c>AddDbContext</c>), so it is the one a late-applied setting would miss. This reads it
    /// back off the DbContext the host actually registered.
    /// </summary>
    [SkippableFact]
    public async Task A_factorys_connection_string_is_the_one_its_DbContext_carries()
    {
        Skip.IfNot(PostgresDatabases.ServerConnectionString() is not null, "Postgres not configured");
        await using var database = await PostgresDatabases.CloneTemplateAsync();
        await using var factory = new TestWebAppFactory { ConnectionString = database.ConnectionString };

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        // R18 BE18s: the API caps its pool (Database:MaxPoolSize, default 40) by adding Maximum Pool
        // Size to the string it was given, so the factory's string is the clone's own string plus
        // that cap — never another database's.
        var carried = new Npgsql.NpgsqlConnectionStringBuilder(db.Database.GetConnectionString());
        var given = new Npgsql.NpgsqlConnectionStringBuilder(database.ConnectionString);
        Assert.Equal(40, carried.MaxPoolSize);
        carried.Remove("Maximum Pool Size");
        given.Remove("Maximum Pool Size");
        Assert.Equal(given.ConnectionString, carried.ConnectionString);
    }
}
