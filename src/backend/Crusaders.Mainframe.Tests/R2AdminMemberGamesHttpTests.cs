using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 2, C6 (ADM-M): the desk's record of a member listed only the courts they had
/// booked, so a member who plays every week as somebody's partner read as someone who never
/// played. <c>GET /admin/members/{id}/bookings</c> and the detail's <c>next_bookings</c> now
/// include accepted partner seats, each row with <c>role</c> and the <c>organiser</c>.
/// </summary>
public sealed class R2AdminMemberGamesHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static async Task<JsonElement> GetAsync(HttpClient admin, string path)
    {
        var response = await admin.GetAsync(path);
        Assert.True(response.IsSuccessStatusCode, $"{path}: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static JsonElement Row(JsonElement items, Guid bookingId) =>
        items.EnumerateArray().Single(r => r.GetProperty("booking_id").GetGuid() == bookingId);

    [SkippableFact]
    public async Task A_members_partner_games_are_on_their_record_with_the_organiser_named()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r2admgames");
        var now = DateTimeOffset.UtcNow;

        var ahead = await club.InsertBookingAsync(f, PlayersClub.Tomorrow(8));
        await club.InsertSeatAsync(f, ahead, 1, club.Organiser, ParticipantStatus.Accepted, 16);
        await club.InsertSeatAsync(f, ahead, 2, club.Sam, ParticipantStatus.Accepted, 16);
        var played = await club.InsertBookingAsync(f, now.AddDays(-2));
        await club.InsertSeatAsync(f, played, 1, club.Organiser, ParticipantStatus.Accepted, 16);
        await club.InsertSeatAsync(f, played, 2, club.Sam, ParticipantStatus.Accepted, 16);
        var onlyAsked = await club.InsertBookingAsync(f, PlayersClub.Tomorrow(12));
        await club.InsertSeatAsync(f, onlyAsked, 1, club.Organiser, ParticipantStatus.Accepted, 16);
        await club.InsertSeatAsync(f, onlyAsked, 2, club.Sam, ParticipantStatus.Invited, 16);
        var own = await club.InsertBookingAsync(f, PlayersClub.Tomorrow(15), organiser: club.Sam);

        var admin = club.Client(f, club.Admin, admin: true);
        var upcoming = (await GetAsync(admin, $"/api/v1/admin/members/{club.Sam}/bookings?when=upcoming")).GetProperty("items");
        var ids = upcoming.EnumerateArray().Select(r => r.GetProperty("booking_id").GetGuid()).ToList();
        Assert.Equal([ahead, own], ids);                        // an unanswered invite is not a game they are on
        var partnerRow = Row(upcoming, ahead);
        Assert.Equal("partner", partnerRow.GetProperty("role").GetString());
        Assert.Equal("Olive Organiser", partnerRow.GetProperty("organiser").GetProperty("name").GetString());
        Assert.Equal(club.Organiser, partnerRow.GetProperty("organiser").GetProperty("user_id").GetGuid());
        var ownRow = Row(upcoming, own);
        Assert.Equal("organiser", ownRow.GetProperty("role").GetString());
        Assert.True(ownRow.GetProperty("organiser").GetProperty("is_self").GetBoolean());

        var past = (await GetAsync(admin, $"/api/v1/admin/members/{club.Sam}/bookings?when=past")).GetProperty("items");
        Assert.Equal("partner", Row(past, played).GetProperty("role").GetString());

        var detail = await GetAsync(admin, $"/api/v1/admin/members/{club.Sam}");
        Assert.Equal([ahead, own], detail.GetProperty("next_bookings").EnumerateArray().Select(r => r.GetProperty("booking_id").GetGuid()).ToList());

        // The organiser's own record is unchanged in kind: their games, as organiser.
        var olive = (await GetAsync(admin, $"/api/v1/admin/members/{club.Organiser}/bookings?when=upcoming")).GetProperty("items");
        Assert.All(olive.EnumerateArray(), r => Assert.Equal("organiser", r.GetProperty("role").GetString()));

        // Another club's desk learns nothing of this member's games.
        var other = await PlayersClub.SeedAsync(f, "r2admgamesB");
        var foreign = await other.Client(f, other.Admin, admin: true).GetAsync($"/api/v1/admin/members/{club.Sam}/bookings?when=upcoming");
        Assert.Equal(System.Net.HttpStatusCode.NotFound, foreign.StatusCode);
    }
}
