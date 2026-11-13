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
/// Money lane BM-6: rand given back for a purchase — a refund the club made, or a chargeback it
/// recorded — posts a <c>PaymentReversal</c> naming the purchase, and the revenue report nets it.
/// Before, no code path posted one: the desk's <c>refund_outside_system</c> moved minutes only and
/// Revenue kept every refunded sale.
/// </summary>
public sealed class PaymentReversalHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static string ReversePath(Guid userId) => $"/api/v1/admin/minutes/{userId}/reverse-payment";

    private static string ReversiblePath(Guid userId) => $"/api/v1/admin/minutes/{userId}/reversible";

    private static async Task<JsonElement> JsonOf(HttpResponseMessage res) => await res.Content.ReadFromJsonAsync<JsonElement>();

    /// <summary>A desk sale of the 5-hour package for the stated rand; returns its ledger row id.</summary>
    private static async Task<Guid> SellAsync(HttpClient admin, PurchaseClub club, Guid userId, decimal zar)
    {
        var sold = await admin.PostAsJsonAsync($"/api/v1/admin/minutes/{userId}/sell",
            new { packageId = club.FiveHours, reasonCode = "top_up_eft", reason = "EFT", quotedPriceZar = 550m, zarReceived = zar });
        Assert.Equal(HttpStatusCode.OK, sold.StatusCode);
        return (await JsonOf(sold)).GetProperty("entry_id").GetGuid();
    }

    private static object Body(Guid entry, string kind, decimal zar, int minutes, string key) =>
        new { entry_id = entry, kind, zar_reversed = zar, minutes_taken_back = minutes, reason = "Member moved away", idempotency_key = key };

    private static async Task<JsonElement> RevenueAsync(HttpClient admin)
    {
        var from = DateTimeOffset.UtcNow.AddDays(-2).ToString("O");
        var to = DateTimeOffset.UtcNow.AddDays(2).ToString("O");
        return await admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/reports/revenue?from={Uri.EscapeDataString(from)}&to={Uri.EscapeDataString(to)}");
    }

    [SkippableFact]
    public async Task A_refund_posts_a_reversal_naming_the_purchase_and_revenue_nets_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        var mail = new StubEmailService();
        await using var f = WithMail(pg.SharedHost, mail);
        var club = await SeedAsync(f, "rv");
        var admin = Admin(f, club);
        var sale = await SellAsync(admin, club, club.MemberUserId, 550m);
        Assert.Equal(550m, (await RevenueAsync(admin)).GetProperty("net_zar").GetDecimal());

        var res = await admin.PostAsJsonAsync(ReversePath(club.MemberUserId), Body(sale, "refund", 550m, 300, "rv-1"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await JsonOf(res);
        Assert.Equal(-300, body.GetProperty("amount_minutes").GetInt32());
        Assert.Equal(550m, body.GetProperty("zar_reversed").GetDecimal());
        Assert.Equal(0m, body.GetProperty("zar_left").GetDecimal());
        Assert.Equal(0, body.GetProperty("minutes_left").GetInt32());
        Assert.Equal((300, 0), (body.GetProperty("balance_before_minutes").GetInt32(), body.GetProperty("balance_after_minutes").GetInt32()));

        var reversal = Assert.Single(await LedgerAsync(f, club, club.MemberUserId), l => l.Type == LedgerEntryType.PaymentReversal);
        Assert.Equal((-300, -550m, sale), (reversal.AmountMinutes, reversal.ZarPaid, reversal.ReversesEntryId!.Value));
        Assert.StartsWith("Refund of R550.00 for ", reversal.Reason);

        var revenue = await RevenueAsync(admin);
        Assert.Equal(550m, revenue.GetProperty("gross_topups_zar").GetDecimal());
        Assert.Equal(-550m, revenue.GetProperty("reversals_zar").GetDecimal());
        Assert.Equal(0m, revenue.GetProperty("net_zar").GetDecimal());
        Assert.Equal(0, revenue.GetProperty("net_minutes").GetInt32());

        var change = await ReadAsync(f, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .SingleAsync(c => c.TenantId == club.TenantId && c.Action == "credit.payment_reversed"));
        Assert.Equal("Member moved away", change.Reason);

        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline && !mail.Sent.Any(m => m.Subject.StartsWith("Refund of", StringComparison.Ordinal))) await Task.Delay(25);
        var told = Assert.Single(mail.Sent, m => m.Subject.StartsWith("Refund of", StringComparison.Ordinal));
        Assert.Equal(club.MemberEmail, told.To);
        Assert.DoesNotContain("credit", told.Subject, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// A refund that takes back NO minutes (the member keeps them) still nets the rand — its sign cannot
    /// come from its minutes, which is how the report used to sign rand. Partial reversals add up to the
    /// purchase and no further, whatever mix of rand and minutes; the fixture varies both.
    /// </summary>
    [SkippableFact]
    public async Task Partial_reversals_add_up_to_the_purchase_and_no_further()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "rvp");
        var admin = Admin(f, club);
        var sale = await SellAsync(admin, club, club.MemberUserId, 500m);

        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync(ReversePath(club.MemberUserId), Body(sale, "refund", 50m, 0, "p-1"))).StatusCode);
        Assert.Equal(450m, (await RevenueAsync(admin)).GetProperty("net_zar").GetDecimal());

        var tooMuch = await admin.PostAsJsonAsync(ReversePath(club.MemberUserId), Body(sale, "chargeback", 450.01m, 0, "p-2"));
        Assert.Equal(HttpStatusCode.Conflict, tooMuch.StatusCode);
        var refusal = await JsonOf(tooMuch);
        Assert.Equal("reversal_exceeds_payment", refusal.GetProperty("error").GetString());
        Assert.Equal(450m, refusal.GetProperty("zar_left").GetDecimal());
        Assert.Equal(300, refusal.GetProperty("minutes_left").GetInt32());

        var tooManyMinutes = await admin.PostAsJsonAsync(ReversePath(club.MemberUserId), Body(sale, "chargeback", 1m, 301, "p-3"));
        Assert.Equal("reversal_exceeds_payment", (await JsonOf(tooManyMinutes)).GetProperty("error").GetString());

        var rest = await admin.PostAsJsonAsync(ReversePath(club.MemberUserId), Body(sale, "chargeback", 450m, 300, "p-4"));
        Assert.Equal(HttpStatusCode.OK, rest.StatusCode);
        Assert.Equal(0m, (await RevenueAsync(admin)).GetProperty("net_zar").GetDecimal());

        var listed = (await admin.GetFromJsonAsync<JsonElement>(ReversiblePath(club.MemberUserId))).GetProperty("entries").EnumerateArray().Single();
        Assert.Equal((0m, 0, 500m), (listed.GetProperty("zar_left").GetDecimal(), listed.GetProperty("minutes_left").GetInt32(), listed.GetProperty("zar_reversed").GetDecimal()));
        Assert.Equal(2, (await LedgerAsync(f, club, club.MemberUserId)).Count(l => l.Type == LedgerEntryType.PaymentReversal));
    }

    /// <summary>Two desks reversing one purchase at once cannot both fit under its rand: the limit is read under the payer lock.</summary>
    [SkippableFact]
    public async Task Concurrent_reversals_of_one_purchase_never_give_back_more_than_it_took()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "rvc");
        var admin = Admin(f, club);
        var sale = await SellAsync(admin, club, club.MemberUserId, 550m);

        var attempts = await Task.WhenAll(Enumerable.Range(0, 6).Select(i =>
            Admin(f, club).PostAsJsonAsync(ReversePath(club.MemberUserId), Body(sale, "refund", 200m, 0, $"c-{i}"))));
        Assert.Equal(2, attempts.Count(a => a.StatusCode == HttpStatusCode.OK));
        Assert.All(attempts.Where(a => a.StatusCode != HttpStatusCode.OK), a => Assert.Equal(HttpStatusCode.Conflict, a.StatusCode));
        var total = (await LedgerAsync(f, club, club.MemberUserId)).Where(l => l.Type == LedgerEntryType.PaymentReversal).Sum(l => l.ZarPaid!.Value);
        Assert.Equal(-400m, total);
    }

    /// <summary>The same key replays the reversal it posted; the same key with another figure is refused, and nothing moves twice.</summary>
    [SkippableFact]
    public async Task A_reversal_is_idempotent_on_the_desks_key()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "rvi");
        var admin = Admin(f, club);
        var sale = await SellAsync(admin, club, club.MemberUserId, 550m);

        var first = await JsonOf(await admin.PostAsJsonAsync(ReversePath(club.MemberUserId), Body(sale, "refund", 100m, 60, "i-1")));
        var again = await admin.PostAsJsonAsync(ReversePath(club.MemberUserId), Body(sale, "refund", 100m, 60, "i-1"));
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        var replayed = await JsonOf(again);
        Assert.Equal(first.GetProperty("entry_id").GetGuid(), replayed.GetProperty("entry_id").GetGuid());
        Assert.Equal(240, replayed.GetProperty("balance_after_minutes").GetInt32());

        var changed = await admin.PostAsJsonAsync(ReversePath(club.MemberUserId), Body(sale, "refund", 120m, 60, "i-1"));
        Assert.Equal(HttpStatusCode.Conflict, changed.StatusCode);
        Assert.Equal("idempotency_key_reused", (await JsonOf(changed)).GetProperty("error").GetString());
        Assert.Single(await LedgerAsync(f, club, club.MemberUserId), l => l.Type == LedgerEntryType.PaymentReversal);
    }

    /// <summary>What may be reversed: a funding row of this member's that took rand. Everything else is refused by name.</summary>
    [SkippableFact]
    public async Task Only_a_paid_funding_row_of_this_member_can_be_reversed()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "rvr");
        var admin = Admin(f, club);
        var sale = await SellAsync(admin, club, club.MemberUserId, 550m);
        var given = await SellAsync(admin, club, club.OtherUserId, 0m);

        Assert.Equal(HttpStatusCode.NotFound, (await admin.PostAsJsonAsync(ReversePath(club.OtherUserId), Body(sale, "refund", 10m, 0, "r-1"))).StatusCode);
        var free = await admin.PostAsJsonAsync(ReversePath(club.OtherUserId), Body(given, "refund", 10m, 0, "r-2"));
        Assert.Equal("entry_not_reversible", (await JsonOf(free)).GetProperty("error").GetString());

        foreach (var (bad, code) in new (object Body, string Code)[]
        {
            (new { entry_id = sale, kind = "goodwill", zar_reversed = 10m, minutes_taken_back = 0, reason = "x", idempotency_key = "b1" }, "kind_invalid"),
            (new { entry_id = sale, kind = "refund", zar_reversed = 0m, minutes_taken_back = 0, reason = "x", idempotency_key = "b2" }, "zar_reversed_out_of_range"),
            (new { entry_id = sale, kind = "refund", zar_reversed = 1.005m, minutes_taken_back = 0, reason = "x", idempotency_key = "b3" }, "zar_reversed_not_whole_cents"),
            (new { entry_id = sale, kind = "refund", zar_reversed = 10m, minutes_taken_back = -1, reason = "x", idempotency_key = "b4" }, "minutes_out_of_range"),
            (new { entry_id = sale, kind = "refund", zar_reversed = 10m, minutes_taken_back = 0, reason = " ", idempotency_key = "b5" }, "reason_required"),
            (new { entry_id = sale, kind = "refund", zar_reversed = 10m, minutes_taken_back = 0, reason = "x" }, "idempotency_key_required"),
        })
        {
            var res = await admin.PostAsJsonAsync(ReversePath(club.MemberUserId), bad);
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
            Assert.Equal(code, (await JsonOf(res)).GetProperty("error").GetString());
        }
        Assert.DoesNotContain(await LedgerAsync(f, club, club.MemberUserId), l => l.Type == LedgerEntryType.PaymentReversal);

        // A member cannot reach the route at all.
        Assert.Equal(HttpStatusCode.Forbidden, (await Member(f, club).PostAsJsonAsync(ReversePath(club.MemberUserId), Body(sale, "refund", 10m, 0, "r-3"))).StatusCode);
    }

    /// <summary>Cross-tenant injection (CLAUDE.md): another club's admin cannot reverse, or even see, this club's purchase.</summary>
    [SkippableFact]
    public async Task Another_clubs_admin_cannot_reverse_or_list_this_clubs_purchase()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await SeedAsync(f, "rvx");
        var rival = await SeedAsync(f, "rvx2");
        var sale = await SellAsync(Admin(f, club), club, club.MemberUserId, 550m);
        var rivalSale = await SellAsync(Admin(f, rival), rival, rival.MemberUserId, 550m);
        var intruder = Admin(f, rival);

        Assert.Equal(HttpStatusCode.NotFound, (await intruder.PostAsJsonAsync(ReversePath(club.MemberUserId), Body(sale, "refund", 10m, 0, "x-1"))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await intruder.GetAsync(ReversiblePath(club.MemberUserId))).StatusCode);
        // The rival's own member, naming this club's purchase: not found either.
        Assert.Equal(HttpStatusCode.NotFound, (await intruder.PostAsJsonAsync(ReversePath(rival.MemberUserId), Body(sale, "refund", 10m, 0, "x-2"))).StatusCode);
        // And this club, naming the rival's purchase for its own member.
        Assert.Equal(HttpStatusCode.NotFound, (await Admin(f, club).PostAsJsonAsync(ReversePath(club.MemberUserId), Body(rivalSale, "refund", 10m, 0, "x-3"))).StatusCode);

        Assert.Empty(await ReadAsync(f, db => db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => (l.TenantId == club.TenantId || l.TenantId == rival.TenantId) && l.Type == LedgerEntryType.PaymentReversal).ToListAsync()));
    }

    private static WebApplicationFactory<Program> WithMail(TestWebAppFactory factory, StubEmailService mail)
        => factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IEmailService>();
            s.AddSingleton<IEmailService>(mail);
        }));
}
