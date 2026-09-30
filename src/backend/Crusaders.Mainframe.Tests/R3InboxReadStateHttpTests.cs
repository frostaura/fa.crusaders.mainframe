using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 3, I-9: invites answered in the app stayed Unread in the inbox, and the member's
/// own "You paid…" receipts counted as unread — a bell of 6 with nothing to do. An invite answered
/// (accepted or declined) marks its invite and reminder lines read and resolved in the answer's own
/// save; a receipt of the member's own action is born read. A receipt of somebody ELSE's action on
/// their money — the organiser told their partner paid — still arrives unread.
/// </summary>
public sealed class R3InboxReadStateHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static Task<List<MemberNotification>> LinesAsync(TestWebAppFactory f, Guid user, Guid bookingId) =>
        PlayersClub.ReadAsync(f, db => db.MemberNotifications.IgnoreQueryFilters().AsNoTracking()
            .Where(n => n.UserId == user && n.BookingId == bookingId).ToListAsync());

    [SkippableFact]
    public async Task Answering_an_invite_reads_it_and_your_own_payment_receipt_is_born_read()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(f, "r3i9inbox");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }, new { userId = club.Alex }]);

        var samInvite = Assert.Single(await LinesAsync(f, club.Sam, bookingId), n => n.Kind == MemberEventCatalogue.Invited);
        Assert.Null(samInvite.ReadAt);

        var seat = PlayersClub.SeatOf(body, 2);
        var shown = (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ShareCredits;
        Assert.True((await club.Client(f, club.Sam).PostAsJsonAsync(
            $"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareCredits = shown })).IsSuccessStatusCode);

        var sam = await LinesAsync(f, club.Sam, bookingId);
        var invite = Assert.Single(sam, n => n.Kind == MemberEventCatalogue.Invited);
        Assert.NotNull(invite.ReadAt);
        Assert.NotNull(invite.ResolvedAt);
        var paid = Assert.Single(sam, n => n.Kind == MemberEventCatalogue.ShareMoved);
        Assert.StartsWith("You paid", paid.Headline);
        Assert.NotNull(paid.ReadAt);
        Assert.Equal(0, (await club.Client(f, club.Sam).GetFromJsonAsync<JsonElement>("/api/v1/me/notifications"))
            .GetProperty("unread_count").GetInt32());

        // The organiser did not act: "Sam paid you" is news to them.
        var received = Assert.Single(await LinesAsync(f, club.Organiser, bookingId), n => n.Kind == MemberEventCatalogue.ShareMoved);
        Assert.Null(received.ReadAt);

        // Declining reads the invite too.
        var alexSeat = PlayersClub.SeatOf(body, 3);
        Assert.True((await club.Client(f, club.Alex).PostAsync($"/api/v1/bookings/{bookingId}/players/{alexSeat}/decline", null)).IsSuccessStatusCode);
        var alexInvite = Assert.Single(await LinesAsync(f, club.Alex, bookingId), n => n.Kind == MemberEventCatalogue.Invited);
        Assert.NotNull(alexInvite.ReadAt);
        Assert.NotNull(alexInvite.ResolvedAt);
    }
}
