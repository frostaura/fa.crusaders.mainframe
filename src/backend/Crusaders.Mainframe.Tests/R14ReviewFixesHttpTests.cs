using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 14, the independent review of lane BE14b's commits:
/// <list type="bullet">
/// <item>M1: every plain return on a seat still on the game read as the organiser's split change —
/// a desk settle-outside ("Olive lowered your share") and a desk adjustment to the booking alike.
/// <c>split_changed</c> now needs the split's own record; settle-outside is <c>club_settled</c>; a
/// return no record explains is <c>share_back</c>, with nobody named.</item>
/// <item>L1: a removal from before R14 has no record — its return is <c>share_back</c>, never the organiser's.</item>
/// <item>L2: a partner paying their share names nobody on the frame.</item>
/// <item>L3: a member's wallet never names an admin — "The club"; admin surfaces keep the name.</item>
/// <item>L5: one definition of given minutes — a desk top-up with no rand (0 or null).</item>
/// </list>
/// </summary>
public sealed class R14ReviewFixesHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed record Game(
        PlayersClub Club, WebApplicationFactory<Program> App, Guid BookingId, Dictionary<Guid, Guid> SeatOf,
        Dictionary<Guid, System.Threading.Channels.Channel<RealtimeMessage>> Wallets);

    private async Task<Game> GameAsync(string prefix, int partners)
    {
        var app = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(app, prefix);
        var who = new[] { club.Sam, club.Alex }.Take(partners).ToArray();
        foreach (var p in who) await club.CreditAsync(app, p, 50);
        await club.CreditAsync(app, club.Organiser, 100);
        var bookingId = await club.InsertBookingAsync(app, DateTimeOffset.UtcNow.AddDays(3).Storable());
        var bus = app.Services.GetRequiredService<IRealtimeBus>();
        var wallets = new[] { club.Organiser, club.Sam, club.Alex }.ToDictionary(u => u, u => bus.Subscribe(RealtimeTopic.Wallet(club.TenantId, u)));
        (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = who.Select(p => (object)new { userId = p }).ToArray() })).EnsureSuccessStatusCode();
        var seatOf = new Dictionary<Guid, Guid>();
        foreach (var seat in await club.SeatsAsync(app, bookingId))
        {
            if (seat.Seat == 1 || seat.UserId is not { } user) continue;
            seatOf[user] = seat.Id;
            (await club.Client(app, user).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}/accept",
                new { expectedShareMinutes = seat.ShareMinutes })).EnsureSuccessStatusCode();
        }
        return new Game(club, app, bookingId, seatOf, wallets);
    }

    private static List<JsonElement> ShareFrames(Game g, Guid user)
    {
        var frames = new List<JsonElement>();
        while (g.Wallets[user].Reader.TryRead(out var frame))
        {
            if (frame.Event != LedgerService.BalanceEvent) continue;
            var json = JsonDocument.Parse(frame.JsonPayload).RootElement.Clone();
            if (json.TryGetProperty("share_cause", out var cause) && cause.ValueKind == JsonValueKind.String) frames.Add(json);
        }
        return frames;
    }

    private static string? Text(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static Task<List<MemberNotification>> ComeBackAsync(Game g, Guid user) =>
        PlayersClub.ReadAsync(g.App, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.UserId == user && n.BookingId == g.BookingId && n.Kind == MemberEventCatalogue.ShareMoved
                        && (n.Headline.Contains("came back") || n.Headline.Contains("went back")))
            .OrderBy(n => n.CreatedAt).ToListAsync());

    private static Task SettleAsync(Game g) =>
        g.App.Services.GetRequiredService<ShareHook>().AfterSettlementAsync(g.Club.TenantId, g.Club.Slug, [g.BookingId], default);

    // ------------------------------------------------------------------ L2

    [SkippableFact]
    public async Task A_partner_paying_their_share_names_nobody_on_the_frame()
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync("r14l2paid", 1);
        var olive = Assert.Single(ShareFrames(g, g.Club.Organiser));
        Assert.Equal(WalletShareCauses.SharePaid, Text(olive, "share_cause"));
        Assert.Null(Text(olive, "actor_name"));
    }

    // ------------------------------------------------------------------ M1: settle-outside

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_share_settled_outside_is_the_clubs_never_the_organisers_split(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r14m1so{partners}", partners);
        foreach (var u in g.Wallets.Keys) ShareFrames(g, u);

        (await g.Club.Client(g.App, g.Club.Admin, admin: true).PostAsJsonAsync(
            $"/api/v1/admin/bookings/{g.BookingId}/players/{g.SeatOf[g.Club.Sam]}/settle-outside", new { reason = "Paid cash" })).EnsureSuccessStatusCode();

        var sam = Assert.Single(ShareFrames(g, g.Club.Sam));
        Assert.Equal("club_settled", Text(sam, "share_cause"));
        Assert.Null(Text(sam, "actor_name"));
        Assert.Equal("club_settled", Text(Assert.Single(ShareFrames(g, g.Club.Organiser)), "share_cause"));
        var samLine = Assert.Single(await ComeBackAsync(g, g.Club.Sam));
        Assert.Contains("the club recorded your share of Court 1", samLine.Headline, StringComparison.Ordinal);
        Assert.DoesNotContain("lowered", samLine.Headline, StringComparison.Ordinal);
        var oliveLine = Assert.Single(await ComeBackAsync(g, g.Club.Organiser));
        Assert.DoesNotContain("you lowered", oliveLine.Headline, StringComparison.Ordinal);
        if (partners == 2) Assert.Empty(ShareFrames(g, g.Club.Alex));
    }

    // ------------------------------------------------------------------ M1: a desk adjustment to the booking

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_desk_adjustment_lowering_the_booking_names_no_act_and_nobody(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r14m1adj{partners}", partners);
        foreach (var u in g.Wallets.Keys) ShareFrames(g, u);

        await g.Club.WriteAsync(g.App, db => db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = g.Club.TenantId,
            UserId = g.Club.Organiser,
            Type = LedgerEntryType.AdminAdjustment,
            AmountMinutes = 16,
            ActorUserId = g.Club.Admin,
            RelatedBookingId = g.BookingId,
            Reason = "Goodwill on the court",
        }));
        await SettleAsync(g);

        var sam = Assert.Single(ShareFrames(g, g.Club.Sam));
        Assert.Equal("share_back", Text(sam, "share_cause"));
        Assert.Null(Text(sam, "actor_name"));
        var samLine = Assert.Single(await ComeBackAsync(g, g.Club.Sam));
        Assert.DoesNotContain("lowered", samLine.Headline, StringComparison.Ordinal);
        Assert.DoesNotContain("Olive", samLine.Headline, StringComparison.Ordinal);
    }

    /// <summary>A real split change after an earlier one keeps saying so — the record, not the seat, decides.</summary>
    [SkippableFact]
    public async Task A_split_change_is_still_said_as_the_organisers()
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync("r14m1split", 1);
        var organiserSeat = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.Seat == 1).Id;
        foreach (var u in g.Wallets.Keys) ShareFrames(g, u);

        (await g.Club.Client(g.App, g.Club.Organiser).PutAsJsonAsync($"/api/v1/bookings/{g.BookingId}/split", new
        {
            mode = "ratio",
            seats = new object[] { new { participantId = organiserSeat, weight = 3 }, new { participantId = g.SeatOf[g.Club.Sam], weight = 1 } },
        })).EnsureSuccessStatusCode();

        var sam = Assert.Single(ShareFrames(g, g.Club.Sam));
        Assert.Equal(WalletShareCauses.SplitChanged, Text(sam, "share_cause"));
        Assert.Equal("Olive Organiser", Text(sam, "actor_name"));
    }

    // ------------------------------------------------------------------ L1: a removal before R14

    [SkippableFact]
    public async Task A_removal_with_no_record_names_nobody()
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync("r14l1old", 1);
        foreach (var u in g.Wallets.Keys) ShareFrames(g, u);
        // What a pre-R14 removal left behind: the seat removed, no players.removed row, the return due.
        await g.Club.WriteAsync(g.App, db =>
        {
            var seat = db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == g.SeatOf[g.Club.Sam]);
            seat.Status = ParticipantStatus.Removed;
            seat.UpdatedAt = DateTimeOffset.UtcNow;
        });
        await SettleAsync(g);

        var sam = Assert.Single(ShareFrames(g, g.Club.Sam));
        Assert.Equal("share_back", Text(sam, "share_cause"));
        Assert.Null(Text(sam, "actor_name"));
        var rows = (await g.Club.SharesAsync(g.App, g.BookingId)).Where(l => l.Reason == "Share of a split booking returned").ToList();
        Assert.Equal(2, rows.Count);
        Assert.All(rows, l => Assert.Equal(Guid.Empty, l.ActorUserId));
    }

    // ------------------------------------------------------------------ L3: members never see an admin's name

    [SkippableFact]
    public async Task A_members_wallet_says_the_club_where_the_admin_ledger_names_the_admin()
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync("r14l3name", 1);
        (await g.Club.Client(g.App, g.Club.Admin, admin: true).PostAsJsonAsync(
            $"/api/v1/admin/bookings/{g.BookingId}/players/{g.SeatOf[g.Club.Sam]}/remove", new { reason = "Double booked" })).EnsureSuccessStatusCode();
        (await g.Club.Client(g.App, g.Club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/minutes/{g.Club.Sam}/adjust",
            new { amountMinutes = 5, reason = "Goodwill", idempotencyKey = Guid.NewGuid().ToString("N") })).EnsureSuccessStatusCode();

        var wallet = await g.Club.Client(g.App, g.Club.Sam).GetFromJsonAsync<JsonElement>("/api/v1/wallet");
        var byAdmin = wallet.GetProperty("entries").EnumerateArray().Where(r => r.GetProperty("actorUserId").GetGuid() == g.Club.Admin).ToList();
        Assert.Equal(2, byAdmin.Count);   // the share coming back, and the desk adjustment
        Assert.All(byAdmin, r =>
        {
            Assert.Equal("The club", r.GetProperty("actor_name").GetString());
            Assert.Equal("The club", r.GetProperty("actorName").GetString());
        });
        Assert.DoesNotContain("Ada Admin", wallet.GetRawText(), StringComparison.Ordinal);

        var ledger = await g.Club.Client(g.App, g.Club.Admin, admin: true).GetFromJsonAsync<JsonElement>($"/api/v1/admin/ledger?userId={g.Club.Sam}");
        var adminRows = ledger.EnumerateArray().Where(r => r.GetProperty("actorUserId").GetGuid() == g.Club.Admin).ToList();
        Assert.NotEmpty(adminRows);
        Assert.All(adminRows, r => Assert.Equal("Ada Admin", r.GetProperty("actor_name").GetString()));
    }

    // ------------------------------------------------------------------ L5: one definition of given

    [Theory]
    [InlineData(LedgerEntryType.AdminTopUp, null, true)]
    [InlineData(LedgerEntryType.AdminTopUp, 0, true)]
    [InlineData(LedgerEntryType.AdminTopUp, 100, false)]
    [InlineData(LedgerEntryType.TopUp, null, false)]
    [InlineData(LedgerEntryType.AdminAdjustment, null, false)]
    public void Given_is_a_desk_top_up_with_no_rand(LedgerEntryType type, int? zar, bool given)
    {
        Assert.Equal(given, GivenMinutes.IsGiven(type, zar));
    }

    [SkippableFact]
    public async Task A_desk_top_up_with_no_rand_recorded_is_given_on_the_reports()
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(app, "r14l5given");
        await club.WriteAsync(app, db => db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = club.TenantId,
            UserId = club.Sam,
            Type = LedgerEntryType.AdminTopUp,
            AmountMinutes = 60,
            ActorUserId = club.Admin,
            ZarPaid = null,
            Reason = "desk sale, no rand recorded",
        }));

        var revenue = await club.Client(app, club.Admin, admin: true).GetFromJsonAsync<JsonElement>("/api/v1/admin/reports/revenue");
        Assert.Equal(60, revenue.GetProperty("given_minutes").GetInt32());
        var mine = await club.Client(app, club.Sam).GetFromJsonAsync<JsonElement>("/api/v1/reports/me/wallet");
        Assert.Equal(60, mine.GetProperty("given_minutes").GetInt32());
        // The desk mail decides with the same rule.
        Assert.True(WalletEndpoints.DeskSaleIsGift(AdminCreditReasons.TopUpCash, null));
    }
}
