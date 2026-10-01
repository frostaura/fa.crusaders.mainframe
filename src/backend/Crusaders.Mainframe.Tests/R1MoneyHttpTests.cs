using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 1, the money half of lane B: a desk cash top-up is counted as revenue but carried
/// no rand, so the month's income read R0.00 for it (B7); ledger rows did not say who moved the
/// money on a member's behalf (B9).
/// </summary>
public sealed class R1MoneyHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    private static string Adjust(PlayersClub club, Guid who) => $"/api/v1/admin/credit/{who}/adjust";

    [SkippableFact]
    public async Task A_desk_top_up_states_the_rand_it_took_and_the_revenue_report_counts_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r1zar");
        var admin = club.Client(f, club.Admin, admin: true);

        // Every top-up code must say how much money changed hands.
        foreach (var code in new[] { "top_up_cash", "top_up_eft", "top_up_card_offline" })
        {
            var missing = await admin.PostAsJsonAsync(Adjust(club, club.Sam), new { amountMinutes = 240, reason = "Cash at the bar", reasonCode = code });
            Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
            Assert.Equal("zar_received_required", (await JsonAsync(missing)).GetProperty("error").GetString());
        }
        var negative = await admin.PostAsJsonAsync(Adjust(club, club.Sam), new { amountMinutes = 240, reason = "Cash", reasonCode = "top_up_cash", zarReceived = -1m });
        Assert.Equal(HttpStatusCode.BadRequest, negative.StatusCode);
        Assert.Equal(0, await PlayersClub.BalanceAsync(f, club.Sam));

        var ok = await admin.PostAsJsonAsync(Adjust(club, club.Sam), new { amountMinutes = 240, reason = "Cash at the bar, slip 12", reasonCode = "top_up_cash", zarReceived = 100m });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal(100m, (await JsonAsync(ok)).GetProperty("zar_received").GetDecimal());
        var snake = await admin.PostAsJsonAsync(Adjust(club, club.Alex), new { amountMinutes = 48, reason = "EFT cleared", reason_code = "top_up_eft", zar_received = 20m });
        Assert.Equal(HttpStatusCode.OK, snake.StatusCode);

        // A goodwill credit is not money the club took: no rand asked, none stored.
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync(Adjust(club, club.Jo), new { amountMinutes = 10, reason = "Sorry about the lights", reasonCode = "goodwill", zarReceived = 999m })).StatusCode);

        var rows = await PlayersClub.ReadAsync(f, db => db.LedgerEntries.IgnoreQueryFilters()
            .Where(l => l.TenantId == club.TenantId && l.ActorUserId == club.Admin).ToListAsync());
        Assert.Equal(100m, rows.Single(r => r.UserId == club.Sam).ZarPaid);
        Assert.Equal(20m, rows.Single(r => r.UserId == club.Alex).ZarPaid);
        Assert.Null(rows.Single(r => r.UserId == club.Jo).ZarPaid);

        var report = await JsonAsync(await admin.GetAsync("/api/v1/admin/reports/revenue"));
        Assert.Equal(120m, report.GetProperty("net_zar").GetDecimal());
        Assert.Equal(120m, report.GetProperty("gross_topups_zar").GetDecimal());
    }

    [SkippableFact]
    public async Task An_amount_out_of_range_names_its_max()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r1max");
        var admin = club.Client(f, club.Admin, admin: true);

        var response = await admin.PostAsJsonAsync(Adjust(club, club.Sam), new { amountMinutes = 99_999_999_999, reason = "typo", reasonCode = "goodwill" });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await JsonAsync(response);
        Assert.Equal("amount_out_of_range", body.GetProperty("error").GetString());
        Assert.True(body.GetProperty("max").GetDecimal() > 0m);
    }

    [SkippableFact]
    public async Task Ledger_rows_name_whoever_moved_the_money_on_the_members_behalf_and_nobody_otherwise()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r1actor");
        await club.CreditAsync(f, club.Organiser, 100);
        var admin = club.Client(f, club.Admin, admin: true);

        // The member books their own court; the desk credits them; the desk books on their behalf.
        await club.BookWithPlayersAsync(f, []);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync(Adjust(club, club.Organiser), new { amountMinutes = 5, reason = "Sorry", reasonCode = "goodwill" })).StatusCode);
        var onBehalf = await admin.PostAsJsonAsync("/api/v1/admin/bookings", new
        {
            courtId = club.CourtId, userId = club.Organiser, startsAt = PlayersClub.Tomorrow(12), sliceCount = 2,
        });
        Assert.True(onBehalf.IsSuccessStatusCode, await onBehalf.Content.ReadAsStringAsync());

        var wallet = await JsonAsync(await club.Client(f, club.Organiser).GetAsync("/api/v1/wallet"));
        var entries = wallet.GetProperty("entries").EnumerateArray().ToList();
        string? ActorOf(JsonElement e) => e.GetProperty("actor_name").ValueKind == JsonValueKind.Null ? null : e.GetProperty("actor_name").GetString();

        Assert.Null(ActorOf(entries.Single(e => e.GetProperty("type").GetString() == "TopUp")));           // system float
        Assert.Equal("Ada Admin", ActorOf(entries.Single(e => e.GetProperty("type").GetString() == "AdminAdjustment")));
        var charges = entries.Where(e => e.GetProperty("type").GetString() == "BookingCharge").ToList();
        Assert.Equal(2, charges.Count);
        Assert.Single(charges, c => ActorOf(c) is null);                                                 // their own
        Assert.Single(charges, c => ActorOf(c) == "Ada Admin");                                            // the desk's

        // The admin ledger says the same.
        var ledger = (await JsonAsync(await admin.GetAsync($"/api/v1/admin/ledger?userId={club.Organiser}"))).EnumerateArray().ToList();
        Assert.Equal("Ada Admin", ActorOf(ledger.Single(e => e.GetProperty("type").GetString() == "AdminAdjustment")));
        Assert.Null(ActorOf(ledger.Single(e => e.GetProperty("type").GetString() == "TopUp")));
    }
}
