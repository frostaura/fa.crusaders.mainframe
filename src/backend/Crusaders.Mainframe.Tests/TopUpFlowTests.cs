using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Payments;
using Crusaders.Mainframe.Api.Payments.PayFast;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using static Crusaders.Mainframe.Tests.PurchaseKit;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A member buying minutes (P13 §3.4, §4.4), end to end over real HTTP against real SQL: the
/// shelf, the purchase that hands the member to PayFast with a signed form, the purchase lock, and
/// the ITN that credits the LOCKED minutes and nothing else.
///
/// <para>
/// The lock is the money test. Everything a member is shown — the package, its minutes, the list
/// price, their discount and the price after it — is copied onto the <c>pending_topups</c> row
/// before the gateway is called, and the ITN reads that row and never the live package. An admin
/// editing the package, archiving it, or changing a group's discount while the member sits on
/// PayFast's card page changes nothing about what money already paid buys.
/// </para>
/// </summary>
public sealed class TopUpFlowTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static async Task<HttpResponseMessage> PostPurchaseAsync(HttpClient client, Guid packageId, decimal quoted)
        => await client.PostAsJsonAsync("/api/v1/minutes/purchase", new { packageId, quotedPriceZar = quoted });

    private static async Task<string> ErrorOf(HttpResponseMessage res)
        => (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString()!;

    // ---- the hand-off carries a signed form ---------------------------------

    /// <summary>
    /// The form is the payment: PayFast has no server-side registration, the browser POSTs this
    /// signed form. The amount is the locked price; the return and cancel URLs are the new
    /// <c>/wallet/buy/{id}</c> page; the item name is ASCII-hyphenated (§12.13).
    /// </summary>
    [SkippableFact]
    public async Task Buying_a_package_returns_the_signed_form_the_browser_must_post()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tu");
        var bought = await BuyAsync(Member(factory, club), club.FiveHours);

        var fields = bought.Body.GetProperty("form_fields").EnumerateArray()
            .Select(f => (Name: f.GetProperty("name").GetString()!, Value: f.GetProperty("value").GetString()!))
            .ToList();

        Assert.Contains(fields, f => f.Name == "merchant_id" && f.Value == MerchantId);
        Assert.Contains(fields, f => f.Name == "amount" && f.Value == "550.00");
        Assert.Contains(fields, f => f.Name == "m_payment_id" && f.Value == bought.CheckoutId);
        Assert.Contains(fields, f => f.Name == "item_name" && f.Value == "Crusaders - 5 hours (5 h)");
        Assert.EndsWith($"/wallet/buy/{bought.Id}", Assert.Single(fields, f => f.Name == "return_url").Value);
        Assert.EndsWith($"/wallet/buy/{bought.Id}?cancelled=1", Assert.Single(fields, f => f.Name == "cancel_url").Value);

        var package = bought.Body.GetProperty("package");
        Assert.Equal(club.FiveHours, package.GetProperty("id").GetGuid());
        Assert.Equal(300, package.GetProperty("minutes").GetInt32());
        Assert.Equal(550m, bought.AmountZar);

        var signature = Assert.Single(fields, f => f.Name == "signature").Value;
        Assert.True(PayFastSignature.Verify(
            fields.Where(f => f.Name != "signature").Select(f => new KeyValuePair<string, string?>(f.Name, f.Value)),
            Passphrase, signature));
    }

    // ---- §4.4: the purchase lock -----------------------------------------------

    /// <summary>
    /// <b>The money test</b> (§10.3, non-negotiable). The member buys 5 hours for R550; while they
    /// are on PayFast's card page an admin re-prices it, changes its minutes, or archives it. The
    /// ITN for R550 credits exactly the 300 minutes the member was sold.
    ///
    /// <para>
    /// Mutation check (§1.4): reading <c>minute_packages</c> in the callback instead of the locked
    /// row credits 600 minutes in the first row, refuses the R550 as a mismatch in the second, and
    /// cannot find the package in the third — each turns this red.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData("minutes")]
    [InlineData("price")]
    [InlineData("archive")]
    public async Task A_purchase_credits_the_locked_minutes_whatever_happens_to_the_package(string edit)
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tl");
        var member = Member(factory, club);
        var bought = await BuyAsync(member, club.FiveHours);

        await EditPackageAsync(factory, club.FiveHours, p =>
        {
            if (edit == "minutes") p.Minutes = 600;
            if (edit == "price") p.PriceZar = 400m;
            if (edit == "archive") p.Status = MinutePackageStatus.Archived;
        });

        var itn = await PostItnAsync(factory, club, bought.CheckoutId, "550.00");
        Assert.Equal(HttpStatusCode.OK, itn.StatusCode);
        var answer = await itn.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(300, answer.GetProperty("minutes").GetInt32());
        Assert.Equal(club.FiveHours, answer.GetProperty("package_id").GetGuid());

        var entry = Assert.Single(await LedgerAsync(factory, club, club.MemberUserId));
        Assert.Equal(300, entry.AmountMinutes);
        Assert.Equal(550m, entry.ZarPaid);
        Assert.Equal(LedgerEntryType.TopUp, entry.Type);
    }

    /// <summary>
    /// The DISCOUNT is locked too, with the group it came from. A league member is sold the club's
    /// 5 hours at 10% off (R495); the admin then moves the league to 50% while the member is
    /// paying. The row keeps 1000 bps, R550 list, R495 and the league group; the ITN for R495
    /// credits 300 minutes.
    /// </summary>
    [SkippableFact]
    public async Task A_group_discount_is_locked_at_checkout_with_the_group_it_came_from()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "td");
        await SetDiscountAsync(factory, club.LeagueGroupId, 1000);
        await JoinAsync(factory, club, club.MemberUserId, club.LeagueGroupId);
        var member = Member(factory, club);

        var bought = await BuyAsync(member, club.FiveHours);
        Assert.Equal(495m, bought.AmountZar);

        await SetDiscountAsync(factory, club.LeagueGroupId, 5000);

        var row = await RowAsync(factory, bought.Id);
        Assert.Equal((300, 550m, 1000, 495m), (row.Minutes, row.ListPriceZar, row.DiscountBps, row.AmountZar));
        Assert.Equal(club.LeagueGroupId, row.GroupId);
        Assert.Equal("5 hours", row.PackageName);

        // The live shelf has moved on; the purchase has not.
        Assert.Equal(275m, await PriceAsync(member, club.FiveHours));
        Assert.Equal(HttpStatusCode.OK, (await PostItnAsync(factory, club, bought.CheckoutId, "495.00")).StatusCode);
        Assert.Equal(300, Assert.Single(await LedgerAsync(factory, club, club.MemberUserId)).AmountMinutes);

        var status = await member.GetFromJsonAsync<JsonElement>($"/api/v1/minutes/purchase/{bought.Id}");
        Assert.Equal("Completed", status.GetProperty("status").GetString());
        Assert.Equal(1000, status.GetProperty("discount_bps").GetInt32());
        Assert.Equal(550m, status.GetProperty("list_price_zar").GetDecimal());
        Assert.Equal(495m, status.GetProperty("amount_zar").GetDecimal());
    }

    /// <summary>
    /// Several groups: the LOWEST discount any active group sets is the one quoted and locked,
    /// with that group named; a group with no say and an archived group take no part (§3.8).
    /// Mutation check (§1.4): "highest wins" locks 2500 and R412.50 instead.
    /// </summary>
    [SkippableFact]
    public async Task The_lowest_discount_among_the_members_active_groups_is_quoted_and_locked()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tw");
        await SetDiscountAsync(factory, club.LeagueGroupId, 1000);
        await JoinAsync(factory, club, club.MemberUserId, club.LeagueGroupId);
        await JoinAsync(factory, club, club.MemberUserId, name: "Students", discountBps: 2500);
        await JoinAsync(factory, club, club.MemberUserId, name: "Juniors", discountBps: null);
        await JoinAsync(factory, club, club.MemberUserId, name: "Old promo", discountBps: 500, status: MemberGroupStatus.Archived);
        var member = Member(factory, club);

        var shelf = await ShelfAsync(member);
        Assert.Equal(1000, shelf.GetProperty("discount").GetProperty("bps").GetInt32());
        Assert.Equal(club.LeagueGroupId, shelf.GetProperty("discount").GetProperty("group").GetProperty("id").GetGuid());

        var bought = await BuyAsync(member, club.FiveHours);
        var row = await RowAsync(factory, bought.Id);
        Assert.Equal(1000, row.DiscountBps);
        Assert.Equal(495m, row.AmountZar);
        Assert.Equal(club.LeagueGroupId, row.GroupId);
    }

    // ---- §3.4: the shelf --------------------------------------------------------

    /// <summary>
    /// Dean's answer 2 on the wire: a group member sees the group's own packages AND the club's,
    /// the club's at their discount; a package of a group they are not in is not on their shelf.
    /// The saving is the contract's own example. A member with no group sees no discount.
    /// </summary>
    [SkippableFact]
    public async Task The_shelf_shows_the_clubs_packages_at_the_members_discount_and_their_groups_own()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "ts");
        await SetDiscountAsync(factory, club.LeagueGroupId, 1000);
        await JoinAsync(factory, club, club.MemberUserId, club.LeagueGroupId);
        var leagueOnly = await AddPackageAsync(factory, club, "League night", 120, 150m, club.LeagueGroupId);
        var coaching = await JoinAsync(factory, club, club.OtherUserId, name: "Coaching", discountBps: null);
        await AddPackageAsync(factory, club, "Coaching block", 300, 400m, coaching);

        var shelf = await ShelfAsync(Member(factory, club));
        var discount = shelf.GetProperty("discount");
        Assert.Equal(1000, discount.GetProperty("bps").GetInt32());
        Assert.Equal("League members", discount.GetProperty("group").GetProperty("name").GetString());

        var items = shelf.GetProperty("packages").EnumerateArray().ToList();
        Assert.Equal(["1 hour", "5 hours", "10 hours", "League night"], items.Select(i => i.GetProperty("name").GetString()));
        var five = items[1];
        Assert.Equal(300, five.GetProperty("minutes").GetInt32());
        Assert.Equal(550m, five.GetProperty("list_price_zar").GetDecimal());
        Assert.Equal(1000, five.GetProperty("discount_bps").GetInt32());
        Assert.Equal(495m, five.GetProperty("price_zar").GetDecimal());
        Assert.Equal(45m, five.GetProperty("saving_zar").GetDecimal());
        Assert.Equal(8, five.GetProperty("saving_pct").GetInt32());
        Assert.Equal("club", five.GetProperty("source").GetString());
        Assert.Equal(JsonValueKind.Null, five.GetProperty("group").ValueKind);
        Assert.Equal(JsonValueKind.Null, items[0].GetProperty("saving_zar").ValueKind);

        var own = items[3];
        Assert.Equal(leagueOnly, own.GetProperty("id").GetGuid());
        Assert.Equal("group", own.GetProperty("source").GetString());
        Assert.Equal(0, own.GetProperty("discount_bps").GetInt32());
        Assert.Equal(150m, own.GetProperty("price_zar").GetDecimal());
        Assert.Equal(club.LeagueGroupId, own.GetProperty("group").GetProperty("id").GetGuid());
        Assert.Empty(shelf.GetProperty("open_checkouts").EnumerateArray());

        // The other member is in Coaching only: no discount, the club shelf at list, and Coaching's block.
        var other = await ShelfAsync(Client(factory, club, club.OtherUserId));
        Assert.Equal(JsonValueKind.Null, other.GetProperty("discount").ValueKind);
        Assert.Equal(["1 hour", "5 hours", "10 hours", "Coaching block"],
            other.GetProperty("packages").EnumerateArray().Select(i => i.GetProperty("name").GetString()));
        Assert.Equal(550m, other.GetProperty("packages")[1].GetProperty("price_zar").GetDecimal());
    }

    // ---- §3.4: refusals ---------------------------------------------------------

    /// <summary>
    /// The club moves the price under an open tab and the member is stopped and shown the new
    /// figure rather than sent to the gateway at it — both triggers: an admin editing the package,
    /// and an admin giving the member's group a discount. <b>No row is written.</b> Compared
    /// exactly, so R549.99 against R550 is a change.
    /// </summary>
    [SkippableTheory]
    [InlineData("package")]
    [InlineData("discount")]
    public async Task A_price_the_club_has_moved_away_from_is_refused_rather_than_silently_repriced(string trigger)
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tq");
        await JoinAsync(factory, club, club.MemberUserId, club.LeagueGroupId);
        var member = Member(factory, club);
        var quoted = await PriceAsync(member, club.FiveHours);
        Assert.Equal(550m, quoted);

        if (trigger == "package") await EditPackageAsync(factory, club.FiveHours, p => p.PriceZar = 549.99m);
        else await SetDiscountAsync(factory, club.LeagueGroupId, 1000);

        var res = await PostPurchaseAsync(member, club.FiveHours, quoted);

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("package_price_changed", body.GetProperty("error").GetString());
        Assert.Equal(trigger == "package" ? 549.99m : 495m, body.GetProperty("package").GetProperty("price_zar").GetDecimal());
        Assert.Equal(300, body.GetProperty("package").GetProperty("minutes").GetInt32());
        Assert.Empty(await ReadAsync(factory, db => db.PendingTopups.IgnoreQueryFilters()
            .Where(x => x.UserId == club.MemberUserId).ToListAsync()));
    }

    [SkippableFact]
    public async Task A_purchase_missing_its_package_or_its_quote_is_refused_by_name()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tm");
        var member = Member(factory, club);

        var noPackage = await member.PostAsJsonAsync("/api/v1/minutes/purchase", new { quotedPriceZar = 120m });
        Assert.Equal(HttpStatusCode.BadRequest, noPackage.StatusCode);
        Assert.Equal("package_id_required", await ErrorOf(noPackage));

        var noQuote = await member.PostAsJsonAsync("/api/v1/minutes/purchase", new { packageId = club.OneHour });
        Assert.Equal(HttpStatusCode.BadRequest, noQuote.StatusCode);
        Assert.Equal("quoted_price_required", await ErrorOf(noQuote));
    }

    /// <summary>
    /// <c>package_unavailable</c> for everything not on THIS member's shelf now: an archived
    /// package, another group's package, a package of a group that has since been archived, and
    /// <b>another club's package</b> (cross-tenant injection, §10.3) — the last two leave no row.
    /// </summary>
    [SkippableFact]
    public async Task A_package_not_on_the_members_shelf_is_unavailable_including_another_clubs()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tx");
        var rival = await SeedAsync(factory, "txr");
        var member = Member(factory, club);

        var coaching = await JoinAsync(factory, club, club.OtherUserId, name: "Coaching", discountBps: null);
        var coachingOnly = await AddPackageAsync(factory, club, "Coaching block", 300, 400m, coaching);
        var archivedPackage = await AddPackageAsync(factory, club, "Old", 30, 50m);
        await EditPackageAsync(factory, archivedPackage, p => p.Status = MinutePackageStatus.Archived);
        var dormant = await JoinAsync(factory, club, club.MemberUserId, name: "Dormant", discountBps: null);
        var dormantOnly = await AddPackageAsync(factory, club, "Dormant block", 60, 90m, dormant);
        await WriteAsync(factory, async db => (await db.MemberGroups.IgnoreQueryFilters().SingleAsync(g => g.Id == dormant)).Status = MemberGroupStatus.Archived);

        foreach (var (id, price) in new[] { (archivedPackage, 50m), (coachingOnly, 400m), (dormantOnly, 90m), (rival.FiveHours, 550m) })
        {
            var res = await PostPurchaseAsync(member, id, price);
            Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
            Assert.Equal("package_unavailable", await ErrorOf(res));
        }

        Assert.Empty(await ReadAsync(factory, db => db.PendingTopups.IgnoreQueryFilters()
            .Where(x => x.UserId == club.MemberUserId || x.TenantId == rival.TenantId).ToListAsync()));
    }

    /// <summary>A purchase or its cancel addressed to another member's — or another club's — row is a stranger's: 404.</summary>
    [SkippableFact]
    public async Task Another_members_or_another_clubs_purchase_is_not_found()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "ty");
        var rival = await SeedAsync(factory, "tyr");
        var theirs = await BuyAsync(Member(factory, rival), rival.OneHour);
        var neighbours = await BuyAsync(Client(factory, club, club.OtherUserId), club.OneHour);
        var member = Member(factory, club);

        foreach (var id in new[] { theirs.Id, neighbours.Id })
        {
            Assert.Equal(HttpStatusCode.NotFound, (await member.GetAsync($"/api/v1/minutes/purchase/{id}")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await member.PostAsync($"/api/v1/minutes/purchase/{id}/cancel", null)).StatusCode);
        }
        Assert.Equal(TopUpStatus.Pending, (await RowAsync(factory, theirs.Id)).Status);
        Assert.Equal(TopUpStatus.Pending, (await RowAsync(factory, neighbours.Id)).Status);
    }

    /// <summary>A 100% discount makes a package free, which PayFast cannot take; the desk can sell it (§3.7).</summary>
    [SkippableFact]
    public async Task A_package_free_after_the_discount_cannot_go_to_the_gateway()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tz");
        await SetDiscountAsync(factory, club.LeagueGroupId, 10_000);
        await JoinAsync(factory, club, club.MemberUserId, club.LeagueGroupId);

        var res = await PostPurchaseAsync(Member(factory, club), club.OneHour, 0m);
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("package_price_zero", await ErrorOf(res));
    }

    [SkippableFact]
    public async Task A_club_without_payment_settings_answers_503_and_writes_nothing()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tn", payments: false);

        var res = await PostPurchaseAsync(Member(factory, club), club.OneHour, 120m);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, res.StatusCode);
        Assert.Equal("payments_not_configured", await ErrorOf(res));
        Assert.Empty(await ReadAsync(factory, db => db.PendingTopups.IgnoreQueryFilters().Where(x => x.TenantId == club.TenantId).ToListAsync()));
    }

    /// <summary>The retired amount-based routes are gone with the cap and the rate (§3.1); only the ITN keeps its path.</summary>
    [SkippableFact]
    public async Task The_retired_top_up_routes_are_gone()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tg");
        var member = Member(factory, club);

        Assert.Equal(HttpStatusCode.NotFound, (await member.GetAsync("/api/v1/credit/topup/options")).StatusCode);
        Assert.NotEqual(HttpStatusCode.OK, (await member.PostAsJsonAsync("/api/v1/credit/topup", new { amountZar = 100m })).StatusCode);
    }

    // ---- the ITN ------------------------------------------------------------------

    /// <summary>
    /// The amount PayFast reports must be the LOCKED price (§4.4, §10.3): R100 against a R550
    /// purchase is refused, the row fails with a code — never an internal string — and nothing is
    /// credited. Mutation check: comparing against the list price or not at all goes red.
    /// </summary>
    [SkippableTheory]
    [InlineData("100.00")]
    [InlineData("550.01")]
    public async Task An_amount_mismatch_is_refused_and_surfaces_a_code(string gross)
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "ta");
        var member = Member(factory, club);
        var bought = await BuyAsync(member, club.FiveHours);

        var itn = await PostItnAsync(factory, club, bought.CheckoutId, gross);
        Assert.Equal(HttpStatusCode.BadRequest, itn.StatusCode);
        Assert.Equal("amount_mismatch", await ErrorOf(itn));

        var status = await member.GetFromJsonAsync<JsonElement>($"/api/v1/minutes/purchase/{bought.Id}");
        Assert.Equal("Failed", status.GetProperty("status").GetString());
        Assert.Equal("amount_mismatch", status.GetProperty("failure_code").GetString());
        Assert.DoesNotContain("reported=", status.GetRawText());
        Assert.Empty(await LedgerAsync(factory, club, club.MemberUserId));
    }

    /// <summary>A discounted purchase is paid at the discounted price: the list price is a mismatch.</summary>
    [SkippableFact]
    public async Task A_discounted_purchase_paid_at_the_list_price_is_a_mismatch()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tb");
        await SetDiscountAsync(factory, club.LeagueGroupId, 1000);
        await JoinAsync(factory, club, club.MemberUserId, club.LeagueGroupId);
        var bought = await BuyAsync(Member(factory, club), club.FiveHours);

        Assert.Equal(HttpStatusCode.BadRequest, (await PostItnAsync(factory, club, bought.CheckoutId, "550.00")).StatusCode);
        Assert.Empty(await LedgerAsync(factory, club, club.MemberUserId));
    }

    /// <summary>The ledger reason names the package, the minutes in words and the rand, in the club's own symbol.</summary>
    [SkippableFact]
    public async Task A_completed_purchase_posts_one_top_up_row_with_the_package_in_its_reason()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tr");
        var bought = await BuyAsync(Member(factory, club), club.TenHours);

        Assert.Equal(HttpStatusCode.OK, (await PostItnAsync(factory, club, bought.CheckoutId, "1000.00", "8800001")).StatusCode);

        var entry = Assert.Single(await LedgerAsync(factory, club, club.MemberUserId));
        Assert.Equal("PayFast purchase: 10 hours for R1000.00", entry.Reason);   // R7: a package named by its minutes says them once
        Assert.Equal($"topup:{club.TenantId:N}:8800001", entry.ExternalReference);
        Assert.Equal(600, entry.AmountMinutes);
        Assert.DoesNotContain("credit", entry.Reason, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// <c>minutes.purchased</c> (§5) carries every figure from the locked row — the package, its
    /// minutes, the list price, the discount and its group, and what was paid.
    /// </summary>
    [Fact]
    public void The_minutes_purchased_payload_is_the_locked_row()
    {
        var group = Guid.NewGuid();
        var row = new PendingTopup
        {
            IdempotencyKey = "tu_x",
            PackageId = Guid.NewGuid(),
            PackageName = "5 hours",
            Minutes = 300,
            ListPriceZar = 550m,
            DiscountBps = 1000,
            GroupId = group,
            AmountZar = 495m,
        };
        var groups = new List<Dictionary<string, object?>> { new() { ["id"] = group, ["name"] = "League", ["system_key"] = "league" } };

        var data = TopUpEndpoints.PurchasedData(row, groups, "pf123");

        Assert.Equal(row.Id, data["purchase_id"]);
        Assert.Equal(row.PackageId, data["package_id"]);
        Assert.Equal("5 hours", data["package_name"]);
        Assert.Equal(300, data["minutes"]);
        Assert.Equal(550m, data["list_price_zar"]);
        Assert.Equal(1000, data["discount_bps"]);
        Assert.Equal(495m, data["zar_paid"]);
        Assert.Equal(group, data["discount_group_id"]);
        Assert.Same(groups, data["groups"]);
        Assert.Equal("pf123", data["external_reference"]);
        Assert.False(data.ContainsKey("conversion_rate"));
        Assert.False(data.ContainsKey("member_class"));
        Assert.False(data.ContainsKey("credits"));
    }

    [SkippableFact]
    public async Task A_cancelled_payment_is_cancelled_rather_than_failed()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tc");
        var member = Member(factory, club);
        var bought = await BuyAsync(member, club.OneHour);

        await PostItnAsync(factory, club, bought.CheckoutId, "120.00", status: "CANCELLED");

        var status = await member.GetFromJsonAsync<JsonElement>($"/api/v1/minutes/purchase/{bought.Id}");
        Assert.Equal("Cancelled", status.GetProperty("status").GetString());
        Assert.Equal("cancelled", status.GetProperty("failure_code").GetString());
    }

    // ---- the mails ----------------------------------------------------------------

    private static WebApplicationFactory<Program> WithMail(TestWebAppFactory factory, StubEmailService mail)
        => factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEmailService>();
            s.AddSingleton<IEmailService>(mail);
        }));

    /// <summary>The ITN dispatches mail in the background, so it may land after the response.</summary>
    private static async Task<EmailMessage?> PollMailAsync(StubEmailService mail)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            var found = mail.Sent.FirstOrDefault();
            if (found is not null) return found;
            await Task.Delay(25);
        }
        return null;
    }

    /// <summary>
    /// <c>feature-spec.md</c> §11: every player-affecting event sends an email, and a purchase that
    /// ends without minutes is the one outcome of handing over card details that once sent nothing.
    /// </summary>
    [SkippableFact]
    public async Task A_declined_payment_emails_the_member_that_nothing_was_charged()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "te");
        var bought = await BuyAsync(Member(factory, club), club.FiveHours);

        var mail = new StubEmailService();
        await using var quiet = WithMail(factory, mail);
        await quiet.CreateClient().PostAsync($"{CallbackPath}?tenant={club.Slug}", Itn(bought.CheckoutId, "550.00", status: "FAILED"));

        var notice = await PollMailAsync(mail);
        Assert.NotNull(notice);
        Assert.Equal(club.MemberEmail, notice!.To);
        Assert.Contains("5 hours", notice.Subject, StringComparison.Ordinal);
        Assert.Contains("R550.00", notice.HtmlBody, StringComparison.Ordinal);
        Assert.Contains("declined the payment", notice.HtmlBody, StringComparison.Ordinal);
        Assert.Contains("nothing was charged", notice.HtmlBody, StringComparison.Ordinal);
        Assert.DoesNotContain("amount_mismatch", notice.HtmlBody, StringComparison.Ordinal);
        Assert.DoesNotContain("gateway_error", notice.HtmlBody, StringComparison.Ordinal);
    }

    [SkippableFact]
    public async Task A_cancelled_payment_emails_the_member_without_calling_it_a_failure()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tf");
        var bought = await BuyAsync(Member(factory, club), club.OneHour);

        var mail = new StubEmailService();
        await using var quiet = WithMail(factory, mail);
        await quiet.CreateClient().PostAsync($"{CallbackPath}?tenant={club.Slug}", Itn(bought.CheckoutId, "120.00", status: "CANCELLED"));

        var notice = await PollMailAsync(mail);
        Assert.NotNull(notice);
        Assert.Contains("cancelled", notice!.Subject, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("failed", notice.Subject, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("You cancelled this payment", notice.HtmlBody, StringComparison.Ordinal);
    }

    /// <summary>The one failure where money may genuinely have moved: the member is told what to send the club.</summary>
    [SkippableFact]
    public async Task An_amount_mismatch_emails_the_member_with_the_reference_to_quote()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "th");
        var bought = await BuyAsync(Member(factory, club), club.FiveHours);

        var mail = new StubEmailService();
        await using var quiet = WithMail(factory, mail);
        var itn = await quiet.CreateClient().PostAsync($"{CallbackPath}?tenant={club.Slug}", Itn(bought.CheckoutId, "100.00"));
        Assert.Equal(HttpStatusCode.BadRequest, itn.StatusCode);

        var notice = await PollMailAsync(mail);
        Assert.NotNull(notice);
        Assert.Contains("R550.00", notice!.HtmlBody, StringComparison.Ordinal);
        Assert.Contains("send the club the reference below", notice.HtmlBody, StringComparison.Ordinal);
        Assert.Contains(bought.CheckoutId, notice.HtmlBody, StringComparison.Ordinal);
        Assert.DoesNotContain("reported=", notice.HtmlBody, StringComparison.Ordinal);
    }

    /// <summary>A completed purchase mails the receipt: the package, the minutes, the list price, the discount and the reference.</summary>
    [SkippableFact]
    public async Task A_completed_purchase_emails_the_package_receipt()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tk");
        await SetDiscountAsync(factory, club.LeagueGroupId, 1000);
        await JoinAsync(factory, club, club.MemberUserId, club.LeagueGroupId);
        var bought = await BuyAsync(Member(factory, club), club.FiveHours);

        var mail = new StubEmailService();
        await using var quiet = WithMail(factory, mail);
        Assert.Equal(HttpStatusCode.OK, (await quiet.CreateClient().PostAsync(
            $"{CallbackPath}?tenant={club.Slug}", Itn(bought.CheckoutId, "495.00", "9900001"))).StatusCode);

        var receipt = await PollMailAsync(mail);
        Assert.NotNull(receipt);
        Assert.Equal(club.MemberEmail, receipt!.To);
        Assert.Contains("5 hours", receipt.Subject, StringComparison.Ordinal);
        Assert.Contains("R495.00", receipt.HtmlBody, StringComparison.Ordinal);
        Assert.Contains("R550.00", receipt.HtmlBody, StringComparison.Ordinal);
        Assert.Contains("League members", receipt.HtmlBody, StringComparison.Ordinal);
        Assert.Contains("9900001", receipt.HtmlBody, StringComparison.Ordinal);
        Assert.DoesNotContain("credit", receipt.HtmlBody, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>PayFast retries an ITN until it is acknowledged. One failure, one email.</summary>
    [SkippableFact]
    public async Task A_retried_notification_does_not_email_the_member_twice()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "ti");
        var bought = await BuyAsync(Member(factory, club), club.OneHour);

        var mail = new StubEmailService();
        await using var quiet = WithMail(factory, mail);
        var itnClient = quiet.CreateClient();
        await itnClient.PostAsync($"{CallbackPath}?tenant={club.Slug}", Itn(bought.CheckoutId, "120.00", status: "FAILED"));
        Assert.NotNull(await PollMailAsync(mail));
        await itnClient.PostAsync($"{CallbackPath}?tenant={club.Slug}", Itn(bought.CheckoutId, "120.00", status: "FAILED"));

        await Task.Delay(500);
        Assert.Single(mail.Sent);
    }

    // ---- R23: the failures the club has to look at reach its admins ---------

    private static async Task<List<AdminNotification>> NoticesAsync(TestWebAppFactory factory, Guid tenantId)
        => await ReadAsync(factory, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == tenantId && n.Kind == AdminEventCatalogue.TopUpFailed).ToListAsync());

    [SkippableFact]
    public async Task An_amount_mismatch_raises_one_admin_notice_however_often_it_is_retried()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tn1");
        var bought = await BuyAsync(Member(factory, club), club.FiveHours);

        for (var i = 0; i < 3; i++) await PostItnAsync(factory, club, bought.CheckoutId, "100.00");

        var notice = Assert.Single(await NoticesAsync(factory, club.TenantId));
        var payload = JsonSerializer.Deserialize<TopUpFailedPayload>(notice.PayloadJson, AdminEventCatalogue.Json)!;
        Assert.Equal("amount_mismatch", payload.Reason);
        Assert.Equal(550m, payload.AmountZar);
        Assert.Equal("Naledi Khoza", payload.MemberName);
        // P13 §5: the notice names the package and its minutes.
        Assert.Equal("5 hours", payload.PackageName);
        Assert.Equal(300, payload.Minutes);
    }

    [SkippableTheory]
    [InlineData("FAILED")]
    [InlineData("CANCELLED")]
    public async Task A_decline_or_a_cancellation_raises_no_admin_notice(string status)
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tn2");
        var bought = await BuyAsync(Member(factory, club), club.OneHour);

        Assert.Equal(HttpStatusCode.OK, (await PostItnAsync(factory, club, bought.CheckoutId, "120.00", status: status)).StatusCode);
        Assert.Empty(await NoticesAsync(factory, club.TenantId));
    }

    [SkippableFact]
    public async Task An_unrecognised_gateway_answer_raises_an_admin_notice()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tn3");
        var bought = await BuyAsync(Member(factory, club), club.OneHour);

        await PostItnAsync(factory, club, bought.CheckoutId, "120.00", status: "SOMETHING_ELSE");

        var notice = Assert.Single(await NoticesAsync(factory, club.TenantId));
        Assert.Equal("topup.failed:gateway_error:" + bought.Id.ToString("N"), notice.DedupeKey);
    }

    /// <summary>The ITN route is anonymous: a flood of unsigned notifications is one notice a day.</summary>
    [SkippableFact]
    public async Task Unsigned_notifications_raise_at_most_one_notice_a_day()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tn4");

        for (var i = 0; i < 4; i++)
        {
            var forged = await factory.CreateClient().PostAsync(
                $"{CallbackPath}?tenant={club.Slug}",
                new StringContent("m_payment_id=tu_x&payment_status=COMPLETE&amount_gross=100.00&signature=forged",
                    System.Text.Encoding.UTF8, "application/x-www-form-urlencoded"));
            Assert.Equal(HttpStatusCode.Unauthorized, forged.StatusCode);
        }

        var notice = Assert.Single(await NoticesAsync(factory, club.TenantId));
        Assert.Equal("topup.failed:signature_invalid:" + DateTimeOffset.UtcNow.ToString("yyyyMMdd", System.Globalization.CultureInfo.InvariantCulture),
            notice.DedupeKey);
    }

    [Fact]
    public void An_unsigned_notifications_identity_is_its_utc_day()
    {
        var morning = new DateTimeOffset(2026, 9, 23, 1, 5, 0, TimeSpan.Zero);
        Assert.Equal(TopUpAlerts.DayOf(morning), TopUpAlerts.DayOf(morning.AddHours(20)));
        Assert.NotEqual(TopUpAlerts.DayOf(morning), TopUpAlerts.DayOf(morning.AddDays(1)));
    }

    /// <summary>A COMPLETE with no payment reference is refused and the desk is told; the row stays open and the member is not mailed.</summary>
    [SkippableFact]
    public async Task A_payment_with_no_reference_raises_an_admin_notice_and_leaves_the_purchase_open()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tn5");
        var mail = new StubEmailService();
        await using var app = WithMail(factory, mail);
        var bought = await BuyAsync(Member(factory, club), club.OneHour);

        var itn = await app.CreateClient().PostAsync($"{CallbackPath}?tenant={club.Slug}", Itn(bought.CheckoutId, "120.00", pfPaymentId: ""));
        Assert.Equal(HttpStatusCode.BadRequest, itn.StatusCode);

        var notice = Assert.Single(await NoticesAsync(factory, club.TenantId));
        Assert.Equal($"topup.failed:payment_id_missing:{bought.Id:N}", notice.DedupeKey);
        var payload = JsonSerializer.Deserialize<TopUpFailedPayload>(notice.PayloadJson, AdminEventCatalogue.Json)!;
        Assert.Equal(120m, payload.AmountZar);
        Assert.Equal("Naledi Khoza", payload.MemberName);
        Assert.Equal(TopUpStatus.Pending, (await RowAsync(factory, bought.Id)).Status);
        Assert.Null(await PollMailAsync(mail));
    }

    /// <summary>A gateway that will not even start a checkout for a member.</summary>
    private sealed class RefusingProvider(IPaymentProvider real) : IPaymentProvider
    {
        public string ProviderName => real.ProviderName;

        public Task<RegisterCheckoutResult> RegisterCheckoutAsync(RegisterCheckoutRequest req, CancellationToken ct) =>
            Task.FromResult(new RegisterCheckoutResult(false, null, null, "merchant_suspended"));

        public Task<CallbackInterpretation> InterpretCallbackAsync(CallbackPayload payload, CancellationToken ct) =>
            real.InterpretCallbackAsync(payload, ct);

        public Task<PaymentStatusSnapshot> GetStatusAsync(string checkoutId, PerTenantCredentials creds, CancellationToken ct) =>
            real.GetStatusAsync(checkoutId, creds, ct);
    }

    [SkippableFact]
    public async Task A_checkout_the_gateway_refuses_to_start_raises_an_admin_notice()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = CreateFactory();
        var club = await SeedAsync(factory, "tn6");
        await using var app = factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IPaymentProvider>();
            s.AddScoped<PayFastProvider>();
            s.AddScoped<IPaymentProvider>(sp => new RefusingProvider(sp.GetRequiredService<PayFastProvider>()));
        }));

        var res = await PostPurchaseAsync(Member(app, club), club.OneHour, 120m);
        Assert.Equal((HttpStatusCode)502, res.StatusCode);

        var notice = Assert.Single(await NoticesAsync(factory, club.TenantId));
        var payload = JsonSerializer.Deserialize<TopUpFailedPayload>(notice.PayloadJson, AdminEventCatalogue.Json)!;
        Assert.Equal("provider_register_failed", payload.Reason);
        Assert.Equal(120m, payload.AmountZar);
        Assert.StartsWith("topup.failed:provider_register_failed:", notice.DedupeKey, StringComparison.Ordinal);
    }
}
