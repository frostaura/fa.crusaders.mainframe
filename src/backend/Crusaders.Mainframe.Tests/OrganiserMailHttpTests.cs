using System.Net;
using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// What the organiser is mailed about their partners (browser lane BM-20, BM-21): a decline or a
/// withdrawal is mailed, not only put on the inbox; a part payment is ONE mail that says what was paid
/// and what is left, never a second "paid their share" beside it; and the organiser's own mails say
/// they organised the booking, not that somebody added them to it.
/// </summary>
public sealed class OrganiserMailHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static async Task DeliverAsync(WebApplicationFactory<Program> f)
    {
        for (var i = 0; i < 50 && await PeopleClub.DeliverAdminNoticesAsync(f, DateTimeOffset.UtcNow) > 0; i++) { }
    }

    private static List<EmailMessage> ToOrganiser(CapturingMail mail) =>
        mail.Sent.Where(m => m.To.StartsWith("olive.organiser@", StringComparison.Ordinal)).ToList();

    private static async Task<(PlayersClub Club, Guid BookingId, Guid SamSeat)> GameAsync(WebApplicationFactory<Program> f, string prefix, int samMinutes)
    {
        var club = await PlayersClub.SeedAsync(f, prefix);
        await club.CreditAsync(f, club.Organiser, 100);
        await club.CreditAsync(f, club.Sam, samMinutes);
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(3).Storable());
        (await club.Client(f, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = new object[] { new { userId = club.Sam } } })).EnsureSuccessStatusCode();
        var seat = (await club.SeatsAsync(f, bookingId)).Single(s => s.UserId == club.Sam);
        return (club, bookingId, seat.Id);
    }

    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_partner_who_declines_or_withdraws_is_mailed_to_the_organiser(bool withdraw)
    {
        Skip.IfNot(pg.Available, Skipped);
        var mail = new CapturingMail();
        var f = CapturingMail.On(pg.SharedHost, mail);
        var (club, bookingId, seat) = await GameAsync(f, withdraw ? "om-wd" : "om-dec", samMinutes: 100);
        var sam = club.Client(f, club.Sam);

        if (withdraw)
        {
            var share = (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ShareMinutes;
            Assert.Equal(HttpStatusCode.OK, (await sam.PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareMinutes = share })).StatusCode);
            await DeliverAsync(f);
            mail.Sent.Clear();
        }
        var answer = await sam.PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/{(withdraw ? "withdraw" : "decline")}", new { });
        Assert.True(answer.IsSuccessStatusCode, await answer.Content.ReadAsStringAsync());
        await DeliverAsync(f);

        var told = Assert.Single(ToOrganiser(mail), m => m.Subject.StartsWith("Sam Partner", StringComparison.Ordinal)
                                                         && (m.Subject.Contains("can't make it") || m.Subject.Contains("pulled out")));
        Assert.Contains(withdraw ? "pulled out" : "can't make it", told.Subject);
        Assert.Contains("you organised this court booking", told.PlainBody);
        Assert.DoesNotContain("credit", told.PlainBody, StringComparison.OrdinalIgnoreCase);

        // The inbox line is still there, under the same kind.
        Assert.True(await PlayersClub.ReadAsync(f, db => db.MemberNotifications.IgnoreQueryFilters()
            .AnyAsync(n => n.TenantId == club.TenantId && n.UserId == club.Organiser && n.Kind == MemberEventCatalogue.Response)));
    }

    [SkippableFact]
    public async Task An_accept_stays_on_the_inbox_and_is_not_mailed_as_a_response()
    {
        Skip.IfNot(pg.Available, Skipped);
        var mail = new CapturingMail();
        var f = CapturingMail.On(pg.SharedHost, mail);
        var (club, bookingId, seat) = await GameAsync(f, "om-acc", samMinutes: 100);
        var share = (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ShareMinutes;
        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Sam).PostAsJsonAsync(
            $"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareMinutes = share })).StatusCode);
        await DeliverAsync(f);

        Assert.False(await PlayersClub.ReadAsync(f, db => db.AdminNotifications.IgnoreQueryFilters()
            .AnyAsync(n => n.TenantId == club.TenantId && n.Kind == MemberEventCatalogue.Response)));
        // The payment's receipt is the organiser's mail about it.
        Assert.Single(ToOrganiser(mail), m => m.Subject.Contains("paid their share", StringComparison.Ordinal));
    }

    [SkippableFact]
    public async Task A_part_payment_is_one_mail_to_the_organiser_saying_what_was_paid_and_left()
    {
        Skip.IfNot(pg.Available, Skipped);
        var mail = new CapturingMail();
        var f = CapturingMail.On(pg.SharedHost, mail);
        var (club, bookingId, seat) = await GameAsync(f, "om-part", samMinutes: 6);
        var share = (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ShareMinutes;
        Assert.True(share > 6, $"the fixture needs Sam short of a {share}-minute share");
        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Sam).PostAsJsonAsync(
            $"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareMinutes = share, payMinutes = 6 })).StatusCode);
        await DeliverAsync(f);

        var olive = ToOrganiser(mail);
        Assert.DoesNotContain(olive, m => m.Subject.Contains("paid their share", StringComparison.Ordinal));
        var shortfall = Assert.Single(olive);
        Assert.StartsWith($"Sam Partner paid 6 minutes of their {share} minutes share", shortfall.Subject);
        Assert.Contains("you organised this court booking", shortfall.PlainBody);
        Assert.DoesNotContain("added you to a court booking", shortfall.PlainBody);

        // The receipt is still on the organiser's inbox, as the record of the minutes that moved.
        Assert.True(await PlayersClub.ReadAsync(f, db => db.MemberNotifications.IgnoreQueryFilters()
            .AnyAsync(n => n.TenantId == club.TenantId && n.UserId == club.Organiser && n.Kind == MemberEventCatalogue.ShareMoved)));
    }
}
