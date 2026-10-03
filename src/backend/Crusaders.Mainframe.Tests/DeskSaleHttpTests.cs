using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using static Crusaders.Mainframe.Tests.PurchaseKit;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The desk's shelf and sale (P13 §3.7): the member's shelf exactly as they see it, a package
/// sold over the counter at that price by default, the refusals, the mails — and another club's
/// member or package reaching none of it (cross-tenant injection, §10.3).
/// </summary>
public sealed class DeskSaleHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static string ShelfPath(Guid userId) => $"/api/v1/admin/minutes/{userId}/packages";

    private static string SellPath(Guid userId) => $"/api/v1/admin/minutes/{userId}/sell";

    private static async Task<JsonElement> JsonOf(HttpResponseMessage res) => await res.Content.ReadFromJsonAsync<JsonElement>();

    /// <summary>The desk sees the member's own shelf — their discount, their group's packages — and no open checkouts.</summary>
    [SkippableFact]
    public async Task The_desk_shelf_is_the_members_own_shelf_without_open_checkouts()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "dk");
        await SetDiscountAsync(f, club.LeagueGroupId, 1000);
        await JoinAsync(f, club, club.MemberUserId, club.LeagueGroupId);
        await AddPackageAsync(f, club, "League night", 120, 150m, club.LeagueGroupId);
        await BuyAsync(Member(f, club), club.OneHour);

        var desk = await JsonOf(await Admin(f, club).GetAsync(ShelfPath(club.MemberUserId)));
        var own = await ShelfAsync(Member(f, club));

        Assert.Equal(own.GetProperty("discount").GetRawText(), desk.GetProperty("discount").GetRawText());
        Assert.Equal(own.GetProperty("packages").GetRawText(), desk.GetProperty("packages").GetRawText());
        Assert.False(desk.TryGetProperty("open_checkouts", out _));
        Assert.Equal(495m, desk.GetProperty("packages")[1].GetProperty("price_zar").GetDecimal());

        // The other member is in no group: list prices, no League night.
        var other = await JsonOf(await Admin(f, club).GetAsync(ShelfPath(club.OtherUserId)));
        Assert.Equal(3, other.GetProperty("packages").GetArrayLength());
        Assert.Equal(JsonValueKind.Null, other.GetProperty("discount").ValueKind);
    }

    /// <summary>
    /// A sale posts the package's minutes and, unless the desk says otherwise, the member's shelf
    /// price — a discounted one included. 409 for a package not on the member's shelf.
    /// </summary>
    [SkippableFact]
    public async Task A_sale_defaults_to_the_members_shelf_price_and_refuses_what_is_not_on_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "dks");
        await SetDiscountAsync(f, club.LeagueGroupId, 1000);
        await JoinAsync(f, club, club.MemberUserId, club.LeagueGroupId);
        var leagueOnly = await AddPackageAsync(f, club, "League night", 120, 150m, club.LeagueGroupId);
        var admin = Admin(f, club);

        var sold = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), new { packageId = club.FiveHours, reasonCode = "top_up_eft", reason = "EFT 0912" });
        Assert.Equal(HttpStatusCode.OK, sold.StatusCode);
        var body = await JsonOf(sold);
        Assert.Equal(495m, body.GetProperty("zar_received").GetDecimal());
        Assert.Equal(300, body.GetProperty("amount_minutes").GetInt32());

        var entry = Assert.Single(await LedgerAsync(f, club, club.MemberUserId));
        Assert.Equal(LedgerEntryType.AdminTopUp, entry.Type);
        Assert.Equal(495m, entry.ZarPaid);
        Assert.Equal("EFT 0912 — 5 hours", entry.Reason);

        // The other member is not in the league: its package is not theirs to buy.
        var notTheirs = await admin.PostAsJsonAsync(SellPath(club.OtherUserId), new { packageId = leagueOnly, reasonCode = "top_up_cash", reason = "Cash" });
        Assert.Equal(HttpStatusCode.Conflict, notTheirs.StatusCode);
        Assert.Equal("package_unavailable", (await JsonOf(notTheirs)).GetProperty("error").GetString());

        // A 100%-discounted package cannot go to PayFast, but the desk can sell it — for R0.
        await SetDiscountAsync(f, club.LeagueGroupId, 10_000);
        var free = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), new { packageId = club.OneHour, reasonCode = "top_up_cash", reason = "Staff" });
        Assert.Equal(HttpStatusCode.OK, free.StatusCode);
        Assert.Equal(0m, (await JsonOf(free)).GetProperty("zar_received").GetDecimal());

        var missing = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), new { reasonCode = "top_up_cash", reason = "Cash" });
        Assert.Equal("package_id_required", (await JsonOf(missing)).GetProperty("error").GetString());
        var blank = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), new { packageId = club.OneHour, reasonCode = "top_up_cash", reason = " " });
        Assert.Equal("reason_required", (await JsonOf(blank)).GetProperty("error").GetString());
    }

    /// <summary>A retried sale moves the money once; the same key with another package is refused, not replayed.</summary>
    [SkippableFact]
    public async Task A_sale_is_idempotent_on_the_desks_key()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "dki");
        var admin = Admin(f, club);

        object Body(Guid package) => new { packageId = package, reasonCode = "top_up_cash", reason = "Cash", idempotencyKey = "sale-1" };
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync(SellPath(club.MemberUserId), Body(club.OneHour))).StatusCode);
        var again = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), Body(club.OneHour));
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.Equal(60, (await JsonOf(again)).GetProperty("balance_after_minutes").GetInt32());

        var other = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), Body(club.TenHours));
        Assert.Equal(HttpStatusCode.Conflict, other.StatusCode);
        Assert.Equal("idempotency_key_reused", (await JsonOf(other)).GetProperty("error").GetString());

        Assert.Single(await LedgerAsync(f, club, club.MemberUserId));
    }

    /// <summary>
    /// <b>Cross-tenant injection on the desk shelf and sale</b> (§10.3). Club B's admin reads no
    /// shelf of club A's member and sells them nothing; club B's admin cannot sell club A's package
    /// to club B's own member either. Nothing is posted anywhere.
    /// </summary>
    [SkippableFact]
    public async Task Another_clubs_desk_reaches_no_member_and_no_package_of_this_club()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "dkxa");
        var rival = await SeedAsync(f, "dkxb");
        var intruder = Admin(f, rival);

        Assert.Equal(HttpStatusCode.NotFound, (await intruder.GetAsync(ShelfPath(club.MemberUserId))).StatusCode);

        var toTheirMember = await intruder.PostAsJsonAsync(SellPath(club.MemberUserId), new { packageId = rival.FiveHours, reasonCode = "top_up_cash", reason = "Cash" });
        Assert.Equal(HttpStatusCode.NotFound, toTheirMember.StatusCode);

        var theirPackage = await intruder.PostAsJsonAsync(SellPath(rival.MemberUserId), new { packageId = club.FiveHours, reasonCode = "top_up_cash", reason = "Cash" });
        Assert.Equal(HttpStatusCode.Conflict, theirPackage.StatusCode);
        Assert.Equal("package_unavailable", (await JsonOf(theirPackage)).GetProperty("error").GetString());

        var adjustTheirs = await intruder.PostAsJsonAsync($"/api/v1/admin/minutes/{club.MemberUserId}/adjust", new { amountMinutes = 60, reasonCode = "goodwill", reason = "gift" });
        Assert.Equal(HttpStatusCode.NotFound, adjustTheirs.StatusCode);

        Assert.Empty(await LedgerAsync(f, club, club.MemberUserId));
        Assert.Empty(await LedgerAsync(f, rival, rival.MemberUserId));
        Assert.Empty(await ReadAsync(f, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == club.TenantId || a.TenantId == rival.TenantId).ToListAsync()));
    }

    private static async Task<EmailMessage?> PollMailAsync(StubEmailService mail)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            if (mail.Sent.FirstOrDefault() is { } found) return found;
            await Task.Delay(25);
        }
        return null;
    }

    private static WebApplicationFactory<Program> WithMail(TestWebAppFactory factory, StubEmailService mail)
        => factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEmailService>();
            s.AddSingleton<IEmailService>(mail);
        }));

    /// <summary>
    /// Review round 7, J7-10: a R0.00 package could only be sold as "Cash paid at the desk" and was
    /// worded as revenue. <c>package_free</c> gives it at no charge — only on a package that costs
    /// this member nothing, never with a rand figure, and the mail says nothing was paid.
    /// </summary>
    [SkippableFact]
    public async Task A_free_package_is_given_at_no_charge_and_only_a_free_package_can_be()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "dkf");
        await SetDiscountAsync(f, club.LeagueGroupId, 10_000);
        await JoinAsync(f, club, club.MemberUserId, club.LeagueGroupId);

        var mail = new StubEmailService();
        await using var app = WithMail(f, mail);
        var admin = Admin(app, club);

        // The other member pays list price for the hour: "free" is not true of it.
        var priced = await admin.PostAsJsonAsync(SellPath(club.OtherUserId), new { packageId = club.OneHour, reasonCode = "package_free", reason = "Welcome" });
        Assert.Equal(HttpStatusCode.BadRequest, priced.StatusCode);
        var pricedBody = await JsonOf(priced);
        Assert.Equal("reason_code_invalid", pricedBody.GetProperty("error").GetString());
        Assert.Equal(["top_up_cash", "top_up_eft", "top_up_card_offline"], pricedBody.GetProperty("valid").EnumerateArray().Select(v => v.GetString()));

        var withRand = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), new { packageId = club.OneHour, reasonCode = "package_free", reason = "Welcome", zarReceived = 5m });
        Assert.Equal(HttpStatusCode.BadRequest, withRand.StatusCode);
        Assert.Equal("zar_received_out_of_range", (await JsonOf(withRand)).GetProperty("error").GetString());
        Assert.Empty(await LedgerAsync(f, club, club.MemberUserId));

        var given = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), new { packageId = club.OneHour, reasonCode = "package_free", reason = "Welcome", zarReceived = 0m });
        Assert.Equal(HttpStatusCode.OK, given.StatusCode);
        var body = await JsonOf(given);
        Assert.Equal("package_free", body.GetProperty("reason_code").GetString());
        Assert.Equal(0m, body.GetProperty("zar_received").GetDecimal());
        var entry = Assert.Single(await LedgerAsync(f, club, club.MemberUserId));
        Assert.Equal(LedgerEntryType.AdminTopUp, entry.Type);
        Assert.Equal(0m, entry.ZarPaid);

        var sent = await PollMailAsync(mail);
        Assert.NotNull(sent);
        Assert.Contains("no charge", sent!.HtmlBody, StringComparison.Ordinal);
        Assert.DoesNotContain("Amount received", sent.HtmlBody, StringComparison.Ordinal);
        Assert.DoesNotContain("what you paid", sent.HtmlBody, StringComparison.Ordinal);

        // Review round 8, E8-5: the Night and the club's change record said "sold" about a package
        // nobody paid for. Both now say it was given at no charge.
        var night = await JsonOf(await admin.GetAsync($"/api/v1/admin/members/{club.MemberUserId}/trace"));
        var desk = Assert.Single(night.GetProperty("events").EnumerateArray(),
            e => e.GetProperty("kind").GetString() == "wallet.topped_up_at_the_desk");
        var said = desk.GetProperty("headline").GetString()!;
        Assert.Contains("at no charge", said, StringComparison.Ordinal);
        Assert.DoesNotContain("sold", said, StringComparison.OrdinalIgnoreCase);

        var changes = await JsonOf(await admin.GetAsync("/api/v1/admin/changes"));
        var record = Assert.Single(changes.GetProperty("rows").EnumerateArray(),
            r => r.GetProperty("action").GetString() == "credit.topped_up");
        var headline = record.GetProperty("headline").GetString()!;
        Assert.StartsWith("Gave a member a package at no charge", headline, StringComparison.Ordinal);
    }

    /// <summary>Every player-affecting event sends an email: a sale says the package, the minutes and the rand; an adjustment says the minutes and the reason.</summary>
    [SkippableFact]
    public async Task A_sale_and_an_adjustment_each_mail_the_member_in_minutes()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "dkm");

        var saleMail = new StubEmailService();
        await using (var app = WithMail(f, saleMail))
        {
            var res = await Admin(app, club).PostAsJsonAsync(SellPath(club.MemberUserId), new { packageId = club.FiveHours, reasonCode = "top_up_cash", reason = "Cash" });
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        }
        var sale = await PollMailAsync(saleMail);
        Assert.NotNull(sale);
        Assert.Equal(club.MemberEmail, sale!.To);
        Assert.Contains("5 hours", sale.Subject, StringComparison.Ordinal);
        Assert.Contains("R550.00", sale.HtmlBody, StringComparison.Ordinal);
        Assert.DoesNotContain("credit", sale.HtmlBody, StringComparison.OrdinalIgnoreCase);

        var adjustMail = new StubEmailService();
        await using (var app = WithMail(f, adjustMail))
        {
            var res = await Admin(app, club).PostAsJsonAsync($"/api/v1/admin/minutes/{club.MemberUserId}/adjust",
                new { amountMinutes = -45, reasonCode = "correction", reason = "Double-booked court" });
            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        }
        var adjust = await PollMailAsync(adjustMail);
        Assert.NotNull(adjust);
        Assert.Contains("45 minutes", adjust!.Subject + adjust.HtmlBody, StringComparison.Ordinal);
        Assert.Contains("Double-booked court", adjust.HtmlBody, StringComparison.Ordinal);
        Assert.DoesNotContain("credit", adjust.HtmlBody, StringComparison.OrdinalIgnoreCase);
    }
}
