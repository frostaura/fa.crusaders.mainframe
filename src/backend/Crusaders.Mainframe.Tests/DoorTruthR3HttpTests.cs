using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Round three's backend findings: the places a door surface said something that was not true,
/// and the places it could not say anything at all.
///
/// <para>
/// <b>The theme of the round, and of this file, is the product reasoning from evidence it had
/// itself destroyed.</b> A shut door's console reasoned about whether the board had been told
/// from a silence the server manufactured by refusing to record that the board was talking to
/// it (R3-1). The outage history described one continuous silence as four recoveries because a
/// close by a switch was written in the same shape as a close by a heartbeat (R3-2). "Newest
/// first" was asserted over a list ordered by a column nobody was looking at (R3-17). A
/// "Not recognised" filter could not reach the rows the same page labelled "Not recognised"
/// (R3-16). In every one of those the screen was not merely unhelpful: it was confidently
/// wrong, and a test that only asserted the happy answer would have stayed green through all
/// four.
/// </para>
///
/// <para>
/// Postgres-backed, because every one of these reads either jsonb containment or a real
/// migration.
/// </para>
/// </summary>
public sealed class DoorTruthR3HttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public DoorTruthR3HttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string LogPath = "/api/v1/admin/doors/activity";
    private const string CsvPath = "/api/v1/admin/doors/activity.csv";

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    private static List<JsonElement> Items(JsonElement body) => body.GetProperty("items").EnumerateArray().ToList();

    /// <summary>A client carrying the club's device key, which is how every board authenticates.</summary>
    private static HttpClient BoardClient(TestWebAppFactory factory, DoorClub club)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", club.DeviceKey);
        return client;
    }

    private static async Task<Device> DeviceAsync(TestWebAppFactory factory, Guid deviceId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.Devices.IgnoreQueryFilters().AsNoTracking().FirstAsync(d => d.Id == deviceId);
    }

    private static async Task<List<DeviceOutage>> OutagesAsync(TestWebAppFactory factory, Guid deviceId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.DeviceOutages.IgnoreQueryFilters().AsNoTracking()
            .Where(o => o.DeviceId == deviceId).OrderBy(o => o.DetectedAt).ToListAsync();
    }

    /// <summary>
    /// A signed-out client that still names the club — by the HOST, which is the only way this
    /// product resolves a tenant for an anonymous caller. A query parameter does not do it, and
    /// the failure is a <c>404 tenant_not_found</c> that reads exactly like a broken route.
    /// </summary>
    private static HttpClient AnonymousClient(TestWebAppFactory factory, DoorClub club)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";
        return client;
    }

    /// <summary>The MAC of a seeded door, which the fixture invents and the board must send.</summary>
    private static async Task<string> MacAsync(TestWebAppFactory factory, Guid deviceId)
        => (await DeviceAsync(factory, deviceId)).MacAddress;

    // ------------------------------------------------------------------ R3-1: a shut door hears

    /// <summary>
    /// The refusal a shut board gets is itself contact, and the server now writes down both
    /// halves: that the board is reachable, and that it has been told.
    /// </summary>
    [SkippableFact]
    public async Task A_shut_boards_refused_call_is_recorded_as_contact_and_as_having_been_heard()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3shut");
        var stale = DateTimeOffset.UtcNow.AddHours(-2);
        var doorId = await club.AddDoorAsync(
            factory, "gate-r30001", "front-door", name: "Front door", enabled: false, lastSeenAt: stale);
        var mac = await MacAsync(factory, doorId);

        var response = await BoardClient(factory, club).PostAsJsonAsync(
            "/api/v1/device/gate", new { mac, method = "qr", token = "WHATEVER12" });

        // The answer is unchanged and must stay unchanged: on this surface a 403 means "the club
        // has taken this board out of service" and nothing else.
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);

        var device = await DeviceAsync(factory, doorId);
        Assert.NotNull(device.ShutHeardAt);
        Assert.True(device.LastSeenAt > stale, "a refused call is still a call; last_seen_at must move");

        // And no outage row either way. The sweep skips disabled rows, so there is never an open
        // one to extend — and minting a closed one for a board the club switched off itself is
        // the noise the switch-close exists to prevent.
        Assert.Empty(await OutagesAsync(factory, doorId));
    }

    /// <summary>
    /// The instant is the FIRST 403 of this shut. A board retries on a fixed cadence, and a
    /// value that moved forward on every retry would answer "it heard just now" for ever —
    /// which is not the question the console asks.
    /// </summary>
    [SkippableFact]
    public async Task The_heard_instant_is_the_first_refusal_and_a_reopen_clears_it()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3heard");
        var doorId = await club.AddDoorAsync(factory, "gate-r30002", "side-door", enabled: false);
        var mac = await MacAsync(factory, doorId);
        var board = BoardClient(factory, club);

        await board.PostAsJsonAsync("/api/v1/device/heartbeat", new { mac, kind = "gate", uptime_ms = 1000 });
        var first = (await DeviceAsync(factory, doorId)).ShutHeardAt;
        Assert.NotNull(first);

        await Task.Delay(30);
        await board.PostAsJsonAsync("/api/v1/device/heartbeat", new { mac, kind = "gate", uptime_ms = 2000 });
        Assert.Equal(first, (await DeviceAsync(factory, doorId)).ShutHeardAt);

        // Reopened: the door has not been told anything, because there is nothing to tell.
        var reopen = await club.AdminClient(factory).PatchAsJsonAsync(
            $"/api/v1/admin/devices/{doorId}", new { enabled = true });
        Assert.Equal(HttpStatusCode.OK, reopen.StatusCode);
        Assert.Null((await DeviceAsync(factory, doorId)).ShutHeardAt);

        // And shutting it again does not inherit the previous shut's instant, which would make
        // the console confirm a new shut with an old shut's evidence.
        await club.AdminClient(factory).PatchAsJsonAsync($"/api/v1/admin/devices/{doorId}", new { enabled = false });
        Assert.Null((await DeviceAsync(factory, doorId)).ShutHeardAt);
    }

    /// <summary>
    /// A board belonging to ANOTHER club is not reachable through this club's key, shut or not —
    /// and the new write must not become the first thing on this surface that can tell whether a
    /// MAC exists elsewhere.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_shut_board_is_not_reachable_and_is_not_written_to()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await DoorClub.SeedAsync(factory, "r3mine");
        var theirs = await DoorClub.SeedAsync(factory, "r3theirs");

        var theirDoorId = await theirs.AddDoorAsync(factory, "gate-r30003", "their-door", enabled: false);
        var theirMac = await MacAsync(factory, theirDoorId);

        var response = await BoardClient(factory, mine).PostAsJsonAsync(
            "/api/v1/device/gate", new { mac = theirMac, method = "qr", token = "WHATEVER12" });

        // 404, not 403: this club has no such board, and the tenant filter is what says so.
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);

        var untouched = await DeviceAsync(factory, theirDoorId);
        Assert.Null(untouched.ShutHeardAt);
        Assert.Null(untouched.LastSeenAt);
    }

    // ------------------------------------------------------------------ R3-13 / R3-32 / R3-15: refusals

    /// <summary>
    /// A door id this club cannot answer for is refused by name. An empty list under the ordinary
    /// heading is the answer that lies, and the export is where it gets filed as evidence.
    /// </summary>
    [SkippableFact]
    public async Task A_door_this_club_never_had_is_refused_by_name_on_the_log_and_the_export()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3stale");
        await club.AddDoorAsync(factory, "gate-r30006", "front-door");
        var stranger = Guid.NewGuid();

        var admin = club.AdminClient(factory);
        foreach (var path in new[] { LogPath, CsvPath })
        {
            var response = await admin.GetAsync($"{path}?door={stranger}");
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Contains(DoorLogQuery.DoorNotFound, await response.Content.ReadAsStringAsync());
        }

        // The neighbouring edge, and the one that must NOT be refused: a door the club removed.
        // Its rows survive it, the log offers it in removed_doors, and filtering by it is a real
        // question with a real answer.
        var removedId = Guid.NewGuid();
        await club.WriteRowAsync(
            factory, removedId, DeviceGateEndpoint.OpenedAction, DateTimeOffset.UtcNow.AddMinutes(-20),
            gateKey: "old-door", doorName: "Old door");
        await club.DeleteRecordAsync(factory, removedId, "gate-old", DateTimeOffset.UtcNow.AddMinutes(-10));

        var removed = await admin.GetFromJsonAsync<JsonElement>($"{LogPath}?removed_door={removedId}");
        Assert.Single(Items(removed));
    }

    /// <summary>
    /// A limit that is not a number cannot be clamped to anything, so it is refused; one that is
    /// merely out of range is still clamped, because a console asking for too much is
    /// unambiguous.
    /// </summary>
    [SkippableTheory]
    [InlineData("abc")]
    [InlineData("1e9")]
    [InlineData("")]
    [InlineData("12.5")]
    public async Task A_limit_that_is_not_an_integer_is_refused_by_name(string limit)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3limit");

        var response = await club.AdminClient(factory).GetAsync($"{LogPath}?limit={limit}");

        // An EMPTY limit is absent, not invalid — a console that clears its own input has said
        // nothing rather than said nonsense.
        if (limit.Length == 0)
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return;
        }

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal($"{{\"error\":\"{DoorLogQuery.LimitInvalid}\"}}", await response.Content.ReadAsStringAsync());
    }

    /// <summary>The clamp survives, in both directions, and is documented by being asserted.</summary>
    [SkippableTheory]
    [InlineData("-1", 1)]
    [InlineData("0", 1)]
    [InlineData("100000", DoorLogQuery.MaxLimit)]
    public async Task A_limit_outside_the_range_is_clamped_rather_than_refused(string asked, int effective)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3clamp");
        var doorId = await club.AddDoorAsync(factory, "gate-r30007", "front-door");
        for (var i = 0; i < 3; i++)
        {
            await club.WriteRowAsync(
                factory, doorId, DeviceGateEndpoint.OpenedAction, DateTimeOffset.UtcNow.AddMinutes(-i - 1),
                gateKey: "front-door");
        }

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>($"{LogPath}?limit={asked}");
        Assert.Equal(Math.Min(effective, 3), Items(body).Count);
    }

    /// <summary>
    /// A day outside the range a club day can take is a refusal, not an exception.
    /// <c>day=9999-12-31</c> asked <c>DateOnly</c> for the day after the last one it has.
    /// </summary>
    [SkippableTheory]
    [InlineData("9999-12-31")]
    [InlineData("1999-12-31")]
    [InlineData("0001-01-01")]
    public async Task A_day_outside_the_bounds_is_a_named_refusal_and_never_a_500(string day)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3day");

        var response = await club.AdminClient(factory).GetAsync($"{LogPath}?day={day}");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal($"{{\"error\":\"{DoorPeriod.DayInvalid}\"}}", await response.Content.ReadAsStringAsync());
    }

    /// <summary>
    /// The neighbouring edge: TOMORROW in the club's own zone is answerable. An admin whose club
    /// is ahead of the server must not be told their own date does not exist.
    /// </summary>
    [SkippableFact]
    public async Task Tomorrow_in_the_clubs_own_zone_is_an_empty_list_rather_than_a_refusal()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, "r3tomorrow",
            """{"slice_minutes":15,"grace_window_minutes":5,"timezone":"Pacific/Auckland","heartbeat_seconds":45}""");

        var tomorrow = DateTimeOffset.UtcNow.AddDays(1).ToString("yyyy-MM-dd");
        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>($"{LogPath}?day={tomorrow}");

        Assert.Empty(Items(body));
    }

    // ------------------------------------------------------------------ R3-15: the door's name

    /// <summary>
    /// A name the column cannot hold is a 400 that names the field and the bound, not a 500 out
    /// of <c>SaveChangesAsync</c>.
    /// </summary>
    [SkippableFact]
    public async Task A_name_longer_than_the_column_is_refused_by_name_with_its_bound()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3name");
        var doorId = await club.AddDoorAsync(factory, "gate-r30008", "front-door", name: "Front door");

        var response = await club.AdminClient(factory).PatchAsJsonAsync(
            $"/api/v1/admin/devices/{doorId}", new { name = new string('x', Device.NameMaxLength + 1) });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(AdminDeviceEndpoints.NameTooLong, body.GetProperty("error").GetString());
        Assert.Equal(Device.NameMaxLength, body.GetProperty("max").GetInt32());

        // Nothing was written — a refusal that had already renamed the door would be worse than
        // the 500 it replaces.
        Assert.Equal("Front door", (await DeviceAsync(factory, doorId)).Name);

        // And the boundary itself is accepted, or the bound is one out.
        var exact = await club.AdminClient(factory).PatchAsJsonAsync(
            $"/api/v1/admin/devices/{doorId}", new { name = new string('x', Device.NameMaxLength) });
        Assert.Equal(HttpStatusCode.OK, exact.StatusCode);
    }

    /// <summary>
    /// A blank name CLEARS the name, says it changed, and the wire answers one unnamed state —
    /// <c>null</c> — rather than an empty string a page renders as a gap.
    /// </summary>
    [SkippableTheory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task A_blank_name_clears_it_and_is_reported_as_a_change(string blank)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3blank");
        var doorId = await club.AddDoorAsync(factory, "gate-r30009", "front-door", name: "Front door");

        var response = await club.AdminClient(factory).PatchAsJsonAsync(
            $"/api/v1/admin/devices/{doorId}", new { name = blank });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, body.GetProperty("name").ValueKind);
        Assert.False(body.GetProperty("unchanged").GetBoolean(), "clearing a name is a change, not a no-op");

        // And the door's own feed says it was RENAMED, so the trail records what happened.
        var feed = await club.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>($"/api/v1/admin/devices/{doorId}/activity");
        var renamed = feed.GetProperty("events").EnumerateArray()
            .First(e => e.GetProperty("kind").GetString() == DoorAuditActions.RenamedKind);
        Assert.Equal("Door Admin", renamed.GetProperty("actor_name").GetString());
    }

    // ------------------------------------------------------------------ R3-34: the stale tab

    /// <summary>
    /// A PATCH built on a reading of the row that is no longer true is a 409 with nothing
    /// written — including the fields that had nothing to do with the disagreement.
    /// </summary>
    [SkippableFact]
    public async Task A_patch_whose_expected_state_is_stale_is_refused_and_writes_nothing()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3stale2");
        var doorId = await club.AddDoorAsync(factory, "gate-r30010", "front-door", name: "Front door");

        // Somebody else shut it while this tab was open.
        await club.AdminClient(factory).PatchAsJsonAsync($"/api/v1/admin/devices/{doorId}", new { enabled = false });

        var response = await club.AdminClient(factory).PatchAsJsonAsync(
            $"/api/v1/admin/devices/{doorId}",
            new { expected_enabled = true, enabled = false, name = "Renamed by the stale tab" });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(
            $"{{\"error\":\"{AdminDeviceEndpoints.DoorChanged}\"}}", await response.Content.ReadAsStringAsync());
        Assert.Equal("Front door", (await DeviceAsync(factory, doorId)).Name);

        // The same request with the RIGHT expectation goes through, so this is a guard and not a
        // second way to fail.
        var agreed = await club.AdminClient(factory).PatchAsJsonAsync(
            $"/api/v1/admin/devices/{doorId}", new { expected_enabled = false, name = "Front door west" });
        Assert.Equal(HttpStatusCode.OK, agreed.StatusCode);
    }

    // ------------------------------------------------------------------ R3-16: the offline refusal

    /// <summary>
    /// The filter, the row, the count and the export all call an offline refusal the same thing.
    /// It used to be labelled "Not recognised" on screen, missed by <c>reason=not_recognised</c>,
    /// and blank in the export's machine column.
    /// </summary>
    [SkippableFact]
    public async Task An_offline_refusal_is_not_recognised_to_the_filter_the_row_and_the_export()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3offline");
        var doorId = await club.AddDoorAsync(factory, "gate-r30011", "side-door", name: "Side door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(
            factory, doorId, DoorTrail.OfflineUnknownScanAction, now.AddMinutes(-10),
            seq: 7, gateKey: "side-door", occurredAt: now.AddMinutes(-40));
        await club.WriteRowAsync(
            factory, doorId, $"{DoorTrail.DeniedPrefix}{GateAccess.NotRecognised}", now.AddMinutes(-5),
            reason: GateAccess.NotRecognised, gateKey: "side-door");

        var admin = club.AdminClient(factory);

        var filtered = await admin.GetFromJsonAsync<JsonElement>($"{LogPath}?reason={GateAccess.NotRecognised}");
        Assert.Equal(2, Items(filtered).Count);
        Assert.Equal(2, filtered.GetProperty("total").GetInt32());
        Assert.All(
            Items(filtered),
            i => Assert.Equal(GateAccess.NotRecognised, i.GetProperty("reason").GetString()));

        // And the offline one is still visibly offline: naming the reason must not erase the
        // distinction between a refusal the server decided and one a board decided alone.
        Assert.Contains(Items(filtered), i => i.GetProperty("offline").GetBoolean());

        var csv = await admin.GetStringAsync($"{CsvPath}?reason={GateAccess.NotRecognised}");
        var offlineLine = csv.Split("\r\n").First(l => l.Contains(",yes,"));
        var cells = offlineLine.Split(',');
        Assert.Equal(DoorWords.NotOnTheSavedList, cells[7]);
        Assert.Equal(GateAccess.NotRecognised, cells[8]);
        Assert.Equal("yes", cells[9]);
    }

    // ------------------------------------------------------------------ R3-17: time that is true

    /// <summary>
    /// "Newest first" is true of the instants on screen. A batch delivered now carrying scans
    /// from hours ago belongs where those scans happened, not at the top.
    /// </summary>
    [SkippableFact]
    public async Task The_log_is_ordered_by_the_instant_each_row_prints()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3order");
        var doorId = await club.AddDoorAsync(factory, "gate-r30012", "side-door", name: "Side door");
        var now = DateTimeOffset.UtcNow;

        // Delivered LAST, scanned FIRST — the shape an outage produces every time.
        await club.WriteRowAsync(
            factory, doorId, DoorTrail.OfflineOpenAction, now.AddMinutes(-1),
            seq: 1, gateKey: "side-door", occurredAt: now.AddHours(-5));
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddHours(-2), gateKey: "side-door");
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-30), gateKey: "side-door");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(LogPath);
        var times = Items(body).Select(i => i.GetProperty("at").GetDateTimeOffset()).ToList();

        Assert.Equal(3, times.Count);
        Assert.True(times[0] > times[1] && times[1] > times[2], $"not newest first: {string.Join(" | ", times)}");
        Assert.Equal(now.AddHours(-5).ToUniversalTime().Ticks / 10_000, times[2].ToUniversalTime().Ticks / 10_000);
    }

    /// <summary>
    /// And paging agrees with it. A cursor over one column while the list is ordered by another
    /// skips and repeats rows at every page boundary — silently, which is the whole problem.
    /// </summary>
    [SkippableFact]
    public async Task Paging_the_log_walks_the_same_order_with_no_skips_and_no_repeats()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3page");
        var doorId = await club.AddDoorAsync(factory, "gate-r30013", "side-door", name: "Side door");
        var now = DateTimeOffset.UtcNow;

        // Nine rows whose delivery order is deliberately the REVERSE of their scan order.
        for (var i = 0; i < 9; i++)
        {
            await club.WriteRowAsync(
                factory, doorId, DoorTrail.OfflineOpenAction, now.AddMinutes(-1 - i),
                seq: i + 1, gateKey: "side-door", occurredAt: now.AddHours(-10).AddMinutes(i * 7));
        }

        var admin = club.AdminClient(factory);
        var seen = new List<DateTimeOffset>();
        string? cursor = null;
        for (var page = 0; page < 5; page++)
        {
            var url = cursor is null ? $"{LogPath}?limit=4" : $"{LogPath}?limit=4&cursor={Uri.EscapeDataString(cursor)}";
            var body = await admin.GetFromJsonAsync<JsonElement>(url);
            seen.AddRange(Items(body).Select(i => i.GetProperty("at").GetDateTimeOffset()));

            cursor = body.GetProperty("next_cursor").ValueKind == JsonValueKind.Null
                ? null
                : body.GetProperty("next_cursor").GetString();
            if (cursor is null) break;
        }

        Assert.Equal(9, seen.Count);
        Assert.Equal(9, seen.Distinct().Count());
        Assert.Equal(seen.OrderByDescending(t => t).ToList(), seen);
    }

    /// <summary>
    /// A row whose time the server had to overrule, or whose delivery is earlier than the scan
    /// it delivers, says so — on the admin log, in the export, and on the member's own history.
    /// </summary>
    [SkippableFact]
    public async Task A_row_whose_clock_was_overruled_is_flagged_everywhere_it_is_printed()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3clock");
        var doorId = await club.AddDoorAsync(factory, "gate-r30014", "side-door", name: "Side door");
        var now = DateTimeOffset.UtcNow;

        await WriteClampedRowAsync(factory, club, doorId, now.AddMinutes(-20), now.AddDays(-400));
        await club.WriteRowAsync(
            factory, doorId, DoorTrail.OfflineOpenAction, now.AddMinutes(-10),
            seq: 2, gateKey: "side-door", occurredAt: now.AddMinutes(-45));

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(LogPath);
        var items = Items(body);

        Assert.Equal(2, items.Count);
        Assert.Equal(1, items.Count(i => i.GetProperty("time_uncertain").GetBoolean()));

        // The ordinary late-delivered row is NOT flagged. A flag on every offline row would say
        // nothing, and the page's sentence about an approximate time would stop being read.
        var honest = items.Single(i => !i.GetProperty("time_uncertain").GetBoolean());
        Assert.True(honest.GetProperty("delivered_at").GetDateTimeOffset() > honest.GetProperty("at").GetDateTimeOffset());

        var csv = await club.AdminClient(factory).GetStringAsync(CsvPath);
        var lines = csv.Split("\r\n").Where(l => l.Length > 0).ToList();
        Assert.Equal(AdminDoorLogEndpoint.Header, lines[0].TrimStart('﻿'));
        Assert.Equal(1, lines.Skip(1).Count(l => l.Split(',')[12] == "yes"));
    }

    /// <summary>
    /// The other shape of the same defect: a delivery EARLIER than the scan it delivers. That
    /// cannot have happened, so the product says the time is approximate rather than printing an
    /// impossible order.
    /// </summary>
    [SkippableFact]
    public async Task A_delivery_earlier_than_the_scan_it_delivers_is_flagged_as_uncertain()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3impossible");
        var doorId = await club.AddDoorAsync(factory, "gate-r30015", "side-door", name: "Side door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(
            factory, doorId, DoorTrail.OfflineOpenAction, now.AddMinutes(-40),
            subjectUserId: club.MemberUserId, seq: 3, gateKey: "side-door", occurredAt: now.AddMinutes(-15));

        var admin = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(LogPath);
        Assert.True(Items(admin).Single().GetProperty("time_uncertain").GetBoolean());

        var member = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>("/api/v1/me/door/history");
        Assert.True(Items(member).Single().GetProperty("time_uncertain").GetBoolean());
    }

    /// <summary>
    /// A clamped row as <c>DeviceEventEndpoints.RecordAsync</c> writes it: the scan's instant is
    /// the upload's, and the board's own claim is kept beside it.
    /// </summary>
    private static async Task WriteClampedRowAsync(
        TestWebAppFactory factory, DoorClub club, Guid deviceId, DateTimeOffset at, DateTimeOffset claimed)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = club.TenantId,
            ActorUserId = Guid.Empty,
            Action = DoorTrail.OfflineOpenAction,
            DetailsJson = JsonSerializer.Serialize(new
            {
                device_id = deviceId,
                device_code = "gate-000000",
                gate_key = "side-door",
                seq = 1L,
                occurred_at = at,
                occurred_at_clamped_from = claimed,
            }),
            CreatedAt = at.ToUniversalTime(),
        });
        await db.SaveChangesAsync();
    }

    // ------------------------------------------------------------------ R3-33: the lost records

    /// <summary>
    /// The board's dropped-record counter reaches the club's own screen, with the instant it was
    /// reported. A heartbeat that does not mention it leaves both alone.
    /// </summary>
    [SkippableFact]
    public async Task The_boards_lost_record_counter_reaches_the_device_row()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3lost");
        var doorId = await club.AddDoorAsync(factory, "gate-r30016", "front-door", name: "Front door");
        var mac = await MacAsync(factory, doorId);
        var board = BoardClient(factory, club);

        await board.PostAsJsonAsync(
            "/api/v1/device/heartbeat", new { mac, kind = "gate", uptime_ms = 1000, events_lost = 17 });

        var view = (await club.AdminClient(factory).GetFromJsonAsync<JsonElement>("/api/v1/admin/devices/"))
            .EnumerateArray().Single(d => d.GetProperty("id").GetGuid() == doorId);
        Assert.Equal(17, view.GetProperty("events_lost").GetInt32());
        Assert.NotEqual(JsonValueKind.Null, view.GetProperty("events_lost_reported_at").ValueKind);

        // A board on an older build says nothing, and silence must not be read as "nothing was
        // lost" — a club that has seen a loss goes on seeing it.
        await board.PostAsJsonAsync("/api/v1/device/heartbeat", new { mac, kind = "gate", uptime_ms = 2000 });
        Assert.Equal(17, (await DeviceAsync(factory, doorId)).EventsLost);
    }

    // ------------------------------------------------------------------ R3-18: who did what

    /// <summary>
    /// Shut, reopen, rename, a card edit and a delete are five different words with the actor's
    /// name on each — not five copies of "edited".
    /// </summary>
    [SkippableFact]
    public async Task Every_admin_action_on_a_door_has_its_own_word_and_names_who_did_it()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3who");
        var doorId = await club.AddDoorAsync(factory, "gate-r30017", "front-door", name: "Front door");
        var admin = club.AdminClient(factory);

        await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{doorId}", new { enabled = false });
        await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{doorId}", new { enabled = true });
        await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{doorId}", new { name = "Front door east" });
        await admin.PatchAsJsonAsync($"/api/v1/admin/devices/{doorId}", new { location_note = "By the car park" });

        var feed = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/devices/{doorId}/activity");
        var events = feed.GetProperty("events").EnumerateArray().ToList();
        var kinds = events.Select(e => e.GetProperty("kind").GetString()).ToList();

        Assert.Contains(DoorAuditActions.ShutKind, kinds);
        Assert.Contains(DoorAuditActions.ReopenedKind, kinds);
        Assert.Contains(DoorAuditActions.RenamedKind, kinds);
        Assert.Contains(DoorAuditActions.DetailsChangedKind, kinds);
        Assert.All(kinds, k => Assert.Contains(k, DoorAuditActions.EventKinds));
        Assert.All(
            events.Where(e => e.GetProperty("kind").GetString() != DoorAuditActions.ClockCorrectedKind),
            e => Assert.Equal("Door Admin", e.GetProperty("actor_name").GetString()));
    }

    /// <summary>
    /// Nine clock corrections from one upload are one entry with a count. A door's feed is read
    /// to find the row that explains something, and nine copies of one row is what buries it.
    /// </summary>
    [SkippableFact]
    public async Task A_run_of_identical_events_in_one_minute_is_one_entry_with_a_count()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3group");
        var doorId = await club.AddDoorAsync(factory, "gate-r30018", "side-door", name: "Side door");

        // One minute, exactly as one clamped batch writes them.
        var minute = new DateTimeOffset(2026, 9, 20, 19, 22, 0, TimeSpan.Zero);
        for (var i = 0; i < 9; i++)
        {
            await club.WriteEventRowAsync(
                factory, doorId, DoorAuditActions.EventTimeClamped, minute.AddSeconds(i), Guid.Empty, []);
        }

        // …and one an hour later, which must stay its own entry.
        await club.WriteEventRowAsync(
            factory, doorId, DoorAuditActions.EventTimeClamped, minute.AddHours(1), Guid.Empty, []);

        var feed = await club.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>($"/api/v1/admin/devices/{doorId}/activity");
        var clock = feed.GetProperty("events").EnumerateArray()
            .Where(e => e.GetProperty("kind").GetString() == DoorAuditActions.ClockCorrectedKind)
            .ToList();

        Assert.Equal(2, clock.Count);
        Assert.Equal(1, clock[0].GetProperty("count").GetInt32());
        Assert.Equal(9, clock[1].GetProperty("count").GetInt32());
        Assert.Equal(
            minute.AddSeconds(8).ToUniversalTime(), clock[1].GetProperty("at").GetDateTimeOffset().ToUniversalTime());
        Assert.Equal(
            minute.ToUniversalTime(), clock[1].GetProperty("from").GetDateTimeOffset().ToUniversalTime());
    }

    // ------------------------------------------------------------------ R3-39: a removed door

    /// <summary>
    /// Deleting a door that has scans leaves its rows readable and its old name on the log, on
    /// the removed-door filter, and in the export.
    /// </summary>
    [SkippableFact]
    public async Task A_deleted_door_keeps_its_name_on_the_log_the_filter_and_the_export()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3removed");
        var doorId = await club.AddDoorAsync(factory, "gate-r30019", "annex-door", name: "Annex door");
        await club.WriteRowAsync(
            factory, doorId, DeviceGateEndpoint.OpenedAction, DateTimeOffset.UtcNow.AddMinutes(-30),
            gateKey: "annex-door", doorName: "Annex door");

        var admin = club.AdminClient(factory);
        var deleted = await admin.DeleteAsync($"/api/v1/admin/devices/{doorId}");
        Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);

        var body = await admin.GetFromJsonAsync<JsonElement>(LogPath);
        var row = Items(body).Single(i => i.GetProperty("door").GetProperty("removed").GetBoolean());
        Assert.Equal("Annex door", row.GetProperty("door").GetProperty("name").GetString());

        var removed = body.GetProperty("removed_doors").EnumerateArray().Single();
        Assert.Equal(doorId.ToString(), removed.GetProperty("key").GetString());
        Assert.Equal("Annex door", removed.GetProperty("name").GetString());

        var csv = await admin.GetStringAsync($"{CsvPath}?removed_door={doorId}");
        Assert.Contains("Annex door", csv);
    }

    // ------------------------------------------------------------------ WIRE §5: which doors

    /// <summary>
    /// A member told the club has shut "some" of its doors is told WHICH — and a door nobody has
    /// named is left out rather than described by the code on its label.
    /// </summary>
    [SkippableFact]
    public async Task The_member_is_told_which_doors_are_shut_by_the_name_the_club_uses()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3which");
        await club.AddDoorAsync(factory, "gate-r30020", "front-door", name: "Front door");
        await club.AddDoorAsync(factory, "gate-r30021", "side-door", name: "Side door", enabled: false);
        await club.AddDoorAsync(
            factory, "gate-r30022", gateKey: null, name: DeviceRegistryService.GatePlaceholderName, enabled: false);

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>("/api/v1/me/door");
        var names = body.GetProperty("doors_shut_names").EnumerateArray().Select(n => n.GetString()).ToList();

        Assert.Equal(MeDoorEndpoints.ShutSome, body.GetProperty("doors_shut").GetString());
        Assert.Equal(["Side door"], names);
    }

    // ------------------------------------------------------------------ R3-7: one window

    /// <summary>
    /// <b>The two numbers on <c>/me/door</c> that describe a booking code's door window belong
    /// to the same rule, or the page prints two windows two hours apart (D-H5 / R3-7).</b>
    ///
    /// <para>
    /// The reviewer met <c>early_entry_minutes: 30</c> beside a <c>door_opens_at</c> 130 minutes
    /// before the slot, under <c>active_member</c>. That pair does not reproduce on current code
    /// — E-H3 already nulled the field under that policy, because <c>gate_early_entry_minutes</c>
    /// is NOT the door's window there — and the point of pinning it is that it stays that way:
    /// the field is exactly the number the gate enforces, or it is absent.
    /// </para>
    ///
    /// <para>
    /// The rule, in one sentence: <c>door_opens_at</c> is always
    /// <c>StartsAt − BookingCodeWindow.DoorHorizonMinutes</c>, which is the function
    /// <c>GateAccess</c> bounds a booking code with; under <c>booking_window</c> that horizon IS
    /// <c>gate_early_entry_minutes</c> and the field carries it, and under <c>active_member</c>
    /// it is the wider phone-display horizon and the field is null rather than a second,
    /// smaller, wrong number.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData(GateAccessPolicies.BookingWindow, true)]
    [InlineData(GateAccessPolicies.ActiveMember, false)]
    public async Task The_booking_codes_door_window_is_stated_once_and_agrees_with_the_gate(
        string policy, bool carriesTheNumber)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(
            factory, $"r3win{policy.Length}",
            $$"""{"slice_minutes":15,"grace_window_minutes":5,"timezone":"UTC","heartbeat_seconds":45,"gate_access_policy":"{{policy}}","gate_early_entry_minutes":30,"roster_window_minutes":90,"activation_cue_window_minutes":40}""");

        var startsAt = DateTimeOffset.UtcNow.AddHours(6);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.Bookings.Add(new Booking
            {
                TenantId = club.TenantId,
                UserId = club.MemberUserId,
                CourtId = club.CourtId,
                StartsAt = startsAt,
                EndsAt = startsAt.AddMinutes(30),
                SliceMinutes = 15,
                SliceCount = 2,
                Status = BookingStatus.Booked,
                AmountChargedMinutes = 16,
            });
            await db.SaveChangesAsync();
        }

        var body = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>("/api/v1/me/door");
        var booking = body.GetProperty("next_booking");
        var opensAt = booking.GetProperty("door_opens_at").GetDateTimeOffset();
        var horizon = (int)(startsAt - opensAt).TotalMinutes;

        if (carriesTheNumber)
        {
            // booking_window: the horizon IS gate_early_entry_minutes, and the field says so.
            Assert.Equal(30, horizon);
            Assert.Equal(30, body.GetProperty("early_entry_minutes").GetInt32());
        }
        else
        {
            // active_member: the horizon is roster + cue (90 + 40), capped at four hours — the
            // window the member's own phone shows the code over. The field is null, because
            // thirty would be a number from a rule this club is not running.
            Assert.Equal(130, horizon);
            Assert.Equal(JsonValueKind.Null, body.GetProperty("early_entry_minutes").ValueKind);
        }

        // And whatever the policy, the number on the wire is the one the DOOR enforces — the
        // same function, not a second arrangement of the same settings.
        using (var scope = factory.Services.CreateScope())
        {
            // The tenant has to be resolved by hand: a scope created outside a request has none,
            // so TenantSettingsAccessor would read an empty document and answer the PRODUCT's
            // defaults — which for this comparison is the worst possible failure mode, because
            // one of the two policies' defaults happens to equal the right number and the check
            // would pass while proving nothing.
            scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>()
                .Set(club.TenantId, club.Slug);
            var settings = await scope.ServiceProvider
                .GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

            Assert.Equal(policy, settings.GateAccessPolicy);
            Assert.Equal(BookingCodeWindow.DoorHorizonMinutes(settings), horizon);
        }
    }

    // ------------------------------------------------------------------ R3-37: the member's name

    /// <summary>
    /// The route that creates every membership row bounds the name, which only the profile PUT
    /// did. Four hundred characters of markup is refused rather than stored or 500'd.
    /// </summary>
    [SkippableFact]
    public async Task Registration_bounds_the_full_name_like_the_profile_edit_always_did()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "r3fullname");

        var response = await AnonymousClient(factory, club).PostAsync(
            "/api/v1/auth/register",
            new StringContent(
                JsonSerializer.Serialize(new
                {
                    email = "toolong@test.local",
                    password = "AdminPass!",
                    fullName = string.Concat(Enumerable.Repeat("<b>name</b>", 40)),
                    membershipNumber = "MEM-R3-1",
                }),
                Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(PersonNames.FullNameInvalid, body.GetProperty("error").GetString());
        Assert.Equal(PersonNames.MaxFullNameLength, body.GetProperty("max").GetInt32());

        // The boundary is accepted, or the bound is one out and every long-named member is
        // locked out of the club they belong to.
        var exact = await TestPhotos.RegisterAsync(
            AnonymousClient(factory, club), "exact@test.local", "MEM-R3-2", new string('n', PersonNames.MaxFullNameLength), "AdminPass!");
        Assert.Equal(HttpStatusCode.OK, exact.StatusCode);
    }
}

/// <summary>
/// R3-2 — one continuous silence is one outage row, however many times an admin shuts and
/// reopens the door while it stays dark.
///
/// <para>
/// <b>Why this is a separate class on the in-memory host.</b> Everything here is the health
/// sweep, which walks EVERY tenant in the database with the query filters off; run against the
/// Postgres tier, whose database is shared by the whole boundary suite, one tick would open
/// outages for other classes' seeded boards and mail their admins about them. The outage rules
/// read no jsonb and no SQL, so the in-memory host is both sufficient and the pattern
/// <c>PeripheralHealthTests</c> already establishes.
/// </para>
/// </summary>
public sealed class DoorOutageFlapTests
{
    private static PeripheralHealthWorker CreateWorker(TestHost host) =>
        new(host.Services, host.Services.GetRequiredService<IEventBus>(),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<PeripheralHealthWorker>.Instance);

    private static async Task<Device> AddDoorAsync(
        TestHost host, MainframeDbContext db, DateTimeOffset lastSeen)
    {
        var device = new Device
        {
            TenantId = host.Tenant.Id,
            DeviceCode = $"gate-{Guid.NewGuid():N}"[..12],
            Name = "Side door",
            Kind = DeviceKind.Gate,
            Hardware = DeviceHardware.Esp32,
            GateKey = "side-door",
            MacAddress = Guid.NewGuid().ToString("N")[..12],
            LastSeenAt = lastSeen,
            CreatedAt = lastSeen.AddDays(-30),
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync();
        return device;
    }

    /// <summary>
    /// One admin action, in its own scope — which is what an HTTP request is.
    ///
    /// <para>
    /// <b>Sharing one <c>DbContext</c> across the whole test is not a shortcut here, it is a
    /// different system.</b> The health sweep runs in a scope of its own and writes to the same
    /// store; a long-lived context tracking rows the sweep has since changed answers a query
    /// with its own stale copies, so a second edit writes only the properties IT changed and
    /// silently leaves the sweep's work in place. That is a fixture artefact and not a product
    /// behaviour — every PATCH in the running app gets a fresh context — and a test built on it
    /// would be asserting against a system nobody deploys.
    /// </para>
    /// </summary>
    private static async Task SwitchAsync(TestHost host, Guid deviceId, bool enabled)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var registry = scope.ServiceProvider.GetRequiredService<DeviceRegistryService>();
        var device = await db.Devices.IgnoreQueryFilters().FirstAsync(d => d.Id == deviceId);
        await registry.UpdateAsync(device, new UpdateDeviceCommand(null, enabled, null), host.AdminUser.Id, default);
    }

    private static async Task<List<DeviceOutage>> OutagesAsync(TestHost host, Guid deviceId)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.DeviceOutages.IgnoreQueryFilters().AsNoTracking()
            .Where(o => o.DeviceId == deviceId).ToListAsync();
    }

    /// <summary>
    /// The reviewer's case, at the sweep: a door dark for hours, shut and reopened twice while
    /// it is dark, across several ticks. It produced four rows, three of them stamped with an
    /// <c>EndedAt</c> nobody was present for, while <c>LastSeenAt</c> never moved once.
    /// </summary>
    [Fact]
    public async Task A_door_silent_across_several_sweeps_is_one_outage_however_often_it_is_shut()
    {
        await using var host = await TestHost.CreateAsync();
        var worker = CreateWorker(host);
        var lastSeen = DateTimeOffset.UtcNow.AddHours(-3);

        Guid doorId;
        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            doorId = (await AddDoorAsync(host, db, lastSeen)).Id;
        }

        await worker.TickAsync(default);
        Assert.Single(await OutagesAsync(host, doorId));

        for (var round = 0; round < 3; round++)
        {
            await SwitchAsync(host, doorId, enabled: false);
            await worker.TickAsync(default);
            await SwitchAsync(host, doorId, enabled: true);
            await worker.TickAsync(default);
            await worker.TickAsync(default);
        }

        var outage = Assert.Single(await OutagesAsync(host, doorId));
        Assert.Equal(lastSeen, outage.StartedAt);

        // Still OPEN, because the board still has not called. An EndedAt here would be the
        // product asserting a recovery that nothing witnessed.
        Assert.Null(outage.EndedAt);

        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var door = await db.Devices.IgnoreQueryFilters().AsNoTracking().FirstAsync(d => d.Id == doorId);
            Assert.Equal(lastSeen, door.LastSeenAt);
        }
    }

    /// <summary>
    /// The close a switch performs is still a close — the row has to stop being the open-outage
    /// guard, or a board left out of service for months mails the club "back after 43 200
    /// minutes" when it returns — but it says nobody heard from the board.
    /// </summary>
    [Fact]
    public async Task An_outage_closed_by_a_shut_records_that_nobody_heard_from_the_board()
    {
        await using var host = await TestHost.CreateAsync();

        Guid doorId;
        using (var scope = host.NewScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            doorId = (await AddDoorAsync(host, db, DateTimeOffset.UtcNow.AddHours(-4))).Id;
        }

        await CreateWorker(host).TickAsync(default);
        await SwitchAsync(host, doorId, enabled: false);

        var outage = Assert.Single(await OutagesAsync(host, doorId));
        Assert.NotNull(outage.EndedAt);
        Assert.False(outage.EndedByContact, "a switch is not a witness that the board called in");
    }

    /// <summary>
    /// And the settlement does not read that close as contact.
    ///
    /// <para>
    /// <c>DeviceOutageIndex</c> takes a closed outage's <c>EndedAt</c> as an instant the API
    /// HEARD from the board, and prices no-show waivers off it — so a close nobody was present
    /// for tells the money that a dark court box came back.
    /// </para>
    ///
    /// <para>
    /// <b>The fixture is built so that the witness is the ONLY thing that can decide it, and
    /// the first version of this test was not.</b> That one left the board out of service, so
    /// <c>OutOfServiceSince</c> answered the question on its own and the assertion held with the
    /// fix reverted — a mutant walked straight through it. The board here is back IN service (an
    /// admin shut a dark door and reopened it, which is the case R3-2 is about), it is still
    /// silent, and the deadline sits ONE MINUTE after the false <c>EndedAt</c> — inside
    /// <c>offline_after_seconds</c> of it. Believe the close and the box looks reachable at that
    /// deadline; read the silence as the unbroken thing it is and it does not.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_switch_closed_outage_is_not_read_as_evidence_the_board_came_back()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var settings = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
        var offlineAfter = HeartbeatCadence.OfflineAfterSeconds(settings.HeartbeatSeconds);

        var now = DateTimeOffset.UtcNow;
        var lastSeen = now.AddHours(-4);
        var switchedAt = now.AddSeconds(-offlineAfter + 60);
        var deadline = switchedAt.AddSeconds(30);

        var box = new Device
        {
            TenantId = host.Tenant.Id,
            DeviceCode = $"box-{Guid.NewGuid():N}"[..12],
            Name = "Front panel",
            MacAddress = Guid.NewGuid().ToString("N")[..12],
            CourtNumbers = [host.Courts[0].CourtNumber],

            // Back in service and still dark: shut while it was already silent, then reopened.
            Enabled = true,
            LastSeenAt = lastSeen,
            OutOfServiceSince = null,
            CreatedAt = now.AddDays(-30),
        };
        db.Devices.Add(box);

        db.DeviceOutages.Add(new DeviceOutage
        {
            TenantId = host.Tenant.Id,
            DeviceId = box.Id,
            StartedAt = lastSeen,
            DetectedAt = lastSeen.AddSeconds(offlineAfter),
            EndedAt = switchedAt,
            EndedByContact = false,
        });
        await db.SaveChangesAsync();

        var index = await DeviceOutageIndex.BuildAsync(db, now.AddHours(-6), offlineAfter, default);

        Assert.True(
            index.CourtWasDark(host.Courts[0].Id, deadline),
            "a close nobody witnessed must not make the court look reachable at the next deadline");

        // The control, which is what makes the assertion above about the WITNESS and not about
        // the arithmetic: the identical row closed by a real heartbeat does make it lit.
        var heard = await db.DeviceOutages.IgnoreQueryFilters().FirstAsync();
        heard.EndedByContact = true;
        await db.SaveChangesAsync();

        var believed = await DeviceOutageIndex.BuildAsync(db, now.AddHours(-6), offlineAfter, default);
        Assert.False(believed.CourtWasDark(host.Courts[0].Id, deadline));
    }
}
