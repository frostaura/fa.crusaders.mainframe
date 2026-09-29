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

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

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

        // The organiser sees it as theirs, carrying the remainder after the partners' shares.
        var organiser = Assert.Single((await JsonAsync(await club.Client(f, club.Organiser).GetAsync("/api/v1/me/bookings/upcoming")))
            .GetProperty("items").EnumerateArray(), i => i.GetProperty("booking_id").GetGuid() == bookingId);
        Assert.Equal("organiser", organiser.GetProperty("role").GetString());
        Assert.Equal(12m, organiser.GetProperty("my_share_credits").GetDecimal());
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
}
