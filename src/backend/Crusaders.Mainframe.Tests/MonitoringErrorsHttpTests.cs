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
public sealed class MonitoringErrorsHttpTests : IClassFixture<PostgresFixture>
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

/// <summary>
/// <c>GET /api/v1/admin/monitoring/summary</c> — the club's estate in one read.
///
/// <para>
/// <b>Its counts are the club's, not the list's.</b> The list answers a filtered question; this
/// answers the unfiltered one — how much is open, right now, at each severity — because that is
/// the number a page puts in its heading. A summary computed from whatever chip happened to be
/// selected is a summary that changes when somebody clicks.
/// </para>
/// </summary>
public sealed class MonitoringSummaryHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public MonitoringSummaryHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private Task<ControlBoardClub> SeedAsync(TestWebAppFactory factory, string prefix)
        => ControlBoardClub.SeedAsync(factory, prefix, MonitoringFixture.Settings);

    /// <summary>
    /// A club with nothing wrong answers a whole envelope of zeros and a NULL worst offender.
    /// Null rather than an empty object, because "the worst board is —" with a blank after it is
    /// a sentence a page renders, and null is a state it can branch on.
    /// </summary>
    [SkippableFact]
    public async Task A_healthy_club_has_no_worst_offender_rather_than_a_blank_one()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "sumclean");
        await club.AddBoxAsync(factory, "box-sum01", [1], lastSeenAt: DateTimeOffset.UtcNow);

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(MonitoringFixture.SummaryPath);

        Assert.Equal(0, body.GetProperty("open").GetProperty("error").GetInt32());
        Assert.Empty(body.GetProperty("by_device").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("worst_offender").ValueKind);
        Assert.Equal(0, body.GetProperty("last_24h").GetProperty("opened").GetInt32());
        Assert.Equal(0, body.GetProperty("last_24h").GetProperty("resolved").GetInt32());
    }

    /// <summary>
    /// Two boards, one of them badly off. The counts are open-only, the per-board block names
    /// its worst severity, and the worst offender is the one with the most open faults.
    /// </summary>
    [SkippableFact]
    public async Task Two_boards_and_the_worse_one_is_named()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "sumtwo");
        var now = DateTimeOffset.UtcNow;
        var bad = await club.AddBoxAsync(factory, "box-sum02", [1], lastSeenAt: now);
        var mild = await club.AddBoxAsync(factory, "box-sum03", [2], lastSeenAt: now);

        await MonitoringFixture.AddErrorAsync(factory, club, DeviceErrorCodes.MegaLinkLost, new ErrorRow { DeviceId = bad });
        await MonitoringFixture.AddErrorAsync(factory, club, DeviceErrorCodes.WdtReset, new ErrorRow { DeviceId = bad });
        await MonitoringFixture.AddErrorAsync(factory, club, DeviceErrorCodes.HttpTimeout, new ErrorRow { DeviceId = bad });
        await MonitoringFixture.AddErrorAsync(factory, club, DeviceErrorCodes.LcdResync, new ErrorRow { DeviceId = mild });

        // Resolved yesterday — open is open, and a closed fault is not one.
        await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.RelayCmdDropped,
            new ErrorRow { DeviceId = mild, ResolvedAt = now.AddHours(-2), ResolvedByUserId = club.AdminUserId });

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(MonitoringFixture.SummaryPath);

        var open = body.GetProperty("open");
        Assert.Equal(1, open.GetProperty("critical").GetInt32());
        Assert.Equal(1, open.GetProperty("error").GetInt32());
        Assert.Equal(2, open.GetProperty("warning").GetInt32());
        Assert.Equal(0, open.GetProperty("info").GetInt32());

        var boards = body.GetProperty("by_device").EnumerateArray().ToList();
        Assert.Equal(2, boards.Count);

        // Worst first, which is the order an admin would walk the club in.
        Assert.Equal("box-sum02", boards[0].GetProperty("device_code").GetString());
        Assert.Equal(3, boards[0].GetProperty("open").GetInt32());
        Assert.Equal("critical", boards[0].GetProperty("worst").GetString());
        Assert.Equal("online", boards[0].GetProperty("link").GetString());
        Assert.Equal(1, boards[1].GetProperty("open").GetInt32());
        Assert.Equal("warning", boards[1].GetProperty("worst").GetString());

        Assert.Equal("box-sum02", body.GetProperty("worst_offender").GetProperty("device_code").GetString());
        Assert.Equal(3, body.GetProperty("worst_offender").GetProperty("open").GetInt32());

        Assert.Equal(5, body.GetProperty("last_24h").GetProperty("opened").GetInt32());
        Assert.Equal(1, body.GetProperty("last_24h").GetProperty("resolved").GetInt32());
    }

    /// <summary>
    /// <b>The per-board list is deliberately shorter than the count above it, and that is not a
    /// discrepancy.</b> A fault with no board — an authentication failure has none by
    /// construction — is counted in <c>open</c> and cannot appear under a board, because
    /// inventing a board for it would attribute a stranger's bad key to a club's own hardware.
    /// The list, with no device filter, is where it is found.
    /// </summary>
    [SkippableFact]
    public async Task A_fault_with_no_board_counts_as_open_and_is_charged_to_no_board()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "sumorphan");
        await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.AuthFailed,
            new ErrorRow { Source = DeviceErrorSource.Server, ClaimedMac = "ffeeddccbbaa" });

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(MonitoringFixture.SummaryPath);

        Assert.Equal(1, body.GetProperty("open").GetProperty("error").GetInt32());
        Assert.Empty(body.GetProperty("by_device").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("worst_offender").ValueKind);
    }

    /// <summary>
    /// D2-B29, on this surface. A club that asked for a 600-second heartbeat gets boxes running
    /// at 300, so the band is derived from 300 — otherwise the fault list and the control board
    /// say two different things about the same silent box and neither is obviously wrong.
    /// </summary>
    [SkippableFact]
    public async Task The_band_comes_from_the_effective_heartbeat_not_the_configured_one()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ControlBoardClub.SeedAsync(
            factory, "sumeff",
            """{"slice_minutes":15,"timezone":"UTC","heartbeat_seconds":600}""");
        var now = DateTimeOffset.UtcNow;

        // 1000 s of silence. Against the CONFIGURED 600 x 3 = 1800 it is merely silent; against
        // the EFFECTIVE 300 x 3 = 900 it is offline, which is what the boxes actually do.
        var quiet = await club.AddBoxAsync(factory, "box-sum04", [1], lastSeenAt: now.AddSeconds(-1000));
        var shut = await club.AddBoxAsync(
            factory, "box-sum05", [2], lastSeenAt: now, enabled: false, outOfServiceSince: now.AddHours(-1));

        await MonitoringFixture.AddErrorAsync(factory, club, DeviceErrorCodes.MegaLinkLost, new ErrorRow { DeviceId = quiet });
        await MonitoringFixture.AddErrorAsync(factory, club, DeviceErrorCodes.MegaLinkLost, new ErrorRow { DeviceId = shut });

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(MonitoringFixture.SummaryPath);
        var boards = body.GetProperty("by_device").EnumerateArray()
            .ToDictionary(b => b.GetProperty("device_code").GetString()!, b => b.GetProperty("link").GetString());

        Assert.Equal("offline", boards["box-sum04"]);

        // The club's own decision outranks the board's chatter: a board an admin shut is out of
        // service even while it is heartbeating.
        Assert.Equal("out_of_service", boards["box-sum05"]);
    }

    /// <summary>A club's summary never counts another club's faults.</summary>
    [SkippableFact]
    public async Task A_clubs_summary_never_counts_another_clubs_faults()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await SeedAsync(factory, "summine");
        var theirs = await SeedAsync(factory, "sumtheirs");

        var theirBox = await theirs.AddBoxAsync(factory, "box-sumtheirs", [1], lastSeenAt: DateTimeOffset.UtcNow);
        await MonitoringFixture.AddErrorAsync(factory, theirs, DeviceErrorCodes.MegaLinkLost, new ErrorRow { DeviceId = theirBox });

        var body = await mine.AdminClient(factory).GetFromJsonAsync<JsonElement>(MonitoringFixture.SummaryPath);

        Assert.Equal(0, body.GetProperty("open").GetProperty("critical").GetInt32());
        Assert.Empty(body.GetProperty("by_device").EnumerateArray());
        Assert.DoesNotContain("box-sumtheirs", JsonSerializer.Serialize(body), StringComparison.Ordinal);
    }
}

/// <summary>
/// Resolving a fault — one at a time, and a list at a time.
///
/// <para>
/// <b>Three answers, and the two refusals are deliberately different.</b> A fault this club does
/// not have is <c>404</c>; a fault somebody else already closed is <c>409</c>, because the row
/// IS there, an admin can see who closed it, and answering "not found" for a row on their screen
/// is how two admins in one club start distrusting the page. The bulk route is per-item and
/// never all-or-nothing: the honest answer to a list of checkboxes is a list of outcomes.
/// </para>
/// </summary>
public sealed class MonitoringResolveHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public MonitoringResolveHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private Task<ControlBoardClub> SeedAsync(TestWebAppFactory factory, string prefix)
        => ControlBoardClub.SeedAsync(factory, prefix, MonitoringFixture.Settings);

    private static HttpContent Note(string? note) => JsonContent.Create(new { note });

    /// <summary>
    /// The row comes back resolved, named and noted — the SAME shape the list hands out, so a
    /// console can replace the row it was clicked in rather than re-fetching the page.
    /// </summary>
    [SkippableFact]
    public async Task Resolving_answers_the_whole_row_and_writes_the_trail()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "resone");
        var box = await club.AddBoxAsync(factory, "box-res01", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var id = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.LcdI2cTimeout, new ErrorRow { DeviceId = box });

        var response = await club.AdminClient(factory)
            .PostAsync(MonitoringFixture.ResolvePath(id), Note("reseated the ribbon cable"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var row = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(id, row.GetProperty("id").GetGuid());
        Assert.NotEqual(JsonValueKind.Null, row.GetProperty("resolved_at").ValueKind);
        Assert.Equal("Board Admin", row.GetProperty("resolved_by_name").GetString());
        Assert.Equal("reseated the ribbon cable", row.GetProperty("resolution_note").GetString());
        Assert.Equal(DeviceErrorCodes.HeadlineOf(DeviceErrorCodes.LcdI2cTimeout), row.GetProperty("headline").GetString());

        // It leaves the fault list's default question, which is the visible effect.
        var open = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(MonitoringFixture.ErrorsPath);
        Assert.Empty(MonitoringFixture.Rows(open));

        // And the club's trail says who did it. Not a door action — a board's health is not a
        // door action, which is the defect DoorAuditActions is named after.
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var audit = await db.AuditLogs.IgnoreQueryFilters().AsNoTracking()
            .Where(a => a.TenantId == club.TenantId && a.Action == AdminMonitoringEndpoints.ResolvedAction)
            .SingleAsync();
        Assert.Equal(club.AdminUserId, audit.ActorUserId);
        Assert.Contains(id.ToString(), audit.DetailsJson!, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// A second resolve is <c>409 already_resolved</c> and changes NOTHING — not the resolver,
    /// not the note, not the instant. Two admins clicking at once must not let the second
    /// overwrite the first's record of what was actually done.
    /// </summary>
    [SkippableFact]
    public async Task A_second_resolve_is_a_conflict_and_overwrites_nothing()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "restwice");
        var box = await club.AddBoxAsync(factory, "box-res02", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var id = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.WdtReset, new ErrorRow { DeviceId = box });

        var client = club.AdminClient(factory);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync(MonitoringFixture.ResolvePath(id), Note("first"))).StatusCode);

        var second = await client.PostAsync(MonitoringFixture.ResolvePath(id), Note("second"));
        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
        Assert.Equal(
            AdminMonitoringEndpoints.AlreadyResolved,
            (await second.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        Assert.Equal("first", (await MonitoringFixture.ReadAsync(factory, id))!.ResolutionNote);
    }

    /// <summary>
    /// A fault this club does not have — including another club's, which is the case that
    /// matters. Non-committal on purpose: the refusal must not tell an admin whether the id
    /// exists somewhere else.
    /// </summary>
    [SkippableFact]
    public async Task An_unknown_or_foreign_fault_is_not_found_and_is_untouched()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await SeedAsync(factory, "resmine");
        var theirs = await SeedAsync(factory, "restheirs");
        var theirBox = await theirs.AddBoxAsync(factory, "box-res03", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var theirFault = await MonitoringFixture.AddErrorAsync(
            factory, theirs, DeviceErrorCodes.MegaLinkLost, new ErrorRow { DeviceId = theirBox });

        var client = mine.AdminClient(factory);

        var invented = await client.PostAsync(MonitoringFixture.ResolvePath(Guid.NewGuid()), Note("x"));
        Assert.Equal(HttpStatusCode.NotFound, invented.StatusCode);

        var foreign = await client.PostAsync(MonitoringFixture.ResolvePath(theirFault), Note("x"));
        Assert.Equal(HttpStatusCode.NotFound, foreign.StatusCode);
        Assert.Equal(
            AdminMonitoringEndpoints.ErrorNotFound,
            (await foreign.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        // Their fault is exactly as open as it was.
        Assert.Null((await MonitoringFixture.ReadAsync(factory, theirFault))!.ResolvedAt);
    }

    /// <summary>A member cannot close a fault. It is the club's record of its own estate.</summary>
    [SkippableFact]
    public async Task A_member_may_not_resolve_a_fault()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "resrole");
        var box = await club.AddBoxAsync(factory, "box-res04", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var id = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.MegaLinkLost, new ErrorRow { DeviceId = box });

        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await club.MemberClient(factory).PostAsync(MonitoringFixture.ResolvePath(id), Note("x"))).StatusCode);
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await club.MemberClient(factory).PostAsync(MonitoringFixture.BulkPath, JsonContent.Create(new { ids = new[] { id } }))).StatusCode);

        Assert.Null((await MonitoringFixture.ReadAsync(factory, id))!.ResolvedAt);
    }

    /// <summary>
    /// The note is bounded to the column, truncated rather than refused — and the row that comes
    /// back carries the STORED note, so the console shows the admin exactly what was kept rather
    /// than the longer thing they typed beside a row that disagrees with it.
    /// </summary>
    [SkippableFact]
    public async Task An_over_long_note_is_truncated_and_the_response_says_what_was_kept()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "resnote");
        var box = await club.AddBoxAsync(factory, "box-res05", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var id = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.HttpTimeout, new ErrorRow { DeviceId = box });

        var essay = new string('n', DeviceError.MaxDetailLength + 400);
        var response = await club.AdminClient(factory).PostAsync(MonitoringFixture.ResolvePath(id), Note(essay));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var kept = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("resolution_note").GetString();

        Assert.Equal(DeviceError.MaxDetailLength, kept!.Length);
        Assert.Equal(kept, (await MonitoringFixture.ReadAsync(factory, id))!.ResolutionNote);
    }

    /// <summary>A resolve with no note at all is a resolve. A fault an admin simply attended to needs no sentence.</summary>
    [SkippableFact]
    public async Task A_resolve_with_no_note_is_still_a_resolve()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "resnonote");
        var box = await club.AddBoxAsync(factory, "box-res06", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var id = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.Boot, new ErrorRow { DeviceId = box });

        var response = await club.AdminClient(factory).PostAsync(MonitoringFixture.ResolvePath(id), Note(null));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(
            JsonValueKind.Null,
            (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("resolution_note").ValueKind);
        Assert.NotNull((await MonitoringFixture.ReadAsync(factory, id))!.ResolvedAt);
    }

    // ---- the bulk route --------------------------------------------------------------

    /// <summary>
    /// <b>Per-item, in request order, and never all-or-nothing.</b> One open fault, one somebody
    /// already closed, and one that belongs to another club: three different outcomes in one
    /// <c>200</c>, and the two that could not be resolved do not cost the one that could. The
    /// mutant is a transactional batch, where the foreign id takes the other two down with it.
    /// </summary>
    [SkippableFact]
    public async Task A_bulk_resolve_answers_each_item_in_request_order()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "resbulk");
        var theirs = await SeedAsync(factory, "resbulkx");
        var box = await club.AddBoxAsync(factory, "box-res07", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var theirBox = await theirs.AddBoxAsync(factory, "box-res08", [1], lastSeenAt: DateTimeOffset.UtcNow);
        var now = DateTimeOffset.UtcNow;

        var open = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.MegaLinkLost, new ErrorRow { DeviceId = box });
        var closed = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.LcdResync,
            new ErrorRow { DeviceId = box, ResolvedAt = now.AddHours(-1), ResolvedByUserId = club.AdminUserId });
        var foreign = await MonitoringFixture.AddErrorAsync(
            factory, theirs, DeviceErrorCodes.WdtReset, new ErrorRow { DeviceId = theirBox });
        var second = await MonitoringFixture.AddErrorAsync(
            factory, club, DeviceErrorCodes.HttpTimeout, new ErrorRow { DeviceId = box });

        // Deliberately ordered so the failure sits in the MIDDLE: an implementation that stops
        // at the first problem passes a test where the problem is last.
        var ids = new[] { open, closed, foreign, second };

        var response = await club.AdminClient(factory)
            .PostAsync(MonitoringFixture.BulkPath, JsonContent.Create(new { ids, note = "swept the club" }));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(4, body.GetProperty("requested").GetInt32());
        Assert.Equal(2, body.GetProperty("succeeded").GetInt32());
        Assert.Equal(2, body.GetProperty("failed").GetInt32());

        var results = body.GetProperty("results").EnumerateArray().ToList();
        Assert.Equal(ids, results.Select(r => r.GetProperty("id").GetGuid()));
        Assert.Equal(AdminMonitoringEndpoints.ResolvedStatus, results[0].GetProperty("status").GetString());
        Assert.Equal(AdminMonitoringEndpoints.AlreadyResolved, results[1].GetProperty("status").GetString());
        Assert.Equal(AdminMonitoringEndpoints.FailedStatus, results[2].GetProperty("status").GetString());
        Assert.Equal(AdminMonitoringEndpoints.ErrorNotFound, results[2].GetProperty("error").GetString());
        Assert.Equal(AdminMonitoringEndpoints.ResolvedStatus, results[3].GetProperty("status").GetString());

        // The effects, not just the report: two closed here, the other club's untouched, and
        // the one that was already closed keeps the resolver it already had.
        Assert.Equal("swept the club", (await MonitoringFixture.ReadAsync(factory, open))!.ResolutionNote);
        Assert.Equal("swept the club", (await MonitoringFixture.ReadAsync(factory, second))!.ResolutionNote);
        Assert.Null((await MonitoringFixture.ReadAsync(factory, foreign))!.ResolvedAt);
        Assert.Null((await MonitoringFixture.ReadAsync(factory, closed))!.ResolutionNote);
    }

    /// <summary>
    /// The batch is bounded, the refusal NAMES the bound, and an empty list is its own refusal.
    /// A console that has to discover a ceiling by hitting it will hit it in front of an admin.
    /// </summary>
    [SkippableFact]
    public async Task The_batch_is_bounded_and_the_refusal_states_the_bound()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "resbound");
        var client = club.AdminClient(factory);

        var tooMany = Enumerable.Range(0, AdminMonitoringEndpoints.MaxBulkIds + 1).Select(_ => Guid.NewGuid()).ToArray();
        var refused = await client.PostAsync(MonitoringFixture.BulkPath, JsonContent.Create(new { ids = tooMany }));
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);

        var body = await refused.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(AdminMonitoringEndpoints.TooManyIds, body.GetProperty("error").GetString());
        Assert.Equal(AdminMonitoringEndpoints.MaxBulkIds, body.GetProperty("max_ids").GetInt32());

        var empty = await client.PostAsync(MonitoringFixture.BulkPath, JsonContent.Create(new { ids = Array.Empty<Guid>() }));
        Assert.Equal(HttpStatusCode.BadRequest, empty.StatusCode);
        Assert.Equal(
            AdminMonitoringEndpoints.NoIds,
            (await empty.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        // A list naming one fault twice is a console bug, and answering it twice hides it.
        var twin = Guid.NewGuid();
        var duplicated = await client.PostAsync(
            MonitoringFixture.BulkPath, JsonContent.Create(new { ids = new[] { twin, twin } }));
        Assert.Equal(HttpStatusCode.BadRequest, duplicated.StatusCode);
        Assert.Equal(
            AdminMonitoringEndpoints.DuplicateId,
            (await duplicated.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
    }
}
