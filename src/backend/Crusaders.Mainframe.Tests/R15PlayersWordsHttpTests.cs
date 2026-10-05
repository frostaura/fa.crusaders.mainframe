using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 15, lane BE15b — what a partner and an organiser are told, through the whole stack:
/// <list type="bullet">
/// <item>E15-1: the club cancelling a STARTED session (nothing refunded) told every partner their share
/// "comes back" — it stands.</item>
/// <item>E15-4: the cancelled game's <c>players.game_cancelled</c> record landed after the share rows it
/// caused, so the Night and the CSV read effect before cause.</item>
/// <item>J15-1 (server): a member taken off a game, or added by the club, was told it was the
/// organiser — the 404 and the seat read now say <c>removed_by</c>, the invites <c>added_by_club</c>.</item>
/// <item>J15-5: inbox lines with no court and no day; the re-collection after a late check-in named
/// nobody. J15-9: a split change to a share the club settled outside the app. E15-8: the
/// settle-outside receipt dropped the desk's reason.</item>
/// </list>
/// </summary>
public sealed class R15PlayersWordsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed record Game(
        PlayersClub Club, WebApplicationFactory<Program> App, CapturingMail Mail, Guid BookingId, DateTimeOffset Start,
        Dictionary<Guid, Guid> SeatOf)
    {
        /// <summary>The court and start as every inbox line says them: "Court 1, Thu 8 Oct, 08:00".</summary>
        public string Where => $"Court 1, {Start.ToString("ddd d MMM, HH:mm", CultureInfo.InvariantCulture)}";
    }

    /// <summary>Olive's 32-minute court three days out at 08:00, with Sam (and, for two, Alex) accepted and paid.</summary>
    private async Task<Game> GameAsync(string prefix, int partners, int partnerFloat = 50)
    {
        var mail = new CapturingMail();
        var app = CapturingMail.On(pg.SharedHost, mail);
        var club = await PlayersClub.SeedAsync(app, prefix);
        var who = new[] { club.Sam, club.Alex }.Take(partners).ToArray();
        foreach (var p in who) await club.CreditAsync(app, p, partnerFloat);
        await club.CreditAsync(app, club.Organiser, 100);
        var start = PlayersClub.Tomorrow(8).AddDays(2);
        var bookingId = await club.InsertBookingAsync(app, start);
        (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = who.Select(p => (object)new { userId = p }).ToArray() })).EnsureSuccessStatusCode();
        var seatOf = new Dictionary<Guid, Guid>();
        foreach (var seat in await club.SeatsAsync(app, bookingId))
        {
            if (seat.Seat == 1 || seat.UserId is not { } user) continue;
            seatOf[user] = seat.Id;
            // With nothing to pay with, the member's own accept is refused (402): the club says yes for them, consenting to nothing.
            var accept = partnerFloat > 0
                ? club.Client(app, user).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}/accept", new { expectedShareMinutes = seat.ShareMinutes })
                : club.Client(app, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players/{seat.Id}/accept", new { reason = "Playing tonight" });
            (await accept).EnsureSuccessStatusCode();
        }
        await DeliverAsync(app);
        mail.Sent.Clear();
        return new Game(club, app, mail, bookingId, start, seatOf);
    }

    private static async Task DeliverAsync(WebApplicationFactory<Program> app)
    {
        for (var i = 0; i < 50 && await PeopleClub.DeliverAdminNoticesAsync(app) > 0; i++) { }
    }

    private static string Flat(string? text) => System.Text.RegularExpressions.Regex.Replace(text ?? "", @"\s+", " ");

    private static List<EmailMessage> MailTo(Game g, string handle) =>
        [.. g.Mail.Sent.Where(m => m.To == $"{handle}@{g.Club.Slug}.review.test")];

    private static Task<List<MemberNotification>> InboxAsync(Game g, Guid user, string kind) =>
        PlayersClub.ReadAsync(g.App, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.UserId == user && n.BookingId == g.BookingId && n.Kind == kind)
            .OrderBy(n => n.CreatedAt).ToListAsync());

    private static HttpClient Admin(Game g) => g.Club.Client(g.App, g.Club.Admin, admin: true);

    // ------------------------------------------------------------------ E15-1

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task The_club_cancelling_a_started_session_tells_each_partner_their_share_stands(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r15stnd{partners}", partners);
        var shares = (await g.Club.SharesAsync(g.App, g.BookingId)).Count;
        await g.Club.WriteAsync(g.App, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == g.BookingId);
            b.StartsAt = DateTimeOffset.UtcNow.AddMinutes(-5).Storable();
            b.EndsAt = b.StartsAt.AddMinutes(32);
            b.CheckedInAt = b.StartsAt.AddMinutes(1);
            b.LightsOnCuedAt = b.CheckedInAt;
        });

        (await Admin(g).PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/cancel", new { reason = "Flooded court" })).EnsureSuccessStatusCode();
        await DeliverAsync(g.App);

        Assert.Equal(shares, (await g.Club.SharesAsync(g.App, g.BookingId)).Count);   // nothing went back: it stands
        foreach (var (partner, handle) in new[] { (g.Club.Sam, "sam.partner"), (g.Club.Alex, "alex.partner") }.Take(partners))
        {
            var mail = Assert.Single(MailTo(g, handle), m => m.Subject.StartsWith("Game cancelled", StringComparison.Ordinal));
            var text = Flat(mail.PlainBody) + Flat(mail.HtmlBody);
            Assert.Contains("The session had started, so any share you paid stands", text, StringComparison.Ordinal);
            Assert.DoesNotContain("comes back", text, StringComparison.Ordinal);
            Assert.DoesNotContain("separate receipt", text, StringComparison.Ordinal);

            var line = Assert.Single(await InboxAsync(g, partner, MemberEventCatalogue.GameCancelled));
            Assert.Equal($"The club cancelled {(await RefreshedWhereAsync(g))} — it had started, so your share stands", line.Headline);
        }
    }

    /// <summary>The court and start after the fixture moved the booking.</summary>
    private static async Task<string> RefreshedWhereAsync(Game g)
    {
        var start = await PlayersClub.ReadAsync(g.App, db => db.Bookings.IgnoreQueryFilters().Where(b => b.Id == g.BookingId).Select(b => b.StartsAt).FirstAsync());
        return $"Court 1, {start.ToString("ddd d MMM, HH:mm", CultureInfo.InvariantCulture)}";
    }

    // ------------------------------------------------------------------ E15-4

    [SkippableTheory]
    [InlineData(1, false)]
    [InlineData(2, false)]
    [InlineData(2, true)]
    public async Task A_cancelled_games_record_comes_before_the_shares_it_sends_back(int partners, bool byClub)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r15ord{partners}{(byClub ? "c" : "m")}", partners);
        var before = DateTimeOffset.UtcNow;

        var cancel = byClub
            ? Admin(g).PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/cancel", new { reason = "Court resurfacing" })
            : g.Club.Client(g.App, g.Club.Organiser).PostAsync($"/api/v1/bookings/{g.BookingId}/cancel", null);
        (await cancel).EnsureSuccessStatusCode();

        var records = await PlayersClub.ReadAsync(g.App, db => db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == g.Club.TenantId && a.Action == "players.game_cancelled").ToListAsync());
        Assert.Equal(partners, records.Count);
        var returns = (await g.Club.SharesAsync(g.App, g.BookingId)).Where(l => l.CreatedAt >= before).ToList();
        Assert.Equal(partners * 2, returns.Count);
        Assert.True(records.Max(r => r.CreatedAt) <= returns.Min(l => l.CreatedAt),
            $"cause {records.Max(r => r.CreatedAt):O} after effect {returns.Min(l => l.CreatedAt):O}");
    }

    // ------------------------------------------------------------------ J15-1: who took them off, who added them

    [SkippableTheory]
    [InlineData(true, 1)]
    [InlineData(false, 1)]
    [InlineData(true, 2)]
    [InlineData(false, 2)]
    public async Task The_404_and_the_seat_read_say_who_took_the_member_off(bool byClub, int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r15rmby{(byClub ? "c" : "o")}{partners}", partners);
        var seat = g.SeatOf[g.Club.Sam];
        var remove = byClub
            ? Admin(g).PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/remove", new { reason = "Double booked" })
            : g.Club.Client(g.App, g.Club.Organiser).DeleteAsync($"/api/v1/bookings/{g.BookingId}/players/{seat}");
        (await remove).EnsureSuccessStatusCode();
        var sam = g.Club.Client(g.App, g.Club.Sam);

        var detail = await sam.GetAsync($"/api/v1/bookings/{g.BookingId}");
        Assert.Equal(HttpStatusCode.NotFound, detail.StatusCode);
        var body = await detail.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(seat, body.GetProperty("own_seat_id").GetGuid());
        Assert.Equal(byClub ? "club" : "organiser", body.GetProperty("removed_by").GetString());

        var mine = await sam.GetFromJsonAsync<JsonElement>($"/api/v1/me/invites/{seat}");
        Assert.Equal("removed", mine.GetProperty("status").GetString());
        Assert.Equal(byClub ? "club" : "organiser", mine.GetProperty("removed_by").GetString());

        // A stranger learns nothing.
        var stranger = await (await g.Club.Client(g.App, g.Club.Bystander).GetAsync($"/api/v1/bookings/{g.BookingId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, stranger.GetProperty("removed_by").ValueKind);
    }

    [SkippableFact]
    public async Task A_member_who_withdrew_was_removed_by_nobody()
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync("r15rmwd", 2);
        var seat = g.SeatOf[g.Club.Sam];
        var sam = g.Club.Client(g.App, g.Club.Sam);
        (await sam.PostAsync($"/api/v1/bookings/{g.BookingId}/players/{seat}/withdraw", null)).EnsureSuccessStatusCode();

        var body = await (await sam.GetAsync($"/api/v1/bookings/{g.BookingId}")).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(seat, body.GetProperty("own_seat_id").GetGuid());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("removed_by").ValueKind);
        Assert.Equal(JsonValueKind.Null, (await sam.GetFromJsonAsync<JsonElement>($"/api/v1/me/invites/{seat}")).GetProperty("removed_by").ValueKind);
    }

    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task An_invite_says_whether_the_club_added_the_member(bool byClub)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r15addby{(byClub ? "c" : "o")}", 1);
        var add = byClub
            ? Admin(g).PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players", new { userId = g.Club.Jo, reason = "Phoned in" })
            : g.Club.Client(g.App, g.Club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{g.BookingId}/players", new { players = new object[] { new { userId = g.Club.Jo } } });
        (await add).EnsureSuccessStatusCode();
        var seat = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.UserId == g.Club.Jo).Id;
        var jo = g.Club.Client(g.App, g.Club.Jo);

        var list = await jo.GetFromJsonAsync<JsonElement>("/api/v1/me/invites");
        var item = Assert.Single(list.GetProperty("items").EnumerateArray());
        Assert.Equal(byClub, item.GetProperty("added_by_club").GetBoolean());
        Assert.Equal(byClub, (await jo.GetFromJsonAsync<JsonElement>($"/api/v1/me/invites/{seat}")).GetProperty("added_by_club").GetBoolean());
        // Sam, invited by the organiser in the fixture, was not added by the club.
        Assert.False((await g.Club.Client(g.App, g.Club.Sam).GetFromJsonAsync<JsonElement>($"/api/v1/me/invites/{g.SeatOf[g.Club.Sam]}"))
            .GetProperty("added_by_club").GetBoolean());
    }

    // ------------------------------------------------------------------ J15-5: inbox lines carry court and day

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_paid_share_and_a_split_change_name_the_court_and_the_day_in_the_inbox(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r15inb{partners}", partners);
        var share = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.Id == g.SeatOf[g.Club.Sam]).ShareMinutes;

        var samPaid = Assert.Single(await InboxAsync(g, g.Club.Sam, MemberEventCatalogue.ShareMoved));
        Assert.Equal($"You paid Olive Organiser {share} minutes for {g.Where}", samPaid.Headline);
        var oliveGot = (await InboxAsync(g, g.Club.Organiser, MemberEventCatalogue.ShareMoved)).First(n => n.Headline.StartsWith("Sam Partner", StringComparison.Ordinal));
        Assert.Equal($"Sam Partner paid you {share} minutes for {g.Where}", oliveGot.Headline);

        var organiserSeat = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.Seat == 1).Id;
        (await g.Club.Client(g.App, g.Club.Organiser).PutAsJsonAsync($"/api/v1/bookings/{g.BookingId}/split", new
        {
            mode = "ratio",
            seats = new object[] { new { participantId = organiserSeat, weight = 3 } }
                .Concat(g.SeatOf.Values.Select(s => (object)new { participantId = s, weight = 1 })).ToArray(),
        })).EnsureSuccessStatusCode();
        var now = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.Id == g.SeatOf[g.Club.Sam]).ShareMinutes;

        var changed = Assert.Single(await InboxAsync(g, g.Club.Sam, MemberEventCatalogue.GameChanged));
        Assert.Equal($"Olive Organiser changed your share of {g.Where} — now {now} minutes", changed.Headline);
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task The_clubs_collect_names_the_court_and_the_day_in_the_inbox(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r15col{partners}", partners, partnerFloat: 0);   // accepted, nothing paid
        var seat = g.SeatOf[g.Club.Sam];
        var share = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.Id == seat).ShareMinutes;

        (await Admin(g).PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/collect",
            new { reason = "Paid at the bar tab", allowNegativeBalance = true })).EnsureSuccessStatusCode();

        var line = Assert.Single(await InboxAsync(g, g.Club.Sam, MemberEventCatalogue.ShareMoved));
        Assert.Equal($"The club collected {share} minutes for your share of {g.Where}", line.Headline);
        var olive = Assert.Single(await InboxAsync(g, g.Club.Organiser, MemberEventCatalogue.ShareMoved));
        Assert.Equal($"The club collected Sam Partner's share of {g.Where}: {share} minutes", olive.Headline);
    }

    [SkippableFact]
    public async Task A_share_taken_again_after_a_late_check_in_names_the_scanner_with_the_court_and_day()
    {
        Skip.IfNot(pg.Available, Skipped);
        var start = DateTimeOffset.UtcNow.AddMinutes(-10).Storable();
        var mail = new CapturingMail();
        var app = CapturingMail.On(pg.SharedHost, mail);
        var club = await PlayersClub.SeedAsync(app, "r15again");
        await club.CreditAsync(app, club.Sam, 50);
        var bookingId = await club.InsertBookingAsync(app, start);
        await club.CreditAsync(app, club.Organiser, 32);
        (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = new object[] { new { userId = club.Sam } } })).EnsureSuccessStatusCode();
        var seat = (await club.SeatsAsync(app, bookingId)).Single(s => s.Seat == 2);
        (await club.Client(app, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}/accept",
            new { expectedShareMinutes = seat.ShareMinutes })).EnsureSuccessStatusCode();
        await new NoShowWorker(app.Services, app.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance)
            .TickAsync(DateTimeOffset.UtcNow, default);
        await club.InClubAsync(app, async sp =>
        {
            var row = await sp.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(b => b.Id == bookingId);
            return await sp.GetRequiredService<BookingService>().ReverseNoShowAsync(
                row, start.AddMinutes(2).Storable(), Guid.Empty, default, scan: new ReversalScan(club.Organiser, "member_code"));
        });
        await app.Services.GetRequiredService<ShareHook>().AfterSettlementAsync(club.TenantId, club.Slug, [bookingId], default);
        for (var i = 0; i < 50 && await PeopleClub.DeliverAdminNoticesAsync(app) > 0; i++) { }

        var where = $"Court 1, {start.ToString("ddd d MMM, HH:mm", CultureInfo.InvariantCulture)}";
        var lines = await PlayersClub.ReadAsync(app, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.BookingId == bookingId && n.Kind == MemberEventCatalogue.ShareMoved).ToListAsync());
        var sam = Assert.Single(lines, n => n.UserId == club.Sam && n.Headline.Contains("taken again", StringComparison.Ordinal));
        Assert.EndsWith($" taken again for your share of {where} — Olive Organiser checked in, so the session was attended", sam.Headline, StringComparison.Ordinal);
        var olive = Assert.Single(lines, n => n.UserId == club.Organiser && n.Headline.Contains("attended", StringComparison.Ordinal));
        Assert.StartsWith("Sam Partner's share of ", olive.Headline, StringComparison.Ordinal);
        Assert.EndsWith($" came back to you for {where} — you checked in, so the session was attended", olive.Headline, StringComparison.Ordinal);

        var samMail = Assert.Single(mail.Sent, m => m.To.StartsWith("sam.partner@", StringComparison.Ordinal) && m.Subject.StartsWith("Share taken again", StringComparison.Ordinal));
        Assert.Contains("Olive Organiser's check-in has since come through", Flat(samMail.PlainBody), StringComparison.Ordinal);
        var oliveMail = Assert.Single(mail.Sent, m => m.To.StartsWith("olive.organiser@", StringComparison.Ordinal) && m.Subject.Contains("share came back to you", StringComparison.Ordinal));
        Assert.Contains("Your check-in has since come through", Flat(oliveMail.PlainBody), StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------ J15-9 and E15-8: the club's settle-outside

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_settled_partners_split_change_mail_says_nothing_moves_and_the_settle_receipt_has_the_reason(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r15stl{partners}", partners);
        var seat = g.SeatOf[g.Club.Sam];
        (await Admin(g).PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/settle-outside",
            new { reason = "Paid cash at the bar" })).EnsureSuccessStatusCode();
        await DeliverAsync(g.App);

        var receipt = Assert.Single(MailTo(g, "sam.partner"), m => m.Subject.Contains("settled outside the app", StringComparison.Ordinal));
        Assert.Contains("Reason given by the club: Paid cash at the bar", Flat(receipt.PlainBody), StringComparison.Ordinal);
        var olives = Assert.Single(MailTo(g, "olive.organiser"), m => m.Subject.StartsWith("Share returned to Sam Partner", StringComparison.Ordinal));
        Assert.Contains("Reason given by the club: Paid cash at the bar", Flat(olives.PlainBody), StringComparison.Ordinal);
        g.Mail.Sent.Clear();

        var organiserSeat = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.Seat == 1).Id;
        (await g.Club.Client(g.App, g.Club.Organiser).PutAsJsonAsync($"/api/v1/bookings/{g.BookingId}/split", new
        {
            mode = "ratio",
            seats = new object[] { new { participantId = organiserSeat, weight = 1 } }
                .Concat(g.SeatOf.Values.Select(s => (object)new { participantId = s, weight = 3 })).ToArray(),
        })).EnsureSuccessStatusCode();
        await DeliverAsync(g.App);

        var change = Assert.Single(MailTo(g, "sam.partner"), m => m.Subject.StartsWith("Your share has changed", StringComparison.Ordinal));
        Assert.Contains("The club has recorded your share as paid outside the app, so nothing is taken or returned in the app for this change.",
            Flat(change.PlainBody), StringComparison.Ordinal);
        Assert.DoesNotContain("Nothing more is taken until you accept", Flat(change.PlainBody), StringComparison.Ordinal);
        if (partners == 2)
        {
            var alex = Assert.Single(MailTo(g, "alex.partner"), m => m.Subject.StartsWith("Your share has changed", StringComparison.Ordinal));
            Assert.DoesNotContain("paid outside the app", Flat(alex.PlainBody), StringComparison.Ordinal);
        }
    }
}
