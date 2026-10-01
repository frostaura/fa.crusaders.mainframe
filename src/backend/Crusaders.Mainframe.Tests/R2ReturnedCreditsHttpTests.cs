using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 2, F2-4: a cancelled game's detail read "paid 0.00" for a partner whose share had
/// just come back — <c>paid_minutes</c> nets the return out, and nothing said the money went back.
/// Each seat now carries <c>returned_minutes</c>: the share credits refunded to it.
/// </summary>
public sealed class R2ReturnedMinutesHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static JsonElement Seat(JsonElement detail, Guid seatId) =>
        detail.GetProperty("players").EnumerateArray()
            .Single(p => p.GetProperty("participant_id").ValueKind == JsonValueKind.String && p.GetProperty("participant_id").GetGuid() == seatId);

    [SkippableFact]
    public async Task A_cancelled_games_detail_says_what_came_back_to_each_partner()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(f, "r2returned");
        await club.CreditAsync(f, club.Organiser, 100);
        await club.CreditAsync(f, club.Sam, 100);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }, new { userId = club.Alex }]);
        var sam = PlayersClub.SeatOf(body, 2);
        var alex = PlayersClub.SeatOf(body, 3);
        var shown = (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == sam).ShareMinutes;
        Assert.True((await club.Client(f, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{sam}/accept", new { expectedShareMinutes = shown })).IsSuccessStatusCode);

        var before = await (await club.Client(f, club.Organiser).GetAsync($"/api/v1/bookings/{bookingId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(shown, Seat(before, sam).GetProperty("paid_minutes").GetDecimal());
        Assert.Equal(0, Seat(before, sam).GetProperty("returned_minutes").GetInt32());

        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Organiser).PostAsync($"/api/v1/bookings/{bookingId}/cancel", null)).StatusCode);

        var after = await (await club.Client(f, club.Organiser).GetAsync($"/api/v1/bookings/{bookingId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(0, Seat(after, sam).GetProperty("paid_minutes").GetInt32());
        Assert.Equal(shown, Seat(after, sam).GetProperty("returned_minutes").GetDecimal());
        Assert.Equal(0, Seat(after, alex).GetProperty("returned_minutes").GetInt32());   // never paid, nothing back
    }
}
