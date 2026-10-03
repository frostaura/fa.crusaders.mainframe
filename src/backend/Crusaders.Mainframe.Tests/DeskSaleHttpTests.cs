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

        var sold = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), new { packageId = club.FiveHours, reasonCode = "top_up_eft", reason = "EFT 0912", quotedPriceZar = 495m });
        Assert.Equal(HttpStatusCode.OK, sold.StatusCode);
        var body = await JsonOf(sold);
        Assert.Equal(495m, body.GetProperty("zar_received").GetDecimal());
        Assert.Equal(300, body.GetProperty("amount_minutes").GetInt32());

        var entry = Assert.Single(await LedgerAsync(f, club, club.MemberUserId));
        Assert.Equal(LedgerEntryType.AdminTopUp, entry.Type);
        Assert.Equal(495m, entry.ZarPaid);
        Assert.Equal("EFT 0912 — 5 hours", entry.Reason);

        // The other member is not in the league: its package is not theirs to buy.
        var notTheirs = await admin.PostAsJsonAsync(SellPath(club.OtherUserId), new { packageId = leagueOnly, reasonCode = "top_up_cash", reason = "Cash", quotedPriceZar = 150m });
        Assert.Equal(HttpStatusCode.Conflict, notTheirs.StatusCode);
        Assert.Equal("package_unavailable", (await JsonOf(notTheirs)).GetProperty("error").GetString());

        // A 100%-discounted package cannot go to PayFast, but the desk can sell it — for R0.
        await SetDiscountAsync(f, club.LeagueGroupId, 10_000);
        var free = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), new { packageId = club.OneHour, reasonCode = "top_up_cash", reason = "Staff", quotedPriceZar = 0m });
        Assert.Equal(HttpStatusCode.OK, free.StatusCode);
        Assert.Equal(0m, (await JsonOf(free)).GetProperty("zar_received").GetDecimal());

        var missing = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), new { reasonCode = "top_up_cash", reason = "Cash" });
        Assert.Equal("package_id_required", (await JsonOf(missing)).GetProperty("error").GetString());
        var blank = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), new { packageId = club.OneHour, reasonCode = "top_up_cash", reason = " " });
        Assert.Equal("reason_required", (await JsonOf(blank)).GetProperty("error").GetString());
    }

    /// <summary>
    /// Review round 11, J11-1: the same key sent to ANOTHER member's sell URL answered 200 with the
    /// first member's sale — entry id, package, "270 → 300" — while nothing was sold to the second.
    /// It is refused as a reused key, and nothing moves.
    /// </summary>
    [SkippableFact]
    public async Task A_sale_key_reused_for_another_member_is_refused_not_replayed()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "dkx");
        var admin = Admin(f, club);

        var body = new { packageId = club.OneHour, reasonCode = "top_up_cash", reason = "Cash", idempotencyKey = "sale-x", quotedPriceZar = 120m };
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync(SellPath(club.MemberUserId), body)).StatusCode);

        var crossed = await admin.PostAsJsonAsync(SellPath(club.OtherUserId), body);
        Assert.Equal(HttpStatusCode.Conflict, crossed.StatusCode);
        Assert.Equal("idempotency_key_reused", (await JsonOf(crossed)).GetProperty("error").GetString());
        Assert.Empty(await LedgerAsync(f, club, club.OtherUserId));
        Assert.Single(await LedgerAsync(f, club, club.MemberUserId));
    }

    /// <summary>A retried sale moves the money once; the same key with another package is refused, not replayed.</summary>
    [SkippableFact]
    public async Task A_sale_is_idempotent_on_the_desks_key()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "dki");
        var admin = Admin(f, club);

        object Body(Guid package, decimal shown) => new { packageId = package, reasonCode = "top_up_cash", reason = "Cash", idempotencyKey = "sale-1", quotedPriceZar = shown };
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync(SellPath(club.MemberUserId), Body(club.OneHour, 120m))).StatusCode);
        var again = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), Body(club.OneHour, 120m));
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.Equal(60, (await JsonOf(again)).GetProperty("balance_after_minutes").GetInt32());

        var other = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), Body(club.TenHours, 1000m));
        Assert.Equal(HttpStatusCode.Conflict, other.StatusCode);
        Assert.Equal("idempotency_key_reused", (await JsonOf(other)).GetProperty("error").GetString());

        Assert.Single(await LedgerAsync(f, club, club.MemberUserId));
    }

    /// <summary>
    /// Review round 10, J10-2: a replay of an APPLIED key answered 409 <c>package_price_changed</c>
    /// (or <c>package_unavailable</c>) once the shelf had moved, because the price and shelf checks
    /// ran before the key was looked up — the sheet said "Nothing was recorded", cleared the key,
    /// and the admin's next confirm sold the package twice. The earlier sale wins over the shelf as
    /// it stands now: same entry, one ledger row, after a discount move and after the package retired.
    /// </summary>
    [SkippableFact]
    public async Task A_replayed_sale_returns_the_earlier_sale_whatever_the_shelf_now_says()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "dkr");
        await SetDiscountAsync(f, club.LeagueGroupId, 1000);
        await JoinAsync(f, club, club.MemberUserId, club.LeagueGroupId);
        var admin = Admin(f, club);
        var body = new { packageId = club.FiveHours, reasonCode = "top_up_cash", reason = "Cash", idempotencyKey = "sale-r", quotedPriceZar = 495m };

        var first = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), body);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var entryId = (await JsonOf(first)).GetProperty("entry_id").GetGuid();

        // The discount moves to 20% (R440) before the reply reaches the desk; the desk retries.
        await SetDiscountAsync(f, club.LeagueGroupId, 2000);
        var moved = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), body);
        Assert.Equal(HttpStatusCode.OK, moved.StatusCode);
        var movedBody = await JsonOf(moved);
        Assert.Equal(entryId, movedBody.GetProperty("entry_id").GetGuid());
        Assert.Equal(495m, movedBody.GetProperty("zar_received").GetDecimal());
        Assert.Equal(495m, movedBody.GetProperty("package").GetProperty("price_zar").GetDecimal());
        Assert.Equal(300, movedBody.GetProperty("balance_after_minutes").GetInt32());

        // The package is retired from the shelf; the retry still finds the sale it made.
        await EditPackageAsync(f, club.FiveHours, p => p.Status = MinutePackageStatus.Archived);
        var retired = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), body);
        Assert.Equal(HttpStatusCode.OK, retired.StatusCode);
        Assert.Equal(entryId, (await JsonOf(retired)).GetProperty("entry_id").GetGuid());

        // A NEW key still meets the shelf as it stands: retired is unavailable.
        var fresh = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), body with { idempotencyKey = "sale-r2" });
        Assert.Equal(HttpStatusCode.Conflict, fresh.StatusCode);
        Assert.Equal("package_unavailable", (await JsonOf(fresh)).GetProperty("error").GetString());

        // The same key with a different movement is still refused, not replayed.
        var changed = await admin.PostAsJsonAsync(SellPath(club.MemberUserId), body with { quotedPriceZar = 440m });
        Assert.Equal(HttpStatusCode.Conflict, changed.StatusCode);
        Assert.Equal("idempotency_key_reused", (await JsonOf(changed)).GetProperty("error").GetString());

        Assert.Single(await LedgerAsync(f, club, club.MemberUserId));
    }

    /// <summary>
    /// Review round 10, J10-3: an admin take-back that left the member 10 spendable minutes in a club
    /// whose shortest court is 15 mailed only "Balance after 10 minutes" — the member learned they
    /// could not book by trying. The mail says so plainly; a take-back that leaves enough, and any
    /// grant, says nothing of the kind.
    /// </summary>
    [SkippableFact]
    public async Task A_take_back_that_leaves_less_than_a_court_says_so_in_the_mail()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "dkj3");
        var mail = new StubEmailService();
        await using var app = WithMail(f, mail);
        var admin = Admin(app, club);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync(SellPath(club.MemberUserId),
            new { packageId = club.OneHour, reasonCode = "top_up_cash", reason = "Cash", quotedPriceZar = 120m })).StatusCode);
        Assert.NotNull(await mail.WaitFor(m => m.Subject.StartsWith("Minutes bought", StringComparison.Ordinal)));
        mail.Clear();

        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"/api/v1/admin/minutes/{club.MemberUserId}/adjust",
            new { amountMinutes = -20, reasonCode = "correction", reason = "Double entry" })).StatusCode);
        var enough = await mail.WaitFor(m => m.Subject.StartsWith("Minutes taken off", StringComparison.Ordinal));
        Assert.NotNull(enough);
        Assert.DoesNotContain("a court needs", enough!.PlainBody, StringComparison.Ordinal);
        mail.Clear();

        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"/api/v1/admin/minutes/{club.MemberUserId}/adjust",
            new { amountMinutes = -30, reasonCode = "correction", reason = "Double entry" })).StatusCode);
        var shortOf = await mail.WaitFor(m => m.Subject.StartsWith("Minutes taken off", StringComparison.Ordinal));
        Assert.NotNull(shortOf);
        var flat = System.Text.RegularExpressions.Regex.Replace(shortOf!.PlainBody ?? "", @"\s+", " ");
        Assert.Contains("That leaves 10 minutes to spend — less than the 15 minutes a court needs.", flat, StringComparison.Ordinal);
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

        var toTheirMember = await intruder.PostAsJsonAsync(SellPath(club.MemberUserId), new { packageId = rival.FiveHours, reasonCode = "top_up_cash", reason = "Cash", quotedPriceZar = 550m });
        Assert.Equal(HttpStatusCode.NotFound, toTheirMember.StatusCode);

        var theirPackage = await intruder.PostAsJsonAsync(SellPath(rival.MemberUserId), new { packageId = club.FiveHours, reasonCode = "top_up_cash", reason = "Cash", quotedPriceZar = 550m });
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
        var priced = await admin.PostAsJsonAsync(SellPath(club.OtherUserId), new { packageId = club.OneHour, reasonCode = "package_free", reason = "Welcome", quotedPriceZar = 120m });
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
            var res = await Admin(app, club).PostAsJsonAsync(SellPath(club.MemberUserId), new { packageId = club.FiveHours, reasonCode = "top_up_cash", reason = "Cash", quotedPriceZar = 550m });
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

    /// <summary>
    /// Review round 9, J9-1: the desk confirmed R495 for five hours, the league's discount moved
    /// before Sell was pressed, and the server filled in the LIVE price — R440 recorded and mailed,
    /// a figure the admin never saw. The sale now carries the price the admin was shown
    /// (<c>quotedPriceZar</c>); a shelf that moved answers 409 <c>package_price_changed</c> with the
    /// fresh item and discount, and nothing is posted.
    /// </summary>
    [SkippableFact]
    public async Task A_sale_whose_shelf_price_moved_is_refused_with_the_new_price()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "dkq");
        await SetDiscountAsync(f, club.LeagueGroupId, 1000);
        await JoinAsync(f, club, club.MemberUserId, club.LeagueGroupId);
        var admin = Admin(f, club);

        // Shown R495 (10% off R550); the discount becomes 20% before the admin confirms.
        await SetDiscountAsync(f, club.LeagueGroupId, 2000);
        var stale = await admin.PostAsJsonAsync(SellPath(club.MemberUserId),
            new { packageId = club.FiveHours, reasonCode = "top_up_cash", reason = "Cash", quotedPriceZar = 495m });
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        var body = await JsonOf(stale);
        Assert.Equal("package_price_changed", body.GetProperty("error").GetString());
        Assert.Equal(440m, body.GetProperty("package").GetProperty("price_zar").GetDecimal());
        Assert.Equal(2000, body.GetProperty("discount").GetProperty("bps").GetInt32());
        Assert.Empty(await LedgerAsync(f, club, club.MemberUserId));

        // Confirmed at the new price: recorded at it.
        var sold = await admin.PostAsJsonAsync(SellPath(club.MemberUserId),
            new { packageId = club.FiveHours, reasonCode = "top_up_cash", reason = "Cash", quotedPriceZar = 440m });
        Assert.Equal(HttpStatusCode.OK, sold.StatusCode);
        Assert.Equal(440m, Assert.Single(await LedgerAsync(f, club, club.MemberUserId)).ZarPaid);
    }

    /// <summary>
    /// J9-1, backward compatibility: a client that states neither the price it showed nor the rand
    /// it took is refused — never handed the live price in silence, which is the defect itself.
    /// </summary>
    [SkippableFact]
    public async Task A_sale_that_states_no_price_is_refused_not_priced_by_the_server()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "dkn");
        var res = await Admin(f, club).PostAsJsonAsync(SellPath(club.MemberUserId),
            new { packageId = club.FiveHours, reasonCode = "top_up_cash", reason = "Cash" });
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("quoted_price_required", (await JsonOf(res)).GetProperty("error").GetString());
        Assert.Empty(await LedgerAsync(f, club, club.MemberUserId));
    }

    /// <summary>
    /// J9-1, the other direction: a free give confirmed while the member's discount was 100%, after
    /// the discount went away, was "400 reason_code_invalid — That didn't go through", naming
    /// nothing. It is the same stale price, and it is told the same way: 409 with the new price.
    /// </summary>
    [SkippableFact]
    public async Task A_free_give_whose_discount_vanished_is_told_the_new_price()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "dkv");
        await SetDiscountAsync(f, club.LeagueGroupId, 10_000);
        await JoinAsync(f, club, club.MemberUserId, club.LeagueGroupId);
        await SetDiscountAsync(f, club.LeagueGroupId, null);

        var res = await Admin(f, club).PostAsJsonAsync(SellPath(club.MemberUserId),
            new { packageId = club.OneHour, reasonCode = "package_free", reason = "Welcome", quotedPriceZar = 0m, zarReceived = 0m });
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        var body = await JsonOf(res);
        Assert.Equal("package_price_changed", body.GetProperty("error").GetString());
        Assert.True(body.GetProperty("package").GetProperty("price_zar").GetDecimal() > 0m);
        Assert.Empty(await LedgerAsync(f, club, club.MemberUserId));
    }

    /// <summary>
    /// Review round 9, J9-3: the Transactions page called a package GIVEN at no charge "Package sold
    /// at the desk" — the admin ledger rows carried neither the rand nor the desk's code. Each row
    /// now carries <c>zar_paid</c> (rand, null where no rand applies) and <c>reason_code</c> (the
    /// desk's code on a sale or adjustment, null elsewhere), and only this club's.
    /// </summary>
    [SkippableFact]
    public async Task The_admin_ledger_says_what_the_desk_took_and_under_which_code()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "dkl");
        var rival = await SeedAsync(f, "dklr");
        await SetDiscountAsync(f, club.LeagueGroupId, 10_000);
        await JoinAsync(f, club, club.MemberUserId, club.LeagueGroupId);
        var admin = Admin(f, club);

        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync(SellPath(club.MemberUserId),
            new { packageId = club.OneHour, reasonCode = "package_free", reason = "Welcome", quotedPriceZar = 0m, zarReceived = 0m })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync(SellPath(club.OtherUserId),
            new { packageId = club.FiveHours, reasonCode = "top_up_eft", reason = "EFT", quotedPriceZar = 550m, zarReceived = 549.5m })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"/api/v1/admin/minutes/{club.OtherUserId}/adjust",
            new { amountMinutes = 5, reasonCode = "goodwill", reason = "Lights" })).StatusCode);
        // The rival club's desk sells at the same moment, under a different code.
        Assert.Equal(HttpStatusCode.OK, (await Admin(f, rival).PostAsJsonAsync(SellPath(rival.MemberUserId),
            new { packageId = rival.FiveHours, reasonCode = "top_up_cash", reason = "Cash", quotedPriceZar = 550m })).StatusCode);

        var rows = (await JsonOf(await admin.GetAsync("/api/v1/admin/ledger"))).EnumerateArray().ToList();
        Assert.Equal(3, rows.Count);
        var given = Assert.Single(rows, r => r.GetProperty("subjectUserId").GetGuid() == club.MemberUserId);
        Assert.Equal("package_free", given.GetProperty("reason_code").GetString());
        Assert.Equal(0m, given.GetProperty("zar_paid").GetDecimal());
        var sold = Assert.Single(rows, r => r.GetProperty("type").GetString() == "AdminTopUp" && r.GetProperty("subjectUserId").GetGuid() == club.OtherUserId);
        Assert.Equal("top_up_eft", sold.GetProperty("reason_code").GetString());
        Assert.Equal(549.5m, sold.GetProperty("zar_paid").GetDecimal());
        var adjusted = Assert.Single(rows, r => r.GetProperty("type").GetString() == "AdminAdjustment");
        Assert.Equal("goodwill", adjusted.GetProperty("reason_code").GetString());
        Assert.Equal(JsonValueKind.Null, adjusted.GetProperty("zar_paid").ValueKind);
        Assert.DoesNotContain(rows, r => r.GetProperty("reason_code").GetString() == "top_up_cash");
    }
}
