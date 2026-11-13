using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Pay what you can (players-and-splits.md §4): a partner short of their share pays part of it
/// (<c>payMinutes</c> on the accept), the booking becomes an amount split with the organiser covering
/// the rest, the organiser is told, and the organiser's next re-split — the others deciding how to
/// split what is left — clears it.
///
/// <para>
/// The game: 32 minutes split equally three ways — Sam 10, Alex 10, the organiser 12.
/// </para>
/// </summary>
public sealed class PayWhatYouCanHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static async Task<(PlayersClub Club, Guid BookingId, BookingParticipant Sam)> GameAsync(TestWebAppFactory app, string prefix, int samMinutes)
    {
        var club = await PlayersClub.SeedAsync(app, prefix);
        await club.CreditAsync(app, club.Organiser, 100);
        await club.CreditAsync(app, club.Sam, samMinutes);
        await club.CreditAsync(app, club.Alex, 50);
        var bookingId = await club.InsertBookingAsync(app, DateTimeOffset.UtcNow.AddDays(3).Storable());
        (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = new object[] { new { userId = club.Sam }, new { userId = club.Alex } } })).EnsureSuccessStatusCode();
        var sam = (await club.SeatsAsync(app, bookingId)).Single(s => s.UserId == club.Sam);
        Assert.Equal(10, sam.ShareMinutes);
        return (club, bookingId, sam);
    }

    private static Task<HttpResponseMessage> AcceptAsync(PlayersClub club, TestWebAppFactory app, Guid user, Guid bookingId, Guid seatId, int expected, int? pay) =>
        club.Client(app, user).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seatId}/accept",
            new { expectedShareMinutes = expected, payMinutes = pay });

    private static async Task<string?> ErrorOf(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString();

    [SkippableFact]
    public async Task A_partner_short_of_their_share_pays_what_they_can_and_the_organiser_covers_the_rest()
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var (club, bookingId, sam) = await GameAsync(app, "pwyc-happy", samMinutes: 6);

        var response = await AcceptAsync(club, app, club.Sam, bookingId, sam.Id, expected: 10, pay: 6);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var answer = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("accepted", answer.GetProperty("status").GetString());
        Assert.Equal(6, answer.GetProperty("share_minutes").GetInt32());
        Assert.Equal(6, answer.GetProperty("paid_minutes").GetInt32());

        // The ledger: one pair of exactly what they paid, netting to zero.
        var shares = await club.SharesAsync(app, bookingId);
        Assert.Equal(2, shares.Count);
        Assert.Equal(-6, Assert.Single(shares, l => l.UserId == club.Sam).AmountMinutes);
        Assert.Equal(6, Assert.Single(shares, l => l.UserId == club.Organiser).AmountMinutes);
        Assert.Equal(0, await PlayersClub.BalanceAsync(app, club.Sam));

        // The seats: an amount split, Sam at 6 with 4 short, Alex untouched, the organiser the remainder.
        var seats = await club.SeatsAsync(app, bookingId);
        var samNow = seats.Single(s => s.Id == sam.Id);
        Assert.Equal((6, 6, 4, ParticipantStatus.Accepted), (samNow.ShareMinutes, samNow.ConsentedMinutes, samNow.ShortfallMinutes, samNow.Status));
        Assert.Equal(10, seats.Single(s => s.UserId == club.Alex).ShareMinutes);
        var organiserSeat = seats.Single(s => s.Seat == 1);
        Assert.Equal(16, organiserSeat.ShareMinutes);
        Assert.Equal(SplitModes.Amount, organiserSeat.SplitMode);
        Assert.Equal(0, organiserSeat.ShortfallMinutes);

        // The organiser is told, in the inbox and by mail, with the booking to split it from.
        var notice = await PlayersClub.ReadAsync(app, db => db.MemberNotifications.IgnoreQueryFilters()
            .SingleAsync(n => n.TenantId == club.TenantId && n.UserId == club.Organiser && n.Kind == MemberEventCatalogue.Shortfall));
        Assert.Equal($"/bookings/{bookingId}", notice.Link);
        Assert.Contains("could pay 6", notice.Headline);
        Assert.Contains("You're covering it for now", notice.Headline);
        Assert.DoesNotContain("credit", notice.Headline, StringComparison.OrdinalIgnoreCase);
        Assert.True(await PlayersClub.ReadAsync(app, db => db.AdminNotifications.IgnoreQueryFilters()
            .AnyAsync(n => n.TenantId == club.TenantId && n.RecipientUserId == club.Organiser && n.Kind == MemberEventCatalogue.Shortfall)));

        // The booking detail says it: Sam's row and the money's left to cover.
        var detail = await club.Client(app, club.Organiser).GetFromJsonAsync<JsonElement>($"/api/v1/bookings/{bookingId}");
        Assert.Equal(4, detail.GetProperty("money").GetProperty("left_to_cover_minutes").GetInt32());
        var samRow = detail.GetProperty("players").EnumerateArray().Single(p => p.GetProperty("participant_id").GetString() == sam.Id.ToString());
        Assert.Equal(4, samRow.GetProperty("shortfall_minutes").GetInt32());

        // A second tap answers the same 200 and writes nothing more.
        var again = await AcceptAsync(club, app, club.Sam, bookingId, sam.Id, expected: 10, pay: 6);
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.Equal(2, (await club.SharesAsync(app, bookingId)).Count);
        Assert.Equal(4, (await club.SeatsAsync(app, bookingId)).Single(s => s.Id == sam.Id).ShortfallMinutes);
    }

    [SkippableTheory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(10)]
    [InlineData(11)]
    public async Task A_part_that_is_not_a_whole_part_of_the_share_is_refused_and_nothing_changes(int pay)
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var (club, bookingId, sam) = await GameAsync(app, $"pwyc-bad{pay + 1}", samMinutes: 50);

        var response = await AcceptAsync(club, app, club.Sam, bookingId, sam.Id, expected: 10, pay: pay);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(PlayerErrors.PayMinutesInvalid, await ErrorOf(response));

        Assert.Empty(await club.SharesAsync(app, bookingId));
        var seat = (await club.SeatsAsync(app, bookingId)).Single(s => s.Id == sam.Id);
        Assert.Equal((ParticipantStatus.Invited, 10, 0), (seat.Status, seat.ShareMinutes, seat.ShortfallMinutes));
        Assert.Equal(SplitModes.Equal, (await club.SeatsAsync(app, bookingId)).Single(s => s.Seat == 1).SplitMode);
    }

    [SkippableFact]
    public async Task A_part_above_the_spendable_minutes_is_402_and_nothing_changes()
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var (club, bookingId, sam) = await GameAsync(app, "pwyc-402", samMinutes: 6);

        var response = await AcceptAsync(club, app, club.Sam, bookingId, sam.Id, expected: 10, pay: 8);
        Assert.Equal(HttpStatusCode.PaymentRequired, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(PlayerErrors.InsufficientBalance, body.GetProperty("error").GetString());
        Assert.Equal(6, body.GetProperty("current_minutes").GetInt32());
        Assert.Equal(8, body.GetProperty("required_minutes").GetInt32());

        Assert.Empty(await club.SharesAsync(app, bookingId));
        var seats = await club.SeatsAsync(app, bookingId);
        Assert.Equal((ParticipantStatus.Invited, 10, 0), (seats.Single(s => s.Id == sam.Id).Status, seats.Single(s => s.Id == sam.Id).ShareMinutes, seats.Single(s => s.Id == sam.Id).ShortfallMinutes));
        Assert.Equal(12, seats.Single(s => s.Seat == 1).ShareMinutes);
        Assert.False(await PlayersClub.ReadAsync(app, db => db.MemberNotifications.IgnoreQueryFilters()
            .AnyAsync(n => n.TenantId == club.TenantId && n.Kind == MemberEventCatalogue.Shortfall)));
    }

    [SkippableFact]
    public async Task The_organisers_split_of_what_is_left_clears_the_shortfall_and_asks_the_partner_asked_for_more()
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var (club, bookingId, sam) = await GameAsync(app, "pwyc-split", samMinutes: 6);
        (await AcceptAsync(club, app, club.Sam, bookingId, sam.Id, expected: 10, pay: 6)).EnsureSuccessStatusCode();
        var alex = (await club.SeatsAsync(app, bookingId)).Single(s => s.UserId == club.Alex);
        (await AcceptAsync(club, app, club.Alex, bookingId, alex.Id, expected: 10, pay: null)).EnsureSuccessStatusCode();

        // The 4 left: 2 to Alex (10 → 12), the organiser keeps the other 2 (the remainder, 32 − 6 − 12 = 14).
        var organiserSeat = (await club.SeatsAsync(app, bookingId)).Single(s => s.Seat == 1).Id;
        var split = await club.Client(app, club.Organiser).PutAsJsonAsync($"/api/v1/bookings/{bookingId}/split", new
        {
            mode = "amount",
            seats = new object[]
            {
                new { participantId = sam.Id, amount = 6 },
                new { participantId = alex.Id, amount = 12 },
            },
        });
        Assert.Equal(HttpStatusCode.OK, split.StatusCode);

        var seats = await club.SeatsAsync(app, bookingId);
        Assert.All(seats, s => Assert.Equal(0, s.ShortfallMinutes));
        Assert.Equal(14, seats.Single(s => s.Id == organiserSeat).ShareMinutes);
        var alexNow = seats.Single(s => s.Id == alex.Id);
        Assert.Equal((12, 10), (alexNow.ShareMinutes, alexNow.ConsentedMinutes));   // asked again — nothing taken yet

        var detail = await club.Client(app, club.Organiser).GetFromJsonAsync<JsonElement>($"/api/v1/bookings/{bookingId}");
        Assert.Equal(0, detail.GetProperty("money").GetProperty("left_to_cover_minutes").GetInt32());
        var alexRow = detail.GetProperty("players").EnumerateArray().Single(p => p.GetProperty("participant_id").GetString() == alex.Id.ToString());
        Assert.True(alexRow.GetProperty("needs_consent").GetBoolean());
        Assert.Equal(-10, (await club.SharesAsync(app, bookingId)).Where(l => l.UserId == club.Alex).Sum(l => l.AmountMinutes));
    }

    [SkippableFact]
    public async Task Another_clubs_member_cannot_pay_part_of_this_clubs_seat()
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var (club, bookingId, sam) = await GameAsync(app, "pwyc-xt", samMinutes: 6);
        var rival = await PlayersClub.SeedAsync(app, "pwyc-xtr");
        await rival.CreditAsync(app, rival.Sam, 50);

        // The rival's member, signed in to the rival club, names this club's booking and seat.
        var response = await AcceptAsync(rival, app, rival.Sam, bookingId, sam.Id, expected: 10, pay: 6);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);

        Assert.Empty(await club.SharesAsync(app, bookingId));
        var seats = await club.SeatsAsync(app, bookingId);
        var seat = seats.Single(s => s.Id == sam.Id);
        Assert.Equal((ParticipantStatus.Invited, club.Sam, 10, 0), (seat.Status, seat.UserId!.Value, seat.ShareMinutes, seat.ShortfallMinutes));
        Assert.Equal(SplitModes.Equal, seats.Single(s => s.Seat == 1).SplitMode);
        Assert.Equal(50, await PlayersClub.BalanceAsync(app, rival.Sam));
        Assert.False(await PlayersClub.ReadAsync(app, db => db.MemberNotifications.IgnoreQueryFilters()
            .AnyAsync(n => (n.TenantId == club.TenantId || n.TenantId == rival.TenantId) && n.Kind == MemberEventCatalogue.Shortfall)));
    }
}
