using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using static Crusaders.Mainframe.Tests.PurchaseKit;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The club's minutes packages as its admins define them (P13 §3.5, §4.1, §4.5): the list, the
/// writes and every refusal, the change record each write leaves, the group a package is pinned
/// to — and another club reaching none of it (cross-tenant injection on <c>minute_packages</c>,
/// §10.3).
/// </summary>
public sealed class PackageAdminHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string Path = "/api/v1/admin/packages";

    private static async Task<JsonElement> JsonOf(HttpResponseMessage res) => await res.Content.ReadFromJsonAsync<JsonElement>();

    private static StringContent Raw(string json) => new(json, Encoding.UTF8, "application/json");

    private static async Task<List<AdminChangeLog>> ChangesAsync(TestWebAppFactory f, Guid tenantId, Guid subjectId)
        => await ReadAsync(f, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == tenantId && a.SubjectId == subjectId).OrderBy(a => a.OccurredAt).ToListAsync());

    [SkippableFact]
    public async Task An_admin_creates_edits_and_archives_a_package_and_each_write_is_recorded()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "pk");
        var admin = Admin(f, club);

        var created = await admin.PostAsJsonAsync(Path, new { name = "  Taster  ", minutes = 30, priceZar = 70m, sortOrder = 5 });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var body = await JsonOf(created);
        var id = body.GetProperty("id").GetGuid();
        Assert.Equal("Taster", body.GetProperty("name").GetString());
        Assert.Equal(30, body.GetProperty("minutes").GetInt32());
        Assert.Equal(70m, body.GetProperty("price_zar").GetDecimal());
        Assert.Equal(5, body.GetProperty("sort_order").GetInt32());
        Assert.Equal("active", body.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("group").ValueKind);

        var edited = await admin.PutAsJsonAsync($"{Path}/{id}", new { name = "Taster", minutes = 45, priceZar = 90m, sortOrder = 5, reason = "Longer taster" });
        Assert.Equal(HttpStatusCode.OK, edited.StatusCode);
        Assert.Equal(45, (await JsonOf(edited)).GetProperty("minutes").GetInt32());

        // A PUT that changes nothing records nothing.
        Assert.Equal(HttpStatusCode.OK, (await admin.PutAsJsonAsync($"{Path}/{id}", new { name = "Taster", minutes = 45, priceZar = 90m, sortOrder = 5 })).StatusCode);

        var archived = await admin.PostAsJsonAsync($"{Path}/{id}/archive", new { reason = "Season over" });
        Assert.Equal(HttpStatusCode.OK, archived.StatusCode);
        Assert.Equal("archived", (await JsonOf(archived)).GetProperty("status").GetString());
        // Idempotent: a second archive answers 200 and writes no second row.
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsync($"{Path}/{id}/archive", null)).StatusCode);
        // An archived package is not edited.
        var late = await admin.PutAsJsonAsync($"{Path}/{id}", new { name = "Taster", minutes = 60, priceZar = 90m, sortOrder = 5 });
        Assert.Equal(HttpStatusCode.Conflict, late.StatusCode);
        Assert.Equal("package_archived", (await JsonOf(late)).GetProperty("error").GetString());

        var rows = await ChangesAsync(f, club.TenantId, id);
        Assert.Equal([AdminChangeActions.PackageCreated, AdminChangeActions.PackageUpdated, AdminChangeActions.PackageArchived],
            rows.Select(r => r.Action));
        Assert.All(rows, r => Assert.Equal(AdminChangeAreas.Credit, r.Area));
        Assert.All(rows, r => Assert.Equal(AdminChangeSubjects.Package, r.SubjectKind));
        Assert.All(rows, r => Assert.Equal("Taster", r.SubjectLabel));
        Assert.All(rows, r => Assert.Equal(club.AdminUserId, r.ActorUserId));
        Assert.Null(rows[0].BeforeJson);
        Assert.Equal("Longer taster", rows[1].Reason);
        Assert.Equal("Season over", rows[2].Reason);
        Assert.Equal("Changed a minutes package — Taster", AdminChangeActions.Headline(rows[1].Action, rows[1].SubjectLabel));

        using (var before = JsonDocument.Parse(rows[1].BeforeJson!))
        using (var after = JsonDocument.Parse(rows[1].AfterJson!))
        {
            Assert.Equal(30, before.RootElement.GetProperty("minutes").GetInt32());
            Assert.Equal(45, after.RootElement.GetProperty("minutes").GetInt32());
            Assert.Equal(90m, after.RootElement.GetProperty("price_zar").GetDecimal());
            Assert.Equal(JsonValueKind.Null, after.RootElement.GetProperty("group").ValueKind);
            Assert.Equal("active", after.RootElement.GetProperty("status").GetString());
            Assert.Equal(5, after.RootElement.GetProperty("sort_order").GetInt32());
        }
        using (var after = JsonDocument.Parse(rows[2].AfterJson!))
        {
            Assert.Equal("archived", after.RootElement.GetProperty("status").GetString());
        }
    }

    /// <summary>
    /// The list: active by default, archived or all on request, club packages first, then each
    /// group's, each by sort order, minutes and name.
    /// </summary>
    [SkippableFact]
    public async Task The_list_filters_by_status_and_puts_the_club_shelf_first()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "pkl");
        var admin = Admin(f, club);
        await admin.PostAsJsonAsync(Path, new { name = "League night", minutes = 120, priceZar = 150m, groupId = club.LeagueGroupId });
        var old = await AddPackageAsync(f, club, "Old", 30, 50m);
        await EditPackageAsync(f, old, p => p.Status = MinutePackageStatus.Archived);

        var active = (await JsonOf(await admin.GetAsync(Path))).GetProperty("packages").EnumerateArray().ToList();
        Assert.Equal(["1 hour", "5 hours", "10 hours", "League night"], active.Select(p => p.GetProperty("name").GetString()));
        Assert.Equal("League members", active[3].GetProperty("group").GetProperty("name").GetString());

        var archived = (await JsonOf(await admin.GetAsync($"{Path}?status=archived"))).GetProperty("packages").EnumerateArray().ToList();
        Assert.Equal(["Old"], archived.Select(p => p.GetProperty("name").GetString()));
        Assert.Equal(5, (await JsonOf(await admin.GetAsync($"{Path}?status=all"))).GetProperty("packages").GetArrayLength());
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.GetAsync($"{Path}?status=deleted")).StatusCode);

        // A member cannot read it.
        Assert.Equal(HttpStatusCode.Forbidden, (await Member(f, club).GetAsync(Path)).StatusCode);
    }

    /// <summary>
    /// §3.5's validation codes, each with the figures its sentence needs. A fraction of a minute
    /// is refused, never truncated; so is a fraction of a cent. Nothing is saved.
    /// </summary>
    [SkippableTheory]
    [InlineData("""{"name":"   ","minutes":60,"priceZar":100}""", "package_name_invalid")]
    [InlineData("""{"name":"Sixty-five characters xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","minutes":60,"priceZar":100}""", "package_name_invalid")]
    [InlineData("""{"name":"Half","minutes":30.5,"priceZar":100}""", "package_minutes_invalid")]
    [InlineData("""{"name":"Zero","minutes":0,"priceZar":100}""", "package_minutes_invalid")]
    [InlineData("""{"name":"Huge","minutes":60001,"priceZar":100}""", "package_minutes_invalid")]
    [InlineData("""{"name":"Text","minutes":"60","priceZar":100}""", "package_minutes_invalid")]
    [InlineData("""{"name":"Free","minutes":60,"priceZar":0}""", "package_price_invalid")]
    [InlineData("""{"name":"Dear","minutes":60,"priceZar":100000.01}""", "package_price_invalid")]
    [InlineData("""{"name":"Cents","minutes":60,"priceZar":99.999}""", "package_price_invalid")]
    [InlineData("""{"name":"Sorted","minutes":60,"priceZar":100,"sortOrder":-1}""", "package_sort_order_invalid")]
    [InlineData("""{"name":"Bad group","minutes":60,"priceZar":100,"groupId":"not-a-guid"}""", "package_group_invalid")]
    [InlineData("""{"name":"No group","minutes":60,"priceZar":100,"groupId":"00000000-0000-0000-0000-000000000001"}""", "package_group_invalid")]
    public async Task A_package_the_club_could_not_sell_is_refused_by_name(string json, string expected)
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "pkv");

        var res = await Admin(f, club).PostAsync(Path, Raw(json));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(expected, (await JsonOf(res)).GetProperty("error").GetString());
        Assert.Equal(3, await ReadAsync(f, db => db.MinutePackages.IgnoreQueryFilters().CountAsync(p => p.TenantId == club.TenantId)));
    }

    [SkippableFact]
    public async Task The_refusals_carry_the_figures_their_sentence_needs()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "pkf");
        var admin = Admin(f, club);

        var name = await JsonOf(await admin.PostAsync(Path, Raw("""{"name":"","minutes":60,"priceZar":100}""")));
        Assert.Equal((1, 64), (name.GetProperty("min").GetInt32(), name.GetProperty("max").GetInt32()));
        var minutes = await JsonOf(await admin.PostAsync(Path, Raw("""{"name":"x","minutes":0,"priceZar":100}""")));
        Assert.Equal((1, 60000), (minutes.GetProperty("min").GetInt32(), minutes.GetProperty("max").GetInt32()));
        var price = await JsonOf(await admin.PostAsync(Path, Raw("""{"name":"x","minutes":60,"priceZar":0}""")));
        Assert.Equal(100000m, price.GetProperty("max").GetDecimal());
        Assert.Equal(2, price.GetProperty("decimals").GetInt32());
        Assert.Equal(0, price.GetProperty("min_exclusive").GetInt32());
    }

    /// <summary>
    /// A name is unique among ACTIVE packages on the same shelf — the club shelf is a shelf too —
    /// case-insensitively; a group's shelf may reuse a club name, and an archived name is free.
    /// </summary>
    [SkippableFact]
    public async Task A_name_is_unique_on_its_own_shelf_only_while_active()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "pkn");
        var admin = Admin(f, club);

        var taken = await admin.PostAsJsonAsync(Path, new { name = "5 HOURS", minutes = 300, priceZar = 500m });
        Assert.Equal(HttpStatusCode.Conflict, taken.StatusCode);
        Assert.Equal("package_name_taken", (await JsonOf(taken)).GetProperty("error").GetString());

        Assert.Equal(HttpStatusCode.Created,
            (await admin.PostAsJsonAsync(Path, new { name = "5 hours", minutes = 300, priceZar = 450m, groupId = club.LeagueGroupId })).StatusCode);

        await admin.PostAsJsonAsync($"{Path}/{club.FiveHours}/archive", new { });
        Assert.Equal(HttpStatusCode.Created, (await admin.PostAsJsonAsync(Path, new { name = "5 hours", minutes = 300, priceZar = 500m })).StatusCode);

        // A rename onto another active package's name is refused too.
        var rename = await admin.PutAsJsonAsync($"{Path}/{club.OneHour}", new { name = "10 Hours", minutes = 60, priceZar = 120m, sortOrder = 0 });
        Assert.Equal(HttpStatusCode.Conflict, rename.StatusCode);
    }

    [SkippableFact]
    public async Task A_club_holds_at_most_fifty_active_packages()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "pkm");
        for (var i = 0; i < 47; i++) await AddPackageAsync(f, club, $"Pack {i}", 60 + i, 100m);

        var res = await Admin(f, club).PostAsJsonAsync(Path, new { name = "One too many", minutes = 60, priceZar = 100m });

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        var body = await JsonOf(res);
        Assert.Equal("package_limit_reached", body.GetProperty("error").GetString());
        Assert.Equal(50, body.GetProperty("max").GetInt32());
    }

    /// <summary>
    /// A package's group is fixed at creation (§2.3): the PUT may omit it or repeat it, never
    /// change it — moving a package between audiences silently is what the rule exists to stop.
    /// </summary>
    [SkippableFact]
    public async Task A_packages_group_is_fixed_once_it_is_created()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "pkg");
        var admin = Admin(f, club);

        var omitted = await admin.PutAsJsonAsync($"{Path}/{club.OneHour}", new { name = "1 hour", minutes = 60, priceZar = 110m, sortOrder = 0 });
        Assert.Equal(HttpStatusCode.OK, omitted.StatusCode);
        var same = await admin.PutAsync($"{Path}/{club.OneHour}", Raw("""{"name":"1 hour","minutes":60,"priceZar":110,"sortOrder":0,"groupId":null}"""));
        Assert.Equal(HttpStatusCode.OK, same.StatusCode);

        var moved = await admin.PutAsJsonAsync($"{Path}/{club.OneHour}", new { name = "1 hour", minutes = 60, priceZar = 110m, sortOrder = 0, groupId = club.LeagueGroupId });
        Assert.Equal(HttpStatusCode.Conflict, moved.StatusCode);
        Assert.Equal("package_group_immutable", (await JsonOf(moved)).GetProperty("error").GetString());
        Assert.Null(await ReadAsync(f, db => db.MinutePackages.IgnoreQueryFilters().Where(p => p.Id == club.OneHour).Select(p => p.GroupId).SingleAsync()));
    }

    /// <summary>An archived group's packages may not be created, and a group with packages may not be deleted (the FK would 500).</summary>
    [SkippableFact]
    public async Task An_archived_group_takes_no_new_package_and_a_group_with_packages_is_not_deleted()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "pka");
        var admin = Admin(f, club);

        var created = await admin.PostAsJsonAsync("/api/v1/admin/member-groups", new { name = "Juniors" });
        var juniors = (await JsonOf(created)).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.Created, (await admin.PostAsJsonAsync(Path, new { name = "Junior hour", minutes = 60, priceZar = 60m, groupId = juniors })).StatusCode);

        var delete = await admin.DeleteAsync($"/api/v1/admin/member-groups/{juniors}");
        Assert.Equal(HttpStatusCode.Conflict, delete.StatusCode);
        var body = await JsonOf(delete);
        Assert.Equal("group_has_packages", body.GetProperty("error").GetString());
        Assert.Equal(1, body.GetProperty("package_count").GetInt32());

        await admin.PatchAsJsonAsync($"/api/v1/admin/member-groups/{juniors}", new { status = "archived", reason = "Season over" });
        var onArchived = await admin.PostAsJsonAsync(Path, new { name = "Another", minutes = 60, priceZar = 60m, groupId = juniors });
        Assert.Equal(HttpStatusCode.BadRequest, onArchived.StatusCode);
        Assert.Equal("package_group_invalid", (await JsonOf(onArchived)).GetProperty("error").GetString());
    }

    /// <summary>
    /// <b>Cross-tenant injection on <c>minute_packages</c></b> (§10.3, non-negotiable). Club B's
    /// admin cannot list, edit or archive club A's packages, cannot pin a package to club A's
    /// group, and leaves no row in either club's change record trying. Every refusal is the 404
    /// (or the invalid group) an unknown id gets — club A's rows simply do not exist from B.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_admin_reaches_no_package_of_this_club()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "pkxa");
        var rival = await SeedAsync(f, "pkxb");
        var intruder = Admin(f, rival);

        var theirs = (await JsonOf(await intruder.GetAsync($"{Path}?status=all"))).GetProperty("packages").EnumerateArray()
            .Select(p => p.GetProperty("id").GetGuid()).ToList();
        Assert.DoesNotContain(club.FiveHours, theirs);
        Assert.Contains(rival.FiveHours, theirs);

        var put = await intruder.PutAsJsonAsync($"{Path}/{club.FiveHours}", new { name = "5 hours", minutes = 3000, priceZar = 1m, sortOrder = 1 });
        Assert.Equal(HttpStatusCode.NotFound, put.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await intruder.PostAsync($"{Path}/{club.FiveHours}/archive", null)).StatusCode);

        var pinned = await intruder.PostAsJsonAsync(Path, new { name = "Hijack", minutes = 60, priceZar = 1m, groupId = club.LeagueGroupId });
        Assert.Equal(HttpStatusCode.BadRequest, pinned.StatusCode);
        Assert.Equal("package_group_invalid", (await JsonOf(pinned)).GetProperty("error").GetString());

        var package = await ReadAsync(f, db => db.MinutePackages.IgnoreQueryFilters().SingleAsync(p => p.Id == club.FiveHours));
        Assert.Equal((300, 550m, MinutePackageStatus.Active), (package.Minutes, package.PriceZar, package.Status));
        Assert.Empty(await ReadAsync(f, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId || a.TenantId == rival.TenantId).ToListAsync()));
        Assert.Empty(await ReadAsync(f, db => db.MinutePackages.IgnoreQueryFilters().Where(p => p.Name == "Hijack").ToListAsync()));
    }
}
