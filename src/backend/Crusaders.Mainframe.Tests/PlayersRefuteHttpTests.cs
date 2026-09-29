using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The refuter's round on the P11 review fixes (D11–D13), on Postgres: the defects that survived
/// them, each pinned by the probe that proved it. Every test here failed on the code it follows.
/// </summary>
public sealed class PlayersRefuteHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    private static string? Error(JsonElement body) => body.TryGetProperty("error", out var e) ? e.GetString() : null;

    private static Task<HttpResponseMessage> AcceptAsync(PlayersClub club, TestWebAppFactory f, Guid who, Guid bookingId, Guid seat, decimal expected) =>
        club.Client(f, who).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareCredits = expected });

    private static string With(string settings, string extra) => settings.Replace("}", $",{extra}}}");

    /// <summary>
    /// A played game, past its share deadline, on which Sam paid the organiser 16 — and the
    /// organiser has since spent it (their hold was released at the deadline): balance 0.
    /// </summary>
    private static async Task<(Guid BookingId, Guid Seat)> SpentGameAsync(PlayersClub club, TestWebAppFactory f)
    {
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(-5));
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).Status = BookingStatus.Completed);
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16m);
        var seat = await club.InsertSeatAsync(f, bookingId, 2, club.Sam, ParticipantStatus.Accepted, 16m);
        await club.WriteAsync(f, db =>
        {
            db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).ConsentedCredits = 16m;
            foreach (var posting in ShareLedger.Pair(new Booking { Id = bookingId }, new ShareMove(seat, club.Sam, club.Organiser, 16m, 1), club.Sam))
            {
                db.LedgerEntries.Add(new LedgerEntry
                {
                    TenantId = club.TenantId, UserId = posting.UserId, Type = posting.Type, AmountCredits = posting.AmountCredits,
                    ActorUserId = posting.ActorUserId, RelatedBookingId = bookingId, ExternalReference = posting.ExternalReference,
                });
            }
        });
        await club.CreditAsync(f, club.Organiser, 32m);   // pays for the court: 0 after the charge
        await club.CreditAsync(f, club.Organiser, -16m);  // spends Sam's 16, released at the deadline
        await club.CreditAsync(f, club.Sam, 16m);
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Organiser));
        return (bookingId, seat);
    }

    // ------------------------------------------------------------------ H1. no silent overdraft after the deadline

    /// <summary>
    /// After the deadline an admin remove or settle-outside hands a paid share back from an
    /// organiser whose hold has ended. Without <c>allowNegativeBalance</c> both are refused and
    /// nothing moves; with it (and a reason) they go through, on the record.
    /// </summary>
    [SkippableTheory]
    [InlineData("remove")]
    [InlineData("settle-outside")]
    public async Task After_the_deadline_an_admin_return_needs_the_overdraft_said_by_name(string action)
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, $"rfadm{action.Length}");
        var (bookingId, seat) = await SpentGameAsync(club, f);
        var admin = club.Client(f, club.Admin, admin: true);
        var path = $"/api/v1/admin/bookings/{bookingId}/players/{seat}/{action}";

        var refused = await admin.PostAsJsonAsync(path, new { reason = "Asked for it back" });
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal(PlayerErrors.OverdraftNotAuthorised, Error(await JsonAsync(refused)));
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Organiser));
        var untouched = (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat);
        Assert.Equal(ParticipantStatus.Accepted, untouched.Status);
        Assert.Null(untouched.SettledOutsideAt);

        var forced = await admin.PostAsJsonAsync(path, new { reason = "Agreed at the desk", allowNegativeBalance = true });
        Assert.True(forced.IsSuccessStatusCode, await forced.Content.ReadAsStringAsync());
        Assert.Equal(-16m, await PlayersClub.BalanceAsync(f, club.Organiser));
        Assert.Equal(16m, await PlayersClub.BalanceAsync(f, club.Sam));
    }

    /// <summary>
    /// Any return that runs after the hold has ended — here a seat taken off by a path that
    /// reconciles with no authority — is left unpaid rather than overdrawing the organiser.
    /// </summary>
    [SkippableFact]
    public async Task A_return_after_the_hold_ended_never_overdraws_the_organiser_silently()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rfret");
        var (bookingId, seat) = await SpentGameAsync(club, f);
        await club.WriteAsync(f, db => db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).Status = ParticipantStatus.Removed);

        var moves = await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(bookingId, default));

        Assert.Empty(moves);
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Organiser));

        // The organiser tops up: the return is covered now, and the next reconcile makes it.
        await club.CreditAsync(f, club.Organiser, 20m);
        await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(bookingId, default));
        Assert.Equal(4m, await PlayersClub.BalanceAsync(f, club.Organiser));
        Assert.Equal(16m, await PlayersClub.BalanceAsync(f, club.Sam));
    }

    // ------------------------------------------------------------------ H2. the deadline is frozen per booking

    /// <summary>
    /// A booking's share deadline is fixed when it first gets players. Changing
    /// <c>share_lapse_hours</c> afterwards moves no deadline already set: the game stays open (or
    /// closed) and its hold releases exactly when it said it would.
    /// </summary>
    [SkippableFact]
    public async Task Changing_the_lapse_hours_moves_no_deadline_already_set()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rffreeze");
        await club.CreditAsync(f, club.Sam, 50m);
        var start = DateTimeOffset.UtcNow.AddHours(-40);
        var bookingId = await club.InsertBookingAsync(f, start);
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).Status = BookingStatus.Completed);
        var organiser = club.Client(f, club.Organiser);
        var add = await organiser.PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players", new { players = new object[] { new { userId = club.Sam } } });
        Assert.True(add.IsSuccessStatusCode, await add.Content.ReadAsStringAsync());
        var deadline = start.AddMinutes(60).AddHours(48);

        await club.WriteAsync(f, db => db.TenantSettings.IgnoreQueryFilters().First(s => s.TenantId == club.TenantId).SettingsJson =
            With(PlayersClub.Settings, "\"share_lapse_hours\":1"));

        var detail = await JsonAsync(await organiser.GetAsync($"/api/v1/bookings/{bookingId}"));
        Assert.Equal(deadline, detail.GetProperty("money").GetProperty("share_deadline").GetDateTimeOffset(), TimeSpan.FromSeconds(1));
        var again = await organiser.PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players", new { players = new object[] { new { userId = club.Alex } } });
        Assert.True(again.IsSuccessStatusCode, await again.Content.ReadAsStringAsync());

        var sam = (await club.SeatsAsync(f, bookingId)).Single(s => s.UserId == club.Sam);
        Assert.Equal(HttpStatusCode.OK, (await AcceptAsync(club, f, club.Sam, bookingId, sam.Id, sam.ShareCredits)).StatusCode);
        var wallet = await JsonAsync(await organiser.GetAsync("/api/v1/wallet"));
        Assert.Equal(sam.ShareCredits, wallet.GetProperty("held_credits").GetDecimal());
        Assert.Equal(deadline, wallet.GetProperty("held_until").GetDateTimeOffset(), TimeSpan.FromSeconds(1));
    }

    // ------------------------------------------------------------------ M1. no pay-for over a pending return

    /// <summary>
    /// A booking whose partner was taken off while their share had not yet gone back (a return
    /// pending) is still a split booking: a payer override at the box is ignored, so the return
    /// is never left owed by a volunteer who took the court over.
    /// </summary>
    [SkippableFact]
    public async Task A_payer_override_is_ignored_while_a_share_is_still_on_the_booking()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rfpayfor");
        await club.CreditAsync(f, club.Sam, 50m);
        await club.CreditAsync(f, club.Jo, 100m);
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddMinutes(2));
        var add = await club.Client(f, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = new object[] { new { userId = club.Sam } } });
        var seat = (await JsonAsync(add)).GetProperty("participants")[0].GetProperty("participant_id").GetGuid();
        Assert.Equal(HttpStatusCode.OK, (await AcceptAsync(club, f, club.Sam, bookingId, seat, 16m)).StatusCode);
        // Sam comes off the booking; the return has not been reconciled yet.
        await club.WriteAsync(f, db => db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).Status = ParticipantStatus.Withdrawn);

        await club.InClubAsync(f, async sp =>
        {
            var activation = sp.GetRequiredService<CourtActivationService>();
            var db = sp.GetRequiredService<MainframeDbContext>();
            var booking = await db.Bookings.FirstAsync(b => b.Id == bookingId);
            var court = await db.Courts.FirstAsync(c => c.Id == club.CourtId);
            return await activation.ActivateAsync(court, booking, club.Organiser, payerOverrideUserId: club.Jo, "qr", default);
        });

        var row = await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == bookingId));
        Assert.Equal(club.Organiser, row.PaidByUserId);
        Assert.Equal(100m, await PlayersClub.BalanceAsync(f, club.Jo));
    }

    // ------------------------------------------------------------------ (a) one meaning for balance_credits

    /// <summary><c>balance_credits</c> is the raw balance everywhere; spendable and held sit beside it.</summary>
    [SkippableFact]
    public async Task Balance_credits_is_the_raw_balance_with_spendable_and_held_beside_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rfbal");
        await club.CreditAsync(f, club.Organiser, 100m);
        await club.CreditAsync(f, club.Sam, 50m);
        await club.CreditAsync(f, club.Alex, 100m);
        var (a, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        Assert.Equal(HttpStatusCode.OK, (await AcceptAsync(club, f, club.Sam, a, PlayersClub.SeatOf(body, 2), 16m)).StatusCode);
        // The organiser: 100 − 32 + 16 = 84, of which 16 held.

        var alexBooks = await club.Client(f, club.Alex).PostAsJsonAsync("/api/v1/bookings", new
        {
            // The day after: the organiser's own game tomorrow already fills their daily cap.
            courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(12).AddDays(1), sliceCount = 4, players = new object[] { new { userId = club.Organiser } },
        });
        var b = (await JsonAsync(alexBooks)).GetProperty("booking_id").GetGuid();

        var invite = (await JsonAsync(await club.Client(f, club.Organiser).GetAsync("/api/v1/me/invites"))).GetProperty("items")[0];
        Assert.Equal(84m, invite.GetProperty("balance_credits").GetDecimal());
        Assert.Equal(68m, invite.GetProperty("spendable_credits").GetDecimal());
        Assert.Equal(16m, invite.GetProperty("held_credits").GetDecimal());

        var seat = invite.GetProperty("participant_id").GetGuid();
        var accepted = await JsonAsync(await AcceptAsync(club, f, club.Organiser, b, seat, 16m));
        Assert.Equal(68m, accepted.GetProperty("balance_credits").GetDecimal());
        Assert.Equal(52m, accepted.GetProperty("spendable_credits").GetDecimal());
        Assert.Equal(16m, accepted.GetProperty("held_credits").GetDecimal());
    }

    // ------------------------------------------------------------------ (c) a collapsed invite with no reminder behind it

    /// <summary>
    /// An invite repeated inside the cadence is collapsed only when a club reminder will follow;
    /// with reminders off, or a cadence that would fall after the deadline, it is mailed at once.
    /// </summary>
    [SkippableTheory]
    [InlineData("\"share_reminder_max\":0")]
    [InlineData("\"share_reminder_hours\":168")]
    public async Task A_repeated_invite_is_mailed_when_no_reminder_will_follow(string setting)
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rfmail", With(PlayersClub.Settings, setting));
        await club.CreditAsync(f, club.Organiser, 100m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Alex }]);
        Assert.Equal(HttpStatusCode.OK, (await club.Client(f, club.Organiser).DeleteAsync($"/api/v1/bookings/{bookingId}/players/{PlayersClub.SeatOf(body, 2)}")).StatusCode);

        var admin = club.Client(f, club.Admin, admin: true);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players", new { userId = club.Alex, reason = "Phoned" })).StatusCode);

        var mailed = await PlayersClub.ReadAsync(f, db => db.AdminNotifications.IgnoreQueryFilters()
            .CountAsync(n => n.TenantId == club.TenantId && n.RecipientUserId == club.Alex && n.Kind == MemberEventCatalogue.Invited));
        Assert.Equal(2, mailed);
    }

    // ------------------------------------------------------------------ (d) the invite cap under a race

    [SkippableFact]
    public async Task The_invite_cap_holds_under_concurrent_adds()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "rfcap", With(PlayersClub.Settings, "\"player_invites_per_booking\":4"));
        await club.CreditAsync(f, club.Organiser, 100m);
        // An amount split with zero-share links leaves the organiser's own seat untouched by each add,
        // so its version token does not happen to serialise the racers — only the cap's lock can.
        var (bookingId, body) = await club.BookWithPlayersAsync(f,
            [new { link = true, amount = 0m }, new { link = true, amount = 0m }, new { link = true, amount = 0m }], "amount");
        var organiser = club.Client(f, club.Organiser);
        foreach (var seat in new[] { 2, 3, 4 })
        {
            Assert.Equal(HttpStatusCode.OK, (await organiser.DeleteAsync($"/api/v1/bookings/{bookingId}/players/{PlayersClub.SeatOf(body, seat)}")).StatusCode);
        }

        // Three invites made; the cap allows one more. Three arrive at once, one per free seat —
        // and are made to overlap for certain: a table lock that lets every read through but
        // holds every insert until all three have counted.
        HttpResponseMessage[] answers;
        await using (var gate = new Npgsql.NpgsqlConnection(pg.ConnectionString))
        {
            await gate.OpenAsync();
            await using var tx = await gate.BeginTransactionAsync();
            await using (var lockCmd = new Npgsql.NpgsqlCommand("LOCK TABLE booking_participants IN SHARE ROW EXCLUSIVE MODE", gate, tx))
            {
                await lockCmd.ExecuteNonQueryAsync();
            }
            var racing = Task.WhenAll(new[] { 2, 3, 4 }.Select(seat => club.Client(f, club.Organiser)
                .PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players", new { players = new object[] { new { link = true, seat, amount = 0m } }, splitMode = "amount" })));
            await Task.Delay(1500);
            await tx.RollbackAsync();
            answers = await racing;
        }

        var codes = string.Join(",", await Task.WhenAll(answers.Select(async a => $"{(int)a.StatusCode}:{await a.Content.ReadAsStringAsync()}")));
        Assert.True(answers.Count(a => a.StatusCode == HttpStatusCode.OK) == 1, codes);
        Assert.Equal(4, (await club.SeatsAsync(f, bookingId)).Count(s => s.Seat > 1 && s.GuestName is null));
    }
}
