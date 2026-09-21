using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// GOAL item 7's device half: what a board says is wrong with itself, and where it lands.
///
/// <para>
/// <b>The channel already existed and terminated in a row nothing read.</b> <c>Kind::Fault</c>
/// has been on the wire since the event queue was written, and <c>boot</c> is emitted by both
/// firmwares in production today; both fell through the dispatch switch to a
/// <c>device.&lt;kind&gt;</c> audit row with a null outcome that no screen has ever shown. So
/// these tests are about modelling and surfacing, not about plumbing.
/// </para>
///
/// <para>
/// <b>The fields are reused rather than extended</b>, which is a constraint of the hardware:
/// the event record lives in a fixed ring on a part with no allocator. <c>subject</c> carries
/// the fault CODE, <c>duration_ms</c> the COUNT since that code was last reported, and
/// <c>court</c> the relay when the fault is about one.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class DeviceFaultIngestHttpTests
{
    private readonly PostgresFixture _pg;

    public DeviceFaultIngestHttpTests(PostgresFixture pg) => _pg = pg;

    private const string EventsPath = "/api/v1/device/events";
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed record Box(Guid DeviceId, string Mac, string ApiKey, Guid TenantId, string Slug);

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static async Task<Box> SeedAsync(TestWebAppFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        var slug = $"flt-{Guid.NewGuid():N}"[..20];
        var tenant = new Tenant
        {
            Slug = slug,
            DisplayName = "Fault Club",
            DeviceApiKey = DeviceApiKey.Generate(),
            DeviceApiKeyRegeneratedAt = DateTimeOffset.UtcNow,
        };
        db.Tenants.Add(tenant);
        db.TenantSettings.Add(new TenantSettings
        {
            TenantId = tenant.Id,
            SettingsJson = """{"slice_minutes":15,"timezone":"UTC","heartbeat_seconds":60}""",
        });
        db.Courts.Add(new Court { TenantId = tenant.Id, CourtNumber = 1, Name = "Court 1", SlicePriceCredits = 8m });

        var mac = Guid.NewGuid().ToString("N")[..12];
        var device = new Device
        {
            TenantId = tenant.Id,
            DeviceCode = $"box-{mac[^6..]}",
            Name = "Court box",
            Kind = DeviceKind.CourtBox,
            Hardware = DeviceHardware.Esp8266,
            MacAddress = mac,
            CourtNumbers = [1],
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync();

        return new Box(device.Id, mac, tenant.DeviceApiKey!, tenant.Id, slug);
    }

    private static async Task<HttpResponseMessage> UploadAsync(
        HttpClient client, Box box, params object[] events)
    {
        var body = JsonSerializer.SerializeToNode(new { uptime_ms = 600_000L, events })!.AsObject();
        body["mac"] = box.Mac;

        var req = new HttpRequestMessage(HttpMethod.Post, EventsPath)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", box.ApiKey);
        return await client.SendAsync(req);
    }

    private static object Fault(long seq, string code, long count = 1, int court = -1) => new
    {
        seq,
        uptime_ms = 590_000L,
        kind = "fault",
        court,
        subject = code,
        duration_ms = count,
    };

    /// <summary>
    /// The error log is written off the request thread, so a test has to wait for it rather
    /// than assert immediately — the alternative is a monitoring write that can fail a device
    /// upload, which is the one thing it must never be able to do.
    /// </summary>
    private static async Task<List<DeviceError>> ErrorsAsync(
        TestWebAppFactory factory, Box box, int expected)
    {
        for (var attempt = 0; attempt < 60; attempt++)
        {
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var rows = await db.DeviceErrors.IgnoreQueryFilters()
                .Where(e => e.TenantId == box.TenantId)
                .OrderBy(e => e.Code)
                .ToListAsync();
            if (rows.Count >= expected) return rows;
            await Task.Delay(100);
        }

        using var last = factory.Services.CreateScope();
        var lastDb = last.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await lastDb.DeviceErrors.IgnoreQueryFilters()
            .Where(e => e.TenantId == box.TenantId).OrderBy(e => e.Code).ToListAsync();
    }

    /// <summary>
    /// A reported fault becomes a row an admin can read, with the code the board sent and the
    /// count it aggregated.
    ///
    /// <para><b>Mutant:</b> drop the <c>fault</c> dispatch case. The event still gets its
    /// receipt and its audit row — which is exactly why nobody noticed for as long as they
    /// did — and the monitoring page stays empty.</para>
    /// </summary>
    [SkippableFact]
    public async Task A_reported_fault_becomes_a_row_carrying_its_code_and_its_count()
    {
        Skip.IfNot(_pg.Available, Skipped);
        using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        using var client = factory.CreateClient();

        var res = await UploadAsync(client, box, Fault(1, "serial_badcrc", count: 1200));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var row = Assert.Single(await ErrorsAsync(factory, box, 1));
        Assert.Equal("serial_badcrc", row.Code);
        Assert.Equal(1200, row.Count);
        Assert.Equal(DeviceErrorSource.Device, row.Source);
        Assert.Equal(box.DeviceId, row.DeviceId);

        // Severity is the SERVER's grade, never the board's — a table where half the
        // severities are the firmware's opinion is not sortable.
        Assert.Equal(DeviceErrorCodes.SeverityOf("serial_badcrc"), row.Severity);
    }

    /// <summary>
    /// A flood of one fault is ONE row whose count climbs — the whole point of the table.
    ///
    /// <para><b>Mutant:</b> insert instead of upserting, or drop the fingerprint's code from
    /// its material. Either turns a league night's bad cable into a page nobody can read.</para>
    /// </summary>
    [SkippableFact]
    public async Task A_flood_of_one_fault_is_one_row_with_a_climbing_count()
    {
        Skip.IfNot(_pg.Available, Skipped);
        using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        using var client = factory.CreateClient();

        await UploadAsync(client, box,
            Fault(1, "serial_badcrc", count: 10),
            Fault(2, "serial_badcrc", count: 20),
            Fault(3, "serial_badcrc", count: 30));

        for (var attempt = 0; attempt < 60; attempt++)
        {
            var rows = await ErrorsAsync(factory, box, 1);
            if (rows.Count == 1 && rows[0].Count == 60) break;
            await Task.Delay(100);
        }

        var row = Assert.Single(await ErrorsAsync(factory, box, 1));
        Assert.Equal(60, row.Count);
        Assert.True(row.LastSeenAt >= row.FirstSeenAt);
    }

    /// <summary>
    /// Two different codes are two rows. The count is only meaningful if it counts ONE thing.
    /// </summary>
    [SkippableFact]
    public async Task Two_different_codes_are_two_rows()
    {
        Skip.IfNot(_pg.Available, Skipped);
        using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        using var client = factory.CreateClient();

        await UploadAsync(client, box, Fault(1, "serial_badcrc"), Fault(2, "lcd_i2c_timeout"));

        var rows = await ErrorsAsync(factory, box, 2);
        Assert.Equal(2, rows.Count);
        Assert.Contains(rows, r => r.Code == "serial_badcrc");
        Assert.Contains(rows, r => r.Code == "lcd_i2c_timeout");
    }

    /// <summary>
    /// A code this server has never heard of is recorded as <c>unknown</c> WITH THE RAW STRING,
    /// never dropped.
    ///
    /// <para>
    /// A firmware ahead of this server reports something real. Dropping the string would make
    /// the monitoring page go quiet exactly when a new release starts misbehaving — which is
    /// the one moment a club is looking at it.
    /// </para>
    ///
    /// <para><b>Mutant:</b> return early on an unrecognised code.</para>
    /// </summary>
    [SkippableFact]
    public async Task An_unknown_firmware_code_is_recorded_with_its_raw_string_and_never_dropped()
    {
        Skip.IfNot(_pg.Available, Skipped);
        using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        using var client = factory.CreateClient();

        await UploadAsync(client, box, Fault(1, "flux_capacitor_desync"));

        var row = Assert.Single(await ErrorsAsync(factory, box, 1));
        Assert.Equal(DeviceErrorCodes.Unknown, row.Code);
        Assert.Contains("flux_capacitor_desync", row.Detail);
    }

    /// <summary>
    /// A <c>boot</c> event is recorded too — and at <c>Info</c>, because every board boots.
    ///
    /// <para>
    /// The value is the COUNT: a board restarting forty times in an evening is a failing power
    /// supply, and that is a sentence only this row can say.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_boot_is_recorded_at_info_and_repeated_boots_are_one_climbing_row()
    {
        Skip.IfNot(_pg.Available, Skipped);
        using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        using var client = factory.CreateClient();

        await UploadAsync(client, box,
            new { seq = 1L, uptime_ms = 1_000L, kind = "boot", court = -1, duration_ms = 0L },
            new { seq = 2L, uptime_ms = 2_000L, kind = "boot", court = -1, duration_ms = 0L });

        for (var attempt = 0; attempt < 60; attempt++)
        {
            var probe = await ErrorsAsync(factory, box, 1);
            if (probe.Count == 1 && probe[0].Count == 2) break;
            await Task.Delay(100);
        }

        var row = Assert.Single(await ErrorsAsync(factory, box, 1));
        Assert.Equal(DeviceErrorCodes.Boot, row.Code);
        Assert.Equal(DeviceErrorSeverity.Info, row.Severity);
        Assert.Equal(2, row.Count);
    }

    /// <summary>
    /// A replayed batch does not double-count. The receipt is what makes that free, and it is
    /// why the events queue is the right channel for faults and the heartbeat is not.
    ///
    /// <para><b>Mutant:</b> record the fault before the receipt, or outside the
    /// <c>recorded</c> branch.</para>
    /// </summary>
    [SkippableFact]
    public async Task A_replayed_batch_does_not_double_count_a_fault()
    {
        Skip.IfNot(_pg.Available, Skipped);
        using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        using var client = factory.CreateClient();

        await UploadAsync(client, box, Fault(1, "http_timeout", count: 5));
        await ErrorsAsync(factory, box, 1);

        await UploadAsync(client, box, Fault(1, "http_timeout", count: 5));
        await Task.Delay(500);

        var row = Assert.Single(await ErrorsAsync(factory, box, 1));
        Assert.Equal(5, row.Count);
    }

    /// <summary>
    /// A fault still gets its receipt and its audit row, so <c>accepted_through</c> arithmetic
    /// is untouched and the box's queue drains exactly as before.
    ///
    /// <para>
    /// A monitoring feature that changed the drain would be a monitoring feature that could
    /// wedge a board's queue — the failure the malformed-kind outcome exists to prevent.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_fault_is_still_receipted_and_still_audited()
    {
        Skip.IfNot(_pg.Available, Skipped);
        using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        using var client = factory.CreateClient();

        var res = await UploadAsync(client, box, Fault(7, "wdt_reset"));
        var body = JsonDocument.Parse(await res.Content.ReadAsStringAsync()).RootElement;

        Assert.Equal(7, body.GetProperty("accepted_through").GetInt64());
        Assert.Equal(1, body.GetProperty("recorded").GetInt32());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        Assert.True(await db.DeviceEventReceipts.IgnoreQueryFilters()
            .AnyAsync(r => r.DeviceId == box.DeviceId && r.Seq == 7 && r.Kind == "fault"));
        Assert.True(await db.AuditLogs.IgnoreQueryFilters()
            .AnyAsync(a => a.TenantId == box.TenantId && a.Action == "device.fault"));

        // …and NO second device.fault_<code> row. A board reporting a fault has not failed at
        // reporting it, and a refusal row per diagnostic would fill the door trail with
        // board health.
        Assert.False(await db.AuditLogs.IgnoreQueryFilters()
            .AnyAsync(a => a.TenantId == box.TenantId && a.Action.StartsWith("device.fault_")));
    }

    /// <summary>
    /// Another club's board never appears in this club's error log — the non-negotiable
    /// cross-tenant test, on a table fed by anything holding a club's device key.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_faults_are_never_in_this_clubs_error_log()
    {
        Skip.IfNot(_pg.Available, Skipped);
        using var factory = CreateFactory();
        var mine = await SeedAsync(factory);
        var theirs = await SeedAsync(factory);
        using var client = factory.CreateClient();

        await UploadAsync(client, theirs, Fault(1, "serial_badcrc", count: 99));
        await ErrorsAsync(factory, theirs, 1);

        Assert.Empty(await ErrorsAsync(factory, mine, 0));
        Assert.Single(await ErrorsAsync(factory, theirs, 1));
    }

    /// <summary>
    /// D2-B31. Two events in one batch sharing a sequence number must apply their side effect
    /// ONCE.
    ///
    /// <para>
    /// The seen-set was snapshotted before the loop and never updated inside it, so the second
    /// event passed the gate, ran its full settlement — moving money — and only then lost the
    /// unique index, which detached its receipt and its audit rows while the settlement's own
    /// save had already committed. Money moved with no receipt and no audit row, and
    /// <c>accepted_through</c> told the box to drop both.
    /// </para>
    ///
    /// <para>
    /// Asserted here on a fault rather than on an activation because the count is a number the
    /// test can read directly, and the defect is in the LOOP rather than in what the loop
    /// dispatches to.
    /// </para>
    ///
    /// <para><b>Mutant:</b> remove <c>alreadyRecorded.Add(e.Seq)</c>.</para>
    /// </summary>
    [SkippableFact]
    public async Task An_in_batch_duplicate_sequence_number_applies_its_side_effect_once()
    {
        Skip.IfNot(_pg.Available, Skipped);
        using var factory = CreateFactory();
        var box = await SeedAsync(factory);
        using var client = factory.CreateClient();

        var res = await UploadAsync(client, box,
            Fault(4, "queue_overflow", count: 3),
            Fault(4, "queue_overflow", count: 3));

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        await Task.Delay(700);

        var row = Assert.Single(await ErrorsAsync(factory, box, 1));
        Assert.Equal(3, row.Count);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Equal(1, await db.DeviceEventReceipts.IgnoreQueryFilters()
            .CountAsync(r => r.DeviceId == box.DeviceId && r.Seq == 4));
    }

    /// <summary>
    /// D2-B24. A box that is plainly talking is recorded as having talked, even when the batch
    /// it sent cannot be recorded at all.
    ///
    /// <para>
    /// Liveness used to be noted AFTER the whole loop, on the one route most able to throw. A
    /// box uploading every minute and failing on one poisoned event was declared offline: every
    /// admin mailed "court box not reporting", and the outage index began WAIVING NO-SHOW
    /// PENALTIES on those courts. The control board would paint that box red while it was
    /// working, and the error log would be its only contradicting evidence.
    /// </para>
    ///
    /// <para>
    /// Driven with a batch of zero events, which is the cheapest thing that reaches the route
    /// and used to return before the liveness line entirely.
    /// </para>
    ///
    /// <para><b>Mutant:</b> move the first <c>NoteHeartbeat</c> back below the loop.</para>
    /// </summary>
    [SkippableFact]
    public async Task An_empty_upload_still_records_that_the_box_is_talking()
    {
        Skip.IfNot(_pg.Available, Skipped);
        using var factory = CreateFactory();
        var box = await SeedAsync(factory);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var device = await db.Devices.IgnoreQueryFilters().FirstAsync(d => d.Id == box.DeviceId);
            device.LastSeenAt = DateTimeOffset.UtcNow.AddHours(-3);
            await db.SaveChangesAsync();
        }

        using var client = factory.CreateClient();
        var res = await UploadAsync(client, box);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        using var after = factory.Services.CreateScope();
        var db2 = after.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var refreshed = await db2.Devices.IgnoreQueryFilters().FirstAsync(d => d.Id == box.DeviceId);

        Assert.NotNull(refreshed.LastSeenAt);
        Assert.True(
            refreshed.LastSeenAt > DateTimeOffset.UtcNow.AddMinutes(-1),
            "a box that had just uploaded was still recorded as last seen three hours ago");
    }
}
