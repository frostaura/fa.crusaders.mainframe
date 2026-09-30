using System.Net.Http.Json;
using System.Text.Json;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Every member payload that is a cold entry point carries the club's zone at the top level.
///
/// <para>
/// A member opens an invite or a booking straight from a mail, on a phone that may be in another
/// zone. The client learns the club's zone from any response with a top-level <c>timezone</c>
/// (<c>lib/clubZone</c>) and, until it has, writes every court time in the PHONE's zone. CI run
/// 36532040584 caught the booking detail doing exactly that under <c>TZ=UTC</c>: "16:00–16:45"
/// for an 18:00 Johannesburg game. <c>/me/profile</c> carries it so the zone is known from boot;
/// the booking detail, the invite list, the link view and the inbox carry it so a screen that
/// renders before the profile lands still reads the club's day.
/// </para>
/// </summary>
public sealed class PlayersClubZoneHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static string SettingsIn(string zone) => PlayersClub.Settings.Replace("\"timezone\":\"UTC\"", $"\"timezone\":\"{zone}\"");

    private static async Task<string?> ZoneOf(HttpClient client, string path)
    {
        var response = await client.GetAsync(path);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.TryGetProperty("timezone", out var zone) ? zone.GetString() : null;
    }

    [SkippableFact]
    public async Task Every_cold_entry_point_names_the_club_zone()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plzone", SettingsIn("Africa/Johannesburg"));
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }, new { link = true }]);
        var token = PlayersClub.TokenOf(body, 3)!;

        const string zone = "Africa/Johannesburg";
        var organiser = club.Client(f, club.Organiser);
        var sam = club.Client(f, club.Sam);
        Assert.Equal(zone, await ZoneOf(organiser, "/api/v1/me/profile"));
        Assert.Equal(zone, await ZoneOf(organiser, $"/api/v1/bookings/{bookingId}"));
        Assert.Equal(zone, await ZoneOf(sam, $"/api/v1/bookings/{bookingId}"));
        Assert.Equal(zone, await ZoneOf(sam, "/api/v1/me/invites"));
        Assert.Equal(zone, await ZoneOf(sam, "/api/v1/me/notifications"));
        Assert.Equal(zone, await ZoneOf(club.Client(f, club.Jo), $"/api/v1/invites/{token}"));

        // Each invite on the list also carries it — it is the same view the link answers with.
        var invites = await (await sam.GetAsync("/api/v1/me/invites")).Content.ReadFromJsonAsync<JsonElement>();
        var item = Assert.Single(invites.GetProperty("items").EnumerateArray());
        Assert.Equal(zone, item.GetProperty("timezone").GetString());
    }

    [SkippableFact]
    public async Task A_zone_this_platform_cannot_read_is_reported_as_UTC_not_as_the_typo()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plzonebad", SettingsIn("Africa/Johanesburg"));
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, _) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);

        // The times on the wire are computed in UTC for such a club, so the label must say UTC:
        // a page that printed the stored string beside UTC times would be worse than no label.
        var organiser = club.Client(f, club.Organiser);
        Assert.Equal("UTC", await ZoneOf(organiser, "/api/v1/me/profile"));
        Assert.Equal("UTC", await ZoneOf(organiser, $"/api/v1/bookings/{bookingId}"));
    }
}
