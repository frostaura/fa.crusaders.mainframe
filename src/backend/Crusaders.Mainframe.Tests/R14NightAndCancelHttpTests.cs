using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
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
/// Review round 14, lane BE14b — what the club's record, the Night and the member's mail say:
/// <list type="bullet">
/// <item>E14-2: a partner's Night had no row for being taken off, a split change or a cancelled game,
/// and the share rows beside them said "the club's system".</item>
/// <item>E14-3: a late check-in's reversal was the system's on the audit row, the Night and the
/// ledger, while the webhook named the scanner.</item>
/// <item>E14-5: the club cancelling a session that had started told the member nothing in the app,
/// and the mail promised a wallet line for a refund of nothing.</item>
/// <item>J14-8: the share mails after a cancellation gave no cause. J14-10: a member off the game
/// opening an old link got "Booking not found".</item>
/// <item>E14-7: the outage reversal mail said "so … so", and the Night "cancelled Court 3 for them".</item>
/// </list>
/// </summary>
public sealed class R14NightAndCancelHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private sealed record Game(PlayersClub Club, WebApplicationFactory<Program> App, CapturingMail Mail, Guid BookingId, Dictionary<Guid, Guid> SeatOf);

    private async Task<Game> GameAsync(string prefix, int partners, DateTimeOffset? startsAt = null)
    {
        var mail = new CapturingMail();
        var app = CapturingMail.On(pg.SharedHost, mail);
        var club = await PlayersClub.SeedAsync(app, prefix);
        var who = new[] { club.Sam, club.Alex }.Take(partners).ToArray();
        foreach (var p in who) await club.CreditAsync(app, p, 50);
        await club.CreditAsync(app, club.Organiser, 100);
        var bookingId = await club.InsertBookingAsync(app, startsAt ?? DateTimeOffset.UtcNow.AddDays(3).Storable());
        var seatOf = new Dictionary<Guid, Guid>();
        if (partners > 0)
        {
            (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
                new { players = who.Select(p => (object)new { userId = p }).ToArray() })).EnsureSuccessStatusCode();
            foreach (var seat in await club.SeatsAsync(app, bookingId))
            {
                if (seat.Seat == 1 || seat.UserId is not { } user) continue;
                seatOf[user] = seat.Id;
                (await club.Client(app, user).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}/accept",
                    new { expectedShareMinutes = seat.ShareMinutes })).EnsureSuccessStatusCode();
            }
        }
        await DeliverAsync(app);
        mail.Sent.Clear();
        return new Game(club, app, mail, bookingId, seatOf);
    }

    private static async Task DeliverAsync(WebApplicationFactory<Program> app)
    {
        for (var i = 0; i < 50 && await PeopleClub.DeliverAdminNoticesAsync(app) > 0; i++) { }
    }

    private static async Task<List<JsonElement>> NightAsync(Game g, Guid user)
    {
        var body = await g.Club.Client(g.App, g.Club.Admin, admin: true).GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{user}/trace");
        return [.. body.GetProperty("events").EnumerateArray()];
    }

    private static string Kind(JsonElement e) => e.GetProperty("kind").GetString()!;
    private static string Headline(JsonElement e) => e.GetProperty("headline").GetString()!;
    private static string ActorKind(JsonElement e) => e.GetProperty("actor").GetProperty("kind").GetString()!;
    private static string Flat(string? text) => System.Text.RegularExpressions.Regex.Replace(text ?? "", @"\s+", " ");

    private static List<EmailMessage> MailTo(Game g, string handle) =>
        [.. g.Mail.Sent.Where(m => m.To == $"{handle}@{g.Club.Slug}.review.test")];

    // ------------------------------------------------------------------ E14-2: the Night

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task The_Night_says_the_organiser_took_the_partner_off_on_both_sides(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r14ntrm{partners}", partners);

        (await g.Club.Client(g.App, g.Club.Organiser).DeleteAsync($"/api/v1/bookings/{g.BookingId}/players/{g.SeatOf[g.Club.Sam]}")).EnsureSuccessStatusCode();

        var sam = await NightAsync(g, g.Club.Sam);
        Assert.Equal("Olive Organiser took them off Court 1", Headline(Assert.Single(sam, e => Kind(e) == "booking.taken_off")));
        Assert.All(sam.Where(e => Kind(e) == TraceKinds.WalletShareMoved && e.GetProperty("at").GetDateTimeOffset() > DateTimeOffset.UtcNow.AddMinutes(-1)),
            e => Assert.NotEqual(TraceActors.System, ActorKind(e)));
        var olive = await NightAsync(g, g.Club.Organiser);
        Assert.Equal("Took Sam Partner off Court 1", Headline(Assert.Single(olive, e => Kind(e) == "booking.took_player_off")));
    }

    [SkippableFact]
    public async Task The_Night_says_the_club_took_the_partner_off_and_whose_game_it_was()
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync("r14ntadm", 1);

        (await g.Club.Client(g.App, g.Club.Admin, admin: true).PostAsJsonAsync(
            $"/api/v1/admin/bookings/{g.BookingId}/players/{g.SeatOf[g.Club.Sam]}/remove", new { reason = "Double booked" })).EnsureSuccessStatusCode();

        Assert.Equal("Ada Admin took them off Olive Organiser's game on Court 1",
            Headline(Assert.Single(await NightAsync(g, g.Club.Sam), e => Kind(e) == "booking.taken_off")));
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task The_Night_says_the_organiser_changed_the_split_and_what_the_share_is_now(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r14ntsp{partners}", partners);
        var organiserSeat = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.Seat == 1).Id;

        (await g.Club.Client(g.App, g.Club.Organiser).PutAsJsonAsync($"/api/v1/bookings/{g.BookingId}/split", new
        {
            mode = "ratio",
            seats = new object[] { new { participantId = organiserSeat, weight = 3 } }
                .Concat(g.SeatOf.Values.Select(s => (object)new { participantId = s, weight = 1 })).ToArray(),
        })).EnsureSuccessStatusCode();

        var now = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.Id == g.SeatOf[g.Club.Sam]).ShareMinutes;
        Assert.Equal($"Olive Organiser changed how Court 1 is split — their share is now {now} minutes",
            Headline(Assert.Single(await NightAsync(g, g.Club.Sam), e => Kind(e) == "booking.split_changed")));
        Assert.Equal(partners, (await NightAsync(g, g.Club.Organiser)).Count(e => Kind(e) == "booking.changed_split"));
    }

    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task The_partners_Night_says_their_game_was_cancelled_and_by_whom(bool byClub)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync(byClub ? "r14ntcnc" : "r14ntcnm", 2);

        var cancel = byClub
            ? g.Club.Client(g.App, g.Club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/cancel", new { reason = "Court resurfacing" })
            : g.Club.Client(g.App, g.Club.Organiser).PostAsync($"/api/v1/bookings/{g.BookingId}/cancel", null);
        (await cancel).EnsureSuccessStatusCode();

        foreach (var partner in new[] { g.Club.Sam, g.Club.Alex })
        {
            Assert.Equal(
                byClub ? "Ada Admin cancelled Olive Organiser's game on Court 1 for the club" : "Olive Organiser cancelled their game on Court 1",
                Headline(Assert.Single(await NightAsync(g, partner), e => Kind(e) == "booking.game_cancelled")));
        }
        var olive = await NightAsync(g, g.Club.Organiser);
        Assert.DoesNotContain(olive, e => Kind(e) == "booking.game_cancelled");
        if (byClub)
        {
            Assert.Equal("Ada Admin cancelled their booking on Court 1",
                Headline(Assert.Single(olive, e => Kind(e) == TraceKinds.BookingCancelledByClub)));
        }

        // J14-8: each share mail says who cancelled.
        await DeliverAsync(g.App);
        var samMail = Assert.Single(MailTo(g, "sam.partner"), m => m.Subject.Contains("cancelled the game", StringComparison.Ordinal));
        Assert.Equal(byClub ? "The club cancelled the game — Court 1" : "Olive Organiser cancelled the game — Court 1", samMail.Subject);
        var oliveShare = MailTo(g, "olive.organiser").Where(m => m.Subject.StartsWith("Share returned", StringComparison.Ordinal)).ToList();
        Assert.Equal(2, oliveShare.Count);
        Assert.All(oliveShare, m => Assert.Contains(byClub ? "The club cancelled your booking, so" : "You cancelled the booking, so",
            Flat(m.PlainBody), StringComparison.Ordinal));
    }

    // ------------------------------------------------------------------ E14-3: the reversal is the scanner's

    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_late_check_in_reversal_is_the_scanners_on_the_record_the_rows_and_the_Night(bool dark)
    {
        Skip.IfNot(pg.Available, Skipped);
        var start = DateTimeOffset.UtcNow.AddMinutes(-10).Storable();
        var mail = new CapturingMail();
        var app = CapturingMail.On(pg.SharedHost, mail);
        var club = await PlayersClub.SeedAsync(app, dark ? "r14rvo" : "r14rvn");
        if (dark)
        {
            await club.WriteAsync(app, db => db.Devices.Add(new Device
            {
                TenantId = club.TenantId, DeviceCode = $"box-r14rv{dark}", Name = "Box", Kind = DeviceKind.CourtBox,
                MacAddress = Guid.NewGuid().ToString("N")[..12], CourtNumbers = [1], AutoRegistered = false,
                CreatedAt = DateTimeOffset.UtcNow.AddDays(-3), LastSeenAt = DateTimeOffset.UtcNow.AddDays(-1),
            }));
        }
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

        var result = await club.InClubAsync(app, async sp =>
        {
            var row = await sp.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(b => b.Id == bookingId);
            return await sp.GetRequiredService<BookingService>().ReverseNoShowAsync(
                row, start.AddMinutes(2).Storable(), Guid.Empty, default, scan: new ReversalScan(club.Sam, "member_code"));
        });
        Assert.IsType<NoShowReversalResult.Ok>(result);
        await app.Services.GetRequiredService<ShareHook>().AfterSettlementAsync(club.TenantId, club.Slug, [bookingId], default);

        var audit = await PlayersClub.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .SingleAsync(a => a.TenantId == club.TenantId && a.Action == "booking.no_show_reversed"));
        Assert.Equal(club.Sam, audit.ActorUserId);
        var refundBack = await PlayersClub.ReadAsync(app, db => db.LedgerEntries.IgnoreQueryFilters()
            .SingleAsync(l => l.ExternalReference == BookingService.NoShowReversalReference(bookingId, "refund")));
        Assert.Equal(club.Sam, refundBack.ActorUserId);
        // The share taken again after it is the scan's consequence too.
        // The newest pair: the collection after the reversal (the accept's and the sweep's return come before it).
        var again = (await club.SharesAsync(app, bookingId)).TakeLast(2).ToList();
        Assert.All(again, l => Assert.Equal("Share of a split booking", l.Reason));
        Assert.All(again, l => Assert.Equal(club.Sam, l.ActorUserId));

        var night = await club.Client(app, club.Admin, admin: true).GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{club.Organiser}/trace");
        var row = Assert.Single(night.GetProperty("events").EnumerateArray(), e => Kind(e) == TraceKinds.BookingNoShowReversed);
        Assert.Equal($"Sam Partner's check-in reached the club late — {(dark ? "outage refund" : "no-show")} reversed", Headline(row));
        Assert.Equal(TraceActors.Member, ActorKind(row));

        if (dark)
        {
            // E14-7: one "so" in the sentence.
            var reversedMail = Assert.Single(mail.Sent, m => m.Subject.StartsWith("Outage refund reversed", StringComparison.Ordinal));
            var body = Flat(reversedMail.PlainBody);
            Assert.Contains("Its check-in has since come through (Sam Partner checked in), so the booking stands as played", body, StringComparison.Ordinal);
        }
    }

    // ------------------------------------------------------------------ E14-5: the club cancels a session that had started

    [SkippableTheory]
    [InlineData(0)]
    [InlineData(1)]
    public async Task The_club_cancelling_a_started_session_tells_the_member_and_promises_no_wallet_line(int partners)
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync($"r14lit{partners}", partners);
        await g.Club.WriteAsync(g.App, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == g.BookingId);
            b.StartsAt = DateTimeOffset.UtcNow.AddMinutes(-5).Storable();
            b.EndsAt = b.StartsAt.AddMinutes(32);
            b.CheckedInAt = b.StartsAt.AddMinutes(1);
            b.LightsOnCuedAt = b.CheckedInAt;
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
        Assert.Equal(0, frame.GetProperty("delta_minutes").GetInt32());
        Assert.Equal("club", frame.GetProperty("cancelled_by").GetString());
        Assert.Equal("Court 1", frame.GetProperty("court_name").GetString());

        var line = Assert.Single(await PlayersClub.ReadAsync(g.App, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.UserId == g.Club.Organiser && n.BookingId == g.BookingId && n.Kind == MemberEventCatalogue.GameCancelled).ToListAsync()));
        Assert.StartsWith("The club cancelled your session on Court 1, ", line.Headline, StringComparison.Ordinal);
        Assert.EndsWith(" — it had started, so nothing was refunded", line.Headline, StringComparison.Ordinal);

        await DeliverAsync(g.App);
        await Task.Delay(200);   // the cancellation mail is sent in the background
        var cancelMail = Assert.Single(MailTo(g, "olive.organiser"), m => m.Subject.StartsWith("The club cancelled your booking", StringComparison.Ordinal));
        var body = Flat(cancelMail.PlainBody);
        Assert.Contains("Nothing — the session had started", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Each of these is its own line in your wallet", body, StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------ J14-10: the detail names the viewer's own closed seat

    [SkippableFact]
    public async Task A_member_off_the_game_is_told_their_own_seat_without_a_seat_in_the_link()
    {
        Skip.IfNot(pg.Available, Skipped);
        var g = await GameAsync("r14ownseat", 2);
        var seat = g.SeatOf[g.Club.Sam];
        (await g.Club.Client(g.App, g.Club.Organiser).DeleteAsync($"/api/v1/bookings/{g.BookingId}/players/{seat}")).EnsureSuccessStatusCode();

        var sam = await g.Club.Client(g.App, g.Club.Sam).GetAsync($"/api/v1/bookings/{g.BookingId}");
        Assert.Equal(HttpStatusCode.NotFound, sam.StatusCode);
        var body = await sam.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("booking_not_found", body.GetProperty("error").GetString());
        Assert.Equal(seat, body.GetProperty("own_seat_id").GetGuid());

        var stranger = await g.Club.Client(g.App, g.Club.Bystander).GetAsync($"/api/v1/bookings/{g.BookingId}");
        Assert.Equal(HttpStatusCode.NotFound, stranger.StatusCode);
        Assert.Equal(JsonValueKind.Null, (await stranger.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("own_seat_id").ValueKind);
    }
}
