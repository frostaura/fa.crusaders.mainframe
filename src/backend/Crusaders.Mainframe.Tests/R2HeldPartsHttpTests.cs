using System.Net.Http.Json;
using System.Text.Json;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 2, C4 (MJ-M): held credit showed ONE release date for money that frees on two
/// days. <c>/wallet</c>, <c>/me/profile</c> and the wallet stream's frames carry <c>held_parts</c>
/// — one part per share deadline, soonest first, summing to <c>held_credits</c>; <c>held_until</c>
/// stays, as the soonest, for older clients.
/// </summary>
public sealed class R2HeldPartsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static async Task AcceptAsync(PlayersClub club, TestWebAppFactory f, Guid bookingId, Guid seat)
    {
        var shown = (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ShareCredits;
        var accept = await club.Client(f, club.Sam).PostAsJsonAsync(
            $"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareCredits = shown });
        Assert.True(accept.IsSuccessStatusCode, await accept.Content.ReadAsStringAsync());
    }

    private static void AssertParts(JsonElement body, params (decimal Credits, DateTimeOffset Until)[] expected)
    {
        var parts = body.GetProperty("held_parts").EnumerateArray()
            .Select(p => (p.GetProperty("credits").GetDecimal(), p.GetProperty("until").GetDateTimeOffset())).ToList();
        Assert.Equal(expected.Length, parts.Count);
        for (var i = 0; i < parts.Count; i++)
        {
            Assert.Equal(expected[i].Credits, parts[i].Item1);
            Assert.Equal(expected[i].Until, parts[i].Item2, TimeSpan.FromSeconds(1));
        }
        Assert.Equal(body.GetProperty("held_credits").GetDecimal(), parts.Sum(p => p.Item1));
        Assert.Equal(parts[0].Item2, body.GetProperty("held_until").GetDateTimeOffset(), TimeSpan.FromSeconds(1));
    }

    [SkippableFact]
    public async Task Shares_held_on_two_games_are_two_parts_soonest_first_on_the_wallet_and_the_profile()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r2held");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 100m);

        // Booked later-first, so "soonest first" is the server's ordering and not the insert order.
        var laterAt = PlayersClub.Tomorrow(9).AddDays(2);
        var soonerAt = PlayersClub.Tomorrow(8);
        var (later, laterBody) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }], at: laterAt);
        var (sooner, soonerBody) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }], at: soonerAt, slices: 2);
        await AcceptAsync(club, f, later, PlayersClub.SeatOf(laterBody, 2));
        await AcceptAsync(club, f, sooner, PlayersClub.SeatOf(soonerBody, 2));

        // Sold end + 48 h (the default share_lapse_hours) — 4 slices for the later game, 2 for the sooner.
        var expected = new[] { (8m, soonerAt.AddMinutes(30).AddHours(48)), (16m, laterAt.AddMinutes(60).AddHours(48)) };
        var organiser = club.Client(f, club.Organiser);
        AssertParts(await (await organiser.GetAsync("/api/v1/wallet")).Content.ReadFromJsonAsync<JsonElement>(), expected);
        AssertParts(await (await organiser.GetAsync("/api/v1/me/profile")).Content.ReadFromJsonAsync<JsonElement>(), expected);
    }

    [SkippableFact]
    public async Task Nothing_held_is_an_empty_list_and_a_null_date()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r2heldnone");

        var wallet = await (await club.Client(f, club.Organiser).GetAsync("/api/v1/wallet")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(wallet.GetProperty("held_parts").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, wallet.GetProperty("held_until").ValueKind);
    }
}
