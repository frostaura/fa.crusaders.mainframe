using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The member and desk reads in minutes (P13 lane B4, <c>docs/specs/minutes-and-packages.md</c>
/// §3.8, §3.15): the discount a member's groups give them on packages, where each screen reads
/// it, and the utilisation report's two minutes figures.
/// </summary>
public sealed class P13MinutesReadsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static async Task<Guid> GroupAsync(
        TestWebAppFactory factory, DoorClub club, string name, int? discountBps, int sortOrder, params Guid[] members)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var group = new MemberGroup
        {
            TenantId = club.TenantId, Name = name, PackageDiscountBps = discountBps, SortOrder = sortOrder,
        };
        db.MemberGroups.Add(group);
        foreach (var userId in members)
        {
            db.MemberGroupMembers.Add(new MemberGroupMember
            {
                TenantId = club.TenantId, GroupId = group.Id, UserId = userId, AddedByUserId = club.AdminUserId,
            });
        }
        await db.SaveChangesAsync();
        return group.Id;
    }

    /// <summary>
    /// Contract §3.8: the LOWEST discount among the member's active groups that set one wins, and
    /// it is read the same way by the member's own profile, the desk's member record and the
    /// members list — <c>package_discount_bps</c> and <c>discount_group_id</c>, never a rate.
    /// A group with no say (null) does not count as 0%.
    /// </summary>
    [SkippableFact]
    public async Task The_profile_and_the_desk_read_the_lowest_package_discount_and_where_it_came_from()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await DoorClub.SeedAsync(factory, "p13disc");
        await GroupAsync(factory, club, "Coaching", 1500, 0, club.MemberUserId);
        var league = await GroupAsync(factory, club, "League", 1000, 1, club.MemberUserId);
        await GroupAsync(factory, club, "Social", null, 2, club.MemberUserId);

        var profile = await club.MemberClient(factory).GetFromJsonAsync<JsonElement>("/api/v1/me/profile");
        Assert.Equal(1000, profile.GetProperty("package_discount_bps").GetInt32());
        Assert.False(profile.TryGetProperty("top_up_credits_per_zar", out _));

        var admin = club.AdminClient(factory);
        var detail = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{club.MemberUserId}");
        var tariff = detail.GetProperty("tariff");
        Assert.Equal(1000, tariff.GetProperty("package_discount_bps").GetInt32());
        Assert.Equal(league, tariff.GetProperty("discount_group_id").GetGuid());
        Assert.False(tariff.TryGetProperty("top_up_credits_per_zar", out _));
        Assert.False(tariff.TryGetProperty("rate_group_id", out _));

        var list = await admin.GetFromJsonAsync<JsonElement>("/api/v1/admin/members");
        var row = list.EnumerateArray().Single(r => r.GetProperty("user_id").GetGuid() == club.MemberUserId);
        var groups = row.GetProperty("groups").EnumerateArray().ToList();
        Assert.Equal(3, groups.Count);
        Assert.Contains(groups, g => g.GetProperty("name").GetString() == "Social"
                                     && g.GetProperty("package_discount_bps").ValueKind == JsonValueKind.Null);
        Assert.DoesNotContain("per_zar", list.GetRawText(), StringComparison.Ordinal);
        Assert.DoesNotContain("credit", detail.GetRawText(), StringComparison.OrdinalIgnoreCase);

        // A member no group discounts reads null — "no say", not "0% off".
        var adminProfile = await admin.GetFromJsonAsync<JsonElement>("/api/v1/me/profile");
        Assert.Equal(JsonValueKind.Null, adminProfile.GetProperty("package_discount_bps").ValueKind);
    }

    /// <summary>
    /// Contract §3.15: utilisation reports <c>sold_minutes</c> (Σ what the bookings were charged)
    /// and <c>kept_minutes</c> (what the ledger says the club kept). A no-show charged 60,
    /// refunded 60 and penalised 18 was SOLD for 60 and the club KEPT 18; a played booking of 45
    /// was sold and kept whole. Integers, and nothing under the old names.
    /// </summary>
    [SkippableFact]
    public async Task Utilisation_reports_minutes_sold_and_minutes_kept()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await DoorClub.SeedAsync(factory, "p13util");
        var day = DateTimeOffset.UtcNow.Date.AddDays(-2);
        var startsAt = new DateTimeOffset(day.AddHours(9), TimeSpan.Zero);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            Booking Book(DateTimeOffset at, int minutes, BookingStatus status) => new()
            {
                TenantId = club.TenantId, CourtId = club.CourtId, UserId = club.MemberUserId,
                BookedByUserId = club.MemberUserId, PaidByUserId = club.MemberUserId, ActorUserId = club.MemberUserId,
                StartsAt = at, EndsAt = at.AddMinutes(minutes), SliceMinutes = 15, SliceCount = minutes / 15,
                AmountChargedMinutes = minutes, Status = status, ChargedAt = at.AddDays(-1),
            };
            var noShow = Book(startsAt, 60, BookingStatus.NoShow);
            var played = Book(startsAt.AddHours(2), 45, BookingStatus.Completed);
            db.Bookings.AddRange(noShow, played);
            LedgerEntry Row(Booking b, LedgerEntryType type, int amount) => new()
            {
                TenantId = club.TenantId, UserId = club.MemberUserId, ActorUserId = club.MemberUserId,
                Type = type, AmountMinutes = amount, RelatedBookingId = b.Id, CreatedAt = b.StartsAt.ToUniversalTime(),
            };
            db.LedgerEntries.AddRange(
                Row(noShow, LedgerEntryType.BookingCharge, -60),
                Row(noShow, LedgerEntryType.CancellationRefund, 60),
                Row(noShow, LedgerEntryType.NoShowPenalty, -18),
                Row(played, LedgerEntryType.BookingCharge, -45));
            await db.SaveChangesAsync();
        }

        var from = day.AddDays(-1).ToString("yyyy-MM-dd");
        var to = day.AddDays(1).ToString("yyyy-MM-dd");
        var body = await club.AdminClient(factory).GetFromJsonAsync<JsonElement>(
            $"/api/v1/admin/reports/utilisation?from={from}T00:00:00Z&to={to}T00:00:00Z");

        var court = Assert.Single(body.GetProperty("by_court").EnumerateArray().ToList());
        Assert.Equal(105, court.GetProperty("sold_minutes").GetInt32());
        Assert.Equal(63, court.GetProperty("kept_minutes").GetInt32());
        Assert.Equal(105, court.GetProperty("booked_minutes").GetInt32());
        Assert.False(court.TryGetProperty("revenue_credits", out _));
        Assert.False(court.TryGetProperty("quoted_credits", out _));
        Assert.DoesNotContain(".0", court.GetProperty("sold_minutes").GetRawText(), StringComparison.Ordinal);
    }
}
