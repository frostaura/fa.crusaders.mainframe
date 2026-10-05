using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 13, lane BE13b: who did it, and why, on the players' surfaces.
/// <list type="bullet">
/// <item>E13-4 (C13-4): a partner's withdrawal wrote no record, and the share going back was posted
/// as the club's system — the Night said "by the club's own automatic check" and the organiser's
/// receipt gave no cause.</item>
/// <item>E13-6 / X13-3: the partner's "Game cancelled" said nothing of the club having done it.</item>
/// <item>J13-3 (C13-6): mails to a member taken off, or pulled out, linked to a booking page that 404s
/// for them; the link now names their seat, which the page answers with what became of it.</item>
/// <item>J13-6 (C13-1): the booking detail says who cancelled a cancelled booking, and why.</item>
/// </list>
/// </summary>
public sealed class R13PlayersWordsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed record Game(PlayersClub Club, WebApplicationFactory<Program> App, CapturingMail Mail, Guid BookingId, Dictionary<Guid, Guid> SeatOf);

    /// <summary>Olive's 32-minute court three days out, with Sam (and, for two, Alex) accepted and paid.</summary>
    private async Task<Game> GameAsync(string prefix, int partners)
    {
        var mail = new CapturingMail();
        var app = CapturingMail.On(pg.SharedHost, mail);
        var club = await PlayersClub.SeedAsync(app, prefix);
        var who = new[] { club.Sam, club.Alex }.Take(partners).ToArray();
        foreach (var p in who) await club.CreditAsync(app, p, 50);
        await club.CreditAsync(app, club.Organiser, 100);
        var bookingId = await club.InsertBookingAsync(app, DateTimeOffset.UtcNow.AddDays(3).Storable());
        var added = await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = who.Select(p => (object)new { userId = p }).ToArray() });
        added.EnsureSuccessStatusCode();
        var seatOf = new Dictionary<Guid, Guid>();
        foreach (var seat in await club.SeatsAsync(app, bookingId))
        {
            if (seat.Seat == 1 || seat.UserId is not { } user) continue;
            seatOf[user] = seat.Id;
            (await club.Client(app, user).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}/accept",
                new { expectedShareMinutes = seat.ShareMinutes })).EnsureSuccessStatusCode();
        }
        // The accepts' own receipts go out now, so every mail a test reads is about what it did.
        for (var i = 0; i < 50 && await PeopleClub.DeliverAdminNoticesAsync(app) > 0; i++) { }
        mail.Sent.Clear();
        return new Game(club, app, mail, bookingId, seatOf);
    }

    private static async Task DeliverAsync(Game g)
    {
        for (var i = 0; i < 50 && await PeopleClub.DeliverAdminNoticesAsync(g.App) > 0; i++) { }
    }

    private static Task<List<MemberNotification>> InboxAsync(Game g, Guid user, string kind) =>
        PlayersClub.ReadAsync(g.App, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.UserId == user && n.BookingId == g.BookingId && n.Kind == kind).OrderBy(n => n.CreatedAt).ToListAsync());

    private static List<EmailMessage> MailTo(Game g, string handle) =>
        [.. g.Mail.Sent.Where(m => m.To == $"{handle}@{g.Club.Slug}.review.test")];

    private static string Flat(string? text) => System.Text.RegularExpressions.Regex.Replace(text ?? "", @"\s+", " ");

    // ------------------------------------------------------------------ E13-4: a withdrawal

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_withdrawal_is_recorded_as_the_partners_own_and_the_receipts_say_why(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r13wd{partners}", partners);
        var seat = g.SeatOf[g.Club.Sam];
        var paid = (await g.Club.SharesAsync(g.App, g.BookingId)).Where(l => l.UserId == g.Club.Sam).Sum(l => -l.AmountMinutes);

        (await g.Club.Client(g.App, g.Club.Sam).PostAsync($"/api/v1/bookings/{g.BookingId}/players/{seat}/withdraw", null)).EnsureSuccessStatusCode();

        // The record: Sam's own act, with what he had paid in.
        var audit = await PlayersClub.ReadAsync(g.App, db => db.AuditLogs.IgnoreQueryFilters()
            .SingleAsync(a => a.TenantId == g.Club.TenantId && a.Action == "players.withdrew"));
        Assert.Equal(g.Club.Sam, audit.ActorUserId);
        Assert.Equal(g.Club.Sam, audit.SubjectUserId);
        var details = JsonDocument.Parse(audit.DetailsJson!).RootElement;
        Assert.Equal(g.BookingId, details.GetProperty("booking_id").GetGuid());
        Assert.Equal(seat, details.GetProperty("participant_id").GetGuid());
        Assert.Equal(g.Club.Organiser, details.GetProperty("organiser_user_id").GetGuid());
        Assert.Equal(1, details.GetProperty("court_number").GetInt32());
        Assert.Equal(paid, details.GetProperty("paid_minutes").GetInt32());

        // The share back: Sam's act on both legs, not the club's system. Alex's rows are untouched.
        var back = (await g.Club.SharesAsync(g.App, g.BookingId)).Where(l => l.Reason == "Share of a split booking returned").ToList();
        Assert.Equal(2, back.Count);
        Assert.All(back, l => Assert.Equal(g.Club.Sam, l.ActorUserId));

        // The receipts say why.
        var olive = Assert.Single(await InboxAsync(g, g.Club.Organiser, MemberEventCatalogue.ShareMoved),
            n => n.Headline.Contains("went back", StringComparison.Ordinal));
        Assert.Equal($"{paid} minutes went back to Sam Partner — they withdrew from the game", olive.Headline);
        var sam = Assert.Single(await InboxAsync(g, g.Club.Sam, MemberEventCatalogue.ShareMoved),
            n => n.Headline.Contains("came back", StringComparison.Ordinal));
        Assert.Equal($"{paid} minutes of your share came back — you withdrew from the game", sam.Headline);
        // J13-3: Sam is off the game, so his link names his seat.
        Assert.Equal($"/bookings/{g.BookingId}?seat={seat}", sam.Link);
        Assert.Equal($"/bookings/{g.BookingId}", olive.Link);

        await DeliverAsync(g);
        var oliveMail = Assert.Single(MailTo(g, "olive.organiser"), m => m.Subject.Contains("Share returned", StringComparison.Ordinal));
        Assert.Contains("Sam Partner withdrew from the game", Flat(oliveMail.PlainBody), StringComparison.Ordinal);
        var samMail = Assert.Single(MailTo(g, "sam.partner"), m => m.Subject.Contains("Share refunded", StringComparison.Ordinal));
        Assert.Contains("You withdrew from the game", Flat(samMail.PlainBody), StringComparison.Ordinal);
        Assert.Contains($"/bookings/{g.BookingId}?seat={seat}", samMail.PlainBody, StringComparison.Ordinal);
    }

    /// <summary>
    /// BE13a's real-stack check saw no return straight after a withdrawal. The fixture varied: booked
    /// through the API with the organiser funded to exactly the price (no float), or with every free
    /// minute then spent on another court — the received share is held for its partners, so it covers
    /// the return either way, and the return posts in the withdrawal's own request, not on a sweep.
    /// </summary>
    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_withdrawal_returns_the_share_in_the_same_request(bool organiserSpentEverythingFree)
    {
        Skip.IfNot(pg.Available, Skipped);
        var app = pg.SharedHost;
        var club = await PlayersClub.SeedAsync(app, organiserSpentEverythingFree ? "r13wdspent" : "r13wdexact");
        await club.CreditAsync(app, club.Organiser, organiserSpentEverythingFree ? 64 : 32);
        await club.CreditAsync(app, club.Sam, 50);
        var (bookingId, body) = await club.BookWithPlayersAsync(app, [new { userId = club.Sam }]);
        var seat = PlayersClub.SeatOf(body, 2);
        var share = (await club.SeatsAsync(app, bookingId)).Single(s => s.Id == seat).ShareMinutes;
        (await club.Client(app, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept",
            new { expectedShareMinutes = share })).EnsureSuccessStatusCode();
        if (organiserSpentEverythingFree)
        {
            (await club.Client(app, club.Organiser).PostAsJsonAsync("/api/v1/bookings",
                new { courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(14).AddDays(1), sliceCount = 4 })).EnsureSuccessStatusCode();
            Assert.Equal(16, await PlayersClub.BalanceAsync(app, club.Organiser));   // only the held share is left
        }

        (await club.Client(app, club.Sam).PostAsync($"/api/v1/bookings/{bookingId}/players/{seat}/withdraw", null)).EnsureSuccessStatusCode();

        Assert.Equal(50, await PlayersClub.BalanceAsync(app, club.Sam));
        var back = (await club.SharesAsync(app, bookingId)).Where(l => l.Reason == "Share of a split booking returned").ToList();
        Assert.Equal(2, back.Count);
        Assert.All(back, l => Assert.Equal(club.Sam, l.ActorUserId));
        Assert.Null((await club.SeatsAsync(app, bookingId)).Single(s => s.Id == seat).ReturnPendingSince);
    }

    // ------------------------------------------------------------------ J13-3: taken off by the club

    [SkippableFact]
    public async Task A_member_the_club_took_off_is_linked_to_their_seat_in_every_mail()
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync("r13rmlink", 1);
        var seat = g.SeatOf[g.Club.Sam];

        (await g.Club.Client(g.App, g.Club.Admin, admin: true).PostAsJsonAsync(
            $"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/remove", new { reason = "Double booked" })).EnsureSuccessStatusCode();
        await DeliverAsync(g);

        var mails = MailTo(g, "sam.partner");
        Assert.NotEmpty(mails);
        Assert.All(mails, m =>
        {
            Assert.Contains($"/bookings/{g.BookingId}?seat={seat}", m.PlainBody, StringComparison.Ordinal);
            Assert.DoesNotContain($"/bookings/{g.BookingId}\n", m.PlainBody + "\n", StringComparison.Ordinal);
        });
        var refunded = Assert.Single(await InboxAsync(g, g.Club.Sam, MemberEventCatalogue.ShareMoved),
            n => n.Headline.Contains("came back", StringComparison.Ordinal));
        Assert.Equal($"/bookings/{g.BookingId}?seat={seat}", refunded.Link);
        // The organiser is still on the game: a plain link.
        Assert.All(MailTo(g, "olive.organiser"), m => Assert.DoesNotContain("?seat=", m.PlainBody, StringComparison.Ordinal));
    }

    // ------------------------------------------------------------------ E13-6: the partner told the club cancelled

    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task The_partners_game_cancelled_mail_says_who_cancelled_and_why(bool byClub)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync(byClub ? "r13gcclub" : "r13gcown", 2);

        var cancel = byClub
            ? g.Club.Client(g.App, g.Club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/cancel", new { reason = "Court resurfacing" })
            : g.Club.Client(g.App, g.Club.Organiser).PostAsync($"/api/v1/bookings/{g.BookingId}/cancel", null);
        (await cancel).EnsureSuccessStatusCode();
        await DeliverAsync(g);

        foreach (var handle in new[] { "sam.partner", "alex.partner" })
        {
            var mail = Assert.Single(MailTo(g, handle), m => m.Subject.StartsWith("Game cancelled", StringComparison.Ordinal));
            var body = Flat(mail.PlainBody);
            if (byClub)
            {
                Assert.Contains("The club has cancelled the booking Olive Organiser made for Court 1", body, StringComparison.Ordinal);
                Assert.Contains("Reason given by the club: Court resurfacing", body, StringComparison.Ordinal);
            }
            else
            {
                Assert.Contains("Olive Organiser has cancelled the booking for Court 1", body, StringComparison.Ordinal);
                Assert.DoesNotContain("The club has cancelled", body, StringComparison.Ordinal);
                Assert.DoesNotContain("Reason given by the club", body, StringComparison.Ordinal);
            }
        }
        var line = Assert.Single(await InboxAsync(g, g.Club.Sam, MemberEventCatalogue.GameCancelled));
        Assert.StartsWith(byClub ? "The club cancelled Court 1" : "Olive Organiser cancelled Court 1", line.Headline, StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------ J13-6: the detail says who and why

    private static async Task<JsonElement> DetailAsync(Game g, Guid viewer)
    {
        var response = await g.Club.Client(g.App, viewer).GetAsync($"/api/v1/bookings/{g.BookingId}");
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static (string? By, string? Cause, string? Reason) Cancellation(JsonElement d) =>
        (d.GetProperty("cancelled_by").GetString(), d.GetProperty("cancel_cause").GetString(), d.GetProperty("cancel_reason").GetString());

    [SkippableFact]
    public async Task The_booking_detail_says_the_club_cancelled_it_and_why()
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync("r13dtclub", 1);
        Assert.Equal((null, null, null), Cancellation(await DetailAsync(g, g.Club.Organiser)));

        (await g.Club.Client(g.App, g.Club.Admin, admin: true).PostAsJsonAsync(
            $"/api/v1/admin/bookings/{g.BookingId}/cancel", new { reason = "  Court resurfacing " })).EnsureSuccessStatusCode();

        Assert.Equal(("club", null, "Court resurfacing"), Cancellation(await DetailAsync(g, g.Club.Organiser)));
        Assert.Equal(("club", null, "Court resurfacing"), Cancellation(await DetailAsync(g, g.Club.Sam)));
    }

    [SkippableFact]
    public async Task The_booking_detail_says_the_organiser_cancelled_their_own()
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync("r13dtown", 1);

        (await g.Club.Client(g.App, g.Club.Organiser).PostAsync($"/api/v1/bookings/{g.BookingId}/cancel", null)).EnsureSuccessStatusCode();

        Assert.Equal(("member", null, null), Cancellation(await DetailAsync(g, g.Club.Sam)));
    }

    [SkippableFact]
    public async Task The_booking_detail_says_a_displaced_booking_was_the_clubs_and_why()
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync("r13dtdisp", 1);
        // What DisplacementAsync writes (the booking cancelled as ResoldTailRefunded, by the system).
        await g.Club.WriteAsync(g.App, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == g.BookingId);
            b.Status = BookingStatus.Cancelled;
            b.CancelledAt = DateTimeOffset.UtcNow;
            b.CancellationReason = BookingService.ResoldTailRefunded;
            b.DisplacedByBookingId = Guid.NewGuid();
        });

        Assert.Equal(("club", "displaced", null), Cancellation(await DetailAsync(g, g.Club.Organiser)));
    }
}
