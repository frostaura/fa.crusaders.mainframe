using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// What every monitoring suite needs: a fault row written exactly as the test wants it, and the
/// paths the three files share.
///
/// <para>
/// The club itself is <see cref="ControlBoardClub"/>'s — deliberately, rather than a second
/// seeder. A monitoring page and a control board ask about the same estate, and two fixtures
/// seeding "a club with boards" independently is how two suites end up proving things about two
/// different clubs. What is NOT reused is its <c>AddErrorAsync</c>: it writes a row at
/// <c>now</c> with no detail, no court and no resolution, and almost everything this surface
/// does is about a row whose times, detail and resolution are the point.
/// </para>
/// </summary>
public static class MonitoringFixture
{
    public const string ErrorsPath = "/api/v1/admin/monitoring/errors";
    public const string CsvPath = "/api/v1/admin/monitoring/errors.csv";
    public const string SummaryPath = "/api/v1/admin/monitoring/summary";
    public const string BulkPath = "/api/v1/admin/monitoring/errors/resolve-bulk";
    public const string TicketPath = "/api/v1/admin/monitoring/stream-ticket";
    public const string StreamPath = "/api/v1/admin/monitoring/stream";

    public static string ResolvePath(Guid id) => $"{ErrorsPath}/{id}/resolve";

    /// <summary>
    /// A club on the monitoring page's own numbers: UTC so a range is testable, a 60-second
    /// heartbeat so the link bands are far apart, and a five-second keep-alive so a stream test
    /// is seconds rather than half a minute.
    /// </summary>
    public const string Settings =
        """
        {"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"slice_price_credits":8,
         "timezone":"UTC","heartbeat_seconds":60,"sse_keepalive_seconds":5,
         "control_board_resync_seconds":30,"control_board_stale_multiplier":2}
        """;

    /// <summary>
    /// One row, written straight to the table. Directly rather than through
    /// <c>DeviceErrorService</c> because most of these tests need a fault first seen three months
    /// ago, resolved by a named admin, against a board that has since been deleted — and there is
    /// no sequence of live calls that produces one.
    /// </summary>
    public static async Task<Guid> AddErrorAsync(
        TestWebAppFactory factory, ControlBoardClub club, string code, ErrorRow? row = null)
    {
        var r = row ?? new ErrorRow();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var last = (r.LastSeenAt ?? DateTimeOffset.UtcNow).ToUniversalTime();
        var error = new DeviceError
        {
            TenantId = club.TenantId,
            DeviceId = r.DeviceId,
            ClaimedDeviceCode = r.ClaimedDeviceCode,
            ClaimedMac = r.ClaimedMac,
            Source = r.Source,
            Code = code,
            Severity = DeviceErrorCodes.SeverityOf(code),
            Detail = r.Detail,
            Court = r.Court,
            FirstSeenAt = (r.FirstSeenAt ?? last).ToUniversalTime(),
            LastSeenAt = last,
            Count = r.Count,

            // Unique per row unless the test is deliberately writing two rows that share one —
            // which the open/resolved pair test is.
            Fingerprint = r.Fingerprint ?? Guid.NewGuid().ToString("N"),
            ResolvedAt = r.ResolvedAt?.ToUniversalTime(),
            ResolvedByUserId = r.ResolvedByUserId,
            ResolutionNote = r.ResolutionNote,
        };
        db.DeviceErrors.Add(error);
        await db.SaveChangesAsync();
        return error.Id;
    }

    /// <summary>The one row as it stands in the table now, tenant filters bypassed so a cross-tenant assertion can look.</summary>
    public static async Task<DeviceError?> ReadAsync(TestWebAppFactory factory, Guid id)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.DeviceErrors.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(e => e.Id == id);
    }

    /// <summary>Deletes a board, so a row can be one whose device is gone.</summary>
    public static async Task DeleteDeviceAsync(TestWebAppFactory factory, Guid deviceId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var device = await db.Devices.IgnoreQueryFilters().FirstAsync(d => d.Id == deviceId);
        db.Devices.Remove(device);
        await db.SaveChangesAsync();
    }

    /// <summary>The real writer, on a scope set to this club — for the de-duplication fixtures.</summary>
    public static async Task RecordAsync(
        TestWebAppFactory factory, ControlBoardClub club, DeviceErrorReport report)
    {
        using var scope = factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(club.TenantId, club.Slug);
        await scope.ServiceProvider.GetRequiredService<DeviceErrorService>()
            .RecordAsync(report, CancellationToken.None);
    }

    public static List<JsonElement> Rows(JsonElement body) => [.. body.GetProperty("rows").EnumerateArray()];

    public static JsonElement Row(JsonElement body, Guid id)
        => Rows(body).Single(r => r.GetProperty("id").GetGuid() == id);
}

/// <summary>
/// Everything about one seeded fault that is not its code. A record rather than fifteen optional
/// parameters, which is what it was first.
/// </summary>
public sealed record ErrorRow
{
    public Guid? DeviceId { get; init; }
    public string? ClaimedDeviceCode { get; init; }
    public string? ClaimedMac { get; init; }
    public DeviceErrorSource Source { get; init; } = DeviceErrorSource.Device;
    public string? Detail { get; init; }
    public int? Court { get; init; }
    public int Count { get; init; } = 1;
    public DateTimeOffset? FirstSeenAt { get; init; }
    public DateTimeOffset? LastSeenAt { get; init; }
    public string? Fingerprint { get; init; }
    public DateTimeOffset? ResolvedAt { get; init; }
    public Guid? ResolvedByUserId { get; init; }
    public string? ResolutionNote { get; init; }
}

/// <summary>
/// <c>GET /api/v1/admin/monitoring/errors</c> and its CSV — GOAL item 7's admin list.
///
/// <para>
/// The claims under test are the ones an admin would be silently wrong about. <b>An empty list
/// is the most dangerous answer this surface can give</b>, because the sentence a club takes
/// away from an empty monitoring page is "the hardware is healthy" — so a code this server has
/// never heard of is REFUSED rather than answered with nothing, and a filter that matches
/// nothing is still a whole envelope with a zero in it. <b>The numbers above the rows are the
/// range's, never the page's</b>, because they are the numbers an admin quotes. And <b>a fault
/// is one row whose count climbs</b> rather than four hundred rows nobody scrolls past.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class MonitoringErrorsHttpTests
{
    private readonly PostgresFixture _pg;

    public MonitoringErrorsHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private Task<ControlBoardClub> SeedAsync(TestWebAppFactory factory, string prefix)
        => ControlBoardClub.SeedAsync(factory, prefix, MonitoringFixture.Settings);

    // ---- who may read it -------------------------------------------------------------

    /// <summary>The error log names every board the club owns and what is wrong with it. Not a member's page.</summary>
    [SkippableFact]
    public async Task A_member_may_not_read_the_error_log()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "monrole");

        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await club.MemberClient(factory).GetAsync(MonitoringFixture.ErrorsPath)).StatusCode);
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await club.MemberClient(factory).GetAsync(MonitoringFixture.SummaryPath)).StatusCode);
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await club.MemberClient(factory).GetAsync(MonitoringFixture.CsvPath)).StatusCode);
    }

    /// <summary>
    /// Both halves, because only the second is about this route: a request with no tenant is
    /// refused <c>400 tenant_unresolved</c> by the resolution middleware, which runs before
    /// authentication. The half that proves the route is protected is the one where the club IS
    /// resolved from the host and there is still no credential.
    /// </summary>
    [SkippableFact]
    public async Task An_unauthenticated_request_is_refused()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "monanon");

        var noTenant = await factory.CreateClient().GetAsync(MonitoringFixture.ErrorsPath);
        Assert.Equal(HttpStatusCode.BadRequest, noTenant.StatusCode);

        var anonymous = factory.CreateClient();
        anonymous.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";

        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync(MonitoringFixture.ErrorsPath)).StatusCode);
    }

    // ---- the empty case --------------------------------------------------------------

    /// <summary>
    /// Loading, empty and failed are three states. A club with nothing wrong answers a WHOLE
    /// envelope carrying zeros — never a 404 and never a bare <c>[]</c>, because a page that
    /// cannot tell "nothing is wrong" from "the read failed" renders the same silence for both,
    /// and on this surface the two sentences could not be further apart.
    /// </summary>
    [SkippableFact]
    public async Task A_club_with_nothing_wrong_answers_a_whole_envelope_of_zeros()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "monempty");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(MonitoringFixture.ErrorsPath);

        Assert.Empty(MonitoringFixture.Rows(body));
        Assert.Equal(0, body.GetProperty("total").GetInt32());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("cursor").ValueKind);
        Assert.Equal(MonitoringSettings.DefaultRetentionDays, body.GetProperty("retention_days").GetInt32());
        Assert.Equal("UTC", body.GetProperty("timezone").GetString());

        var counts = body.GetProperty("counts");
        foreach (var severity in new[] { "critical", "error", "warning", "info" })
        {
            Assert.Equal(0, counts.GetProperty(severity).GetInt32());
        }
    }

    // ---- refusals --------------------------------------------------------------------

    /// <summary>
    /// <b>The one refusal this surface needs more than the door log does.</b>
    /// <c>?code=bridge_desync</c> — a real firmware code this server has never heard of —
    /// answering <c>200</c> with an empty list tells an admin the club's hardware is healthy.
    /// It is refused by name, and the row that exists proves the list is not merely broken.
    /// </summary>
    [SkippableFact]
    public async Task An_unrecognised_code_is_refused_rather_than_answered_with_an_empty_list()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "moncode");
        var box = await club.AddBoxAsync(factory, "box-mon01", [1], lastSeenAt: DateTimeOffset.UtcNow);
        await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.LcdI2cTimeout, new ErrorRow { DeviceId = box });

        var client = club.AdminClient(factory);

        var refused = await client.GetAsync($"{MonitoringFixture.ErrorsPath}?code=bridge_desync");
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal(
            DeviceErrorQuery.CodeInvalid,
            (await refused.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        // The same refusal before a FILE is built, for the sharper version of the same reason: a
        // zero-row CSV under the ordinary filename is forwarded and filed as evidence.
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await client.GetAsync($"{MonitoringFixture.CsvPath}?code=bridge_desync")).StatusCode);

        // And a code this server DOES know still answers, so the refusal is about the vocabulary
        // rather than about the parameter being present at all.
        var listed = await client.GetFromJsonAsync<JsonElement>(
            $"{MonitoringFixture.ErrorsPath}?code={DeviceErrorCodes.LcdI2cTimeout}");
        Assert.Single(MonitoringFixture.Rows(listed));
    }

    /// <summary>
    /// Every closed vocabulary refused BY NAME, so a console can tell an admin which control it
    /// got wrong. The door log's grammar, and the door log's refusal codes.
    /// </summary>
    [SkippableTheory]
    [InlineData("?severity=fatal", DeviceErrorQuery.SeverityInvalid)]
    [InlineData("?state=pending", DeviceErrorQuery.StateInvalid)]
    [InlineData("?device=not-a-guid", DeviceErrorQuery.DeviceInvalid)]
    [InlineData("?limit=abc", DeviceErrorQuery.LimitInvalid)]
    [InlineData("?cursor=!!!!", DoorLogQuery.CursorInvalid)]
    [InlineData("?period=fortnight", DoorPeriod.PeriodInvalid)]
    [InlineData("?day=2026-13-40", DoorPeriod.DayInvalid)]
    [InlineData("?from=yesterday", DoorLogQuery.FromInvalid)]
    [InlineData("?to=soon", DoorLogQuery.ToInvalid)]
    [InlineData("?period=today&from=2026-09-01T00:00:00Z", DoorPeriod.RangeConflict)]
    [InlineData("?day=2026-09-01&period=today", DoorPeriod.RangeConflict)]
    public async Task Every_closed_vocabulary_is_refused_by_name(string query, string expected)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "monref");

        var response = await club.AdminClient(factory).GetAsync($"{MonitoringFixture.ErrorsPath}{query}");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(
            expected,
            (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
    }

    // ---- what the default question is ------------------------------------------------

    /// <summary>
    /// <b>The default is OPEN, and the default range is the club's whole retention.</b> A fault
    /// first seen on Tuesday is still wrong on Friday, so a rolling day — the door log's
    /// default — would read <c>open: 0</c> while a court sat dark. Both halves are asserted
    /// here because either one alone would hide the other.
    /// </summary>
    [SkippableFact]
    public async Task The_default_is_every_open_fault_in_the_clubs_retention_and_not_the_last_day()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "monstate");
        var box = await club.AddBoxAsync(factory, "box-mon02", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var now = DateTimeOffset.UtcNow;

        var old = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.MegaLinkLost,
            new ErrorRow { DeviceId = box, LastSeenAt = now.AddDays(-9), FirstSeenAt = now.AddDays(-9) });
        var fresh = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.HttpTimeout, new ErrorRow { DeviceId = box, LastSeenAt = now.AddMinutes(-2) });
        var done = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.LcdResync,
            new ErrorRow { DeviceId = box, LastSeenAt = now.AddHours(-1), ResolvedAt = now, ResolvedByUserId = club.AdminUserId });

        var client = club.AdminClient(factory);

        var open = await client.GetFromJsonAsync<JsonElement>(MonitoringFixture.ErrorsPath);
        Assert.Equal([fresh, old], MonitoringFixture.Rows(open).Select(r => r.GetProperty("id").GetGuid()));
        Assert.Equal(2, open.GetProperty("total").GetInt32());

        var resolved = await client.GetFromJsonAsync<JsonElement>($"{MonitoringFixture.ErrorsPath}?state=resolved");
        Assert.Equal([done], MonitoringFixture.Rows(resolved).Select(r => r.GetProperty("id").GetGuid()));

        var all = await client.GetFromJsonAsync<JsonElement>($"{MonitoringFixture.ErrorsPath}?state=all");
        Assert.Equal(3, all.GetProperty("total").GetInt32());

        // And a day's window really would have hidden the nine-day-old fault, which is the
        // mutant this test kills: a default range copied from DoorLogQuery.
        var day = await client.GetFromJsonAsync<JsonElement>($"{MonitoringFixture.ErrorsPath}?period=last_24h");
        Assert.Equal([fresh], MonitoringFixture.Rows(day).Select(r => r.GetProperty("id").GetGuid()));
    }

    // ---- the row ---------------------------------------------------------------------

    /// <summary>
    /// Every field the console renders, on one row, including the sentence a volunteer admin
    /// reads instead of the code.
    /// </summary>
    [SkippableFact]
    public async Task A_row_carries_its_board_its_sentence_and_its_resolution()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "monrow");
        var box = await club.AddBoxAsync(factory, "box-mon03", [1], lastSeenAt: DateTimeOffset.UtcNow, name: "Court box A");
        var now = DateTimeOffset.UtcNow;

        var id = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.RelayCmdDropped,
            new ErrorRow
            {
                DeviceId = box,
                Detail = "relay B refused twice",
                Court = 1,
                Count = 7,
                FirstSeenAt = now.AddHours(-3),
                LastSeenAt = now.AddMinutes(-4),
                ResolvedAt = now.AddMinutes(-1),
                ResolvedByUserId = club.AdminUserId,
                ResolutionNote = "replaced the relay board",
                Source = DeviceErrorSource.Device,
            });

        var body = await club.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>($"{MonitoringFixture.ErrorsPath}?state=all");
        var row = MonitoringFixture.Row(body, id);

        Assert.Equal(box, row.GetProperty("device_id").GetGuid());
        Assert.Equal("box-mon03", row.GetProperty("device_code").GetString());
        Assert.Equal("Court box A", row.GetProperty("device_name").GetString());
        Assert.Equal(DeviceKinds.CourtBox, row.GetProperty("device_kind").GetString());
        Assert.Equal("device", row.GetProperty("source").GetString());
        Assert.Equal(DeviceErrorCodes.RelayCmdDropped, row.GetProperty("code").GetString());
        Assert.Equal("critical", row.GetProperty("severity").GetString());
        Assert.Equal("relay B refused twice", row.GetProperty("detail").GetString());
        Assert.Equal(1, row.GetProperty("court").GetInt32());
        Assert.Equal(7, row.GetProperty("count").GetInt32());
        Assert.Equal("Board Admin", row.GetProperty("resolved_by_name").GetString());
        Assert.Equal("replaced the relay board", row.GetProperty("resolution_note").GetString());
        Assert.NotEqual(JsonValueKind.Null, row.GetProperty("resolved_at").ValueKind);

        // The headline is the server's, from the code — this audience cannot read
        // `relay_cmd_dropped`, which is the whole reason the column exists.
        Assert.Equal(DeviceErrorCodes.HeadlineOf(DeviceErrorCodes.RelayCmdDropped), row.GetProperty("headline").GetString());
        Assert.NotEqual(row.GetProperty("code").GetString(), row.GetProperty("headline").GetString());
    }

    /// <summary>
    /// <b>A row whose board has been deleted is still readable.</b> Its device row is gone, so
    /// the only identity it has left is what the caller claimed at the time — and a fault list
    /// that renders a blank where a board's name was is a list an admin cannot act on.
    /// </summary>
    [SkippableFact]
    public async Task A_row_whose_board_was_deleted_still_names_what_reported_it()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "mongone");
        var box = await club.AddBoxAsync(factory, "box-mon04", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var id = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.WdtReset,
            new ErrorRow { DeviceId = box, ClaimedDeviceCode = "box-mon04" });

        await MonitoringFixture.DeleteDeviceAsync(factory, box);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(MonitoringFixture.ErrorsPath);
        var row = MonitoringFixture.Row(body, id);

        Assert.Equal("box-mon04", row.GetProperty("device_code").GetString());
        Assert.Equal(JsonValueKind.Null, row.GetProperty("device_name").ValueKind);
        Assert.Equal(JsonValueKind.Null, row.GetProperty("device_kind").ValueKind);
    }

    /// <summary>
    /// A server-detected fault with no board at all — an authentication failure has none by
    /// construction — is a row, and it carries the MAC the caller claimed rather than nothing.
    /// </summary>
    [SkippableFact]
    public async Task A_fault_with_no_board_is_still_a_row()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "monnodev");
        var id = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.AuthFailed,
            new ErrorRow { Source = DeviceErrorSource.Server, ClaimedMac = "a1b2c3d4e5f6" });

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(MonitoringFixture.ErrorsPath);
        var row = MonitoringFixture.Row(body, id);

        Assert.Equal(JsonValueKind.Null, row.GetProperty("device_id").ValueKind);
        Assert.Equal(JsonValueKind.Null, row.GetProperty("device_code").ValueKind);
        Assert.Equal("server", row.GetProperty("source").GetString());
        Assert.Equal("a1b2c3d4e5f6", row.GetProperty("claimed_mac").GetString());
    }

    // ---- de-duplication, as the list sees it -----------------------------------------

    /// <summary>
    /// <b>A flood of one fault is ONE row whose count climbs.</b> Twenty simultaneous reports of
    /// the same fingerprint — the shape a failing link actually produces — and the list holds
    /// one row counting twenty. The mutant: a check-then-insert, which two concurrent reports
    /// walk straight through.
    /// </summary>
    [SkippableFact]
    public async Task Twenty_concurrent_reports_of_one_fault_are_one_row_counting_twenty()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "monflood");
        var box = await club.AddBoxAsync(factory, "box-mon05", [1], lastSeenAt: DateTimeOffset.UtcNow);

        await Task.WhenAll(Enumerable.Range(0, 20).Select(i =>
            MonitoringFixture.RecordAsync(factory, club, new DeviceErrorReport(
                Code: DeviceErrorCodes.SerialBadCrc,
                Source: DeviceErrorSource.Device,
                DeviceId: box,

                // The digits differ on every report and the fingerprint collapses them, which is
                // what makes "CRC error after 5031 ms" and "after 5104 ms" one fault.
                Detail: $"crc mismatch after {5000 + i}ms"))));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(MonitoringFixture.ErrorsPath);
        var row = Assert.Single(MonitoringFixture.Rows(body));

        Assert.Equal(20, row.GetProperty("count").GetInt32());
        Assert.Equal(1, body.GetProperty("total").GetInt32());

        // Stored verbatim, so an admin reads a real number rather than the collapsed one.
        Assert.Contains("ms", row.GetProperty("detail").GetString()!, StringComparison.Ordinal);
    }

    /// <summary>
    /// A resolved row and an open row with the SAME fingerprint both exist and both list. That
    /// is the filtered unique index working: it constrains the PRESENT, so history accumulates
    /// and a board failing again in month four opens a fresh row with a truthful first-seen.
    /// </summary>
    [SkippableFact]
    public async Task A_resolved_row_and_an_open_row_may_share_a_fingerprint()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "monfinger");
        var box = await club.AddBoxAsync(factory, "box-mon06", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var print = Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;

        var old = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.LcdI2cTimeout,
            new ErrorRow
            {
                DeviceId = box, Fingerprint = print, FirstSeenAt = now.AddDays(-30),
                LastSeenAt = now.AddDays(-30), ResolvedAt = now.AddDays(-29), ResolvedByUserId = club.AdminUserId,
            });
        var current = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.LcdI2cTimeout,
            new ErrorRow { DeviceId = box, Fingerprint = print, FirstSeenAt = now.AddHours(-2), LastSeenAt = now });

        var body = await club.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>($"{MonitoringFixture.ErrorsPath}?state=all");

        Assert.Equal([current, old], MonitoringFixture.Rows(body).Select(r => r.GetProperty("id").GetGuid()));

        // The fresh one's first-seen is its own, not the old one's resurrected.
        Assert.True(
            MonitoringFixture.Row(body, current).GetProperty("first_seen_at").GetDateTimeOffset()
            > now.AddDays(-1));
    }

    /// <summary>
    /// A firmware ahead of this server reports something real. It lands as <c>unknown</c> with
    /// the raw string in the detail, it is filterable, and it reads as the neutral sentence —
    /// never as a guess at what the code might have meant.
    /// </summary>
    [SkippableFact]
    public async Task An_unknown_firmware_code_is_visible_rather_than_silent()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "monunknown");
        var box = await club.AddBoxAsync(factory, "box-mon07", [1], lastSeenAt: DateTimeOffset.UtcNow);

        await MonitoringFixture.RecordAsync(factory, club, new DeviceErrorReport(
            Code: "relay_welded_shut", Source: DeviceErrorSource.Device, DeviceId: box, Detail: "relay C"));

        var body = await club.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>($"{MonitoringFixture.ErrorsPath}?code={DeviceErrorCodes.Unknown}");
        var row = Assert.Single(MonitoringFixture.Rows(body));

        Assert.Equal(DeviceErrorCodes.Unknown, row.GetProperty("code").GetString());
        Assert.Contains("relay_welded_shut", row.GetProperty("detail").GetString()!, StringComparison.Ordinal);
        Assert.Equal(DeviceErrorCodes.HeadlineOf(DeviceErrorCodes.Unknown), row.GetProperty("headline").GetString());
    }

    // ---- the numbers above the rows --------------------------------------------------

    /// <summary>
    /// <b><c>total</c> and <c>counts</c> are the RANGE's, never the page's.</b> A heading saying
    /// "2 open faults" above a page of two drawn from a range holding five is the number an
    /// admin quotes in a committee meeting. The keyset then walks the rest without skipping or
    /// repeating one.
    /// </summary>
    [SkippableFact]
    public async Task The_totals_are_the_ranges_and_the_cursor_walks_the_rest()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "monpage");
        var box = await club.AddBoxAsync(factory, "box-mon08", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var now = DateTimeOffset.UtcNow;

        // Five faults, three severities, one minute apart so the order is unambiguous.
        var codes = new[]
        {
            DeviceErrorCodes.MegaLinkLost, DeviceErrorCodes.LcdI2cTimeout, DeviceErrorCodes.WdtReset,
            DeviceErrorCodes.HttpTimeout, DeviceErrorCodes.Boot,
        };
        var seeded = new List<Guid>();
        for (var i = 0; i < codes.Length; i++)
        {
            seeded.Add(await MonitoringFixture.AddErrorAsync(
                factory, club, codes[i], new ErrorRow { DeviceId = box, LastSeenAt = now.AddMinutes(-i) }));
        }

        var client = club.AdminClient(factory);
        var first = await client.GetFromJsonAsync<JsonElement>($"{MonitoringFixture.ErrorsPath}?limit=2");

        Assert.Equal(2, MonitoringFixture.Rows(first).Count);
        Assert.Equal(5, first.GetProperty("total").GetInt32());

        var counts = first.GetProperty("counts");
        Assert.Equal(1, counts.GetProperty("critical").GetInt32());
        Assert.Equal(2, counts.GetProperty("error").GetInt32());
        Assert.Equal(1, counts.GetProperty("warning").GetInt32());
        Assert.Equal(1, counts.GetProperty("info").GetInt32());

        var cursor = first.GetProperty("cursor").GetString();
        Assert.NotNull(cursor);

        var walked = new List<Guid>(MonitoringFixture.Rows(first).Select(r => r.GetProperty("id").GetGuid()));
        while (cursor is not null)
        {
            var page = await client.GetFromJsonAsync<JsonElement>(
                $"{MonitoringFixture.ErrorsPath}?limit=2&cursor={Uri.EscapeDataString(cursor)}");
            walked.AddRange(MonitoringFixture.Rows(page).Select(r => r.GetProperty("id").GetGuid()));
            cursor = page.GetProperty("cursor").GetString();
        }

        // Every row exactly once, newest first — the failure a keyset over the wrong column
        // produces is a row repeated at one boundary and one skipped at the next.
        Assert.Equal(seeded, walked);
    }

    /// <summary>
    /// The counts are the breakdown of the same set <c>total</c> counts, so the chips above the
    /// list and the heading beside them cannot disagree. Filtering to one severity therefore
    /// zeroes the others rather than leaving the unfiltered club-wide numbers standing.
    /// </summary>
    [SkippableFact]
    public async Task The_counts_are_the_breakdown_of_the_same_set_the_total_counts()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "moncounts");
        var box = await club.AddBoxAsync(factory, "box-mon09", [1], lastSeenAt: DateTimeOffset.UtcNow);

        await MonitoringFixture.AddErrorAsync(factory, club, DeviceErrorCodes.MegaLinkLost, new ErrorRow { DeviceId = box });
        await MonitoringFixture.AddErrorAsync(factory, club, DeviceErrorCodes.LcdI2cTimeout, new ErrorRow { DeviceId = box });
        await MonitoringFixture.AddErrorAsync(factory, club, DeviceErrorCodes.HttpTimeout, new ErrorRow { DeviceId = box });

        var body = await club.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>($"{MonitoringFixture.ErrorsPath}?severity=critical");

        Assert.Equal(1, body.GetProperty("total").GetInt32());
        Assert.Equal(1, body.GetProperty("counts").GetProperty("critical").GetInt32());
        Assert.Equal(0, body.GetProperty("counts").GetProperty("error").GetInt32());
        Assert.Equal(0, body.GetProperty("counts").GetProperty("warning").GetInt32());
    }

    // ---- tenancy ---------------------------------------------------------------------

    /// <summary>
    /// A club's fault list never carries another club's board. Both clubs live in one database,
    /// which is the only arrangement under which this assertion means anything — and the
    /// <c>?device=</c> filter is checked too, because that is the parameter that takes another
    /// club's identifier straight off the wire.
    /// </summary>
    [SkippableFact]
    public async Task A_clubs_fault_list_never_carries_another_clubs_board()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await SeedAsync(factory, "monmine");
        var theirs = await SeedAsync(factory, "montheirs");

        var theirBox = await theirs.AddBoxAsync(factory, "box-montheirs", [1], lastSeenAt: DateTimeOffset.UtcNow);
        await MonitoringFixture.AddErrorAsync(
            factory, theirs, DeviceErrorCodes.MegaLinkLost,
            new ErrorRow { DeviceId = theirBox, Detail = "their secret board" });

        var client = mine.AdminClient(factory);

        var body = await client.GetFromJsonAsync<JsonElement>($"{MonitoringFixture.ErrorsPath}?state=all");
        Assert.Empty(MonitoringFixture.Rows(body));
        Assert.Equal(0, body.GetProperty("total").GetInt32());
        Assert.DoesNotContain("their secret board", JsonSerializer.Serialize(body), StringComparison.Ordinal);

        // Their board's own id, handed to my admin's filter: an empty page, not their faults.
        var filtered = await client.GetFromJsonAsync<JsonElement>(
            $"{MonitoringFixture.ErrorsPath}?state=all&device={theirBox}");
        Assert.Empty(MonitoringFixture.Rows(filtered));

        // And the export leaks nothing either — the same filters, the same isolation.
        var csv = await client.GetStringAsync($"{MonitoringFixture.CsvPath}?state=all");
        Assert.DoesNotContain("their secret board", csv, StringComparison.Ordinal);
    }

    // ---- the export ------------------------------------------------------------------

    /// <summary>
    /// <b>Every cell is defused before it is written.</b> A board's name and a fault's detail
    /// are strings a club and a firmware author chose, and a cell beginning <c>=</c>, <c>+</c>,
    /// <c>-</c> or <c>@</c> is a formula in a spreadsheet. The value is kept intact and
    /// prefixed, so the log is still readable and cannot execute.
    /// </summary>
    [SkippableFact]
    public async Task The_export_is_formula_safe_and_carries_the_pinned_header()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "moncsv");
        var box = await club.AddBoxAsync(
            factory, "box-mon10", [1], lastSeenAt: DateTimeOffset.UtcNow, name: "=HYPERLINK(\"http://evil\",\"pay\")");
        await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.HttpTimeout,
            new ErrorRow { DeviceId = box, Detail = "-2 attempts, then nothing" });

        var response = await club.AdminClient(factory).GetAsync(MonitoringFixture.CsvPath);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var csv = await response.Content.ReadAsStringAsync();
        var lines = csv.TrimEnd('\r', '\n').Split("\r\n");

        Assert.Equal(AdminMonitoringEndpoints.Header, lines[0].TrimStart('﻿'));
        Assert.Equal(2, lines.Length);

        // Defused, and intact: the apostrophe is added, the value is not stripped.
        Assert.Contains("'=HYPERLINK", csv, StringComparison.Ordinal);
        Assert.Contains("'-2 attempts", csv, StringComparison.Ordinal);

        // The file announces its own size, so the console stops announcing its page size.
        Assert.Equal("1", response.Headers.GetValues(AdminDoorLogEndpoint.RowsHeader).Single());
    }

    /// <summary>The export honours the same filters as the list it was taken from — anything else is a file that lies about its own name.</summary>
    [SkippableFact]
    public async Task The_export_honours_the_same_filters_as_the_list()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "moncsvf");
        var box = await club.AddBoxAsync(factory, "box-mon11", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var now = DateTimeOffset.UtcNow;

        await MonitoringFixture.AddErrorAsync(factory, club, DeviceErrorCodes.MegaLinkLost, new ErrorRow { DeviceId = box });
        await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.LcdResync,
            new ErrorRow { DeviceId = box, ResolvedAt = now, ResolvedByUserId = club.AdminUserId });

        var client = club.AdminClient(factory);

        var open = await client.GetStringAsync(MonitoringFixture.CsvPath);
        Assert.Equal(2, open.TrimEnd('\r', '\n').Split("\r\n").Length);

        var all = await client.GetStringAsync($"{MonitoringFixture.CsvPath}?state=all");
        Assert.Equal(3, all.TrimEnd('\r', '\n').Split("\r\n").Length);

        var critical = await client.GetStringAsync($"{MonitoringFixture.CsvPath}?state=all&severity=critical");
        Assert.Equal(2, critical.TrimEnd('\r', '\n').Split("\r\n").Length);
    }
}
