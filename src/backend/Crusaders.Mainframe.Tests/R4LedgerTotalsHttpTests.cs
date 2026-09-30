using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 4 (admin carry-over): the Transactions totals cover the whole range. The paged
/// ledger's first page carries them, so a range too big to read whole still totals right.
/// </summary>
public sealed class R4LedgerTotalsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    [SkippableFact]
    public async Task The_first_page_totals_the_whole_range_and_later_pages_do_not()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await DoorClub.SeedAsync(factory, "r4ledtot");
        var now = DateTimeOffset.UtcNow;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            foreach (var (amount, i) in new[] { 10m, 5.5m, -3.25m }.Select((a, i) => (a, i)))
            {
                db.LedgerEntries.Add(new LedgerEntry
                {
                    TenantId = club.TenantId,
                    UserId = club.MemberUserId,
                    Type = amount > 0 ? LedgerEntryType.TopUp : LedgerEntryType.BookingCharge,
                    AmountCredits = amount,
                    ActorUserId = club.MemberUserId,
                    CreatedAt = now.AddMinutes(-10 + i).ToUniversalTime(),
                });
            }
            await db.SaveChangesAsync();
        }

        var client = club.AdminClient(factory);
        var first = await client.GetFromJsonAsync<JsonElement>(
            $"/api/v1/admin/ledger/?userId={club.MemberUserId}&limit=1&cursor=");
        Assert.Single(first.GetProperty("items").EnumerateArray());
        var totals = first.GetProperty("totals");
        Assert.Equal(3, totals.GetProperty("count").GetInt32());
        Assert.Equal(15.5m, totals.GetProperty("credits").GetDecimal());
        Assert.Equal(3.25m, totals.GetProperty("debits").GetDecimal());
        Assert.Equal(12.25m, totals.GetProperty("net").GetDecimal());

        var cursor = first.GetProperty("next_cursor").GetString();
        var second = await client.GetFromJsonAsync<JsonElement>(
            $"/api/v1/admin/ledger/?userId={club.MemberUserId}&limit=1&cursor={Uri.EscapeDataString(cursor!)}");
        Assert.Equal(JsonValueKind.Null, second.GetProperty("totals").ValueKind);
    }
}
