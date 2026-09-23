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
/// The admin actions the change-record vocabulary could name and nothing wrote: a by-hand
/// credit movement, and every group write (decision R19's gap list, 2026-09-23). Postgres-backed
/// because the change record is only trustworthy if the row flushes in the same transaction as
/// the change it describes, and the in-memory provider has no transactions.
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class AdminChangeRecordGapsHttpTests
{
    private readonly PostgresFixture _pg;

    public AdminChangeRecordGapsHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>The club, with the member holding <paramref name="memberCredits"/>.</summary>
    private static async Task<DoorClub> SeedAsync(TestWebAppFactory factory, string prefix, decimal memberCredits)
    {
        var club = await DoorClub.SeedAsync(factory, prefix);
        if (memberCredits == 0m) return club;

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = club.TenantId, UserId = club.MemberUserId, Type = LedgerEntryType.TopUp,
            AmountCredits = memberCredits, ActorUserId = Guid.Empty, Reason = "fixture float",
        });
        await db.SaveChangesAsync();
        return club;
    }

    private static async Task<List<AdminChangeLog>> ChangesAsync(TestWebAppFactory factory, Guid tenantId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == tenantId).OrderBy(a => a.OccurredAt).ToListAsync();
    }


    /// <summary>
    /// A by-hand credit movement is in the undeletable record: an adjustment code as
    /// <c>credit.adjusted</c>, a top-up code as <c>credit.topped_up</c>, each with the admin's
    /// reason and both balances. Another club's record carries neither.
    /// </summary>
    [SkippableFact]
    public async Task A_credit_adjustment_and_a_desk_top_up_are_written_to_the_change_record()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "gmcredit", memberCredits: 40m);
        var other = await SeedAsync(factory, "gmcredx", memberCredits: 0m);
        var admin = club.AdminClient(factory);
        var path = $"/api/v1/admin/credit/{club.MemberUserId}/adjust";

        var adjusted = await admin.PostAsJsonAsync(path, new
        {
            amountCredits = 10m, reason = "Lights failed mid-session", reasonCode = "goodwill", idempotencyKey = "gm_adj",
        });
        var toppedUp = await admin.PostAsJsonAsync(path, new
        {
            amountCredits = 100m, reason = "Paid cash at the bar", reasonCode = "top_up_cash", idempotencyKey = "gm_top",
        });
        Assert.Equal(HttpStatusCode.OK, adjusted.StatusCode);
        Assert.Equal(HttpStatusCode.OK, toppedUp.StatusCode);

        var rows = await ChangesAsync(factory, club.TenantId);
        var adjust = Assert.Single(rows, r => r.Action == AdminChangeActions.CreditAdjusted);
        var topUp = Assert.Single(rows, r => r.Action == AdminChangeActions.CreditToppedUp);

        Assert.Equal(club.AdminUserId, adjust.ActorUserId);
        Assert.Equal(club.MemberUserId, adjust.SubjectId);
        Assert.Equal("Door Member", adjust.SubjectLabel);
        Assert.Equal("Lights failed mid-session", adjust.Reason);
        using (var before = JsonDocument.Parse(adjust.BeforeJson!))
        using (var after = JsonDocument.Parse(adjust.AfterJson!))
        {
            Assert.Equal(40m, before.RootElement.GetProperty("balance_credits").GetDecimal());
            Assert.Equal(50m, after.RootElement.GetProperty("balance_credits").GetDecimal());
            Assert.Equal("goodwill", after.RootElement.GetProperty("reason_code").GetString());
        }
        using (var after = JsonDocument.Parse(topUp.AfterJson!))
        {
            Assert.Equal(150m, after.RootElement.GetProperty("balance_credits").GetDecimal());
        }

        // A replayed click is not a second decision.
        await admin.PostAsJsonAsync(path, new
        {
            amountCredits = 10m, reason = "Lights failed mid-session", reasonCode = "goodwill", idempotencyKey = "gm_adj",
        });
        Assert.Single(await ChangesAsync(factory, club.TenantId), r => r.Action == AdminChangeActions.CreditAdjusted);

        Assert.Empty(await ChangesAsync(factory, other.TenantId));
    }

    /// <summary>
    /// Every group write an admin can make leaves its row: created, updated with the changed
    /// fields only, archived with the reason sent, members added and removed by name, and an
    /// empty group deleted. An edit that changes nothing leaves nothing. Another club's admin
    /// reaches none of it and leaves no row.
    /// </summary>
    [SkippableFact]
    public async Task Every_group_write_is_written_to_the_change_record()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await SeedAsync(factory, "gmgroup", memberCredits: 0m);
        var other = await SeedAsync(factory, "gmgroupx", memberCredits: 0m);
        var admin = club.AdminClient(factory);
        const string Groups = "/api/v1/admin/member-groups";

        var created = await admin.PostAsJsonAsync(Groups, new { name = "Juniors", description = "Under 18" });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        var renamed = await admin.PatchAsJsonAsync($"{Groups}/{id}", new
        {
            name = "Junior squad", pricing = new { mode = "multiplier", multiplierBps = 5_000 },
        });
        Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
        var unchanged = await admin.PatchAsJsonAsync($"{Groups}/{id}", new { name = "Junior squad" });
        Assert.Equal(HttpStatusCode.OK, unchanged.StatusCode);

        await admin.PostAsJsonAsync($"{Groups}/{id}/members", new { userIds = new[] { club.MemberUserId } });
        await admin.DeleteAsync($"{Groups}/{id}/members/{club.MemberUserId}");
        var archived = await admin.PatchAsJsonAsync($"{Groups}/{id}", new { status = "archived", reason = "Season over" });
        Assert.Equal(HttpStatusCode.OK, archived.StatusCode);
        var deleted = await admin.DeleteAsync($"{Groups}/{id}");
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);

        var rows = (await ChangesAsync(factory, club.TenantId)).Where(r => r.SubjectId == id).ToList();
        Assert.Equal(
            [
                AdminChangeActions.GroupCreated, AdminChangeActions.GroupUpdated,
                AdminChangeActions.GroupMembersChanged, AdminChangeActions.GroupMembersChanged,
                AdminChangeActions.GroupArchived, AdminChangeActions.GroupDeleted,
            ],
            rows.Select(r => r.Action).ToList());
        Assert.All(rows, r => Assert.Equal(AdminChangeAreas.Group, r.Area));

        using (var before = JsonDocument.Parse(rows[1].BeforeJson!))
        using (var after = JsonDocument.Parse(rows[1].AfterJson!))
        {
            Assert.Equal("Juniors", before.RootElement.GetProperty("name").GetString());
            Assert.Equal("Junior squad", after.RootElement.GetProperty("name").GetString());
            Assert.Equal(5_000, after.RootElement.GetProperty("multiplier_bps").GetInt32());
            // Changed fields only.
            Assert.False(after.RootElement.TryGetProperty("description", out _));
        }

        Assert.Contains("Door Member", rows[2].AfterJson);
        Assert.Contains(club.MemberUserId.ToString(), rows[2].AfterJson);
        Assert.Equal("Season over", rows[4].Reason);

        // Cross-tenant: club B's admin cannot touch club A's group, and leaves no row anywhere.
        var groupA = await admin.PostAsJsonAsync(Groups, new { name = "Seniors" });
        var groupAId = (await groupA.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var foreign = await other.AdminClient(factory).PatchAsJsonAsync($"{Groups}/{groupAId}", new { name = "Taken over" });
        Assert.Equal(HttpStatusCode.NotFound, foreign.StatusCode);
        Assert.Empty(await ChangesAsync(factory, other.TenantId));
    }
}
