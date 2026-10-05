using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Services;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 14, lane BE14b — the frontend lanes' asks:
/// <list type="bullet">
/// <item>J14-9 (FE14j): the invite view says what the seat last consented to, so a seat the club
/// accepted without asking is not told "your share went up".</item>
/// <item>E14-7 (FE14m): the court and start of every booking a member's share rows name, readable
/// or not — a member taken off a game read "a split booking" with no court or day.</item>
/// </list>
/// </summary>
public sealed class R14PlayerAsksHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static async Task<JsonElement> InviteAsync(PlayersClub club, TestWebAppFactory app, Guid user, Guid seat)
    {
        var body = await club.Client(app, user).GetFromJsonAsync<JsonElement>("/api/v1/me/invites");
        return body.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("participant_id").GetGuid() == seat);
    }

    [SkippableFact]
    public async Task A_seat_the_club_accepted_reads_zero_consented_and_a_raised_share_reads_the_old_figure()
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(app, "r14consent");
        await club.CreditAsync(app, club.Organiser, 100);
        await club.CreditAsync(app, club.Sam, 50);
        await club.CreditAsync(app, club.Alex, 50);
        var bookingId = await club.InsertBookingAsync(app, DateTimeOffset.UtcNow.AddDays(3).Storable());

        // Alex: put on the game by the club, accepted on his behalf — he never said yes to a figure.
        (await club.Client(app, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players",
            new { userId = club.Alex, reason = "Phoned in", accepted = true })).EnsureSuccessStatusCode();
        var alexSeat = (await club.SeatsAsync(app, bookingId)).Single(s => s.UserId == club.Alex);
        var alex = await InviteAsync(club, app, club.Alex, alexSeat.Id);
        Assert.Equal(0, alex.GetProperty("consented_minutes").GetInt32());
        Assert.True(alex.GetProperty("needs_consent").GetBoolean());

        // Sam: invited, accepts his share, then the organiser raises it.
        (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = new object[] { new { userId = club.Sam } } })).EnsureSuccessStatusCode();
        var samSeat = (await club.SeatsAsync(app, bookingId)).Single(s => s.UserId == club.Sam);
        (await club.Client(app, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{samSeat.Id}/accept",
            new { expectedShareMinutes = samSeat.ShareMinutes })).EnsureSuccessStatusCode();
        var agreed = (await club.SeatsAsync(app, bookingId)).Single(s => s.Id == samSeat.Id).ShareMinutes;
        var organiserSeat = (await club.SeatsAsync(app, bookingId)).Single(s => s.Seat == 1).Id;
        (await club.Client(app, club.Organiser).PutAsJsonAsync($"/api/v1/bookings/{bookingId}/split", new
        {
            mode = "ratio",
            seats = new object[]
            {
                new { participantId = organiserSeat, weight = 1 },
                new { participantId = alexSeat.Id, weight = 1 },
                new { participantId = samSeat.Id, weight = 3 },
            },
        })).EnsureSuccessStatusCode();

        var sam = await InviteAsync(club, app, club.Sam, samSeat.Id);
        Assert.True(sam.GetProperty("share_minutes").GetInt32() > agreed);
        Assert.Equal(agreed, sam.GetProperty("consented_minutes").GetInt32());
        Assert.True(sam.GetProperty("needs_consent").GetBoolean());
    }

    [SkippableFact]
    public async Task The_share_places_name_a_booking_the_member_was_taken_off_and_nothing_they_never_shared()
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(app, "r14places");
        await club.CreditAsync(app, club.Organiser, 100);
        await club.CreditAsync(app, club.Sam, 50);
        var bookingId = await club.InsertBookingAsync(app, DateTimeOffset.UtcNow.AddDays(3).Storable());
        var other = await club.InsertBookingAsync(app, DateTimeOffset.UtcNow.AddDays(4).Storable());
        (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = new object[] { new { userId = club.Sam } } })).EnsureSuccessStatusCode();
        var seat = (await club.SeatsAsync(app, bookingId)).Single(s => s.UserId == club.Sam);
        (await club.Client(app, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}/accept",
            new { expectedShareMinutes = seat.ShareMinutes })).EnsureSuccessStatusCode();
        (await club.Client(app, club.Organiser).DeleteAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}")).EnsureSuccessStatusCode();

        var places = await club.InClubAsync(app, sp => sp.GetRequiredService<PlayersQuery>().SharePlacesAsync([bookingId, other], club.Sam, default));
        var place = JsonSerializer.SerializeToElement(Assert.Single(places, p => p.Key == bookingId).Value);
        Assert.Equal("Court 1", place.GetProperty("court_name").GetString());
        Assert.Equal(JsonValueKind.String, place.GetProperty("starts_at").ValueKind);
        Assert.False(places.ContainsKey(other));   // no share row of Sam's names it
        // On the wire (GET /wallet?include=share_bookings): court and start only, beside the null summary.
        var wallet = await club.Client(app, club.Sam).GetFromJsonAsync<JsonElement>("/api/v1/wallet?include=share_bookings");
        Assert.Equal(JsonValueKind.Null, wallet.GetProperty("share_bookings").GetProperty(bookingId.ToString()).ValueKind);
        var wire = wallet.GetProperty("share_places").GetProperty(bookingId.ToString());
        Assert.Equal(["court_name", "starts_at"], wire.EnumerateObject().Select(p => p.Name).Order().ToArray());
        Assert.Equal("Court 1", wire.GetProperty("court_name").GetString());
        var plain = await club.Client(app, club.Sam).GetFromJsonAsync<JsonElement>("/api/v1/wallet");
        Assert.Equal(JsonValueKind.Null, plain.GetProperty("share_places").ValueKind);

        // Another club's member whose share row names this club's booking learns nothing of it.
        var rival = await PlayersClub.SeedAsync(app, "r14placesx");
        await rival.WriteAsync(app, db => db.LedgerEntries.Add(new Api.Domain.LedgerEntry
        {
            TenantId = rival.TenantId, UserId = rival.Sam, Type = Api.Domain.LedgerEntryType.ShareTransfer, AmountMinutes = 5,
            ActorUserId = rival.Sam, RelatedBookingId = bookingId, ExternalReference = $"share:{Guid.NewGuid():N}:1:in",
        }));
        var theirs = await rival.Client(app, rival.Sam).GetFromJsonAsync<JsonElement>("/api/v1/wallet?include=share_bookings");
        Assert.False(theirs.GetProperty("share_places").TryGetProperty(bookingId.ToString(), out _));

        // The summaries keep their null for a booking he is no longer on.
        var summaries = await club.InClubAsync(app, sp => sp.GetRequiredService<PlayersQuery>().ShareSummariesAsync([bookingId], club.Sam, false, default));
        Assert.Null(summaries[bookingId]);
    }
}
