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
/// Review round 3, A-5: an admin adding or removing a club webhook sends the club's event stream
/// somewhere new, or stops sending it — and neither was on the change record. Both are now, with
/// the destination named by scheme and host only: the path, the query and any credentials in the
/// URL, and the signing secret, stay off a record every admin can read and export.
/// </summary>
public sealed class R3WebhookChangeRecordHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string Path = "/api/v1/admin/webhooks/";

    private static async Task<List<AdminChangeLog>> ChangesAsync(TestWebAppFactory factory, Guid tenantId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AdminChangeLogs.IgnoreQueryFilters().AsNoTracking()
            .Where(c => c.TenantId == tenantId).OrderBy(c => c.OccurredAt).ToListAsync();
    }

    [SkippableFact]
    public async Task Adding_and_removing_a_club_webhook_are_both_on_the_change_record_without_its_secrets()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = pg.SharedHost;
        var club = await DoorClub.SeedAsync(factory, "r3hooks");
        var admin = club.AdminClient(factory);

        var created = await admin.PostAsJsonAsync(Path, new
        {
            urlTemplate = "https://relay:hunter2pw@hooks.example.com/in/club?token=pathsecret&e={event}",
            eventFilter = "booking.*",
            description = "Scoreboard feed",
        });
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var hook = await created.Content.ReadFromJsonAsync<JsonElement>();
        var id = hook.GetProperty("id").GetGuid();
        var signingSecret = hook.GetProperty("secret").GetString()!;

        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync($"{Path}{id}")).StatusCode);

        var rows = await ChangesAsync(factory, club.TenantId);
        Assert.Equal([AdminChangeActions.WebhookCreated, AdminChangeActions.WebhookDeleted], rows.Select(r => r.Action));
        Assert.All(rows, r =>
        {
            Assert.Equal(club.AdminUserId, r.ActorUserId);
            Assert.Equal(AdminChangeAreas.Setting, r.Area);
            Assert.Equal(AdminChangeSubjects.Webhook, r.SubjectKind);
            Assert.Equal(id, r.SubjectId);
            Assert.Equal("Scoreboard feed", r.SubjectLabel);
        });
        Assert.Contains("https://hooks.example.com", rows[0].AfterJson!, StringComparison.Ordinal);
        Assert.Contains("booking.*", rows[0].AfterJson!, StringComparison.Ordinal);
        Assert.Contains("https://hooks.example.com", rows[1].BeforeJson!, StringComparison.Ordinal);
        foreach (var leak in new[] { "hunter2pw", "pathsecret", signingSecret })
        {
            Assert.All(rows, r => Assert.DoesNotContain(leak, $"{r.BeforeJson}{r.AfterJson}{r.SubjectLabel}", StringComparison.Ordinal));
        }

        var page = await (await admin.GetAsync("/api/v1/admin/changes?area=setting")).Content.ReadFromJsonAsync<JsonElement>();
        var headlines = page.GetProperty("rows").EnumerateArray().Select(r => r.GetProperty("headline").GetString()).ToList();
        Assert.Contains("Added a webhook — Scoreboard feed", headlines);
        Assert.Contains("Removed a webhook — Scoreboard feed", headlines);
    }

    [SkippableFact]
    public async Task A_webhook_with_no_description_is_named_by_its_host()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = pg.SharedHost;
        var club = await DoorClub.SeedAsync(factory, "r3hooknd");
        var admin = club.AdminClient(factory);

        var created = await admin.PostAsJsonAsync(Path, new { urlTemplate = "https://hooks.example.org/in" });
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);

        var row = Assert.Single(await ChangesAsync(factory, club.TenantId));
        Assert.Equal("hooks.example.org", row.SubjectLabel);
    }
}
