using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// D2 over HTTP, on the real schema: a group's top-up rate and peak priority through the admin
/// group API (both spellings, the three states of a PATCH, the change record), the member-groups
/// PUT that replaced the class endpoint, the admin reads that replaced <c>member_class</c>, the
/// peak refusal a group withholds — and another club reaching none of it.
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class GroupTariffHttpTests
{
    private const string Groups = "/api/v1/admin/member-groups";
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private readonly PostgresFixture _pg;

    public GroupTariffHttpTests(PostgresFixture pg) => _pg = pg;

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static string MemberGroupsPath(Guid userId) => $"/api/v1/admin/members/{userId}/groups";

    /// <summary>The club's league group, as the migration and the seeder leave it.</summary>
    private static async Task<Guid> AddLeagueGroupAsync(TestWebAppFactory factory, DoorClub club, params Guid[] members)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var league = TestHost.LeagueGroup(club.TenantId);
        db.MemberGroups.Add(league);
        foreach (var userId in members)
        {
            db.MemberGroupMembers.Add(new MemberGroupMember
            {
                TenantId = club.TenantId,
                GroupId = league.Id,
                UserId = userId,
                AddedByUserId = club.AdminUserId,
            });
        }
        await db.SaveChangesAsync();
        return league.Id;
    }

    private static async Task<List<AdminChangeLog>> ChangesAsync(TestWebAppFactory factory, Guid tenantId, Guid subjectId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == tenantId && a.SubjectId == subjectId).OrderBy(a => a.OccurredAt).ToListAsync();
    }

    private static async Task<JsonElement> GroupAsync(HttpClient admin, Guid id)
    {
        var list = await admin.GetFromJsonAsync<JsonElement>(Groups);
        return list.GetProperty("groups").EnumerateArray().Single(g => g.GetProperty("id").GetGuid() == id);
    }

    private static async Task<Guid> CreateAsync(HttpClient admin, object body)
    {
        var res = await admin.PostAsJsonAsync(Groups, body);
        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    /// <summary>
    /// The two new fields go in under either spelling and come back snake_case; a PATCH tells
    /// "absent" (unchanged) from <c>null</c> (back to the club default); every change is one
    /// <c>group.updated</c> row naming exactly the fields it moved.
    /// </summary>
    [SkippableFact]
    public async Task A_groups_rate_and_peak_priority_round_trip_under_either_spelling_and_are_recorded()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "d2rate");
        var admin = club.AdminClient(factory);

        var id = await CreateAsync(admin, new { name = "Seniors", creditsPerZar = 2.25m, peakPriority = true });
        var created = await GroupAsync(admin, id);
        Assert.Equal(2.25m, created.GetProperty("credits_per_zar").GetDecimal());
        Assert.True(created.GetProperty("peak_priority").GetBoolean());
        Assert.Equal(JsonValueKind.Null, created.GetProperty("system_key").ValueKind);

        var snake = await admin.PatchAsJsonAsync($"{Groups}/{id}", new Dictionary<string, object?>
        {
            ["credits_per_zar"] = 2.5m,
            ["peak_priority"] = false,
            ["reason"] = "Committee rate review",
        });
        Assert.Equal(HttpStatusCode.OK, snake.StatusCode);
        var patched = await GroupAsync(admin, id);
        Assert.Equal(2.5m, patched.GetProperty("credits_per_zar").GetDecimal());
        Assert.False(patched.GetProperty("peak_priority").GetBoolean());

        // Absent is unchanged: a name-only PATCH does not touch the rate.
        await admin.PatchAsJsonAsync($"{Groups}/{id}", new { name = "Seniors 65+" });
        Assert.Equal(2.5m, (await GroupAsync(admin, id)).GetProperty("credits_per_zar").GetDecimal());

        // An explicit null clears it — the group inherits the club's default rate again.
        var cleared = await admin.PatchAsJsonAsync($"{Groups}/{id}", new Dictionary<string, object?> { ["creditsPerZar"] = null });
        Assert.Equal(HttpStatusCode.OK, cleared.StatusCode);
        Assert.Equal(JsonValueKind.Null, (await GroupAsync(admin, id)).GetProperty("credits_per_zar").ValueKind);

        var rows = await ChangesAsync(factory, club.TenantId, id);
        var updates = rows.Where(r => r.Action == AdminChangeActions.GroupUpdated).ToList();
        Assert.Equal(3, updates.Count);

        using (var before = JsonDocument.Parse(updates[0].BeforeJson!))
        using (var after = JsonDocument.Parse(updates[0].AfterJson!))
        {
            Assert.Equal(2.25m, before.RootElement.GetProperty("credits_per_zar").GetDecimal());
            Assert.Equal(2.5m, after.RootElement.GetProperty("credits_per_zar").GetDecimal());
            Assert.True(before.RootElement.GetProperty("peak_priority").GetBoolean());
            Assert.False(after.RootElement.GetProperty("peak_priority").GetBoolean());
            Assert.Equal("Committee rate review", updates[0].Reason);
        }
        using (var after = JsonDocument.Parse(updates[1].AfterJson!))
        {
            Assert.False(after.RootElement.TryGetProperty("credits_per_zar", out _)); // the rename only
        }
        using (var after = JsonDocument.Parse(updates[2].AfterJson!))
        {
            Assert.Equal(JsonValueKind.Null, after.RootElement.GetProperty("credits_per_zar").ValueKind);
        }
    }

    /// <summary>
    /// A rate of zero takes a member's money and credits nothing; a fifth decimal would be rounded
    /// by the column into a rate nobody typed; a string is not a number. All refused, nothing saved.
    /// </summary>
    [SkippableTheory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("1000.5")]
    [InlineData("2.12345")]
    [InlineData("\"2.4\"")]
    [InlineData("true")]
    public async Task A_rate_the_club_could_not_honour_is_refused(string rateJson)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "d2bad");
        var admin = club.AdminClient(factory);
        var id = await CreateAsync(admin, new { name = "Seniors", creditsPerZar = 2.4m });

        var res = await admin.PatchAsync($"{Groups}/{id}",
            new StringContent($"{{\"credits_per_zar\":{rateJson}}}", System.Text.Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("group_credits_per_zar_invalid",
            (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
        Assert.Equal(2.4m, (await GroupAsync(admin, id)).GetProperty("credits_per_zar").GetDecimal());

        var onCreate = await admin.PostAsync(Groups,
            new StringContent($"{{\"name\":\"Other\",\"creditsPerZar\":{rateJson}}}", System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, onCreate.StatusCode);
    }

    /// <summary>The league group replaced a member class; the product relies on it, so it cannot be deleted.</summary>
    [SkippableFact]
    public async Task The_league_group_cannot_be_deleted_even_when_empty()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "d2del");
        var leagueId = await AddLeagueGroupAsync(factory, club);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.MemberGroups.IgnoreQueryFilters().FirstAsync(g => g.Id == leagueId);
            row.IsSystemDefault = false; // only the system key protects it now
            await db.SaveChangesAsync();
        }

        var res = await club.AdminClient(factory).DeleteAsync($"{Groups}/{leagueId}");

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("group_is_system_default", (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
    }

    /// <summary>
    /// Review D2-P1: a group's peak say is tri-state like its rate — true grants, false withholds,
    /// null (the default, and every pre-D2 group) has no say. A league member put into a group
    /// with no say keeps the priority; an explicit false still wins and is named; null restores
    /// it. Nothing but a JSON boolean or null is accepted.
    /// </summary>
    [SkippableFact]
    public async Task A_group_with_no_say_on_peak_never_withholds_it_and_an_explicit_no_still_wins()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "d2tri");
        var admin = club.AdminClient(factory);
        var leagueId = await AddLeagueGroupAsync(factory, club, club.MemberUserId);
        var juniorsId = await CreateAsync(admin, new { name = "Juniors" });
        Assert.Equal(JsonValueKind.Null, (await GroupAsync(admin, juniorsId)).GetProperty("peak_priority").ValueKind);

        var put = await admin.PutAsJsonAsync(MemberGroupsPath(club.MemberUserId), new { groupIds = new[] { leagueId, juniorsId } });
        var tariff = (await put.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("tariff");
        Assert.True(tariff.GetProperty("peak_priority").GetBoolean());
        Assert.Equal(0, tariff.GetProperty("peak_withheld_by").GetArrayLength());

        await admin.PatchAsJsonAsync($"{Groups}/{juniorsId}", new { peakPriority = false });
        var rules = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{club.MemberUserId}/booking-rules");
        Assert.False(rules.GetProperty("tariff").GetProperty("peak_priority").GetBoolean());
        Assert.Equal("Juniors", rules.GetProperty("tariff").GetProperty("peak_withheld_by")[0].GetString());

        var back = await admin.PatchAsJsonAsync($"{Groups}/{juniorsId}", new Dictionary<string, object?> { ["peak_priority"] = null });
        Assert.Equal(HttpStatusCode.OK, back.StatusCode);
        Assert.Equal(JsonValueKind.Null, (await GroupAsync(admin, juniorsId)).GetProperty("peak_priority").ValueKind);
        rules = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{club.MemberUserId}/booking-rules");
        Assert.True(rules.GetProperty("tariff").GetProperty("peak_priority").GetBoolean());

        var update = (await ChangesAsync(factory, club.TenantId, juniorsId)).Last(r => r.Action == AdminChangeActions.GroupUpdated);
        using (var before = JsonDocument.Parse(update.BeforeJson!))
        using (var after = JsonDocument.Parse(update.AfterJson!))
        {
            Assert.False(before.RootElement.GetProperty("peak_priority").GetBoolean());
            Assert.Equal(JsonValueKind.Null, after.RootElement.GetProperty("peak_priority").ValueKind);
        }

        foreach (var bad in new[] { "\"true\"", "1", "{}" })
        {
            var res = await admin.PatchAsync($"{Groups}/{juniorsId}",
                new StringContent($"{{\"peak_priority\":{bad}}}", System.Text.Encoding.UTF8, "application/json"));
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
            Assert.Equal("group_peak_priority_invalid", (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
        }
    }

    /// <summary>
    /// Review D2-P2: archiving the league group would move every league member to the regular
    /// rate and out of the peak window at a click. It is refused exactly as its delete is; the
    /// group, its members' tariff and the change record are untouched. Other edits still work.
    /// </summary>
    [SkippableFact]
    public async Task The_league_group_cannot_be_archived()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "d2arc");
        var admin = club.AdminClient(factory);
        var leagueId = await AddLeagueGroupAsync(factory, club, club.MemberUserId);

        foreach (var status in new[] { "archived", " Archived " })
        {
            var res = await admin.PatchAsJsonAsync($"{Groups}/{leagueId}", new { status, reason = "Season over" });
            Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
            Assert.Equal("group_is_system_default", (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());
        }

        Assert.Equal("active", (await GroupAsync(admin, leagueId)).GetProperty("status").GetString());
        var rules = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{club.MemberUserId}/booking-rules");
        Assert.Equal(TestHost.LeagueCreditsPerZar, rules.GetProperty("tariff").GetProperty("top_up_credits_per_zar").GetDecimal());
        Assert.True(rules.GetProperty("tariff").GetProperty("peak_priority").GetBoolean());
        Assert.Empty(await ChangesAsync(factory, club.TenantId, leagueId));

        // Renaming it is still an ordinary edit.
        var rename = await admin.PatchAsJsonAsync($"{Groups}/{leagueId}", new { name = "League & seniors", status = "active" });
        Assert.Equal(HttpStatusCode.OK, rename.StatusCode);
    }

    /// <summary>
    /// Review D2-P2 (second reviewer): a tariff move is recorded UNDER THE MEMBER, as the deleted
    /// class endpoint's <c>member.class_changed</c> was — one <c>member.groups_changed</c> audit
    /// row per member moved, from the PUT and from the group surface alike, carrying the tariff
    /// before and after, in this club only, and on the member's trace.
    /// </summary>
    [SkippableFact]
    public async Task A_group_move_is_recorded_under_the_member_with_the_tariff_it_moved()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "d2aud");
        var admin = club.AdminClient(factory);
        var leagueId = await AddLeagueGroupAsync(factory, club);
        var coachingId = await CreateAsync(admin, new { name = "Coaching", creditsPerZar = 2.0m });

        var put = await admin.PutAsJsonAsync(MemberGroupsPath(club.MemberUserId),
            new { groupIds = new[] { leagueId }, reason = "Registered for league" });
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        var add = await admin.PostAsJsonAsync($"{Groups}/{coachingId}/members", new { userIds = new[] { club.MemberUserId } });
        Assert.Equal(HttpStatusCode.OK, add.StatusCode);
        var remove = await admin.DeleteAsync($"{Groups}/{leagueId}/members/{club.MemberUserId}");
        Assert.Equal(HttpStatusCode.NoContent, remove.StatusCode);
        // The same set again moves nobody and records nothing.
        await admin.PutAsJsonAsync(MemberGroupsPath(club.MemberUserId), new { groupIds = new[] { coachingId } });

        List<AuditLog> rows;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            rows = await db.AuditLogs.IgnoreQueryFilters()
                .Where(a => a.SubjectUserId == club.MemberUserId && a.Action == "member.groups_changed")
                .OrderBy(a => a.CreatedAt).ToListAsync();
        }
        Assert.Equal(3, rows.Count);
        Assert.All(rows, r => Assert.Equal(club.TenantId, r.TenantId));
        Assert.All(rows, r => Assert.Equal(club.AdminUserId, r.ActorUserId));

        // (rate before, rate after, peak before, peak after, group added, group removed)
        var expected = new (decimal? RateBefore, decimal RateAfter, bool PeakBefore, bool PeakAfter, Guid? Added, Guid? Removed)[]
        {
            (null, TestHost.LeagueCreditsPerZar, false, true, leagueId, null),
            (TestHost.LeagueCreditsPerZar, 2.0m, true, true, coachingId, null),
            (2.0m, 2.0m, true, false, null, leagueId),
        };
        for (var i = 0; i < expected.Length; i++)
        {
            using var d = JsonDocument.Parse(rows[i].DetailsJson!);
            var (rateBefore, rateAfter, peakBefore, peakAfter, added, removed) = expected[i];
            var tb = d.RootElement.GetProperty("tariff_before");
            var ta = d.RootElement.GetProperty("tariff_after");
            if (rateBefore is { } rb) Assert.Equal(rb, tb.GetProperty("top_up_credits_per_zar").GetDecimal());
            Assert.Equal(rateAfter, ta.GetProperty("top_up_credits_per_zar").GetDecimal());
            Assert.Equal(peakBefore, tb.GetProperty("peak_priority").GetBoolean());
            Assert.Equal(peakAfter, ta.GetProperty("peak_priority").GetBoolean());
            Assert.Equal(added is null ? 0 : 1, d.RootElement.GetProperty("added").GetArrayLength());
            Assert.Equal(removed is null ? 0 : 1, d.RootElement.GetProperty("removed").GetArrayLength());
            if (added is { } a) Assert.Equal(a, d.RootElement.GetProperty("added")[0].GetProperty("id").GetGuid());
            if (removed is { } r) Assert.Equal(r, d.RootElement.GetProperty("removed")[0].GetProperty("id").GetGuid());
        }
        using (var first = JsonDocument.Parse(rows[0].DetailsJson!))
        {
            Assert.Equal("Registered for league", first.RootElement.GetProperty("reason").GetString());
            Assert.NotEqual(TestHost.LeagueCreditsPerZar,
                first.RootElement.GetProperty("tariff_before").GetProperty("top_up_credits_per_zar").GetDecimal());
        }

        // Answerable from the member's side: the trace carries the rows, naming the action.
        var trace = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{club.MemberUserId}/trace");
        Assert.Equal(3, trace.GetProperty("events").EnumerateArray()
            .Count(e => e.GetProperty("headline").GetString()!.Contains("member.groups_changed", StringComparison.Ordinal)));
    }

    /// <summary>
    /// The class endpoint's replacement: the WHOLE set in one PUT, recorded one row per group it
    /// changed, answering with the tariff the member now has. An archived group may be kept but
    /// not joined; an unknown one is refused; the old class route is gone.
    /// </summary>
    [SkippableFact]
    public async Task A_members_groups_are_set_in_one_call_and_recorded_per_group()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "d2put");
        var admin = club.AdminClient(factory);
        var leagueId = await AddLeagueGroupAsync(factory, club);
        var coachingId = await CreateAsync(admin, new { name = "Coaching", creditsPerZar = 2.0m, peakPriority = false });
        var oldId = await CreateAsync(admin, new { name = "Old promo" });
        await admin.PatchAsJsonAsync($"{Groups}/{oldId}", new { status = "archived", reason = "Promo ended" });

        var put = await admin.PutAsJsonAsync(MemberGroupsPath(club.MemberUserId),
            new { groupIds = new[] { leagueId, coachingId }, reason = "Joined the league and the coaching squad" });
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        var body = await put.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(2, body.GetProperty("groups").GetArrayLength());
        var tariff = body.GetProperty("tariff");
        Assert.Equal(2.0m, tariff.GetProperty("top_up_credits_per_zar").GetDecimal()); // the lower of 2.4 and 2.0
        Assert.Equal(coachingId, tariff.GetProperty("rate_group_id").GetGuid());
        Assert.False(tariff.GetProperty("peak_priority").GetBoolean());
        Assert.Equal("Coaching", tariff.GetProperty("peak_withheld_by")[0].GetString());

        foreach (var groupId in new[] { leagueId, coachingId })
        {
            var row = Assert.Single(await ChangesAsync(factory, club.TenantId, groupId),
                r => r.Action == AdminChangeActions.GroupMembersChanged);
            Assert.Equal("Joined the league and the coaching squad", row.Reason);
            Assert.Contains(club.MemberUserId.ToString(), row.AfterJson);
        }

        // snake_case, and a removal: one more row, on Coaching only.
        var snake = await admin.PutAsJsonAsync(MemberGroupsPath(club.MemberUserId),
            new Dictionary<string, object> { ["group_ids"] = new[] { leagueId } });
        Assert.Equal(HttpStatusCode.OK, snake.StatusCode);
        Assert.True((await snake.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("tariff").GetProperty("peak_priority").GetBoolean());
        Assert.Equal(2, (await ChangesAsync(factory, club.TenantId, coachingId)).Count(r => r.Action == AdminChangeActions.GroupMembersChanged));
        Assert.Single(await ChangesAsync(factory, club.TenantId, leagueId), r => r.Action == AdminChangeActions.GroupMembersChanged);

        // The same set again changes nobody and records nothing.
        await admin.PutAsJsonAsync(MemberGroupsPath(club.MemberUserId), new { groupIds = new[] { leagueId } });
        Assert.Single(await ChangesAsync(factory, club.TenantId, leagueId), r => r.Action == AdminChangeActions.GroupMembersChanged);

        var archived = await admin.PutAsJsonAsync(MemberGroupsPath(club.MemberUserId), new { groupIds = new[] { leagueId, oldId } });
        Assert.Equal(HttpStatusCode.BadRequest, archived.StatusCode);
        Assert.Equal("group_archived", (await archived.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        var unknown = await admin.PutAsJsonAsync(MemberGroupsPath(club.MemberUserId), new { groupIds = new[] { Guid.NewGuid() } });
        Assert.Equal("group_not_found", (await unknown.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        var missing = await admin.PutAsJsonAsync(MemberGroupsPath(club.MemberUserId), new { reason = "nothing" });
        Assert.Equal("group_ids_required", (await missing.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        // A member cannot call it.
        var asMember = await club.MemberClient(factory).PutAsJsonAsync(MemberGroupsPath(club.MemberUserId), new { groupIds = Array.Empty<Guid>() });
        Assert.Equal(HttpStatusCode.Forbidden, asMember.StatusCode);

        // The class endpoint is gone with the class.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var membershipId = await db.Memberships.IgnoreQueryFilters()
                .Where(m => m.UserId == club.MemberUserId).Select(m => m.Id).FirstAsync();
            var classCall = await admin.PostAsJsonAsync($"/api/v1/admin/members/{membershipId}/class", new { memberClass = "LeagueOrSenior" });
            Assert.Equal(HttpStatusCode.NotFound, classCall.StatusCode);
        }
    }

    /// <summary>
    /// The admin reads that carried <c>member_class</c> now carry <c>groups</c> — and, for one
    /// release, the class derived from the league group; the detail carries the resolved tariff.
    /// </summary>
    [SkippableFact]
    public async Task The_members_list_and_detail_name_the_groups_and_the_tariff()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "d2list");
        var admin = club.AdminClient(factory);
        var leagueId = await AddLeagueGroupAsync(factory, club, club.MemberUserId);

        var list = await admin.GetFromJsonAsync<JsonElement>("/api/v1/admin/members");
        var member = list.EnumerateArray().Single(r => r.GetProperty("user_id").GetGuid() == club.MemberUserId);
        Assert.Equal("LeagueOrSenior", member.GetProperty("member_class").GetString());
        var group = Assert.Single(member.GetProperty("groups").EnumerateArray());
        Assert.Equal(leagueId, group.GetProperty("id").GetGuid());
        Assert.Equal("league", group.GetProperty("system_key").GetString());
        Assert.Equal(2.4m, group.GetProperty("credits_per_zar").GetDecimal());

        var adminRow = list.EnumerateArray().Single(r => r.GetProperty("user_id").GetGuid() == club.AdminUserId);
        Assert.Equal("Regular", adminRow.GetProperty("member_class").GetString());
        Assert.Equal(0, adminRow.GetProperty("groups").GetArrayLength());

        var detail = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{club.MemberUserId}");
        Assert.Equal(leagueId, detail.GetProperty("groups")[0].GetProperty("id").GetGuid());
        var tariff = detail.GetProperty("tariff");
        Assert.Equal(2.4m, tariff.GetProperty("top_up_credits_per_zar").GetDecimal());
        Assert.Equal(leagueId, tariff.GetProperty("rate_group_id").GetGuid());
        Assert.True(tariff.GetProperty("peak_priority").GetBoolean());

        // The member's own view: their groups by name, and what those add up to — never who else is in them.
        var profile = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>("/api/v1/me/profile");
        var own = Assert.Single(profile.GetProperty("groups").EnumerateArray());
        Assert.Equal("League members", own.GetProperty("name").GetString());
        Assert.False(own.TryGetProperty("member_count", out _));
        Assert.Equal(2.4m, profile.GetProperty("top_up_credits_per_zar").GetDecimal());
        Assert.True(profile.GetProperty("peak_priority").GetBoolean());

        var rules = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{club.MemberUserId}/booking-rules");
        Assert.True(rules.GetProperty("tariff").GetProperty("peak_priority").GetBoolean());
        Assert.True(rules.TryGetProperty("allowed_windows", out _)); // the existing shape, unchanged
    }

    /// <summary>
    /// A member whose league group grants peak, but who is also in a group that does not, is
    /// refused a peak slot — and the refusal names the group; once the admin takes them out of
    /// it, the same slot books.
    /// </summary>
    [SkippableFact]
    public async Task A_group_that_withholds_peak_priority_is_named_in_the_refusal()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "d2peak");
        var admin = club.AdminClient(factory);
        var leagueId = await AddLeagueGroupAsync(factory, club, club.MemberUserId);
        var coachingId = await CreateAsync(admin, new { name = "Coaching", peakPriority = false });
        await admin.PutAsJsonAsync(MemberGroupsPath(club.MemberUserId), new { groupIds = new[] { leagueId, coachingId } });
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = club.TenantId,
                UserId = club.MemberUserId,
                Type = LedgerEntryType.TopUp,
                AmountCredits = 500m,
                ActorUserId = Guid.Empty,
                Reason = "fixture float",
            });
            await db.SaveChangesAsync();
        }

        // 17:00 UTC two days out: inside the default 16:00–19:00 window, far from the 1h allowance.
        var peak = new DateTimeOffset(DateTime.UtcNow.Date.AddDays(2).AddHours(17), TimeSpan.Zero);
        var member = club.MemberClient(factory);

        var refused = await member.PostAsJsonAsync("/api/v1/bookings/", new { courtId = club.CourtId, startsAt = peak, sliceCount = 1 });
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        var body = await refused.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("peak_hours_league_only", body.GetProperty("error").GetString());
        Assert.Equal("Coaching", Assert.Single(body.GetProperty("withheld_by_groups").EnumerateArray()).GetString());

        await admin.PutAsJsonAsync(MemberGroupsPath(club.MemberUserId), new { groupIds = new[] { leagueId } });
        var booked = await member.PostAsJsonAsync("/api/v1/bookings/", new { courtId = club.CourtId, startsAt = peak, sliceCount = 1 });
        Assert.Equal(HttpStatusCode.OK, booked.StatusCode);
    }

    /// <summary>
    /// Tenant isolation, structurally: another club's admin cannot read, edit or join this
    /// club's groups, cannot set this club's member's groups, and leaves no row in this club's
    /// change record trying.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_admin_reaches_no_group_tariff_of_this_club()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "d2xa");
        var other = await DoorClub.SeedAsync(factory, "d2xb");
        var leagueId = await AddLeagueGroupAsync(factory, club, club.MemberUserId);
        var intruder = other.AdminClient(factory);

        var theirList = await intruder.GetFromJsonAsync<JsonElement>(Groups);
        Assert.DoesNotContain(theirList.GetProperty("groups").EnumerateArray(), g => g.GetProperty("id").GetGuid() == leagueId);

        var patch = await intruder.PatchAsJsonAsync($"{Groups}/{leagueId}", new { creditsPerZar = 100m, peakPriority = false });
        Assert.Equal(HttpStatusCode.NotFound, patch.StatusCode);

        var setTheirs = await intruder.PutAsJsonAsync(MemberGroupsPath(club.MemberUserId), new { groupIds = Array.Empty<Guid>() });
        Assert.Equal(HttpStatusCode.NotFound, setTheirs.StatusCode);

        var joinOurs = await intruder.PutAsJsonAsync(MemberGroupsPath(other.MemberUserId), new { groupIds = new[] { leagueId } });
        Assert.Equal(HttpStatusCode.BadRequest, joinOurs.StatusCode);
        Assert.Equal("group_not_found", (await joinOurs.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString());

        var theirView = await intruder.GetAsync($"/api/v1/admin/members/{club.MemberUserId}/booking-rules");
        Assert.Equal(HttpStatusCode.NotFound, theirView.StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var league = await db.MemberGroups.IgnoreQueryFilters().FirstAsync(g => g.Id == leagueId);
        Assert.Equal(TestHost.LeagueCreditsPerZar, league.CreditsPerZar);
        Assert.True(league.PeakPriority);
        Assert.True(await db.MemberGroupMembers.IgnoreQueryFilters().AnyAsync(m => m.GroupId == leagueId && m.UserId == club.MemberUserId));
        Assert.False(await db.MemberGroupMembers.IgnoreQueryFilters().AnyAsync(m => m.GroupId == leagueId && m.UserId == other.MemberUserId));
        Assert.Empty(await db.AdminChangeLogs.IgnoreQueryFilters().Where(a => a.SubjectId == leagueId).ToListAsync());
    }
}
