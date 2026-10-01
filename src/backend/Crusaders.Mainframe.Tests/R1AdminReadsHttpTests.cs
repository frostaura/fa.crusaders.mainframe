using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 1, lane F3's backend asks: what a group read carries (since P13 the package
/// discount, never a court price), a turned-down applicant's reason on the member page, and how many other admins a
/// notice still reaches when one switches it off.
/// </summary>
public sealed class R1AdminReadsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    /// <summary>
    /// P13 §3.8: a group has no price any more — a booking costs its own length in minutes — so the
    /// group read, the member's booking rules and the preview carry the package discount and no
    /// court price of any kind (the round-1 "group prices on the real courts" read is gone with it).
    /// </summary>
    [SkippableFact]
    public async Task Group_reads_carry_the_package_discount_and_no_court_price()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var club = await MemberCodeClub.SeedAsync(app, "r1grp");
        var admin = club.Member(app, club.AdminId, "admin");

        var created = await admin.PostAsJsonAsync("/api/v1/admin/member-groups", new { name = "Students", packageDiscountBps = 1500 });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var id = (await MemberCodeClub.JsonAsync(created)).GetProperty("id").GetGuid();
        var group = (await MemberCodeClub.JsonAsync(await admin.GetAsync("/api/v1/admin/member-groups")))
            .GetProperty("groups").EnumerateArray().Single(g => g.GetProperty("id").GetGuid() == id);
        Assert.Equal(1500, group.GetProperty("package_discount_bps").GetInt32());
        foreach (var gone in new[] { "pricing", "credits_per_zar", "effective_by_court" })
            Assert.False(group.TryGetProperty(gone, out _), gone);

        var rules = await MemberCodeClub.JsonAsync(await admin.GetAsync($"/api/v1/admin/members/{club.Sid}/booking-rules"));
        foreach (var gone in new[] { "slice_price_credits", "slice_price_range_credits", "slice_prices_by_court" })
            Assert.False(rules.TryGetProperty(gone, out _), gone);
        Assert.True(rules.GetProperty("tariff").TryGetProperty("package_discount_bps", out _));
    }

    [SkippableFact]
    public async Task A_turned_down_applicant_shows_the_clubs_reason_and_who_decided()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = pg.SharedHost;
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
        await using var factory = pg.SharedHost;
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
