using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 1, lane F3's backend asks: group prices on the club's REAL courts (not the retired
/// club default), a turned-down applicant's reason on the member page, and how many other admins a
/// notice still reaches when one switches it off.
/// </summary>
public sealed class R1AdminReadsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    [SkippableFact]
    public async Task Group_prices_are_the_courts_own_not_the_retired_club_default()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "r1prices");
        // The retired club default says 40; the courts say 8, and one says 12.
        await club.SetAsync(app, "slice_price_credits", 40);
        await club.WriteAsync(app, async db =>
            (await db.Courts.IgnoreQueryFilters().FirstAsync(c => c.Id == club.Courts[1])).SlicePriceCredits = 12m);
        var admin = club.Member(app, club.AdminId, "admin");

        var groups = await MemberCodeClub.JsonAsync(await admin.GetAsync("/api/v1/admin/member-groups"));
        foreach (var g in groups.GetProperty("groups").EnumerateArray().Where(g => g.GetProperty("pricing").GetProperty("mode").GetString() != "flat"))
        {
            var pricing = g.GetProperty("pricing");
            Assert.NotEqual(40m, pricing.GetProperty("effective_example_credits").GetDecimal());
            Assert.Equal(4, pricing.GetProperty("effective_by_court").GetArrayLength());
        }

        var rules = await MemberCodeClub.JsonAsync(await admin.GetAsync($"/api/v1/admin/members/{club.Olga}/booking-rules"));
        Assert.Equal(8m, rules.GetProperty("slice_price_credits").GetDecimal());
        Assert.Equal(8m, rules.GetProperty("slice_price_range_credits").GetProperty("min").GetDecimal());
        Assert.Equal(12m, rules.GetProperty("slice_price_range_credits").GetProperty("max").GetDecimal());
        var byCourt = rules.GetProperty("slice_prices_by_court").EnumerateArray().ToList();
        Assert.Equal(4, byCourt.Count);
        Assert.Contains(byCourt, c => c.GetProperty("credits").GetDecimal() == 12m);
    }

    [SkippableFact]
    public async Task A_turned_down_applicant_shows_the_clubs_reason_and_who_decided()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "r1rejected");
        await club.WriteAsync(app, async db =>
            (await db.Memberships.IgnoreQueryFilters().FirstAsync(m => m.Id == club.SidMembership)).Status = MembershipStatus.PendingApproval);
        var admin = club.Member(app, club.AdminId, "admin");

        var before = await MemberCodeClub.JsonAsync(await admin.GetAsync($"/api/v1/admin/members/{club.Sid}"));
        Assert.Equal(JsonValueKind.Null, before.GetProperty("rejection_reason").ValueKind);

        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"/api/v1/admin/members/{club.SidMembership}/reject", new { reason = "Not on the club's roll" })).StatusCode);
        var after = await MemberCodeClub.JsonAsync(await admin.GetAsync($"/api/v1/admin/members/{club.Sid}"));
        Assert.Equal("Not on the club's roll", after.GetProperty("rejection_reason").GetString());
        Assert.Equal("Ada Admin", after.GetProperty("review").GetProperty("reviewed_by_name").GetString());
        Assert.NotEqual(JsonValueKind.Null, after.GetProperty("review").GetProperty("reviewed_at").ValueKind);
    }

    [SkippableFact]
    public async Task Each_notice_kind_says_how_many_other_admins_are_still_told()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "r1others");
        // A second admin: Pam.
        await club.WriteAsync(app, async db => (await db.Users.IgnoreQueryFilters().FirstAsync(u => u.Id == club.Pam)).IsAdmin = true);
        var ada = club.Member(app, club.AdminId, "admin");

        var kinds = (await MemberCodeClub.JsonAsync(await ada.GetAsync("/api/v1/admin/notifications/kinds"))).GetProperty("kinds").EnumerateArray().ToList();
        var optional = kinds.First(k => k.GetProperty("optional").GetBoolean());
        Assert.Equal(1, optional.GetProperty("others_receiving").GetInt32());

        // Pam switches that kind off: Ada now reads that nobody else is told.
        var kind = optional.GetProperty("kind").GetString()!;
        var pam = club.Member(app, club.Pam, "admin");
        Assert.True((await pam.PutAsJsonAsync("/api/v1/me/preferences", new { adminNotificationOptouts = new[] { kind } })).IsSuccessStatusCode);
        var again = (await MemberCodeClub.JsonAsync(await ada.GetAsync("/api/v1/admin/notifications/kinds"))).GetProperty("kinds").EnumerateArray()
            .Single(k => k.GetProperty("kind").GetString() == kind);
        Assert.Equal(0, again.GetProperty("others_receiving").GetInt32());
    }
}
