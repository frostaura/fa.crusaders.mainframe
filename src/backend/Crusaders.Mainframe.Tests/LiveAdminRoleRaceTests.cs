using System.Data.Common;
using System.Security.Claims;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <see cref="LiveAdminRole"/>'s one race: a role read already in flight when a revoke commits.
///
/// <para>
/// The read finished with "still an admin", the revoke's eviction removed an entry that did not
/// exist yet, and the read then cached its stale answer — so the demoted admin passed admin
/// routes for the next fifteen seconds on the very container whose whole promise is that a
/// demotion bites on the next request (review finding authz P3-1). Postgres-backed, because the
/// read has to be held open at the exact point between the database's answer and the cache
/// write, and only a real command pipeline has that point.
/// </para>
/// </summary>
public sealed class LiveAdminRoleRaceTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public LiveAdminRoleRaceTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    /// <summary>Holds the first read on the users table after its answer is in, until released.</summary>
    private sealed class HoldAfterRead : DbCommandInterceptor
    {
        public TaskCompletionSource Answered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override async ValueTask<DbDataReader> ReaderExecutedAsync(
            DbCommand command, CommandExecutedEventData eventData, DbDataReader result,
            CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("FROM users", StringComparison.Ordinal) && Answered.TrySetResult())
            {
                await Release.Task;
            }
            return result;
        }
    }

    /// <summary>The services a role check resolves, with the held context in place of the app's.</summary>
    private sealed class Provider(MainframeDbContext db) : IServiceProvider
    {
        public object? GetService(Type serviceType)
            => serviceType == typeof(MainframeDbContext) ? db : null;
    }

    private static ClaimsPrincipal AdminPrincipal(Guid userId, Guid tenantId)
        => new(new ClaimsIdentity(
        [
            new Claim(ClaimTypes.NameIdentifier, userId.ToString()),
            new Claim("tenant_id", tenantId.ToString()),
            new Claim(ClaimTypes.Role, "admin"),
        ], "Bearer"));

    [SkippableFact]
    public async Task A_role_read_in_flight_when_the_revoke_lands_does_not_cache_the_old_answer()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        var club = await DoorClub.SeedAsync(factory, "liverace");
        var live = new LiveAdminRole(new MemoryCache(new MemoryCacheOptions()));

        var hold = new HoldAfterRead();
        var options = new DbContextOptionsBuilder<MainframeDbContext>()
            .UseNpgsql(_pg.ConnectionString)
            .AddInterceptors(hold)
            .Options;
        await using var held = new MainframeDbContext(options, new TenantContext());

        // R: a request carrying the admin's token, missing the cache, its read answered "admin"
        // and held there.
        var inFlight = live.EnforceAsync(AdminPrincipal(club.AdminUserId, club.TenantId), new Provider(held), default);
        await hold.Answered.Task.WaitAsync(TimeSpan.FromSeconds(30));

        // The revoke commits and evicts — exactly what AdminRoleService does after its commit.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var admin = await db.Users.IgnoreQueryFilters().FirstAsync(u => u.Id == club.AdminUserId);
            admin.IsAdmin = false;
            await db.SaveChangesAsync();
        }
        live.Invalidate(club.TenantId, club.AdminUserId);

        hold.Release.SetResult();
        await inFlight;

        // The NEXT request must see the demotion.
        var next = AdminPrincipal(club.AdminUserId, club.TenantId);
        using (var scope = factory.Services.CreateScope())
        {
            await live.EnforceAsync(next, scope.ServiceProvider, default);
        }
        Assert.False(next.IsInRole("admin"));
    }
}
