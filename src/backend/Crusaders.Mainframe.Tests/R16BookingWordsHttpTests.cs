using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 16, lane BE16a — what the booker is told:
/// <list type="bullet">
/// <item>E16-3 / J16-8: the club cancelling a session that had started said "Somebody had already checked
/// in" — even to the organiser who had checked in himself — and the frame's <c>checked_in_by_name</c> and
/// the inbox line named nobody. Now the checker is named, and "you" to themselves.</item>
/// <item>E16-4: the "Missed booking" and "No-show reversed" mails named the court only; a member with two
/// bookings on one court could not tell which. Now the subject and a When row say the day and time.</item>
/// </list>
/// </summary>
public sealed partial class R16BookingWordsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed record Game(PlayersClub Club, WebApplicationFactory<Program> App, CapturingMail Mail, Guid BookingId);

    private async Task<Game> GameAsync(string prefix, int partners, DateTimeOffset startsAt)
    {
        var mail = new CapturingMail();
        var app = CapturingMail.On(pg.SharedHost, mail);
        var club = await PlayersClub.SeedAsync(app, prefix);
        var who = new[] { club.Sam, club.Alex }.Take(partners).ToArray();
        foreach (var p in who) await club.CreditAsync(app, p, 50);
        await club.CreditAsync(app, club.Organiser, 100);
        var bookingId = await club.InsertBookingAsync(app, startsAt.Storable());
        if (partners > 0)
        {
            (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
                new { players = who.Select(p => (object)new { userId = p }).ToArray() })).EnsureSuccessStatusCode();
            foreach (var seat in await club.SeatsAsync(app, bookingId))
            {
                if (seat.Seat == 1 || seat.UserId is not { } user) continue;
                (await club.Client(app, user).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}/accept",
                    new { expectedShareMinutes = seat.ShareMinutes })).EnsureSuccessStatusCode();
            }
        }
        for (var i = 0; i < 50 && await PeopleClub.DeliverAdminNoticesAsync(app) > 0; i++) { }
        mail.Sent.Clear();
        return new Game(club, app, mail, bookingId);
    }

    private static string Flat(string? text) => Regex.Replace(text ?? "", @"\s+", " ");

    private static async Task<EmailMessage> MailAsync(Game g, string handle, string subjectStart)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (true)
        {
            var found = g.Mail.Sent.Where(m => m.To == $"{handle}@{g.Club.Slug}.review.test" && m.Subject.StartsWith(subjectStart, StringComparison.Ordinal)).ToList();
            if (found.Count > 0 || DateTime.UtcNow > deadline) return Assert.Single(found);
            await Task.Delay(100);
        }
    }

    // ------------------------------------------------------------------ E16-3

    /// <summary>
    /// The club cancels a started session. Who checked in is named on the booker's mail, inbox line and
    /// frame: a partner by name (their own seat carries the check-in), or "you" when it was the booker.
    /// </summary>
    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task The_club_cancelling_a_started_session_names_who_checked_in(bool partnerScanned)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r16chk{(partnerScanned ? "p" : "o")}", 1, DateTimeOffset.UtcNow.AddDays(3));
        var checkedIn = DateTimeOffset.UtcNow.AddMinutes(-4).Storable();
        await g.Club.WriteAsync(g.App, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == g.BookingId);
            b.StartsAt = DateTimeOffset.UtcNow.AddMinutes(-5).Storable();
            b.EndsAt = b.StartsAt.AddMinutes(32);
            b.CheckedInAt = checkedIn;
            b.LightsOnCuedAt = checkedIn;
            if (partnerScanned) db.BookingParticipants.IgnoreQueryFilters().First(p => p.BookingId == g.BookingId && p.UserId == g.Club.Sam).CheckedInAt = checkedIn;
        });
        var olive = g.App.Services.GetRequiredService<IRealtimeBus>().Subscribe(RealtimeTopic.Wallet(g.Club.TenantId, g.Club.Organiser));

        (await g.Club.Client(g.App, g.Club.Admin, admin: true).PostAsJsonAsync(
            $"/api/v1/admin/bookings/{g.BookingId}/cancel", new { reason = "Flooded court" })).EnsureSuccessStatusCode();

        var frames = new List<JsonElement>();
        while (olive.Reader.TryRead(out var f))
        {
            if (f.Event == LedgerService.BalanceEvent) frames.Add(JsonDocument.Parse(f.JsonPayload).RootElement.Clone());
        }
        var frame = Assert.Single(frames, f => f.GetProperty("reason").GetString() == "cancelled_no_refund");
        var named = frame.GetProperty("checked_in_by_name");
        if (partnerScanned) Assert.Equal("Sam Partner", named.GetString());
        else Assert.Equal(JsonValueKind.Null, named.ValueKind);

        var line = Assert.Single(await PlayersClub.ReadAsync(g.App, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.UserId == g.Club.Organiser && n.BookingId == g.BookingId && n.Kind == MemberEventCatalogue.GameCancelled).ToListAsync()));
        Assert.EndsWith(partnerScanned
            ? " — it had started (Sam Partner had checked in), so nothing was refunded"
            : " — it had started (you had checked in), so nothing was refunded", line.Headline, StringComparison.Ordinal);

        var body = Flat((await MailAsync(g, "olive.organiser", "The club cancelled your booking")).PlainBody);
        Assert.Contains(partnerScanned ? "Sam Partner had checked in already" : "You had checked in already", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Somebody", body, StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------ E16-4

    [GeneratedRegex(@"^Court 1 on \w{3} \d{1,2} \w{3} at \d{2}:\d{2}$")]
    private static partial Regex CourtAndDay();

    /// <summary>
    /// A swept no-show and its reversal by a late scan: both mails name court AND day and time, in the
    /// subject and in a When row (varied: the booker's own scan, and a partner's).
    /// </summary>
    [SkippableTheory]
    [InlineData(0)]
    [InlineData(1)]
    public async Task The_no_show_and_reversal_mails_say_which_booking(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var start = DateTimeOffset.UtcNow.AddMinutes(-10).Storable();
        var g = await GameAsync($"r16when{partners}", partners, start);

        await new NoShowWorker(g.App.Services, g.App.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance)
            .TickAsync(DateTimeOffset.UtcNow, default);
        var missed = await MailAsync(g, "olive.organiser", "Missed booking — ");
        Assert.Matches(CourtAndDay(), missed.Subject["Missed booking — ".Length..]);
        var where = missed.Subject["Missed booking — ".Length..];
        Assert.Contains("When", Flat(missed.PlainBody), StringComparison.Ordinal);

        var scanner = partners > 0 ? g.Club.Sam : g.Club.Organiser;
        var result = await g.Club.InClubAsync(g.App, async sp =>
        {
            var row = await sp.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(b => b.Id == g.BookingId);
            return await sp.GetRequiredService<BookingService>().ReverseNoShowAsync(
                row, start.AddMinutes(2), Guid.Empty, default, scan: new ReversalScan(scanner, "member_code"));
        });
        Assert.IsType<NoShowReversalResult.Ok>(result);

        var reversed = await MailAsync(g, "olive.organiser", "No-show reversed — ");
        Assert.Equal($"No-show reversed — {where}", reversed.Subject);
        Assert.Contains("When", Flat(reversed.PlainBody), StringComparison.Ordinal);
    }

    /// <summary>The templates themselves: a bare court still reads as before; a known start adds the day and time.</summary>
    [Fact]
    public void The_booking_mails_carry_the_day_when_given_it()
    {
        var club = EmailCatalogue.Riverside;
        var slot = new CourtSlot("Court 2", "Tue 13 Oct, 06:00");

        Assert.Equal("Missed booking — Court 2 on Tue 13 Oct at 06:00", EmailTemplates.BookingNoShow(club, "a@x.review.test", slot, 24, 7).Subject);
        Assert.Equal("No-show reversed — Court 2 on Tue 13 Oct at 06:00", EmailTemplates.NoShowReversed(club, "a@x.review.test", slot, 24, 7).Subject);
        Assert.Equal("Outage refund reversed — Court 2 on Tue 13 Oct at 06:00", EmailTemplates.OutageRefundReversed(club, "a@x.review.test", slot, 24).Subject);
        Assert.Contains("Tue 13 Oct, 06:00", Flat(EmailTemplates.BookingNoShow(club, "a@x.review.test", slot, 24, 7).PlainBody), StringComparison.Ordinal);
        Assert.Equal("Missed booking — Court 2", EmailTemplates.BookingNoShow(club, "a@x.review.test", "Court 2", 24, 7).Subject);
    }
}
