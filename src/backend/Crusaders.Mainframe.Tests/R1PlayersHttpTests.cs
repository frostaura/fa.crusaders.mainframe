using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 1, the players half of lane B: a partner can find the games they joined (B2),
/// a split cancel says what the organiser actually keeps (B3), and "shares not paid yet" counts
/// an open link seat (B4).
/// </summary>
public sealed class R1PlayersHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    private static async Task AcceptAsync(PlayersClub club, TestWebAppFactory f, Guid who, Guid bookingId, Guid seat)
    {
        var shown = (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ShareCredits;
        var response = await club.Client(f, who).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareCredits = shown });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    [SkippableFact]
    public async Task An_accepted_partner_finds_the_game_in_upcoming_and_on_the_grid_as_theirs()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r1upcoming");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }, new { userId = club.Alex }]);
        await AcceptAsync(club, f, club.Sam, bookingId, PlayersClub.SeatOf(body, 2));
        var past = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(-2));   // over: never upcoming

        var sam = await JsonAsync(await club.Client(f, club.Sam).GetAsync("/api/v1/me/bookings/upcoming"));
        Assert.Equal("UTC", sam.GetProperty("timezone").GetString());
        var item = Assert.Single(sam.GetProperty("items").EnumerateArray());
        Assert.Equal(bookingId, item.GetProperty("booking_id").GetGuid());
        Assert.Equal("partner", item.GetProperty("role").GetString());
        Assert.Equal("booked", item.GetProperty("status").GetString());
        Assert.False(string.IsNullOrEmpty(item.GetProperty("court_name").GetString()));
        Assert.Equal(10m, item.GetProperty("my_share_credits").GetDecimal());
        Assert.False(item.GetProperty("needs_action").GetBoolean());
        Assert.Equal(3, item.GetProperty("players").GetArrayLength());
        var names = item.GetProperty("players").EnumerateArray().Select(p => p.GetProperty("name").GetString()).ToList();
        Assert.All(item.GetProperty("players").EnumerateArray(), p =>
            Assert.Equal(["name", "photo_url", "status"], p.EnumerateObject().Select(o => o.Name).Order()));
        Assert.Equal(3, names.Distinct().Count());

        // The organiser sees it as theirs, carrying the remainder after the ACCEPTED partners'
        // shares — Sam's 10; Alex is only invited, so his 10 is still the organiser's (review
        // round 3, M-3: this read 12 and the list said "your share" for money not yet coming back).
        var organiser = Assert.Single((await JsonAsync(await club.Client(f, club.Organiser).GetAsync("/api/v1/me/bookings/upcoming")))
            .GetProperty("items").EnumerateArray(), i => i.GetProperty("booking_id").GetGuid() == bookingId);
        Assert.Equal("organiser", organiser.GetProperty("role").GetString());
        Assert.Equal(22m, organiser.GetProperty("my_share_credits").GetDecimal());
        Assert.DoesNotContain((await JsonAsync(await club.Client(f, club.Organiser).GetAsync("/api/v1/me/bookings/upcoming")))
            .GetProperty("items").EnumerateArray(), i => i.GetProperty("booking_id").GetGuid() == past);

        // An invited (not accepted) partner and a bystander have nothing here.
        Assert.Empty((await JsonAsync(await club.Client(f, club.Alex).GetAsync("/api/v1/me/bookings/upcoming"))).GetProperty("items").EnumerateArray());
        Assert.Empty((await JsonAsync(await club.Client(f, club.Bystander).GetAsync("/api/v1/me/bookings/upcoming"))).GetProperty("items").EnumerateArray());

        // Another club's member, on their own club, sees none of it.
        var other = await PlayersClub.SeedAsync(f, "r1upother");
        Assert.Empty((await JsonAsync(await other.Client(f, other.Sam).GetAsync("/api/v1/me/bookings/upcoming"))).GetProperty("items").EnumerateArray());

        // The grid: Sam's cell is his, as a partner; Alex's (invited) is not.
        var date = DateOnly.FromDateTime(PlayersClub.Tomorrow().UtcDateTime).ToString("yyyy-MM-dd");
        var samSlot = (await JsonAsync(await club.Client(f, club.Sam).GetAsync($"/api/v1/schedule?date={date}")))
            .GetProperty("slots").EnumerateArray().Single(s => s.GetProperty("bookingId").ValueKind == JsonValueKind.String && s.GetProperty("bookingId").GetGuid() == bookingId);
        Assert.True(samSlot.GetProperty("isMine").GetBoolean());
        Assert.Equal("partner", samSlot.GetProperty("role").GetString());
        var alexSlot = (await JsonAsync(await club.Client(f, club.Alex).GetAsync($"/api/v1/schedule?date={date}")))
            .GetProperty("slots").EnumerateArray().Single(s => s.GetProperty("bookingId").ValueKind == JsonValueKind.String && s.GetProperty("bookingId").GetGuid() == bookingId);
        Assert.False(alexSlot.GetProperty("isMine").GetBoolean());
        Assert.Equal(JsonValueKind.Null, alexSlot.GetProperty("role").ValueKind);
        var orgSlot = (await JsonAsync(await club.Client(f, club.Organiser).GetAsync($"/api/v1/schedule?date={date}")))
            .GetProperty("slots").EnumerateArray().Single(s => s.GetProperty("bookingId").ValueKind == JsonValueKind.String && s.GetProperty("bookingId").GetGuid() == bookingId);
        Assert.Equal("organiser", orgSlot.GetProperty("role").GetString());
    }

    [SkippableFact]
    public async Task A_split_cancel_quotes_and_answers_what_the_partners_get_back_and_what_the_organiser_keeps()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r1splitcancel");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 100m);
        await club.CreditAsync(f, club.Alex, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }, new { userId = club.Alex }]);
        await AcceptAsync(club, f, club.Sam, bookingId, PlayersClub.SeatOf(body, 2));
        await AcceptAsync(club, f, club.Alex, bookingId, PlayersClub.SeatOf(body, 3));
        var organiserBefore = await PlayersClub.BalanceAsync(f, club.Organiser);
        var samBefore = await PlayersClub.BalanceAsync(f, club.Sam);

        var quote = await JsonAsync(await club.Client(f, club.Organiser).GetAsync($"/api/v1/bookings/{bookingId}/cancellation-quote"));
        Assert.Equal(32m, quote.GetProperty("refundCredits").GetDecimal());
        Assert.Equal(12m, quote.GetProperty("net_credits").GetDecimal());
        var quoted = quote.GetProperty("partner_refunds").EnumerateArray().ToList();
        Assert.Equal(2, quoted.Count);
        Assert.All(quoted, r => Assert.Equal(10m, r.GetProperty("credits").GetDecimal()));
        Assert.All(quoted, r => Assert.False(string.IsNullOrEmpty(r.GetProperty("name").GetString())));

        var cancel = await club.Client(f, club.Organiser).PostAsync($"/api/v1/bookings/{bookingId}/cancel", null);
        Assert.Equal(HttpStatusCode.OK, cancel.StatusCode);
        var answer = await JsonAsync(cancel);
        Assert.Equal(32m, answer.GetProperty("refunded_credits").GetDecimal());
        Assert.Equal(12m, answer.GetProperty("net_credits").GetDecimal());
        Assert.Equal(20m, answer.GetProperty("partner_refunds").EnumerateArray().Sum(r => r.GetProperty("credits").GetDecimal()));

        // And the wallets agree with what was said.
        Assert.Equal(organiserBefore + 12m, await PlayersClub.BalanceAsync(f, club.Organiser));
        Assert.Equal(samBefore + 10m, await PlayersClub.BalanceAsync(f, club.Sam));
    }

    /// <summary>Lane F1's ask: the desk's cancel and bulk cancel answer the same split truth.</summary>
    [SkippableFact]
    public async Task The_desks_cancel_and_bulk_cancel_name_the_partner_refunds_and_the_net()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r1deskcancel");
        await club.CreditAsync(f, club.Organiser, 200m);
        await club.CreditAsync(f, club.Sam, 100m);
        var admin = club.Client(f, club.Admin, admin: true);

        async Task<Guid> SplitGameAsync(int hour)
        {
            var (id, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }], at: PlayersClub.Tomorrow(hour));
            await AcceptAsync(club, f, club.Sam, id, PlayersClub.SeatOf(body, 2));
            return id;
        }

        var single = await SplitGameAsync(8);
        var one = await JsonAsync(await admin.PostAsJsonAsync($"/api/v1/admin/bookings/{single}/cancel", new { reason = "Court maintenance" }));
        Assert.Equal(32m, one.GetProperty("refunded_credits").GetDecimal());
        Assert.Equal(16m, one.GetProperty("net_credits").GetDecimal());
        var partner = Assert.Single(one.GetProperty("partner_refunds").EnumerateArray());
        Assert.Equal(16m, partner.GetProperty("credits").GetDecimal());
        Assert.Equal("Sam Partner", partner.GetProperty("name").GetString());

        var bulkOne = await SplitGameAsync(10);
        var bulk = await JsonAsync(await admin.PostAsJsonAsync("/api/v1/admin/bookings/bulk-cancel", new
        {
            idempotencyKey = "r1-bulk-split", reason = "Court resurfacing", items = new[] { new { bookingId = bulkOne } },
        }));
        var row = Assert.Single(bulk.GetProperty("results").EnumerateArray());
        Assert.Equal(16m, row.GetProperty("net_credits").GetDecimal());
        Assert.Equal(16m, Assert.Single(row.GetProperty("partner_refunds").EnumerateArray()).GetProperty("credits").GetDecimal());
    }

    [SkippableFact]
    public async Task A_booking_with_no_partners_quotes_its_net_as_its_refund()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r1solocancel");
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, _) = await club.BookWithPlayersAsync(f, []);

        var quote = await JsonAsync(await club.Client(f, club.Organiser).GetAsync($"/api/v1/bookings/{bookingId}/cancellation-quote"));
        Assert.Equal(quote.GetProperty("refundCredits").GetDecimal(), quote.GetProperty("net_credits").GetDecimal());
        Assert.Empty(quote.GetProperty("partner_refunds").EnumerateArray());
    }

    [SkippableFact]
    public async Task Shares_not_paid_yet_count_an_open_link_seat()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r1linkunpaid");
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, _) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }, new { link = true }]);

        var detail = await JsonAsync(await club.Client(f, club.Organiser).GetAsync($"/api/v1/bookings/{bookingId}"));
        // 32 split three ways: partners 10 each (floored), the organiser 12. Sam (invited) and the
        // unclaimed link seat each still owe 10.
        Assert.Equal(20m, detail.GetProperty("money").GetProperty("unpaid_credits").GetDecimal());
        var link = detail.GetProperty("players").EnumerateArray().Single(p => p.GetProperty("kind").GetString() == "open_link");
        Assert.Equal(10m, link.GetProperty("unpaid_credits").GetDecimal());

        // Once the game is off, nothing is owed on it.
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().Single(b => b.Id == bookingId).Status = Crusaders.Mainframe.Api.Domain.BookingStatus.Cancelled);
        var cancelled = await JsonAsync(await club.Client(f, club.Organiser).GetAsync($"/api/v1/bookings/{bookingId}"));
        Assert.Equal(0m, cancelled.GetProperty("money").GetProperty("unpaid_credits").GetDecimal());
    }

    // ------------------------------------------------------------------ F2's asks: the invite reads

    private static HttpClient Anonymous(TestWebAppFactory f, PlayersClub club)
    {
        var client = f.CreateClient();
        client.DefaultRequestHeaders.Host = $"{club.Slug}.crusaders.test";
        return client;
    }

    [SkippableFact]
    public async Task A_link_preview_shows_a_stranger_six_facts_and_nothing_once_the_seat_is_answered()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r1preview");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { link = true }]);
        var token = PlayersClub.TokenOf(body, 2)!;
        var anon = Anonymous(f, club);

        var preview = await anon.GetAsync($"/api/v1/invites/{token}/preview");
        Assert.Equal(HttpStatusCode.OK, preview.StatusCode);
        var view = await JsonAsync(preview);
        Assert.Equal(["court_name", "ends_at", "organiser_first_name", "share_credits", "starts_at", "timezone"],
            view.EnumerateObject().Select(p => p.Name).Order());
        Assert.Equal("Olive", view.GetProperty("organiser_first_name").GetString());
        Assert.Equal(16m, view.GetProperty("share_credits").GetDecimal());
        Assert.Equal("UTC", view.GetProperty("timezone").GetString());

        // Unknown, and another club's host: the same 404.
        Assert.Equal(HttpStatusCode.NotFound, (await anon.GetAsync($"/api/v1/invites/{new string('a', 43)}/preview")).StatusCode);
        var other = await PlayersClub.SeedAsync(f, "r1previewb");
        Assert.Equal(HttpStatusCode.NotFound, (await Anonymous(f, other).GetAsync($"/api/v1/invites/{token}/preview")).StatusCode);

        // Answered (Sam claims the link): nothing to preview any more.
        var claimed = await club.Client(f, club.Sam).PostAsJsonAsync($"/api/v1/invites/{token}/accept", new { expectedShareCredits = 16m });
        Assert.True(claimed.IsSuccessStatusCode, await claimed.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.NotFound, (await anon.GetAsync($"/api/v1/invites/{token}/preview")).StatusCode);
        _ = bookingId;
    }

    [SkippableFact]
    public async Task A_link_preview_is_gone_when_the_game_is_off()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r1prevoff");
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { link = true }]);
        var token = PlayersClub.TokenOf(body, 2)!;
        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Organiser).PostAsync($"/api/v1/bookings/{bookingId}/cancel", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Anonymous(f, club).GetAsync($"/api/v1/invites/{token}/preview")).StatusCode);
    }

    [SkippableFact]
    public async Task A_member_reads_their_own_seat_in_any_state_and_nobody_elses()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r1myseat");
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var seat = PlayersClub.SeatOf(body, 2);
        var sam = club.Client(f, club.Sam);

        var invited = await JsonAsync(await sam.GetAsync($"/api/v1/me/invites/{seat}"));
        Assert.Equal("invited", invited.GetProperty("status").GetString());
        Assert.Equal("booked", invited.GetProperty("booking_status").GetString());
        Assert.Equal(bookingId, invited.GetProperty("booking_id").GetGuid());

        Assert.Equal(HttpStatusCode.OK, (await sam.PostAsync($"/api/v1/bookings/{bookingId}/players/{seat}/decline", null)).StatusCode);
        Assert.Equal("declined", (await JsonAsync(await sam.GetAsync($"/api/v1/me/invites/{seat}"))).GetProperty("status").GetString());

        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Organiser).PostAsync($"/api/v1/bookings/{bookingId}/cancel", null)).StatusCode);
        Assert.Equal("cancelled", (await JsonAsync(await sam.GetAsync($"/api/v1/me/invites/{seat}"))).GetProperty("booking_status").GetString());

        // Anybody else — the organiser included — reads a 404: a participant id proves nothing.
        Assert.Equal(HttpStatusCode.NotFound, (await club.Client(f, club.Bystander).GetAsync($"/api/v1/me/invites/{seat}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await club.Client(f, club.Organiser).GetAsync($"/api/v1/me/invites/{seat}")).StatusCode);
    }
}
