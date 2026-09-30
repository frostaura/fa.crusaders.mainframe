using System.Collections.Concurrent;
using System.Data.Common;
using System.Net;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Perf round (2026-09-30), backend item 4: every tenant-scoped request looked its club up by slug
/// before its handler ran. A club row is only ever added, so a found slug is remembered per host;
/// a slug that is NOT found is never remembered.
/// </summary>
public sealed class TenantSlugCacheHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private const string SlugLookup = "FROM tenants AS t\nWHERE t.\"Slug\" = @";

    [SkippableFact]
    public async Task A_found_club_is_looked_up_once_not_on_every_request()
    {
        Skip.IfNot(pg.Available, Skipped);
        var commands = new CommandLog();
        await using var baseFactory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var f = baseFactory.WithWebHostBuilder(b => b.ConfigureServices(s =>
            s.ConfigureDbContext<MainframeDbContext>(o => o.AddInterceptors(commands))));
        var club = await PlayersClub.SeedAsync(f, "slugcache");
        var olive = club.Client(f, club.Organiser);

        Assert.Equal(HttpStatusCode.OK, (await olive.GetAsync("/api/v1/me/profile")).StatusCode);
        var afterFirst = commands.Count(SlugLookup);
        for (var i = 0; i < 5; i++) Assert.Equal(HttpStatusCode.OK, (await olive.GetAsync("/api/v1/me/profile")).StatusCode);

        Assert.True(afterFirst >= 1, "the first request resolves the club from the database");
        Assert.Equal(afterFirst, commands.Count(SlugLookup));
    }

    [SkippableFact]
    public async Task A_club_that_was_not_there_is_found_the_moment_it_exists()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await PlayersClub.SeedAsync(f, "slugmiss");
        var slug = $"late{Guid.NewGuid():N}"[..20];
        var anonymous = f.CreateClient();
        HttpRequestMessage Preview()
        {
            var request = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/invites/{new string('a', 43)}/preview");
            request.Headers.Host = $"{slug}.example.test";
            return request;
        }

        var before = await anonymous.SendAsync(Preview());
        Assert.Equal(HttpStatusCode.NotFound, before.StatusCode);
        Assert.Contains("tenant_not_found", await before.Content.ReadAsStringAsync(), StringComparison.Ordinal);

        await PlayersClub.ReadAsync(f, async db =>
        {
            var tenant = new Tenant
            {
                Slug = slug, DisplayName = "Late Club",
                DeviceApiKey = DeviceApiKey.Generate(), DeviceApiKeyRegeneratedAt = DateTimeOffset.UtcNow,
            };
            db.Tenants.Add(tenant);
            db.TenantSettings.Add(new TenantSettings { TenantId = tenant.Id, SettingsJson = PlayersClub.Settings });
            return await db.SaveChangesAsync();
        });

        var after = await anonymous.SendAsync(Preview());
        Assert.DoesNotContain("tenant_not_found", await after.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    private sealed class CommandLog : DbCommandInterceptor
    {
        private readonly ConcurrentQueue<string> _texts = new();

        public int Count(string fragment) => _texts.Count(t => t.Contains(fragment, StringComparison.Ordinal));

        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            _texts.Enqueue(command.CommandText);
            return ValueTask.FromResult(result);
        }
    }
}
