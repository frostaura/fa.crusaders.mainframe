using System.Net;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// One physical board, one row.
///
/// <para>
/// A board that has been reflashed, or whose key was lost, announces
/// <c>st=unclaimed</c> with no device id — indistinguishable from a brand-new board
/// except by its MAC. Before this, an admin reconnecting it created a <i>second</i>
/// <c>Device</c> row for the same hardware. Both rows derive working keys, both
/// authenticate, both look legitimate, and one court has two identities: heartbeats
/// land on whichever the board happens to hold, and revoking the row an admin can see
/// does not stop the board.
/// </para>
/// </summary>
public class DeviceMacIdentityTests
{
    private const string Mac = "5ccf7f1a2b3c";

    private static RegisterDeviceCommand Command(string code, string? mac) =>
        new(code, "Court 1 box", DeviceKind.CourtBox, DeviceHardware.Esp8266, 1, null) { MacAddress = mac };

    [Fact]
    public async Task A_discovered_device_records_the_board_it_belongs_to()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var devices = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();

        var registered = await devices.RegisterAsync(Command("court-box-1", Mac), host.AdminUser.Id, default);

        Assert.Equal(Mac, registered.Device.MacAddress);
    }

    /// <summary>A hand-registered device has no MAC, and must stay legal.</summary>
    [Fact]
    public async Task A_hand_registered_device_has_no_mac()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var devices = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();

        var registered = await devices.RegisterAsync(Command("court-box-1", null), host.AdminUser.Id, default);

        Assert.Null(registered.Device.MacAddress);
    }

    /// <summary>A MAC read off a beacon may arrive in any case; the row must not care.</summary>
    [Fact]
    public async Task Mac_lookup_is_case_insensitive()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var devices = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();

        await devices.RegisterAsync(Command("court-box-1", "5CCF7F1A2B3C"), host.AdminUser.Id, default);

        Assert.NotNull(await devices.FindByMacAddressAsync(Mac, default));
        Assert.NotNull(await devices.FindByMacAddressAsync("5CCF7F1A2B3C", default));
    }

    [Fact]
    public async Task An_unknown_board_is_not_found()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var devices = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();

        await devices.RegisterAsync(Command("court-box-1", Mac), host.AdminUser.Id, default);

        Assert.Null(await devices.FindByMacAddressAsync("000000000000", default));
    }

    /// <summary>
    /// The same board in two clubs is two rows, legitimately — a board sold on, or a
    /// tenant testing with borrowed hardware. The lookup must not cross the boundary.
    /// </summary>
    [Fact]
    public async Task The_same_board_in_two_tenants_stays_separate()
    {
        var db = $"shared-{Guid.NewGuid():N}";
        await using var alpha = await TestHost.CreateAsync("alpha", db);
        await using var bravo = await TestHost.CreateAsync("bravo", db);

        using (var scope = alpha.NewScope())
        {
            await scope.ServiceProvider.GetRequiredService<DeviceRegistryService>()
                .RegisterAsync(Command("court-box-1", Mac), alpha.AdminUser.Id, default);
        }

        using (var scope = bravo.NewScope())
        {
            var devices = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();

            // Tenant B cannot see tenant A's board...
            Assert.Null(await devices.FindByMacAddressAsync(Mac, default));

            // ...and may therefore register it itself.
            var registered = await devices.RegisterAsync(Command("court-box-1", Mac), bravo.AdminUser.Id, default);
            Assert.Equal(bravo.Tenant.Id, registered.Device.TenantId);
        }

        using (var scope = alpha.NewScope())
        {
            var found = await scope.ServiceProvider.GetRequiredService<DeviceRegistryService>()
                .FindByMacAddressAsync(Mac, default);

            Assert.Equal(alpha.Tenant.Id, found!.TenantId);
        }
    }
}

/// <summary>
/// The database-level half. The in-memory provider does not enforce unique indexes, so
/// the constraint that makes the application check more than advisory can only be proven
/// against real Postgres — and it is the one that decides a race between two admins
/// claiming the same board at once.
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class DeviceMacIndexTests
{
    private readonly PostgresFixture _pg;

    public DeviceMacIndexTests(PostgresFixture pg) => _pg = pg;

    [SkippableFact]
    public async Task One_board_cannot_be_registered_twice_in_a_tenant()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var tenantId = Guid.NewGuid();
        var mac = Guid.NewGuid().ToString("N")[..12];

        async Task InsertAsync(string code)
        {
            db.Devices.Add(new Device
            {
                TenantId = tenantId,
                DeviceCode = code,
                Name = "Court 1 box",
                CourtNumber = 1,
                MacAddress = mac,
            });
            await db.SaveChangesAsync();
        }

        await InsertAsync("court-box-1");

        var clash = await Assert.ThrowsAsync<DbUpdateException>(() => InsertAsync("court-box-2"));
        Assert.IsType<PostgresException>(clash.InnerException);

        db.ChangeTracker.Clear();
    }

    /// <summary>
    /// The filter is what keeps hand-registered devices usable. Without it the second
    /// null MAC collides and an admin can register exactly one device by hand, ever.
    /// </summary>
    [SkippableFact]
    public async Task Many_devices_may_have_no_mac_at_all()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var tenantId = Guid.NewGuid();

        for (var i = 1; i <= 3; i++)
        {
            db.Devices.Add(new Device
            {
                TenantId = tenantId,
                DeviceCode = $"hand-registered-{i}",
                Name = $"Court {i} box",
                CourtNumber = i,
                MacAddress = null,
            });
        }

        await db.SaveChangesAsync();

        Assert.Equal(3, await db.Devices.IgnoreQueryFilters().CountAsync(d => d.TenantId == tenantId));
    }
}
