using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 4, lane B1 (players): the organiser's own remove / split change / cancel receipts
/// are born read (I4-5, I-9); a cancelled game's "back" figure is what the cancellation returned
/// (M4-4); an unanswered invitee is not mailed a cancellation (M4-5); and the organiser's own seat
/// carries the share it absorbed when a partner seat dies (M4-6).
/// </summary>
public sealed class R4PlayersHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static async Task AcceptAsync(PlayersClub club, TestWebAppFactory f, Guid who, Guid bookingId, Guid seat)
    {
        var shown = (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ShareCredits;
        var response = await club.Client(f, who).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareCredits = shown });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    private static async Task OkAsync(Task<HttpResponseMessage> call)
    {
        var response = await call;
        Assert.True(response.IsSuccessStatusCode, $"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
    }

    /// <summary>The share receipts one member holds for one booking, oldest first.</summary>
    private static Task<List<MemberNotification>> ShareReceiptsAsync(TestWebAppFactory f, Guid userId, Guid bookingId) =>
        PlayersClub.ReadAsync(f, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.UserId == userId && n.BookingId == bookingId && n.Kind == MemberEventCatalogue.ShareMoved)
            .OrderBy(n => n.CreatedAt).ToListAsync());

    /// <summary>A booked game with Sam accepted and paid (16 of 32).</summary>
    private static async Task<(PlayersClub Club, Guid BookingId, Guid SamSeat)> PaidGameAsync(TestWebAppFactory f, string prefix)
    {
        var club = await PlayersClub.SeedAsync(f, prefix);
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var samSeat = PlayersClub.SeatOf(body, 2);
        await AcceptAsync(club, f, club.Sam, bookingId, samSeat);
        return (club, bookingId, samSeat);
    }

    // ---- I4-5 / I-9: the organiser's own actions --------------------------------------------

    [SkippableFact]
    public async Task The_organisers_own_remove_leaves_their_return_receipt_read_and_the_partners_unread()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = CreateFactory();
        var (club, bookingId, samSeat) = await PaidGameAsync(f, "r4rmread");

        await OkAsync(club.Client(f, club.Organiser).DeleteAsync($"/api/v1/bookings/{bookingId}/players/{samSeat}"));

        var organisers = await ShareReceiptsAsync(f, club.Organiser, bookingId);
        Assert.Equal(2, organisers.Count);
        Assert.Null(organisers[0].ReadAt);            // "Sam paid you 16" — Sam's doing: news
        Assert.NotNull(organisers[1].ReadAt);         // "16 went back to Sam" — their own doing
        Assert.Null((await ShareReceiptsAsync(f, club.Sam, bookingId)).Last().ReadAt);   // news to Sam
    }

    [SkippableFact]
    public async Task The_organisers_own_split_change_leaves_their_return_receipt_read()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = CreateFactory();
        var (club, bookingId, samSeat) = await PaidGameAsync(f, "r4splitread");

        await OkAsync(club.Client(f, club.Organiser).PutAsJsonAsync($"/api/v1/bookings/{bookingId}/split", new
        {
            mode = "amount",
            seats = new[] { new { participantId = samSeat, amount = 10m } },
        }));

        var organisers = await ShareReceiptsAsync(f, club.Organiser, bookingId);
        Assert.Equal(2, organisers.Count);
        Assert.NotNull(organisers[1].ReadAt);
        Assert.Null((await ShareReceiptsAsync(f, club.Sam, bookingId)).Last().ReadAt);
    }

    [SkippableFact]
    public async Task The_organisers_own_cancel_leaves_their_return_receipts_read_but_the_desks_does_not()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = CreateFactory();
        var (club, bookingId, _) = await PaidGameAsync(f, "r4cancelread");

        await OkAsync(club.Client(f, club.Organiser).PostAsync($"/api/v1/bookings/{bookingId}/cancel", null));

        var organisers = await ShareReceiptsAsync(f, club.Organiser, bookingId);
        Assert.Equal(2, organisers.Count);
        Assert.NotNull(organisers[1].ReadAt);
        Assert.Null((await ShareReceiptsAsync(f, club.Sam, bookingId)).Last().ReadAt);

        // The desk cancelling somebody else's game: that is news to the organiser.
        var (desk, deskBooking, _) = await PaidGameAsync(f, "r4deskcancel");
        await OkAsync(desk.Client(f, desk.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/bookings/{deskBooking}/cancel", new { waivePenalty = false, reason = "R4 desk cancel" }));
        Assert.Null((await ShareReceiptsAsync(f, desk.Organiser, deskBooking)).Last().ReadAt);
    }

    // ---- M4-4: what the cancellation returned -------------------------------------------------

    [SkippableFact]
    public async Task A_cancelled_games_back_figure_is_what_the_cancellation_returned_not_every_return()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = CreateFactory();
        var (club, bookingId, samSeat) = await PaidGameAsync(f, "r4returned");

        // 16 → 10: six come back before the cancellation.
        await OkAsync(club.Client(f, club.Organiser).PutAsJsonAsync($"/api/v1/bookings/{bookingId}/split", new
        {
            mode = "amount",
            seats = new[] { new { participantId = samSeat, amount = 10m } },
        }));
        await OkAsync(club.Client(f, club.Organiser).PostAsync($"/api/v1/bookings/{bookingId}/cancel", null));

        var detail = await (await club.Client(f, club.Organiser).GetAsync($"/api/v1/bookings/{bookingId}")).Content.ReadFromJsonAsync<JsonElement>();
        var sam = detail.GetProperty("players").EnumerateArray().Single(p => p.GetProperty("participant_id").GetString() == samSeat.ToString());
        Assert.Equal(10m, sam.GetProperty("returned_credits").GetDecimal());
    }

    // ---- M4-5: an unanswered invitee is not mailed a cancellation -----------------------------

    [SkippableFact]
    public async Task A_cancellation_mails_the_accepted_partner_and_only_tells_the_invitee_in_the_inbox()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r4quietcancel");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }, new { userId = club.Alex }]);
        await AcceptAsync(club, f, club.Sam, bookingId, PlayersClub.SeatOf(body, 2));

        await OkAsync(club.Client(f, club.Organiser).PostAsync($"/api/v1/bookings/{bookingId}/cancel", null));

        var mails = await PlayersClub.ReadAsync(f, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Kind == MemberEventCatalogue.GameCancelled)
            .Select(n => n.RecipientUserId).ToListAsync());
        Assert.Equal([club.Sam], mails);

        var lines = await PlayersClub.ReadAsync(f, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Kind == MemberEventCatalogue.GameCancelled)
            .Select(n => n.UserId).ToListAsync());
        Assert.Equal(2, lines.Count);
        Assert.Contains(club.Alex, lines);
    }

    // ---- M4-6: the organiser's own seat absorbs a freed share --------------------------------

    private static async Task<decimal> OrganiserShareAsync(PlayersClub club, TestWebAppFactory f, Guid bookingId)
    {
        var detail = await (await club.Client(f, club.Organiser).GetAsync($"/api/v1/bookings/{bookingId}")).Content.ReadFromJsonAsync<JsonElement>();
        return detail.GetProperty("players").EnumerateArray().Single(p => p.GetProperty("seat").GetInt32() == 1)
            .GetProperty("share_credits").GetDecimal();
    }

    [SkippableFact]
    public async Task The_organisers_seat_absorbs_the_share_of_a_removed_declined_or_withdrawn_partner()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r4absorb");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Jo, 100m);

        // 32 among four: 8 each.
        var (bookingId, body) = await club.BookWithPlayersAsync(f,
            [new { userId = club.Sam }, new { userId = club.Alex }, new { userId = club.Jo }]);
        Assert.Equal(8m, await OrganiserShareAsync(club, f, bookingId));

        await OkAsync(club.Client(f, club.Organiser).DeleteAsync($"/api/v1/bookings/{bookingId}/players/{PlayersClub.SeatOf(body, 2)}"));
        Assert.Equal(16m, await OrganiserShareAsync(club, f, bookingId));

        await OkAsync(club.Client(f, club.Alex).PostAsync($"/api/v1/bookings/{bookingId}/players/{PlayersClub.SeatOf(body, 3)}/decline", null));
        Assert.Equal(24m, await OrganiserShareAsync(club, f, bookingId));

        var joSeat = PlayersClub.SeatOf(body, 4);
        await AcceptAsync(club, f, club.Jo, bookingId, joSeat);
        await OkAsync(club.Client(f, club.Jo).PostAsync($"/api/v1/bookings/{bookingId}/players/{joSeat}/withdraw", null));
        Assert.Equal(32m, await OrganiserShareAsync(club, f, bookingId));
    }

    /// <summary>Two partners declining at once both land, and the organiser's figure counts both.</summary>
    [SkippableFact]
    public async Task Two_partners_declining_together_both_land_and_the_organiser_absorbs_both()
    {
        Skip.IfNot(pg.Available, Skipped);
        var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r4absorbrace");
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f,
            [new { userId = club.Sam }, new { userId = club.Alex }, new { userId = club.Jo }]);

        var answers = await Task.WhenAll(
            club.Client(f, club.Sam).PostAsync($"/api/v1/bookings/{bookingId}/players/{PlayersClub.SeatOf(body, 2)}/decline", null),
            club.Client(f, club.Alex).PostAsync($"/api/v1/bookings/{bookingId}/players/{PlayersClub.SeatOf(body, 3)}/decline", null));
        Assert.All(answers, a => Assert.Equal(HttpStatusCode.OK, a.StatusCode));
        Assert.Equal(24m, await OrganiserShareAsync(club, f, bookingId));
    }
}
