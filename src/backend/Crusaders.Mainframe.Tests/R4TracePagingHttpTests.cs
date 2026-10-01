using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 4: the member trace is read a page at a time (it was one 307 KB answer), and
/// paging through one night is ONE privacy view — the record said "viewed" once per page.
/// </summary>
public sealed class R4TracePagingHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    [SkippableFact]
    public async Task Paging_through_one_night_is_one_recorded_view_and_a_new_range_is_another()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await DoorClub.SeedAsync(factory, "r4trpg");
        var now = DateTimeOffset.UtcNow;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            for (var i = 0; i < 5; i++)
            {
                db.LedgerEntries.Add(new LedgerEntry
                {
                    TenantId = club.TenantId,
                    UserId = club.MemberUserId,
                    Type = LedgerEntryType.TopUp,
                    AmountMinutes = 10,
                    ActorUserId = club.MemberUserId,
                    CreatedAt = now.AddMinutes(-30 + i).ToUniversalTime(),
                });
            }
            await db.SaveChangesAsync();
        }

        var client = club.AdminClient(factory);
        var path = $"/api/v1/admin/members/{club.MemberUserId}/trace";
        var range = $"from={Uri.EscapeDataString(now.AddHours(-2).ToString("O"))}&to={Uri.EscapeDataString(now.AddHours(1).ToString("O"))}";
        string? cursor = null;
        var pages = 0;
        do
        {
            var suffix = cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}";
            var body = await client.GetFromJsonAsync<JsonElement>($"{path}?{range}&limit=2{suffix}");
            Assert.Equal(5, body.GetProperty("total").GetInt32());
            pages++;
            cursor = body.GetProperty("cursor").ValueKind == JsonValueKind.Null ? null : body.GetProperty("cursor").GetString();
        }
        while (cursor is not null);
        Assert.Equal(3, pages);
        Assert.Equal(1, await ViewsAsync(factory, club));

        var yesterday = DateOnly.FromDateTime(now.UtcDateTime).AddDays(-1).ToString("yyyy-MM-dd");
        await client.GetFromJsonAsync<JsonElement>($"{path}?day={yesterday}&limit=2");
        Assert.Equal(2, await ViewsAsync(factory, club));
    }

    private static async Task<int> ViewsAsync(TestWebAppFactory factory, DoorClub club)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AdminChangeLogs.IgnoreQueryFilters()
            .CountAsync(r => r.TenantId == club.TenantId && r.Action == AdminChangeActions.MemberTraceViewed);
    }
}
