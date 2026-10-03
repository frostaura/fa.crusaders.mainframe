using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 9, J9-5 (asked by FC9): a booking the desk made for a member read "You booked" /
/// "You organised this game" — neither member read said who made it. <c>booked_by_club</c> on
/// <c>/me/bookings/upcoming</c> items and on <c>/bookings/{id}</c> is true for the member the club
/// booked FOR, and false for their own bookings and for anybody else on the game (a partner).
/// </summary>
public sealed class R9BookedByClubHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response)
    {
        Assert.True(response.IsSuccessStatusCode, $"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static async Task<JsonElement> UpcomingItemAsync(PlayersClub club, TestWebAppFactory f, Guid who, Guid bookingId) =>
        Assert.Single((await JsonAsync(await club.Client(f, who).GetAsync("/api/v1/me/bookings/upcoming")))
            .GetProperty("items").EnumerateArray(), i => i.GetProperty("booking_id").GetGuid() == bookingId);

    [SkippableFact]
    public async Task Both_member_reads_say_when_the_club_made_the_booking_and_only_to_the_member_it_was_made_for()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(f, "r9byclub");
        await club.CreditAsync(f, club.Sam, 100);
        await club.CreditAsync(f, club.Organiser, 100);

        // The desk books a court for Sam, through the admin route.
        var made = await JsonAsync(await club.Client(f, club.Admin, admin: true).PostAsJsonAsync("/api/v1/admin/bookings", new
        {
            userId = club.Sam, courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(9), sliceCount = 2,
        }));
        var forSam = made.GetProperty("booking_id").GetGuid();
        // Alex holds an accepted seat on it: the club did not book anything FOR him.
        await club.InsertSeatAsync(f, forSam, 2, club.Alex, ParticipantStatus.Accepted, 8);

        // Olive books her own.
        var (own, _) = await club.BookWithPlayersAsync(f, [], at: PlayersClub.Tomorrow(11));

        Assert.True((await UpcomingItemAsync(club, f, club.Sam, forSam)).GetProperty("booked_by_club").GetBoolean());
        Assert.True((await JsonAsync(await club.Client(f, club.Sam).GetAsync($"/api/v1/bookings/{forSam}"))).GetProperty("booked_by_club").GetBoolean());

        Assert.False((await UpcomingItemAsync(club, f, club.Alex, forSam)).GetProperty("booked_by_club").GetBoolean());
        Assert.False((await JsonAsync(await club.Client(f, club.Alex).GetAsync($"/api/v1/bookings/{forSam}"))).GetProperty("booked_by_club").GetBoolean());

        Assert.False((await UpcomingItemAsync(club, f, club.Organiser, own)).GetProperty("booked_by_club").GetBoolean());
        Assert.False((await JsonAsync(await club.Client(f, club.Organiser).GetAsync($"/api/v1/bookings/{own}"))).GetProperty("booked_by_club").GetBoolean());

        // Cross-tenant: another club's member reads nothing of it — no field, no booking.
        var rival = await PlayersClub.SeedAsync(f, "r9byrival");
        Assert.Equal(HttpStatusCode.NotFound, (await rival.Client(f, rival.Sam).GetAsync($"/api/v1/bookings/{forSam}")).StatusCode);
        Assert.DoesNotContain((await JsonAsync(await rival.Client(f, rival.Sam).GetAsync("/api/v1/me/bookings/upcoming")))
            .GetProperty("items").EnumerateArray(), i => i.GetProperty("booking_id").GetGuid() == forSam);
    }
}
