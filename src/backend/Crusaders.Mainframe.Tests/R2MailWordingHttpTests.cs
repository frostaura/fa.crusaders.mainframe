using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 2, mail wording (lane B): the "Booking cancelled" mail named the court and not the
/// time (B-7, both the member's and the club's variant); a club collect omitted the admin's
/// reason while the adjust mail carried one, and the refund when the CLUB removed a partner read
/// "came back from Sam" — as though the organiser had done it (B-8).
/// </summary>
public sealed class R2MailWordingHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static async Task DeliverAsync(WebApplicationFactory<Program> f, PlayersClub club)
    {
        for (var i = 0; i < 200; i++)
        {
            var pending = await PlayersClub.ReadAsync(f, db => db.AdminNotifications.IgnoreQueryFilters()
                .CountAsync(n => n.TenantId == club.TenantId && n.State == AdminNotificationState.Pending));
            if (pending == 0) return;
            await PeopleClub.DeliverAdminNoticesAsync(f);
        }
    }

    private static List<EmailMessage> To(CapturingMail mail, PlayersClub club, string handle) =>
        [.. mail.Sent.Where(m => m.To.StartsWith($"{handle}@{club.Slug}.review.test", StringComparison.Ordinal))];

    private static string Body(EmailMessage m) => System.Text.RegularExpressions.Regex.Replace(m.PlainBody ?? m.HtmlBody, @"\s+", " ");

    /// <summary>The cancellation mail is sent after the commit, off the request: wait for it.</summary>
    private static async Task<EmailMessage> AwaitAsync(CapturingMail mail, PlayersClub club, string handle, string subjectStart)
    {
        for (var i = 0; i < 100; i++)
        {
            var found = To(mail, club, handle).FirstOrDefault(m => m.Subject.StartsWith(subjectStart, StringComparison.Ordinal));
            if (found is not null) return found;
            await Task.Delay(50);
        }
        throw new Xunit.Sdk.XunitException($"no mail to {handle} starting '{subjectStart}'");
    }

    [SkippableFact]
    public async Task Both_cancellation_mails_name_the_court_and_the_time()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = pg.SharedHost;
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await PlayersClub.SeedAsync(f, "r2cxdate");
        await club.CreditAsync(f, club.Organiser, 100m);
        var at = PlayersClub.Tomorrow(10).AddMinutes(15);
        var slot = $"Court 1 · {at.ToString(Api.Services.ClubDate.Format, System.Globalization.CultureInfo.InvariantCulture)}";

        var (own, _) = await club.BookWithPlayersAsync(f, [], at: at, slices: 1);
        Assert.True((await club.Client(f, club.Organiser).PostAsync($"/api/v1/bookings/{own}/cancel", null)).IsSuccessStatusCode);
        var mine = await AwaitAsync(mail, club, "olive.organiser", "Booking cancelled");
        Assert.Equal($"Booking cancelled — {slot}", mine.Subject);
        Assert.Contains($"Your booking on {slot} has been cancelled", Body(mine));

        var (theirs, _) = await club.BookWithPlayersAsync(f, [], at: at.AddHours(2), slices: 1);
        var slot2 = $"Court 1 · {at.AddHours(2).ToString(Api.Services.ClubDate.Format, System.Globalization.CultureInfo.InvariantCulture)}";
        var cancel = await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/bookings/{theirs}/cancel", new { });
        Assert.True(cancel.IsSuccessStatusCode, await cancel.Content.ReadAsStringAsync());
        var byClub = await AwaitAsync(mail, club, "olive.organiser", "The club cancelled");
        Assert.Equal($"The club cancelled your booking — {slot2}", byClub.Subject);
        Assert.Contains($"The club cancelled your booking on {slot2}", Body(byClub));
    }

    [SkippableFact]
    public async Task A_club_collect_carries_the_admins_reason_to_both_sides()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = pg.SharedHost;
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await PlayersClub.SeedAsync(f, "r2collect");
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var seat = PlayersClub.SeatOf(body, 2);
        var admin = club.Client(f, club.Admin, admin: true);
        Assert.True((await admin.PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players/{seat}/accept", new { reason = "At the desk" })).IsSuccessStatusCode);
        var collected = await admin.PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players/{seat}/collect",
            new { reason = "Plays tonight, pays later", allowNegativeBalance = true });
        Assert.True(collected.IsSuccessStatusCode, await collected.Content.ReadAsStringAsync());
        await DeliverAsync(f, club);

        var taken = Assert.Single(To(mail, club, "sam.partner"), m => m.Subject.StartsWith("The club collected your share", StringComparison.Ordinal));
        Assert.Contains("Reason given by the club: Plays tonight, pays later", Body(taken));
        var received = Assert.Single(To(mail, club, "olive.organiser"), m => m.Subject.Contains("paid their share", StringComparison.Ordinal));
        Assert.Contains("Reason given by the club: Plays tonight, pays later", Body(received));
    }

    [SkippableFact]
    public async Task A_partner_the_club_removes_is_told_the_club_did_it_and_why()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = pg.SharedHost;
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await PlayersClub.SeedAsync(f, "r2clubrm");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var seat = PlayersClub.SeatOf(body, 2);
        Assert.True((await club.Client(f, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareCredits = 16m })).IsSuccessStatusCode);
        await DeliverAsync(f, club);
        mail.Sent.Clear();

        var removed = await club.Client(f, club.Admin, admin: true).PostAsJsonAsync(
            $"/api/v1/admin/bookings/{bookingId}/players/{seat}/remove", new { reason = "Injured, can't play" });
        Assert.True(removed.IsSuccessStatusCode, await removed.Content.ReadAsStringAsync());
        await DeliverAsync(f, club);

        var sam = To(mail, club, "sam.partner");
        var refund = Assert.Single(sam, m => m.Subject.StartsWith("The club took you off the game", StringComparison.Ordinal));
        Assert.Contains("The club took you off the game Olive Organiser booked", Body(refund));
        Assert.Contains("Reason given by the club: Injured, can't play", Body(refund));
        Assert.DoesNotContain("came back from", Body(refund));
        var off = Assert.Single(sam, m => m.Subject.StartsWith("You've been taken off a game", StringComparison.Ordinal));
        Assert.Contains("The club has taken you off the booking Olive Organiser made", Body(off));

        var olive = Assert.Single(To(mail, club, "olive.organiser"), m => m.Subject.StartsWith("The club took Sam Partner off your game", StringComparison.Ordinal));
        Assert.Contains("Reason given by the club: Injured, can't play", Body(olive));
    }

    /// <summary>The organiser's own removal still reads as the organiser's — the club wording is the club's only.</summary>
    [SkippableFact]
    public async Task An_organisers_own_removal_keeps_its_own_words()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var factory = pg.SharedHost;
        var mail = new CapturingMail();
        var f = CapturingMail.On(factory, mail);
        var club = await PlayersClub.SeedAsync(f, "r2ownrm");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var seat = PlayersClub.SeatOf(body, 2);
        Assert.True((await club.Client(f, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareCredits = 16m })).IsSuccessStatusCode);
        await DeliverAsync(f, club);
        mail.Sent.Clear();

        Assert.True((await club.Client(f, club.Organiser).DeleteAsync($"/api/v1/bookings/{bookingId}/players/{seat}")).IsSuccessStatusCode);
        await DeliverAsync(f, club);

        var sam = To(mail, club, "sam.partner");
        Assert.Single(sam, m => m.Subject.StartsWith("Share refunded", StringComparison.Ordinal));
        Assert.DoesNotContain(sam, m => m.Subject.Contains("The club", StringComparison.Ordinal));
    }
}
