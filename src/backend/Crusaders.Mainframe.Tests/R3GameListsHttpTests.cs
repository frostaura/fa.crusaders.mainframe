using System.Net.Http.Json;
using System.Text.Json;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 3, M-3: the organiser's game list said "your share 25.00" when they had paid 50
/// and the partner had never accepted — <c>my_share_credits</c> subtracted every live partner's
/// share, invited or not. The organiser's figure now counts only ACCEPTED partners, and two
/// additive fields say what the caller has actually paid (their own wallet, net) and still owes.
/// Every player carries <c>status</c>, so a list can name accepted players only.
/// </summary>
public sealed class R3GameListsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static async Task<JsonElement> ItemAsync(PlayersClub club, TestWebAppFactory f, Guid who, Guid bookingId)
    {
        var body = await (await club.Client(f, who).GetAsync("/api/v1/me/bookings/upcoming")).Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("booking_id").GetGuid() == bookingId);
    }

    [SkippableFact]
    public async Task The_organisers_figure_counts_only_accepted_partners_and_says_what_was_actually_paid()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(f, "r3m3lists");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 100m);

        // 4 slices × 8 = 32, split equally three ways: organiser 12, Sam 10, Alex 10.
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }, new { userId = club.Alex }]);

        // Nobody has accepted: the organiser has paid 32 and, as things stand, carries all of it.
        var before = await ItemAsync(club, f, club.Organiser, bookingId);
        Assert.Equal(32m, before.GetProperty("my_share_credits").GetDecimal());
        Assert.Equal(32m, before.GetProperty("my_paid_credits").GetDecimal());
        Assert.Equal(0m, before.GetProperty("my_owing_credits").GetDecimal());

        var seat = PlayersClub.SeatOf(body, 2);
        var shown = (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ShareCredits;
        var accepted = await club.Client(f, club.Sam).PostAsJsonAsync(
            $"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareCredits = shown });
        Assert.True(accepted.IsSuccessStatusCode, await accepted.Content.ReadAsStringAsync());

        // Sam accepted and paid his 10: the organiser has paid 22 net and carries 22; Alex's
        // invitation reduces nothing until he says yes.
        var organiser = await ItemAsync(club, f, club.Organiser, bookingId);
        Assert.Equal(22m, organiser.GetProperty("my_share_credits").GetDecimal());
        Assert.Equal(22m, organiser.GetProperty("my_paid_credits").GetDecimal());
        Assert.Equal(0m, organiser.GetProperty("my_owing_credits").GetDecimal());
        var statuses = organiser.GetProperty("players").EnumerateArray().Select(p => p.GetProperty("status").GetString()).ToList();
        Assert.Equal(["accepted", "accepted", "invited"], statuses);

        var sam = await ItemAsync(club, f, club.Sam, bookingId);
        Assert.Equal(10m, sam.GetProperty("my_share_credits").GetDecimal());
        Assert.Equal(10m, sam.GetProperty("my_paid_credits").GetDecimal());
        Assert.Equal(0m, sam.GetProperty("my_owing_credits").GetDecimal());
    }
}
