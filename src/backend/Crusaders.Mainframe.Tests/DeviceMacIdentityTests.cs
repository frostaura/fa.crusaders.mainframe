using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// One physical board, one row — and the board decides which row.
///
/// <para>
/// The MAC is now a device's whole identity: the club key says which club is calling and
/// the MAC says which board. So the rule that used to be about recognising a reflashed
/// board (and not silently giving one court two identities) is now the rule that decides
/// whether a heartbeat lands on an existing row or creates one.
/// </para>
/// </summary>
public class DeviceMacIdentityTests
{
    private const string Mac = "5ccf7f1a2b3c";

    /// <summary>
    /// Lenient about what arrives and strict about what is stored. A MAC that does not
    /// match the announced one byte for byte is worse than useless: it silently fails to
    /// recognise the board it exists to recognise, and under auto-registration it would
    /// register a second row for a board that already has one.
    /// </summary>
    [Theory]
    [InlineData("5ccf7f1a2b3c", "5ccf7f1a2b3c")]
    [InlineData("5CCF7F1A2B3C", "5ccf7f1a2b3c")]
    [InlineData("5c:cf:7f:1a:2b:3c", "5ccf7f1a2b3c")]
    [InlineData("5C-CF-7F-1A-2B-3C", "5ccf7f1a2b3c")]
    [InlineData("5ccf.7f1a.2b3c", "5ccf7f1a2b3c")]
    [InlineData("  5ccf7f1a2b3c  ", "5ccf7f1a2b3c")]
    public void A_mac_is_normalised_to_twelve_lowercase_hex(string input, string expected)
        => Assert.Equal(expected, DeviceRegistryService.NormaliseMacAddress(input));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("5ccf7f1a2b3")]        // eleven digits
    [InlineData("5ccf7f1a2b3cd")]      // thirteen
    [InlineData("5ccf7f1a2b3z")]       // a non-hex character must not silently truncate
    [InlineData("not a mac at all")]
    public void Anything_that_is_not_a_mac_is_refused(string? input)
        => Assert.Null(DeviceRegistryService.NormaliseMacAddress(input));

    [Fact]
    public async Task Auto_registration_names_the_box_after_the_last_six_hex_of_its_mac()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var devices = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();

        var device = await devices.AutoRegisterAsync(Mac, DeviceKind.CourtBox, default);

        Assert.Equal(Mac, device.MacAddress);
        Assert.Equal("box-1a2b3c", device.DeviceCode);
        Assert.True(device.AutoRegistered);
    }

    /// <summary>
    /// The courts are a guess, and the guess is the club's own courts in ascending order,
    /// bounded by the four relays the bank has. An admin who disagrees edits the row; the
    /// point is that a box is useful the moment it is switched on rather than after a form
    /// has been filled in.
    /// </summary>
    [Fact]
    public async Task Auto_registration_takes_the_clubs_courts_ascending_up_to_the_relay_count()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        // A fifth court exists; the relay bank has four positions, so it is left out.
        db.Courts.Add(new Court { TenantId = host.Tenant.Id, CourtNumber = 5, Name = "Court 5", SlicePriceCredits = 8m });
        await db.SaveChangesAsync();

        var device = await scope.ServiceProvider.GetRequiredService<DeviceRegistryService>()
            .AutoRegisterAsync(Mac, DeviceKind.CourtBox, default);

        Assert.Equal(new[] { 1, 2, 3, 4 }, device.CourtNumbers);
    }

    /// <summary>
    /// The F13 rule, at the one moment nobody is watching. A club whose map names four
    /// courts and a box that drives two used to have no valid configuration at all; the
    /// box gets the club's map with the buttons it cannot honour turned off.
    /// </summary>
    [Fact]
    public async Task A_box_with_fewer_courts_than_the_clubs_map_gets_a_trimmed_override()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        // Two of the fixture's four courts, so the club's default map (which selects four)
        // reaches past what this box can drive.
        db.Courts.RemoveRange(await db.Courts.Where(c => c.CourtNumber > 2).ToListAsync());
        await db.SaveChangesAsync();

        var device = await scope.ServiceProvider.GetRequiredService<DeviceRegistryService>()
            .AutoRegisterAsync(Mac, DeviceKind.CourtBox, default);

        Assert.Equal(new[] { 1, 2 }, device.CourtNumbers);
        Assert.NotNull(device.ButtonMapJson);
        Assert.Null(ButtonMap.FromJson(device.ButtonMapJson)!.FirstSelectionBeyond(2));
    }

    /// <summary>
    /// Two boards whose MACs happen to end in the same six digits. The short code is what
    /// an admin reads off a label, so it is preferred — but device_code is uniquely
    /// indexed, and a collision that threw would do so while a box was registering itself
    /// at six in the morning.
    /// </summary>
    [Fact]
    public async Task A_colliding_short_code_falls_back_to_the_full_mac()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var devices = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();

        var first = await devices.AutoRegisterAsync("5ccf7f1a2b3c", DeviceKind.CourtBox, default);
        var second = await devices.AutoRegisterAsync("aabbcc1a2b3c", DeviceKind.CourtBox, default);

        Assert.Equal("box-1a2b3c", first.DeviceCode);
        Assert.Equal("box-aabbcc1a2b3c", second.DeviceCode);
    }

    /// <summary>An admin editing the row is what clears the "nobody has checked this" flag.</summary>
    [Fact]
    public async Task An_admin_edit_clears_the_auto_registered_flag()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var devices = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();

        var device = await devices.AutoRegisterAsync(Mac, DeviceKind.CourtBox, default);
        var (updated, changes) = await devices.UpdateAsync(
            device, new UpdateDeviceCommand("Main box", null, null), host.AdminUser.Id, default);

        Assert.False(updated.AutoRegistered);

        // Acknowledging the row IS a change — somebody looked at it, which is the whole meaning
        // of the flag and what takes the row out of the unacknowledged cap. So this PATCH is
        // never the `unchanged` answer, even on its second identical send.
        Assert.Contains("acknowledged", changes);
    }

    /// <summary>
    /// Registration is auditable even though nobody performed it. A box that appeared has
    /// to be visible in the same trail as one an admin edited.
    /// </summary>
    [Fact]
    public async Task Auto_registration_is_audited()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();

        await scope.ServiceProvider.GetRequiredService<DeviceRegistryService>().AutoRegisterAsync(Mac, DeviceKind.CourtBox, default);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var audit = await db.AuditLogs.SingleAsync(a => a.Action == "device.auto_registered");

        Assert.Contains(Mac, audit.DetailsJson);
        Assert.Equal(Guid.Empty, audit.ActorUserId);
    }
}

/// <summary>
/// The database-level half. The in-memory provider does not enforce unique indexes, so
/// the constraint that makes the application check more than advisory can only be proven
/// against real Postgres — and it is the one that decides a race between two heartbeats
/// from a box that has just been switched on.
/// </summary>
public sealed class DeviceMacIndexTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public DeviceMacIndexTests(PostgresFixture pg) => _pg = pg;

    [SkippableFact]
    public async Task One_board_cannot_hold_two_rows_in_a_tenant()
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
                Name = "Court box",
                CourtNumbers = [1],
                MacAddress = mac,
            });
            await db.SaveChangesAsync();
        }

        await InsertAsync("box-000001");

        var clash = await Assert.ThrowsAsync<DbUpdateException>(() => InsertAsync("box-000002"));
        Assert.IsType<PostgresException>(clash.InnerException);

        db.ChangeTracker.Clear();
    }
}
