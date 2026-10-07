using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>Shared set-up for the R17 lane BE17c classes below (split by theme so none is the suite's floor).</summary>
internal static class R17Kit
{
    /// <summary>
    /// A split game three days out with <paramref name="partners"/> invited and NOBODY answered yet:
    /// each partner then says yes themselves (and pays) when <paramref name="paysInApp"/> names them, or
    /// the desk accepts for them (consent 0, nothing paid) otherwise.
    /// </summary>
    public static async Task<R16Kit.Game> GameAsync(PostgresFixture pg, string prefix, int partners, Func<PlayersClub, Guid, bool> paysInApp)
    {
        var g = await R16Kit.GameAsync(pg, prefix, partners, accept: false);
        foreach (var (user, seat) in g.SeatOf)
        {
            if (paysInApp(g.Club, user))
            {
                var share = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.Id == seat).ShareMinutes;
                (await g.As(user).PostAsJsonAsync($"/api/v1/bookings/{g.BookingId}/players/{seat}/accept", new { expectedShareMinutes = share }))
                    .EnsureSuccessStatusCode();
            }
            else
            {
                (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/accept", new { reason = "Phoned in" }))
                    .EnsureSuccessStatusCode();
            }
        }
        await R16Kit.DeliverAsync(g.App);
        g.Mail.Sent.Clear();
        return g;
    }

    /// <summary>Moves the game to have started five minutes ago, with a check-in a minute in.</summary>
    public static Task StartedAsync(R16Kit.Game g) =>
        g.Club.WriteAsync(g.App, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == g.BookingId);
            b.StartsAt = DateTimeOffset.UtcNow.AddMinutes(-5).Storable();
            b.EndsAt = b.StartsAt.AddMinutes(32);
            b.CheckedInAt = b.StartsAt.AddMinutes(1);
            b.LightsOnCuedAt = b.CheckedInAt;
        });

    /// <summary>The court and start as the inbox says them, after a fixture moved the booking.</summary>
    public static async Task<string> WhereAsync(R16Kit.Game g)
    {
        var start = await PlayersClub.ReadAsync(g.App, db => db.Bookings.IgnoreQueryFilters().Where(b => b.Id == g.BookingId).Select(b => b.StartsAt).FirstAsync());
        return $"Court 1, {start.ToString("ddd d MMM, HH:mm", CultureInfo.InvariantCulture)}";
    }

    /// <summary>The named wallet frames that reached <paramref name="channel"/> within about two seconds.</summary>
    public static async Task<List<JsonElement>> FramesAsync(System.Threading.Channels.Channel<RealtimeMessage> channel, bool expectOne)
    {
        var frames = new List<JsonElement>();
        for (var i = 0; i < 40 && (frames.Count == 0 || !expectOne); i++)
        {
            while (channel.Reader.TryRead(out var m))
            {
                if (m.Event == LedgerService.BalanceEvent) frames.Add(JsonDocument.Parse(m.JsonPayload).RootElement.Clone());
            }
            if (frames.Count == 0 || !expectOne) await Task.Delay(50);
        }
        return frames;
    }

    public static async Task<int> PaidAsync(R16Kit.Game g, Guid user) =>
        -(await g.Club.SharesAsync(g.App, g.BookingId)).Where(l => l.UserId == user).Sum(l => l.AmountMinutes);

    public static Task<List<AuditLog>> AuditOfAsync(WebApplicationFactory<Program> app, Guid tenant, string action) =>
        PlayersClub.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == tenant && a.Action == action).OrderBy(a => a.CreatedAt).ToListAsync());
}

/// <summary>
/// Review round 17, lane BE17c — what a partner is told about money that did, or did not, move:
/// <list type="bullet">
/// <item>E17-2: a started game the club cancelled told a partner who had paid NOTHING (the club accepted
/// for them) "your share stands" on the frame, the inbox and the mail; and the cancelled game's detail
/// still read their share as unpaid and asked them to consent to it.</item>
/// <item>L17-8 / E17-3: the club recording a share as paid by hand after the partner had paid it in the
/// app said "nothing moves in the app" while the share went back; and the ledger-derived lines said
/// "paid outside the app" where every other surface says "paid by hand".</item>
/// </list>
/// </summary>
public sealed class R17ShareWordsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    // ------------------------------------------------------------------ E17-2


    [SkippableTheory]
    [InlineData(1, true)]
    [InlineData(1, false)]
    [InlineData(2, true)]
    [InlineData(2, false)]
    public async Task A_cancelled_started_game_says_the_share_stands_only_to_a_partner_who_paid_one(int partners, bool samPays)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        // Sam pays in the app when samPays; Alex (the second partner) never does — the desk accepted for him.
        var g = await R17Kit.GameAsync(pg, $"r17c-st{partners}{(samPays ? "p" : "z")}", partners, (club, u) => samPays && u == club.Sam);
        var players = new[] { (g.Club.Sam, "sam.partner"), (g.Club.Alex, "alex.partner") }.Take(partners).ToList();
        var paid = new Dictionary<Guid, int>();
        foreach (var (u, _) in players) paid[u] = await R17Kit.PaidAsync(g, u);
        Assert.Equal(samPays, paid[g.Club.Sam] > 0);
        if (partners == 2) Assert.Equal(0, paid[g.Club.Alex]);

        await R17Kit.StartedAsync(g);
        var bus = g.App.Services.GetRequiredService<IRealtimeBus>();
        var wallets = players.ToDictionary(p => p.Item1, p => bus.Subscribe(RealtimeTopic.Wallet(g.Club.TenantId, p.Item1)));
        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/cancel", new { reason = "Flooded court" })).EnsureSuccessStatusCode();
        await R16Kit.DeliverAsync(g.App);
        var where = await R17Kit.WhereAsync(g);

        foreach (var (partner, handle) in players)
        {
            var paidSome = paid[partner] > 0;
            var frames = await R17Kit.FramesAsync(wallets[partner], expectOne: paidSome);
            var stands = frames.Where(f => f.GetProperty("reason").GetString() == ShareSweep.CancelledShareStandsReason).ToList();
            Assert.Equal(paidSome ? 1 : 0, stands.Count);

            var line = Assert.Single(await R16Kit.InboxAsync(g, partner, MemberEventCatalogue.GameCancelled));
            Assert.Equal(paidSome
                ? $"The club cancelled {where} — it had started, so your share stands"
                : $"The club cancelled {where} — it had started, but you had paid no share, so nothing moves", line.Headline);

            var mail = Assert.Single(R16Kit.MailTo(g, handle), m => m.Subject.StartsWith("Game cancelled", StringComparison.Ordinal));
            var text = R16Kit.Flat(mail);
            if (paidSome)
            {
                Assert.Contains("any share you paid stands", text, StringComparison.Ordinal);
            }
            else
            {
                Assert.DoesNotContain("stands", text, StringComparison.Ordinal);
                Assert.DoesNotContain("comes back", text, StringComparison.Ordinal);
                Assert.Contains("you had not paid a share", text, StringComparison.Ordinal);
            }

            // The cancelled game asks nothing of anybody: no unpaid figure, no consent.
            var row = await R16Kit.SeatRowAsync(g, g.As(partner), g.SeatOf[partner]);
            Assert.Equal(0, row.GetProperty("unpaid_minutes").GetInt32());
            Assert.False(row.GetProperty("needs_consent").GetBoolean());
            var invite = await g.As(partner).GetFromJsonAsync<JsonElement>($"/api/v1/me/invites/{g.SeatOf[partner]}");
            Assert.False(invite.GetProperty("needs_consent").GetBoolean());
        }
        var detail = await g.Admin.GetFromJsonAsync<JsonElement>($"/api/v1/bookings/{g.BookingId}");
        Assert.Equal(0, detail.GetProperty("money").GetProperty("unpaid_minutes").GetInt32());
        Assert.All(detail.GetProperty("players").EnumerateArray(), p => Assert.False(p.GetProperty("needs_consent").GetBoolean()));
    }

    // ------------------------------------------------------------------ L17-8 / E17-3

    [SkippableTheory]
    [InlineData(1, true)]
    [InlineData(1, false)]
    [InlineData(2, true)]
    [InlineData(2, false)]
    public async Task Paid_by_hand_after_an_in_app_payment_says_what_came_back_and_never_outside_the_app(int partners, bool paidInApp)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        // Alex (two partners) always pays in the app and is never settled — his words must not move.
        var g = await R17Kit.GameAsync(pg, $"r17c-bh{partners}{(paidInApp ? "p" : "z")}", partners, (club, u) => u != club.Sam || paidInApp);
        var paid = await R17Kit.PaidAsync(g, g.Club.Sam);
        Assert.Equal(paidInApp, paid > 0);

        var seat = g.SeatOf[g.Club.Sam];
        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/settle-outside", new { reason = "Cash" })).EnsureSuccessStatusCode();
        await R16Kit.DeliverAsync(g.App);

        var sam = await R16Kit.InboxAsync(g, g.Club.Sam, MemberEventCatalogue.GameChanged);
        var olive = await R16Kit.InboxAsync(g, g.Club.Organiser, MemberEventCatalogue.GameChanged);
        var change = Assert.Single(R16Kit.MailTo(g, "sam.partner"), m => m.Subject.Contains("paid by hand", StringComparison.Ordinal)
                                                                          && !m.Subject.StartsWith("Your share came back", StringComparison.Ordinal));
        if (paidInApp)
        {
            Assert.Contains(sam, n => n.Headline ==
                $"The club recorded that you paid Olive Organiser by hand for {g.Where} — the {paid} minutes you paid in the app go back to you");
            Assert.Contains(olive, n => n.Headline ==
                $"The club recorded that Sam Partner paid you by hand for {g.Where} — the {paid} minutes they paid in the app go back to them");
            Assert.DoesNotContain("Nothing is taken from or returned", R16Kit.Flat(change), StringComparison.Ordinal);
            Assert.Contains($"The {paid} minutes you paid in the app for this share go back to your balance", R16Kit.Flat(change), StringComparison.Ordinal);

            // The return's own receipt says "paid by hand", never "outside the app".
            var receipt = (await R16Kit.InboxAsync(g, g.Club.Sam, MemberEventCatalogue.ShareMoved)).Last();
            Assert.Equal($"{paid} minutes of your share came back — the club recorded your share of {g.Where} as paid by hand", receipt.Headline);
            var receiptMail = Assert.Single(R16Kit.MailTo(g, "sam.partner"), m => m.Subject.StartsWith("Your share came back", StringComparison.Ordinal));
            Assert.Equal("Your share came back: paid by hand — Court 1", receiptMail.Subject);
            Assert.Contains("The club recorded your share as paid by hand", R16Kit.Flat(receiptMail), StringComparison.Ordinal);
        }
        else
        {
            Assert.Contains(sam, n => n.Headline == $"The club recorded that you paid Olive Organiser by hand for {g.Where} — nothing moves in the app");
            Assert.Contains(olive, n => n.Headline == $"The club recorded that Sam Partner paid you by hand for {g.Where}");
        }

        // Every surface derived from the record: no "outside the app" anywhere on either Night or the inbox.
        foreach (var who in new[] { g.Club.Sam, g.Club.Organiser, g.Club.Admin })
        {
            Assert.All(await R16Kit.NightAsync(g, who), e => Assert.DoesNotContain("outside the app", R16Kit.Headline(e), StringComparison.Ordinal));
        }
        Assert.All(await R16Kit.InboxAsync(g, g.Club.Sam), n => Assert.DoesNotContain("outside the app", n.Headline, StringComparison.Ordinal));
        Assert.All(R16Kit.MailTo(g, "sam.partner"), m => Assert.DoesNotContain("outside the app", R16Kit.Flat(m), StringComparison.Ordinal));
        if (partners == 2)
        {
            Assert.Empty(await R16Kit.InboxAsync(g, g.Club.Alex, MemberEventCatalogue.GameChanged));
        }
    }
}

/// <summary>
/// Review round 17, lane BE17c — the picker, play figures and the Night:
/// <list type="bullet">
/// <item>L17-2 / J16-3: two namesakes who never played with the caller read the same "Member since Oct 2026"
/// (a pre-launch club joins in one month); <c>member_since</c> was a UTC date, not the club's.</item>
/// <item>J17-5: a session the club cancelled after its check-in counted in /me/play's stats, partners and streak.</item>
/// </list>
/// </summary>
public sealed class R17PickerPlayHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Joburg =
        """{"slice_minutes":8,"day_start_minute":0,"day_end_minute":1440,"grace_window_minutes":5,"penalty_window_minutes":15,"penalty_pct":30,"timezone":"Africa/Johannesburg","member_quiet_start_minute":0,"member_quiet_end_minute":0}""";

    [SkippableFact]
    public async Task Namesakes_carry_a_ref_that_tells_them_apart_and_member_since_is_the_clubs_date()
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var app = CapturingMail.On(pg.SharedHost, new CapturingMail());
        var club = await PlayersClub.SeedAsync(app, "r17c-dir", Joburg);
        // Two "Sam Partner"s who joined the same club day: 23:30 UTC on the 5th is 01:30 on the 6th in Johannesburg.
        var joined = new DateTimeOffset(2026, 10, 5, 23, 30, 0, TimeSpan.Zero);
        await club.WriteAsync(app, db =>
        {
            foreach (var m in db.Memberships.IgnoreQueryFilters().Where(m => m.UserId == club.Alex || m.UserId == club.Jo))
            {
                m.FullName = "Sam Partner";
                m.CreatedAt = joined;
            }
            // Everyone is findable by default, so the seeded third "Sam Partner" steps aside to leave the two namesakes.
            foreach (var (u, findable) in new[] { (club.Alex, true), (club.Jo, true), (club.Sam, false) })
            {
                db.UserPreferences.Add(new UserPreferences { TenantId = club.TenantId, UserId = u, Findable = findable });
            }
        });

        var olive = club.Client(app, club.Organiser);
        var body = await olive.GetFromJsonAsync<JsonElement>("/api/v1/members/directory?q=Sam");
        var items = body.GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(2, items.Count);
        var refs = new List<string>();
        foreach (var item in items)
        {
            Assert.Equal("2026-10-06", item.GetProperty("member_since").GetString());
            var r = item.GetProperty("member_ref").GetString()!;
            Assert.Matches("^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$", r);
            refs.Add(r);
            Assert.Equal(["user_id", "name", "photo_url", "played_with_you", "last_played_with_you_at", "member_since", "member_ref"],
                item.EnumerateObject().Select(p => p.Name).ToHashSet());
        }
        Assert.NotEqual(refs[0], refs[1]);

        // Stable, and the same on every list a member sees.
        var again = await olive.GetFromJsonAsync<JsonElement>("/api/v1/members/directory?q=Sam");
        Assert.Equal(refs.Order(), again.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("member_ref").GetString()!).Order());
        (await olive.PutAsync($"/api/v1/me/partners/favourites/{club.Jo}", null)).EnsureSuccessStatusCode();
        var favourite = Assert.Single((await olive.GetFromJsonAsync<JsonElement>("/api/v1/me/partners/favourites")).GetProperty("items").EnumerateArray());
        var joRef = items.Single(i => i.GetProperty("user_id").GetGuid() == club.Jo).GetProperty("member_ref").GetString();
        Assert.Equal(joRef, favourite.GetProperty("member_ref").GetString());

        // Never the membership number, the email or the phone.
        var numbers = await PlayersClub.ReadAsync(app, db => db.Memberships.IgnoreQueryFilters().Where(m => m.TenantId == club.TenantId).Select(m => m.MembershipNumber).ToListAsync());
        foreach (var n in numbers) Assert.DoesNotContain(n, body.GetRawText(), StringComparison.Ordinal);
        Assert.DoesNotContain("review.test", body.GetRawText(), StringComparison.Ordinal);
    }

    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_session_the_club_cancelled_after_check_in_is_not_attended_on_my_play(bool cancelled)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var app = CapturingMail.On(pg.SharedHost, new CapturingMail());
        var club = await PlayersClub.SeedAsync(app, $"r17c-att{(cancelled ? "c" : "p")}");
        // Sam played with Olive nine days ago; two days ago a session with Alex was cut short by the club (or not).
        var first = DateTimeOffset.UtcNow.AddDays(-9).Storable();
        var second = DateTimeOffset.UtcNow.AddDays(-2).Storable();
        var g1 = await club.InsertBookingAsync(app, first);
        await club.InsertSeatAsync(app, g1, 1, club.Organiser, ParticipantStatus.Accepted, 16);
        await club.InsertSeatAsync(app, g1, 2, club.Sam, ParticipantStatus.Accepted, 16);
        var g2 = await club.InsertBookingAsync(app, second, organiser: club.Alex);
        await club.InsertSeatAsync(app, g2, 1, club.Alex, ParticipantStatus.Accepted, 16);
        await club.InsertSeatAsync(app, g2, 2, club.Sam, ParticipantStatus.Accepted, 16);
        await club.WriteAsync(app, db =>
        {
            foreach (var b in db.Bookings.IgnoreQueryFilters().Where(b => b.Id == g1 || b.Id == g2)) b.CheckedInAt = b.StartsAt.AddMinutes(1);
            if (!cancelled) return;
            var cut = db.Bookings.IgnoreQueryFilters().First(b => b.Id == g2);
            cut.Status = BookingStatus.Cancelled;
            cut.CancelledAt = cut.StartsAt.AddMinutes(10);
        });

        var play = await club.Client(app, club.Sam).GetFromJsonAsync<JsonElement>("/api/v1/me/play");
        var stats = play.GetProperty("stats");
        Assert.Equal(cancelled ? 1 : 2, stats.GetProperty("sessions_attended").GetInt32());
        Assert.Equal(cancelled ? 32 : 64, stats.GetProperty("minutes_on_court").GetInt32());
        var partners = play.GetProperty("partners").EnumerateArray().Select(p => p.GetProperty("user_id").GetGuid()).ToList();
        Assert.Contains(club.Organiser, partners);
        Assert.Equal(!cancelled, partners.Contains(club.Alex));
    }
}

/// <summary>
/// Review round 17, lane BE17c — the Night of everybody on a split game:
/// <list type="bullet">
/// <item>J17-4: a partner who checked in after the first scanner left no trace (BE17b now writes
/// <c>court.checked_in</c> per seat stamp; this maps it — the scanner's own voice, the organiser's view, and
/// never twice beside the <c>court.activated</c> of the same scan).</item>
/// <item>E17-4: only the organiser's Night said the lights came on — not a partner's, nor the payer's at the box.</item>
/// <item>E17-8: a member's own invite, accept and decline were not on the Night at all.</item>
/// </list>
/// </summary>
public sealed class R17NightHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    /// <summary>A seat check-in row as BE17b writes it (scratchpad contract r17-ask-BE17b-to-BE17c).</summary>
    private static AuditLog CheckedInRow(PlayersClub club, Guid bookingId, Guid seatId, Guid scanner, DateTimeOffset at, bool litCourt) => new()
    {
        TenantId = club.TenantId,
        ActorUserId = scanner,
        SubjectUserId = scanner,
        Action = "court.checked_in",
        ScanAt = at,
        DetailsJson = JsonSerializer.Serialize(new
        {
            booking_id = bookingId,
            participant_id = seatId,
            organiser_user_id = club.Organiser,
            court_number = 1,
            method = "member_code",
            occurred_at = at,
            lit_court = litCourt,
            reversed_no_show = false,
        }),
    };

    /// <summary>The server's lights row for a lit booking, as <c>CourtLightStateService.Audit</c> writes it (nested details).</summary>
    private static AuditLog LightsRow(PlayersClub club, Guid bookingId, Guid identified, Guid? payer, DateTimeOffset at) => new()
    {
        TenantId = club.TenantId,
        ActorUserId = Guid.Empty,
        SubjectUserId = club.Organiser,
        Action = "court.lights_on",
        DetailsJson = JsonSerializer.Serialize(new
        {
            court_id = club.CourtId,
            court_number = 1,
            device_id = (Guid?)null,
            details = new { method = "member_code", payer_user_id = payer, booking_id = bookingId, occurred_at = at, identified_user_id = identified },
        }),
    };

    private static AuditLog ActivatedRow(PlayersClub club, Guid bookingId, Guid scanner, DateTimeOffset at) => new()
    {
        TenantId = club.TenantId,
        ActorUserId = scanner,
        SubjectUserId = club.Organiser,
        Action = "court.activated",
        ScanAt = at,
        DetailsJson = JsonSerializer.Serialize(new { booking_id = bookingId, court_number = 1, method = "member_code", occurred_at = at }),
    };

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task Every_seat_check_in_is_on_the_scanners_and_the_organisers_Night_once(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var app = CapturingMail.On(pg.SharedHost, new CapturingMail());
        var club = await PlayersClub.SeedAsync(app, $"r17c-ci{partners}");
        var start = DateTimeOffset.UtcNow.AddMinutes(-10).Storable();
        var bookingId = await club.InsertBookingAsync(app, start);
        await club.InsertSeatAsync(app, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16);
        var sam = await club.InsertSeatAsync(app, bookingId, 2, club.Sam, ParticipantStatus.Accepted, 8);
        var alex = partners == 2 ? await club.InsertSeatAsync(app, bookingId, 3, club.Alex, ParticipantStatus.Accepted, 8) : Guid.Empty;
        // Olive's scan lit the court (court.activated + her own lit_court row); Sam (and Alex) walked in after her.
        var lit = start.AddMinutes(1);
        await club.WriteAsync(app, db =>
        {
            var seat1 = db.BookingParticipants.IgnoreQueryFilters().First(p => p.BookingId == bookingId && p.Seat == 1);
            db.AuditLogs.Add(ActivatedRow(club, bookingId, club.Organiser, lit));
            db.AuditLogs.Add(CheckedInRow(club, bookingId, seat1.Id, club.Organiser, lit, litCourt: true));
            db.AuditLogs.Add(CheckedInRow(club, bookingId, sam, club.Sam, start.AddMinutes(3), litCourt: false));
            if (partners == 2) db.AuditLogs.Add(CheckedInRow(club, bookingId, alex, club.Alex, start.AddMinutes(4), litCourt: false));
        });
        var g = new R16Kit.Game(club, app, new CapturingMail(), bookingId, start, []);

        var oliveNight = await R16Kit.NightAsync(g, club.Organiser);
        var olive = oliveNight.Where(e => R16Kit.Kind(e) == TraceKinds.CourtCheckedIn).Select(R16Kit.Headline).ToList();
        var expected = new List<string> { "Checked in at Court 1", "Sam Partner checked in at Court 1" };
        if (partners == 2) expected.Add("Alex Partner checked in at Court 1");
        Assert.Equal(expected, olive);

        var samNight = await R16Kit.NightAsync(g, club.Sam);
        Assert.Equal("Checked in at Court 1 for Olive Organiser's booking",
            R16Kit.Headline(Assert.Single(samNight, e => R16Kit.Kind(e) == TraceKinds.CourtCheckedIn)));
        var body = await g.Admin.GetFromJsonAsync<JsonElement>($"/api/v1/admin/members/{club.Sam}/trace");
        Assert.Equal(start.AddMinutes(3), body.GetProperty("summary").GetProperty("first_seen_at").GetDateTimeOffset());
        if (partners == 2)
        {
            // Another partner's check-in is theirs, not Sam's.
            Assert.DoesNotContain(samNight, e => R16Kit.Headline(e).Contains("Alex Partner checked in", StringComparison.Ordinal));
        }
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task The_lights_coming_on_is_on_every_players_Night_and_the_payers(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var app = CapturingMail.On(pg.SharedHost, new CapturingMail());
        var club = await PlayersClub.SeedAsync(app, $"r17c-lt{partners}");
        var start = DateTimeOffset.UtcNow.AddMinutes(-10).Storable();
        var bookingId = await club.InsertBookingAsync(app, start);
        await club.InsertSeatAsync(app, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16);
        await club.InsertSeatAsync(app, bookingId, 2, club.Sam, ParticipantStatus.Accepted, partners == 2 ? 8 : 16);
        if (partners == 2) await club.InsertSeatAsync(app, bookingId, 3, club.Alex, ParticipantStatus.Accepted, 8);
        // Jo was invited and said no; Bea paid for the court at the box.
        await club.InsertSeatAsync(app, bookingId, 4, club.Jo, ParticipantStatus.Declined, 0);
        await club.WriteAsync(app, db =>
        {
            db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).PaidByUserId = club.Bystander;
            db.AuditLogs.Add(LightsRow(club, bookingId, club.Sam, club.Bystander, start.AddMinutes(1)));
        });
        var g = new R16Kit.Game(club, app, new CapturingMail(), bookingId, start, []);

        var lit = new[] { club.Organiser, club.Sam, club.Bystander }.Concat(partners == 2 ? [club.Alex] : Array.Empty<Guid>());
        foreach (var who in lit)
        {
            var night = await R16Kit.NightAsync(g, who);
            Assert.Equal("Court 1 lights came on", R16Kit.Headline(Assert.Single(night, e => R16Kit.Kind(e) == TraceKinds.LightsOn)));
        }
        Assert.DoesNotContain(await R16Kit.NightAsync(g, club.Jo), e => R16Kit.Kind(e) == TraceKinds.LightsOn);
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_members_own_invite_accept_and_decline_are_on_the_Night(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = await R16Kit.GameAsync(pg, $"r17c-act{partners}", partners, accept: false);
        var sam = g.SeatOf[g.Club.Sam];
        var share = (await g.Club.SeatsAsync(g.App, g.BookingId)).Single(s => s.Id == sam).ShareMinutes;
        (await g.As(g.Club.Sam).PostAsJsonAsync($"/api/v1/bookings/{g.BookingId}/players/{sam}/accept", new { expectedShareMinutes = share }))
            .EnsureSuccessStatusCode();
        if (partners == 2)
        {
            (await g.As(g.Club.Alex).PostAsync($"/api/v1/bookings/{g.BookingId}/players/{g.SeatOf[g.Club.Alex]}/decline", null)).EnsureSuccessStatusCode();
        }

        var samNight = (await R16Kit.NightAsync(g, g.Club.Sam)).Select(R16Kit.Headline).ToList();
        Assert.Contains("Olive Organiser invited them to a game on Court 1", samNight);
        Assert.Contains("Accepted their place in Olive Organiser's game on Court 1", samNight);

        var oliveNight = (await R16Kit.NightAsync(g, g.Club.Organiser)).Select(R16Kit.Headline).ToList();
        Assert.Contains("Invited Sam Partner to their game on Court 1", oliveNight);
        Assert.Contains("Sam Partner accepted a place in their game on Court 1", oliveNight);
        if (partners == 2)
        {
            Assert.Contains("Invited Alex Partner to their game on Court 1", oliveNight);
            Assert.Contains("Alex Partner declined a place in their game on Court 1", oliveNight);
            Assert.Contains("Declined a place in Olive Organiser's game on Court 1", (await R16Kit.NightAsync(g, g.Club.Alex)).Select(R16Kit.Headline));
        }
        Assert.DoesNotContain(oliveNight.Concat(samNight), h => h.StartsWith("unrecognised", StringComparison.OrdinalIgnoreCase));
        var kinds = (await R16Kit.NightAsync(g, g.Club.Sam)).Select(R16Kit.Kind).ToList();
        Assert.DoesNotContain(TraceKinds.Unrecognised, kinds);
    }
}
