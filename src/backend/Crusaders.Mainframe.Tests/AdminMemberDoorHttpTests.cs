using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// D9 — an admin's read of one member's door history, and the audit row every such read leaves.
///
/// <para>
/// <b>What this class does NOT flip.</b>
/// <c>AdminDoorLogHttpTests.No_parameter_named_after_a_member_changes_anything</c> still holds
/// and still must: the CLUB log remains unsearchable by a person. D9 added a read of a person an
/// admin already named, as a path segment, and
/// <see cref="The_club_log_still_cannot_be_searched_by_a_person_after_D9"/> pins that the two
/// live side by side — the member route answers about them while the club log, asked the same
/// question by parameter, answers exactly what it answered before.
/// </para>
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class AdminMemberDoorHttpTests
{
    private readonly PostgresFixture _pg;

    public AdminMemberDoorHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string ClubLogPath = "/api/v1/admin/doors/activity";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static string DoorsPath(Guid userId, string query = "") => $"/api/v1/admin/members/{userId}/doors{query}";

    private static string CsvPath(Guid userId, string query = "") => $"/api/v1/admin/members/{userId}/doors.csv{query}";

    private static List<JsonElement> Items(JsonElement body) => body.GetProperty("items").EnumerateArray().ToList();

    /// <summary>This club's <c>member.door_history_viewed</c> rows in the undeletable change record.</summary>
    private static async Task<List<AdminChangeLog>> ChangeRowsAsync(TestWebAppFactory factory, DoorClub club)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId && a.Action == AdminChangeActions.MemberDoorHistoryViewed)
            .OrderBy(a => a.OccurredAt)
            .ToListAsync();
    }

    /// <summary>
    /// The member's rows and nobody else's — and the whole of the club's retention by default,
    /// not the club log's rolling day, because "full history" is the decision's own wording.
    /// </summary>
    [SkippableFact]
    public async Task The_history_is_this_members_scans_across_the_whole_retention_and_nobody_elses()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mdoorall");
        var door = await club.AddDoorAsync(factory, "gate-md0001", "front-door", name: "Front door");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(factory, door, DeviceGateEndpoint.OpenedAction, now.AddHours(-1),
            subjectUserId: club.MemberUserId, gateKey: "front-door");
        await club.WriteRowAsync(factory, door, $"{DeviceGateEndpoint.DeniedActionPrefix}too_early", now.AddDays(-10),
            subjectUserId: club.MemberUserId, reason: "too_early", gateKey: "front-door");
        await club.WriteRowAsync(factory, door, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-30),
            subjectUserId: club.AdminUserId, gateKey: "front-door");

        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath(club.MemberUserId));
        var items = Items(body);

        Assert.Equal(2, items.Count);
        Assert.Equal(2, body.GetProperty("total").GetInt32());
        Assert.Equal("released", items[0].GetProperty("outcome").GetString());
        Assert.Equal("refused", items[1].GetProperty("outcome").GetString());
        Assert.Equal("too_early", items[1].GetProperty("reason").GetString());
        Assert.Equal("Front door", items[0].GetProperty("door").GetProperty("name").GetString());
        Assert.Equal(club.MemberUserId, body.GetProperty("member").GetProperty("user_id").GetGuid());
        Assert.Equal(DoorSettings.DefaultLogRetentionDays, body.GetProperty("retention_days").GetInt32());

        // An explicit window is honoured exactly as the club log honours it.
        var lastDay = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(
            DoorsPath(club.MemberUserId, "?period=last_24h"));
        Assert.Single(Items(lastDay));
    }

    /// <summary>
    /// Every read leaves an access record — the page and the export alike — naming the admin,
    /// the member and the range. A refused read (another club's member) leaves none, because
    /// nothing was read.
    /// </summary>
    [SkippableFact]
    public async Task Every_read_is_recorded_with_who_looked_at_whom_and_over_what_range()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mdooraud");
        var door = await club.AddDoorAsync(factory, "gate-md0002", "front-door");
        await club.WriteRowAsync(factory, door, DeviceGateEndpoint.OpenedAction, DateTimeOffset.UtcNow.AddHours(-2),
            subjectUserId: club.MemberUserId);

        var admin = club.AdminClient(factory);
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync(DoorsPath(club.MemberUserId))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync(CsvPath(club.MemberUserId))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.GetAsync(DoorsPath(club.MemberUserId, "?outcome=maybe"))).StatusCode);

        var rows = (await club.AuditRowsAsync(factory, AdminMemberDoorEndpoints.ViewedAction))
            .OrderBy(r => r.CreatedAt).ToList();

        Assert.Equal(2, rows.Count);
        Assert.All(rows, r =>
        {
            Assert.Equal(club.AdminUserId, r.ActorUserId);
            Assert.Equal(club.MemberUserId, r.SubjectUserId);
        });

        var page = JsonDocument.Parse(rows[0].DetailsJson!).RootElement;
        Assert.False(page.GetProperty("exported").GetBoolean());
        Assert.Equal(1, page.GetProperty("rows").GetInt32());
        Assert.True(page.GetProperty("range").TryGetProperty("from", out _));
        Assert.True(page.GetProperty("range").TryGetProperty("to", out _));
        Assert.True(JsonDocument.Parse(rows[1].DetailsJson!).RootElement.GetProperty("exported").GetBoolean());

        // The same two reads, and only those, in the change record that has no delete path —
        // the refused 400 wrote neither record.
        var changes = await ChangeRowsAsync(factory, club);
        Assert.Equal(2, changes.Count);
        Assert.All(changes, c =>
        {
            Assert.Equal(club.AdminUserId, c.ActorUserId);
            Assert.Equal(AdminChangeSubjects.User, c.SubjectKind);
            Assert.Equal(club.MemberUserId, c.SubjectId);
            Assert.Equal("Door Member", c.SubjectLabel);
            Assert.Equal(AdminChangeAreas.Member, c.Area);
        });
        var pageAfter = JsonDocument.Parse(changes[0].AfterJson!).RootElement;
        Assert.False(pageAfter.GetProperty("exported").GetBoolean());
        Assert.Equal(1, pageAfter.GetProperty("rows").GetInt32());
        Assert.True(pageAfter.GetProperty("range").TryGetProperty("from", out _));
        Assert.True(JsonDocument.Parse(changes[1].AfterJson!).RootElement.GetProperty("exported").GetBoolean());
    }

    /// <summary>
    /// The access record reads back through the club's change record as a sentence composed like
    /// its neighbours — the member area, the member named — not as a raw action string.
    /// </summary>
    [SkippableFact]
    public async Task A_read_appears_in_the_club_change_record_as_a_member_sentence()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mdoorchg");
        var admin = club.AdminClient(factory);
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync(CsvPath(club.MemberUserId))).StatusCode);

        var body = await admin.GetFromJsonAsync<JsonElement>("/api/v1/admin/changes?area=member");
        var row = Assert.Single(body.GetProperty("rows").EnumerateArray(),
            r => r.GetProperty("action").GetString() == AdminChangeActions.MemberDoorHistoryViewed);

        Assert.Equal(AdminChangeAreas.Member, row.GetProperty("area").GetString());
        Assert.Equal("Looked at one member's door history — Door Member", row.GetProperty("headline").GetString());
        Assert.Equal(club.MemberUserId, row.GetProperty("subject").GetProperty("id").GetGuid());
    }

    /// <summary>
    /// Two cross-tenant shapes. Another club's admin asking about this member gets the same 404
    /// as an invented id, and writes no access record. And another club's row naming THIS
    /// member's id at THIS club's door id never reaches this club's history — the subject
    /// comparison cannot separate two clubs holding the same guid; only the tenant filter can.
    /// </summary>
    [SkippableFact]
    public async Task Another_club_can_neither_read_this_members_doors_nor_write_into_them()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var mine = await DoorClub.SeedAsync(factory, "mdoormine");
        var theirs = await DoorClub.SeedAsync(factory, "mdoortheirs");
        var myDoor = await mine.AddDoorAsync(factory, "gate-md0003", "mine");
        var now = DateTimeOffset.UtcNow;

        await mine.WriteRowAsync(factory, myDoor, DeviceGateEndpoint.OpenedAction, now.AddHours(-3), subjectUserId: mine.MemberUserId);
        await theirs.WriteRowAsync(factory, myDoor, DeviceGateEndpoint.OpenedAction, now.AddHours(-1), subjectUserId: mine.MemberUserId);

        var foreign = theirs.AdminClient(factory);
        foreach (var path in new[] { DoorsPath(mine.MemberUserId), CsvPath(mine.MemberUserId) })
        {
            var response = await foreign.GetAsync(path);
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            Assert.Equal("member_not_found",
                (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
        }
        Assert.Empty(await theirs.AuditRowsAsync(factory, AdminMemberDoorEndpoints.ViewedAction));
        Assert.Empty(await mine.AuditRowsAsync(factory, AdminMemberDoorEndpoints.ViewedAction));
        Assert.Empty(await ChangeRowsAsync(factory, theirs));
        Assert.Empty(await ChangeRowsAsync(factory, mine));

        var body = await mine.AdminClient(factory).GetFromJsonAsync<JsonElement>(DoorsPath(mine.MemberUserId));
        Assert.Single(Items(body));
        Assert.Equal(1, body.GetProperty("total").GetInt32());

        // The legitimate read is recorded in its OWN club's change record and never in the other's.
        Assert.Single(await ChangeRowsAsync(factory, mine));
        Assert.Empty(await ChangeRowsAsync(factory, theirs));
    }

    [SkippableFact]
    public async Task A_member_cannot_read_door_history_through_the_admin_route_even_their_own()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mdoorrole");
        var member = club.MemberClient(factory);

        Assert.Equal(HttpStatusCode.Forbidden, (await member.GetAsync(DoorsPath(club.MemberUserId))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.GetAsync(CsvPath(club.MemberUserId))).StatusCode);
        Assert.Empty(await club.AuditRowsAsync(factory, AdminMemberDoorEndpoints.ViewedAction));
        Assert.Empty(await ChangeRowsAsync(factory, club));
    }

    /// <summary>
    /// The export: the member's rows only, the method column, the membership number in the
    /// name, and a club-entered door name defused before it is quoted.
    /// </summary>
    [SkippableFact]
    public async Task The_export_is_this_members_rows_defused_and_named_for_them()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mdoorcsv");
        var door = await club.AddDoorAsync(factory, "gate-md0005", "side", name: "=HYPERLINK(\"x\")");
        var now = DateTimeOffset.UtcNow;

        await club.WriteRowAsync(factory, door, DeviceGateEndpoint.OpenedAction, now.AddHours(-2), subjectUserId: club.MemberUserId);
        await club.WriteRowAsync(factory, door, DeviceGateEndpoint.OpenedAction, now.AddHours(-1), subjectUserId: club.AdminUserId);

        var response = await club.AdminClient(factory).GetAsync(CsvPath(club.MemberUserId));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("1", response.Headers.GetValues(AdminDoorLogEndpoint.RowsHeader).Single());
        Assert.Contains($"member-doors-{club.Slug}-m", response.Content.Headers.ContentDisposition!.ToString());

        var text = Encoding.UTF8.GetString(await response.Content.ReadAsByteArrayAsync()).TrimStart('﻿');
        var lines = text.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(AdminMemberDoorEndpoints.Header, lines[0]);
        Assert.Equal(2, lines.Length);
        Assert.Contains("\"'=HYPERLINK(\"\"x\"\")\"", lines[1]);
    }

    /// <summary>
    /// D9 did not open the club log. Asked about a person by parameter, the club log answers the
    /// same bytes it answers unfiltered — while the member route, asked by path, answers about
    /// exactly that person. Both halves, one test, so neither can drift without the other seeing.
    /// </summary>
    [SkippableFact]
    public async Task The_club_log_still_cannot_be_searched_by_a_person_after_D9()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "mdoorp3");
        var door = await club.AddDoorAsync(factory, "gate-md0006", "front-door");
        var now = DateTimeOffset.UtcNow;
        await club.WriteRowAsync(factory, door, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-5), subjectUserId: club.MemberUserId);
        await club.WriteRowAsync(factory, door, DeviceGateEndpoint.OpenedAction, now.AddMinutes(-4), subjectUserId: club.AdminUserId);

        var admin = club.AdminClient(factory);
        var window = $"?from={Uri.EscapeDataString(now.AddHours(-6).ToString("O"))}&to={Uri.EscapeDataString(now.ToString("O"))}";

        var baseline = await (await admin.GetAsync(ClubLogPath + window)).Content.ReadAsStringAsync();
        var asked = await (await admin.GetAsync($"{ClubLogPath}{window}&member={club.MemberUserId}")).Content.ReadAsStringAsync();
        Assert.Equal(baseline, asked);

        var mine = await admin.GetFromJsonAsync<JsonElement>(DoorsPath(club.MemberUserId, window));
        Assert.Single(Items(mine));
    }
}
