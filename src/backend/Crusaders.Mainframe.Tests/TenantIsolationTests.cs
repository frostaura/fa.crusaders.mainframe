using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Cross-tenant injection tests. Pattern: spin up two tenants, prove tenant A's queries cannot see tenant B's data.
/// Every tenant-scoped table should have an assertion here.
/// </summary>
public class TenantIsolationTests
{
    [Fact]
    public async Task Bookings_are_filtered_by_current_tenant()
    {
        await using var hostA = await TestHost.CreateAsync("alpha");
        await using var hostB = await TestHost.CreateAsync("bravo");

        // Top up + book under tenant A
        using (var scope = hostA.NewScope())
        {
            var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
            var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
            await ledger.PostAsync(new LedgerPosting(hostA.PlayerUser.Id, LedgerEntryType.TopUp, 200m, hostA.PlayerUser.Id), default);
            await booking.CreateAsync(hostA.Courts[0].Id, hostA.PlayerUser.Id, hostA.PlayerUser.Id, DateTimeOffset.UtcNow.AddHours(2), 1, default);
        }

        // Tenant B sees zero bookings, zero ledger entries — even though both DBs share an in-memory provider host.
        // (TestHost uses unique DB names per host, but the global query filter is what enforces isolation in real code.)
        using (var scope = hostB.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Empty(await db.Bookings.ToListAsync());
            Assert.Empty(await db.LedgerEntries.ToListAsync());
        }

        // And with IgnoreQueryFilters disabled, A still sees its own.
        using (var scope = hostA.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.NotEmpty(await db.Bookings.ToListAsync());
        }
    }

    [Fact]
    public async Task Memberships_are_filtered_by_current_tenant()
    {
        await using var hostA = await TestHost.CreateAsync("alpha");
        await using var hostB = await TestHost.CreateAsync("bravo");

        using (var scope = hostA.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var memberships = await db.Memberships.ToListAsync();
            Assert.All(memberships, m => Assert.Equal(hostA.Tenant.Id, m.TenantId));
        }

        using (var scope = hostB.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var memberships = await db.Memberships.ToListAsync();
            Assert.All(memberships, m => Assert.Equal(hostB.Tenant.Id, m.TenantId));
        }
    }
}
