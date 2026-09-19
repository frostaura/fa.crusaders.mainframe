using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Workers;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// W1.9 — the door trail is DELETED past the club's retention, not anonymised.
///
/// <para>
/// <b>This closes the residual <c>door-gate.md</c> §6 wrote down and left open.</b>
/// <c>RetentionWorker</c> has never deleted an audit row: past <c>retention_years</c> it points
/// the subject at a sentinel and keeps everything else, and it never touches
/// <c>DetailsJson</c> at all. So a club held a member-identified record of every door decision
/// it had ever made for two years, and an anonymous one for ever — against a spec whose own
/// §1 says a door scan is never attendance and whose threat section refuses to build anything
/// on these rows. Anonymising is not enough for a door: the row still says which door, at what
/// minute, and a club's membership is small enough that a pattern is a person.
/// </para>
///
/// <para>
/// <b>The receipts outlive the audit rows on purpose.</b> A <c>device_event_receipt</c> is what
/// makes an upload idempotent — a board may upload an event, lose the link before reading the
/// response, and upload it again, which is the normal shape of an unreliable network. Purging
/// a receipt inside <c>MaxEventAge</c> would let a re-upload write a second row for one scan,
/// so the floor is <c>max(door_log_retention_days, MaxEventAge)</c> and never the club's number
/// alone.
/// </para>
/// </summary>
public sealed class DoorRetentionTests
{
    private static RetentionWorker WorkerFor(TestHost host)
        => new(host.Services, NullLogger<RetentionWorker>.Instance);

    /// <summary>A club with the settings the caller names, and one door.</summary>
    private static async Task<Guid> SeedDoorAsync(TestHost host, string settingsJson)
    {
        using var scope = host.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var settings = await db.TenantSettings.FirstAsync(s => s.TenantId == host.Tenant.Id);
        settings.SettingsJson = settingsJson;

        var device = new Device
        {
            TenantId = host.Tenant.Id,
            DeviceCode = "gate-ret001",
            Name = "Front door",
            Kind = DeviceKind.Gate,
            Hardware = DeviceHardware.Esp32,
            GateKey = "front-door",
            MacAddress = Guid.NewGuid().ToString("N")[..12],
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync();
        return device.Id;
    }

    private static void AddRow(MainframeDbContext db, Guid tenantId, Guid deviceId, string action, DateTimeOffset at)
    {
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = tenantId,
            ActorUserId = Guid.Empty,
            SubjectUserId = Guid.NewGuid(),
            Action = action,
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new { device_id = deviceId }),
            CreatedAt = at,
        });
    }

    private const string NinetyDays =
        """{"slice_minutes":15,"grace_window_minutes":5,"timezone":"UTC","door_log_retention_days":90}""";

    [Fact]
    public async Task A_door_row_past_the_clubs_retention_is_deleted_and_not_anonymised()
    {
        await using var host = await TestHost.CreateAsync();
        var doorId = await SeedDoorAsync(host, NinetyDays);
        var now = DateTimeOffset.UtcNow;

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            AddRow(db, host.Tenant.Id, doorId, DeviceGateEndpoint.OpenedAction, now.AddDays(-91));
            AddRow(db, host.Tenant.Id, doorId, $"{DeviceGateEndpoint.DeniedActionPrefix}too_early", now.AddDays(-120));
            AddRow(db, host.Tenant.Id, doorId, DoorTrail.OfflineOpenAction, now.AddDays(-200));
            AddRow(db, host.Tenant.Id, doorId, DoorTrail.OfflineUnknownScanAction, now.AddDays(-95));
            await db.SaveChangesAsync();
        }

        await WorkerFor(host).TickAsync(default);

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var left = await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == host.Tenant.Id && a.Action != "retention.anonymised")
                .ToListAsync();

            Assert.Empty(left);
        }
    }

    [Fact]
    public async Task A_door_row_inside_the_clubs_retention_survives_untouched()
    {
        await using var host = await TestHost.CreateAsync();
        var doorId = await SeedDoorAsync(host, NinetyDays);
        var now = DateTimeOffset.UtcNow;

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            AddRow(db, host.Tenant.Id, doorId, DeviceGateEndpoint.OpenedAction, now.AddDays(-89));
            await db.SaveChangesAsync();
        }

        await WorkerFor(host).TickAsync(default);

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.AuditLogs.IgnoreQueryFilters()
                .SingleAsync(a => a.TenantId == host.Tenant.Id && a.Action == DeviceGateEndpoint.OpenedAction);
            Assert.NotNull(row.SubjectUserId);
        }
    }

    /// <summary>
    /// The purge is the DOOR's, not the audit log's. A booking row, a ledger adjustment and an
    /// admin's edit are not door rows and are governed by <c>retention_years</c>, which is years
    /// rather than days — deleting one here would take money evidence with it.
    /// </summary>
    [Fact]
    public async Task A_row_that_is_not_a_door_row_is_left_to_the_years_long_retention()
    {
        await using var host = await TestHost.CreateAsync();
        var doorId = await SeedDoorAsync(host, NinetyDays);
        var now = DateTimeOffset.UtcNow;

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            AddRow(db, host.Tenant.Id, doorId, "device.updated", now.AddDays(-200));
            AddRow(db, host.Tenant.Id, doorId, "device.registered", now.AddDays(-200));
            AddRow(db, host.Tenant.Id, doorId, "booking.created_on_behalf", now.AddDays(-200));
            AddRow(db, host.Tenant.Id, doorId, "credit.adjusted", now.AddDays(-200));
            await db.SaveChangesAsync();
        }

        await WorkerFor(host).TickAsync(default);

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var left = await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == host.Tenant.Id && a.Action != "retention.anonymised")
                .Select(a => a.Action)
                .ToListAsync();

            Assert.Equal(4, left.Count);
        }
    }

    /// <summary>The number is the club's, clamped — the same one the log's page states.</summary>
    [Fact]
    public async Task The_cutoff_is_the_clubs_own_setting()
    {
        await using var host = await TestHost.CreateAsync();
        var doorId = await SeedDoorAsync(
            host, """{"slice_minutes":15,"grace_window_minutes":5,"timezone":"UTC","door_log_retention_days":7}""");
        var now = DateTimeOffset.UtcNow;

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            AddRow(db, host.Tenant.Id, doorId, DeviceGateEndpoint.OpenedAction, now.AddDays(-8));
            AddRow(db, host.Tenant.Id, doorId, DeviceGateEndpoint.OpenedAction, now.AddDays(-6));
            await db.SaveChangesAsync();
        }

        await WorkerFor(host).TickAsync(default);

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var left = await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == host.Tenant.Id && a.Action == DeviceGateEndpoint.OpenedAction)
                .ToListAsync();
            Assert.Single(left);
        }
    }

    /// <summary>A hand-edited column is not a PUT, so the cutoff is clamped on read here too.</summary>
    [Fact]
    public async Task A_retention_below_the_floor_does_not_purge_a_weeks_worth_of_doors()
    {
        await using var host = await TestHost.CreateAsync();
        var doorId = await SeedDoorAsync(
            host, """{"slice_minutes":15,"grace_window_minutes":5,"timezone":"UTC","door_log_retention_days":1}""");
        var now = DateTimeOffset.UtcNow;

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            AddRow(db, host.Tenant.Id, doorId, DeviceGateEndpoint.OpenedAction, now.AddDays(-3));
            await db.SaveChangesAsync();
        }

        await WorkerFor(host).TickAsync(default);

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == host.Tenant.Id && a.Action == DeviceGateEndpoint.OpenedAction)
                .ToListAsync());
        }
    }

    /// <summary>
    /// The receipt floor. A club on the seven-day minimum still keeps its door receipts for the
    /// full event horizon, because a purged receipt is a re-upload that writes a second row for
    /// one scan.
    /// </summary>
    [Fact]
    public async Task Door_receipts_outlive_a_short_retention_by_the_event_horizon()
    {
        await using var host = await TestHost.CreateAsync();
        var doorId = await SeedDoorAsync(
            host, """{"slice_minutes":15,"grace_window_minutes":5,"timezone":"UTC","door_log_retention_days":7}""");
        var now = DateTimeOffset.UtcNow;

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

            // Inside the 30-day horizon though well past the club's seven days.
            db.DeviceEventReceipts.Add(new DeviceEventReceipt
            {
                TenantId = host.Tenant.Id, DeviceId = doorId, Seq = 1,
                Kind = DeviceEventEndpoints.GateOpenKind, OccurredAt = now.AddDays(-20), CreatedAt = now.AddDays(-20),
            });

            // Past both.
            db.DeviceEventReceipts.Add(new DeviceEventReceipt
            {
                TenantId = host.Tenant.Id, DeviceId = doorId, Seq = 2,
                Kind = DeviceEventEndpoints.GateOpenKind, OccurredAt = now.AddDays(-40), CreatedAt = now.AddDays(-40),
            });
            db.DeviceEventReceipts.Add(new DeviceEventReceipt
            {
                TenantId = host.Tenant.Id, DeviceId = doorId, Seq = 3,
                Kind = DeviceEventEndpoints.UnknownScanKind, OccurredAt = now.AddDays(-40), CreatedAt = now.AddDays(-40),
            });
            await db.SaveChangesAsync();
        }

        await WorkerFor(host).TickAsync(default);

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var left = await db.DeviceEventReceipts.IgnoreQueryFilters()
                .Where(r => r.TenantId == host.Tenant.Id)
                .Select(r => r.Seq)
                .ToListAsync();

            Assert.Equal([1L], left);
        }
    }

    /// <summary>A court box's activation receipt is not a door's and is not purged by this rule.</summary>
    [Fact]
    public async Task A_court_boxs_receipt_is_not_a_door_receipt()
    {
        await using var host = await TestHost.CreateAsync();
        var doorId = await SeedDoorAsync(host, NinetyDays);
        var now = DateTimeOffset.UtcNow;

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.DeviceEventReceipts.Add(new DeviceEventReceipt
            {
                TenantId = host.Tenant.Id, DeviceId = doorId, Seq = 9,
                Kind = "activation", OccurredAt = now.AddDays(-400), CreatedAt = now.AddDays(-400),
            });
            await db.SaveChangesAsync();
        }

        await WorkerFor(host).TickAsync(default);

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Single(await db.DeviceEventReceipts.IgnoreQueryFilters()
                .Where(r => r.TenantId == host.Tenant.Id).ToListAsync());
        }
    }

    /// <summary>Tenant isolation — a sweep for one club must not reach another's rows.</summary>
    [Fact]
    public async Task The_purge_never_crosses_a_tenant_boundary()
    {
        await using var host = await TestHost.CreateAsync();
        var doorId = await SeedDoorAsync(
            host, """{"slice_minutes":15,"grace_window_minutes":5,"timezone":"UTC","door_log_retention_days":7}""");
        var now = DateTimeOffset.UtcNow;
        var otherTenant = Guid.NewGuid();

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

            // Another club that keeps its doors for a year, with a row this club's sweep would
            // delete if the cutoff were applied without the tenant filter.
            db.Tenants.Add(new Tenant { Id = otherTenant, Slug = "other-club", DisplayName = "Other" });
            db.TenantSettings.Add(new TenantSettings
            {
                TenantId = otherTenant,
                SettingsJson = """{"timezone":"UTC","door_log_retention_days":365}""",
            });
            AddRow(db, otherTenant, doorId, DeviceGateEndpoint.OpenedAction, now.AddDays(-30));
            AddRow(db, host.Tenant.Id, doorId, DeviceGateEndpoint.OpenedAction, now.AddDays(-30));
            await db.SaveChangesAsync();
        }

        await WorkerFor(host).TickAsync(default);

        using (var scope = host.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Assert.Single(await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == otherTenant && a.Action == DeviceGateEndpoint.OpenedAction).ToListAsync());
            Assert.Empty(await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.TenantId == host.Tenant.Id && a.Action == DeviceGateEndpoint.OpenedAction).ToListAsync());
        }
    }
}
