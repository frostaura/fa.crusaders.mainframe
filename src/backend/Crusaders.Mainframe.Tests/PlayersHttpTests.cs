using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Crusaders.Mainframe.Api.Workers;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// D11–D12 at the HTTP boundary, on Postgres: booking with players, accepting and paying, the
/// share following every settlement path, withdrawal, lapse, the partner's cap, and a partner's
/// access at the court and the door.
///
/// <para>
/// Postgres because every guarantee here is the database's: the partner's lock, the pair's
/// references on the unique index, the seat's version token, the partial seat indexes. The
/// in-memory provider has none of them and would prove the opposite (<c>memory/gotchas.md</c>).
/// </para>
///
/// <para>
/// The club's slices are 8 minutes long; the standard game is four slices — 32 minutes, which is
/// its price (§1.1) — split equally three ways: Sam and Alex 10 each (rounded down), the organiser 12.
/// </para>
/// </summary>
public sealed class PlayersHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static object[] SamAndAlex(PlayersClub club) => [new { userId = club.Sam }, new { userId = club.Alex }];

    /// <summary>Accepts as the partner would: naming the share the accept sheet showed them — the seat's share as it stands.</summary>
    private static async Task<HttpResponseMessage> AcceptAsync(PlayersClub club, TestWebAppFactory f, Guid who, Guid bookingId, Guid seat)
    {
        var shown = (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ShareMinutes;
        return await club.Client(f, who).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareMinutes = shown });
    }

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    private static async Task SettleAsync(PlayersClub club, TestWebAppFactory f, Guid bookingId) =>
        await f.Services.GetRequiredService<ShareHook>().AfterSettlementAsync(club.TenantId, club.Slug, [bookingId], default);

    // ------------------------------------------------------------------ booking with players

    [SkippableFact]
    public async Task A_booking_made_with_players_charges_the_organiser_in_full_and_invites_the_partners()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plbook");
        await club.CreditAsync(f, club.Organiser, 100);

        var (bookingId, body) = await club.BookWithPlayersAsync(f, SamAndAlex(club));

        Assert.Equal(68, body.GetProperty("balance_after_minutes").GetInt32());
        var seats = await club.SeatsAsync(f, bookingId);
        Assert.Equal([1, 2, 3], seats.Select(s => s.Seat));
        Assert.Equal([12, 10, 10], seats.Select(s => s.ShareMinutes));
        Assert.Equal(ParticipantStatus.Accepted, seats[0].Status);
        Assert.All(seats.Skip(1), s => Assert.Equal(ParticipantStatus.Invited, s.Status));
        Assert.All(seats.Skip(1), s => Assert.NotNull(s.InviteTokenHash));
        Assert.Empty(await club.SharesAsync(f, bookingId));

        // Each partner has an invite on their inbox and one in the outbox — the same fact twice.
        var inbox = await PlayersClub.ReadAsync(f, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Kind == MemberEventCatalogue.Invited).Select(n => n.UserId).ToListAsync());
        Assert.Equal(new[] { club.Sam, club.Alex }.Order(), inbox.Order());
        var outbox = await PlayersClub.ReadAsync(f, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Audience == NotificationAudience.Member).ToListAsync());
        Assert.Equal(2, outbox.Count);
        Assert.All(outbox, n => Assert.Equal(MemberEventCatalogue.Invited, n.Kind));
    }

    [SkippableFact]
    public async Task A_split_that_cannot_work_books_nothing()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plbad");
        await club.CreditAsync(f, club.Organiser, 100);

        var response = await club.Client(f, club.Organiser).PostAsJsonAsync("/api/v1/bookings", new
        {
            courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(), sliceCount = 4, splitMode = "amount",
            players = new object[] { new { userId = club.Sam, amount = 40 } },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(SplitCalculator.ExceedsPrice, (await JsonAsync(response)).GetProperty("error").GetString());
        Assert.Equal(100, await PlayersClub.BalanceAsync(f, club.Organiser));
        Assert.Equal(0, await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().CountAsync(b => b.TenantId == club.TenantId)));
    }

    [SkippableFact]
    public async Task A_fifth_player_has_no_seat_to_take()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plfull");
        await club.CreditAsync(f, club.Organiser, 100);
        var (bookingId, _) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }, new { userId = club.Alex }, new { userId = club.Jo }]);

        var response = await club.Client(f, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = new object[] { new { guestName = "Uncle Bob" } } });

        // R19 J19-5: no room is "booking_full", not "that seat was taken" (a seat to pick does not exist).
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(PlayerErrors.BookingFull, (await JsonAsync(response)).GetProperty("error").GetString());

        // And the database says so on its own, whatever the service believes.
        var extra = await Assert.ThrowsAsync<DbUpdateException>(() => club.InsertSeatAsync(
            f, bookingId, 3, club.Bystander, ParticipantStatus.Invited, 0));
        Assert.Equal("23505", (extra.InnerException as Npgsql.PostgresException)?.SqlState);
    }

    // ------------------------------------------------------------------ accept and pay

    /// <summary>A double tap is one payment: one pair on the ledger, the same answer twice.</summary>
    [SkippableFact]
    public async Task Accepting_twice_pays_once()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "placc");
        await club.CreditAsync(f, club.Organiser, 100);
        await club.CreditAsync(f, club.Sam, 50);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, SamAndAlex(club));
        var samSeat = PlayersClub.SeatOf(body, 2);

        var first = await AcceptAsync(club, f, club.Sam, bookingId, samSeat);
        var second = await AcceptAsync(club, f, club.Sam, bookingId, samSeat);

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.Equal(10, (await JsonAsync(second)).GetProperty("paid_minutes").GetInt32());

        var pair = await club.SharesAsync(f, bookingId);
        Assert.Equal(2, pair.Count);
        Assert.Equal(-10, pair.Single(l => l.UserId == club.Sam).AmountMinutes);
        Assert.Equal(10, pair.Single(l => l.UserId == club.Organiser).AmountMinutes);
        Assert.Equal(0, pair.Sum(l => l.AmountMinutes));
        Assert.Equal(ShareLedger.Reference(samSeat, 1, "out"), pair.Single(l => l.UserId == club.Sam).ExternalReference);
        Assert.Equal(40, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(78, await PlayersClub.BalanceAsync(f, club.Organiser));
    }

    /// <summary>Five taps in flight together: the partner's lock and the pair's references keep it one payment.</summary>
    [SkippableFact]
    public async Task Racing_accepts_pay_once()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plrace");
        await club.CreditAsync(f, club.Organiser, 100);
        await club.CreditAsync(f, club.Sam, 50);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, SamAndAlex(club));
        var samSeat = PlayersClub.SeatOf(body, 2);

        var answers = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => AcceptAsync(club, f, club.Sam, bookingId, samSeat)));

        Assert.All(answers, a => Assert.Equal(HttpStatusCode.OK, a.StatusCode));
        Assert.Equal(2, (await club.SharesAsync(f, bookingId)).Count);
        Assert.Equal(40, await PlayersClub.BalanceAsync(f, club.Sam));
    }

    /// <summary>Two members racing for one open link seat: one gets it, the other is told it has gone.</summary>
    [SkippableFact]
    public async Task One_link_seat_is_one_player()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "pllink");
        await club.CreditAsync(f, club.Organiser, 100);
        await club.CreditAsync(f, club.Sam, 50);
        await club.CreditAsync(f, club.Jo, 50);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { link = true }]);
        var token = PlayersClub.TokenOf(body, 2)!;
        Assert.Equal(22, token.Length);

        // Opening the link shows the game, priced for whoever opened it.
        var view = await JsonAsync(await club.Client(f, club.Sam).GetAsync($"/api/v1/invites/{token}"));
        Assert.True(view.GetProperty("open_link").GetBoolean());
        Assert.Equal(16, view.GetProperty("to_pay_minutes").GetInt32());

        var answers = await Task.WhenAll(
            club.Client(f, club.Sam).PostAsJsonAsync($"/api/v1/invites/{token}/accept", new { expectedShareMinutes = 16 }),
            club.Client(f, club.Jo).PostAsJsonAsync($"/api/v1/invites/{token}/accept", new { expectedShareMinutes = 16 }));

        Assert.Single(answers, a => a.StatusCode == HttpStatusCode.OK);
        var seats = await club.SeatsAsync(f, bookingId);
        Assert.Single(seats, s => s.Seat == 2 && s.Status == ParticipantStatus.Accepted);
        Assert.Equal(2, (await club.SharesAsync(f, bookingId)).Count);
        Assert.Equal(84, await PlayersClub.BalanceAsync(f, club.Sam) + await PlayersClub.BalanceAsync(f, club.Jo));

        // The link names a claimed seat now: a third member learns nothing from it.
        Assert.Equal(HttpStatusCode.NotFound, (await club.Client(f, club.Bystander).GetAsync($"/api/v1/invites/{token}")).StatusCode);
    }

    [SkippableFact]
    public async Task A_partner_who_cannot_cover_the_share_is_told_by_how_much_and_nothing_changes()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plshort");
        await club.CreditAsync(f, club.Organiser, 100);
        await club.CreditAsync(f, club.Sam, 4);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, SamAndAlex(club));
        var samSeat = PlayersClub.SeatOf(body, 2);

        var response = await AcceptAsync(club, f, club.Sam, bookingId, samSeat);

        Assert.Equal(HttpStatusCode.PaymentRequired, response.StatusCode);
        var refusal = await JsonAsync(response);
        Assert.Equal(PlayerErrors.InsufficientBalance, refusal.GetProperty("error").GetString());
        Assert.Equal(10, refusal.GetProperty("required_minutes").GetInt32());
        Assert.Equal(4, refusal.GetProperty("current_minutes").GetInt32());
        Assert.Equal(ParticipantStatus.Invited, (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == samSeat).Status);
        Assert.Empty(await club.SharesAsync(f, bookingId));
    }

    // ------------------------------------------------------------------ reconcile, and every settlement path

    [SkippableFact]
    public async Task Reconciling_twice_writes_nothing_the_second_time()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plidem");
        await club.CreditAsync(f, club.Organiser, 100);
        await club.CreditAsync(f, club.Sam, 50);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, SamAndAlex(club));
        await AcceptAsync(club, f, club.Sam, bookingId, PlayersClub.SeatOf(body, 2));

        var before = await PlayersClub.ReadAsync(f, db => db.LedgerEntries.IgnoreQueryFilters().CountAsync(l => l.TenantId == club.TenantId));
        var worker = f.Services.GetRequiredService<ShareWorker>();
        await worker.TickAsync(DateTimeOffset.UtcNow, default);
        await worker.TickAsync(DateTimeOffset.UtcNow, default);
        await SettleAsync(club, f, bookingId);
        var moves = await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(bookingId, default));

        Assert.Empty(moves);
        Assert.Equal(before, await PlayersClub.ReadAsync(f, db => db.LedgerEntries.IgnoreQueryFilters().CountAsync(l => l.TenantId == club.TenantId)));
    }

    /// <summary>The organiser cancels outside the window: the club refunds them in full and every paid share comes back.</summary>
    [SkippableFact]
    public async Task Cancelling_returns_every_share_and_tells_every_player()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plcancel");
        await club.CreditAsync(f, club.Organiser, 100);
        await club.CreditAsync(f, club.Sam, 50);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, SamAndAlex(club));
        await AcceptAsync(club, f, club.Sam, bookingId, PlayersClub.SeatOf(body, 2));

        var cancel = await club.Client(f, club.Organiser).PostAsync($"/api/v1/bookings/{bookingId}/cancel", null);

        Assert.Equal(HttpStatusCode.OK, cancel.StatusCode);
        Assert.Equal(50, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(100, await PlayersClub.BalanceAsync(f, club.Organiser));
        Assert.Equal(4, (await club.SharesAsync(f, bookingId)).Count);
        var told = await PlayersClub.ReadAsync(f, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Kind == MemberEventCatalogue.GameCancelled).Select(n => n.UserId).ToListAsync());
        Assert.Equal(new[] { club.Sam, club.Alex }.Order(), told.Order());
    }

    /// <summary>Inside the window the late-cancel penalty stands — on the organiser alone. The partners get everything back.</summary>
    [SkippableFact]
    public async Task A_late_cancellation_penalty_is_the_organisers()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "pllate");
        await club.CreditAsync(f, club.Sam, 50);
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddMinutes(10));
        await club.CreditAsync(f, club.Organiser, 32);
        var seat = await AddPartnerAsync(club, f, bookingId, club.Sam);
        Assert.Equal(HttpStatusCode.OK, (await AcceptAsync(club, f, club.Sam, bookingId, seat)).StatusCode);
        Assert.Equal(34, await PlayersClub.BalanceAsync(f, club.Sam));

        var cancel = await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/cancel", new { reason = "Court maintenance" });

        Assert.Equal(HttpStatusCode.OK, cancel.StatusCode);
        Assert.Equal(50, await PlayersClub.BalanceAsync(f, club.Sam));
        // 0 after the charge, +16 from Sam, +32 refund, −9 penalty (⌊30% of 32⌋, the member keeps
        // the part-minute, §1.2), −16 back to Sam.
        Assert.Equal(23, await PlayersClub.BalanceAsync(f, club.Organiser));
    }

    /// <summary>A no-show's penalty is shared pro rata; the rest of each share comes back.</summary>
    [SkippableFact]
    public async Task A_no_show_shares_the_penalty_pro_rata()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plnoshow");
        await club.CreditAsync(f, club.Sam, 50);
        var start = DateTimeOffset.UtcNow.AddMinutes(-10);
        var bookingId = await club.InsertBookingAsync(f, start);
        await club.CreditAsync(f, club.Organiser, 32);
        var seat = await AddPartnerAsync(club, f, bookingId, club.Sam);
        Assert.Equal(HttpStatusCode.OK, (await AcceptAsync(club, f, club.Sam, bookingId, seat)).StatusCode);

        await new NoShowWorker(f.Services, f.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance)
            .TickAsync(DateTimeOffset.UtcNow, default);

        var booking = await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == bookingId));
        Assert.Equal(BookingStatus.NoShow, booking.Status);
        // Owed = ⌊30% of 32⌋ = 9; Sam's 16 of 32 is half of it, rounded down: ⌊4.5⌋ = 4 — so 12 came
        // back to him and the organiser keeps the odd minute of the penalty (§1.2).
        Assert.Equal(50 - 4, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(32 - 9 + 4, await PlayersClub.BalanceAsync(f, club.Organiser));

        // Late evidence reverses the no-show: the court was played, so the share is the full 16 again.
        await club.InClubAsync(f, async sp =>
        {
            var db = sp.GetRequiredService<MainframeDbContext>();
            var row = await db.Bookings.FirstAsync(b => b.Id == bookingId);
            return await sp.GetRequiredService<BookingService>().ReverseNoShowAsync(row, start.AddMinutes(1), Guid.Empty, default);
        });
        await SettleAsync(club, f, bookingId);

        Assert.Equal(34, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(16, await PlayersClub.BalanceAsync(f, club.Organiser));
    }

    /// <summary>
    /// Review round 8, E8-1: a no-show reversed by the box's late upload stamped the booking checked
    /// in but no PLAYER — the page read "Checked in at 08:52" above "0 of 2 players checked in", and
    /// the scanner's Night had no "Checked in" row. The reversal now records the scan exactly as an
    /// activation does: the scanner's own seat, and the <c>court.activated</c> row with their name.
    /// </summary>
    [SkippableFact]
    public async Task A_reversed_no_show_checks_in_the_player_who_scanned()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plrevscan");
        await club.CreditAsync(f, club.Sam, 50);
        var start = DateTimeOffset.UtcNow.AddMinutes(-10);
        var bookingId = await club.InsertBookingAsync(f, start);
        await club.CreditAsync(f, club.Organiser, 32);
        var seat = await AddPartnerAsync(club, f, bookingId, club.Sam);
        Assert.Equal(HttpStatusCode.OK, (await AcceptAsync(club, f, club.Sam, bookingId, seat)).StatusCode);

        await new NoShowWorker(f.Services, f.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance)
            .TickAsync(DateTimeOffset.UtcNow, default);

        var scannedAt = start.AddMinutes(2).Storable();
        var result = await club.InClubAsync(f, async sp =>
        {
            var row = await sp.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(b => b.Id == bookingId);
            return await sp.GetRequiredService<BookingService>().ReverseNoShowAsync(
                row, scannedAt, Guid.Empty, default, scan: new ReversalScan(club.Sam, "member_code"));
        });
        Assert.IsType<NoShowReversalResult.Ok>(result);

        var detail = await JsonAsync(await club.Client(f, club.Sam).GetAsync($"/api/v1/bookings/{bookingId}"));
        Assert.Equal(1, detail.GetProperty("attendance").GetProperty("players_checked_in").GetInt32());
        var samSeat = detail.GetProperty("players").EnumerateArray().Single(p => p.GetProperty("participant_id").GetGuid() == seat);
        Assert.Equal(JsonValueKind.String, samSeat.GetProperty("checked_in_at").ValueKind);

        var night = await JsonAsync(await club.Client(f, club.Admin, admin: true)
            .GetAsync($"/api/v1/admin/members/{club.Sam}/trace?day={scannedAt:yyyy-MM-dd}"));
        var checkedIn = Assert.Single(night.GetProperty("events").EnumerateArray(),
            e => e.GetProperty("kind").GetString() == TraceKinds.CourtCheckedIn);
        Assert.StartsWith("Checked in at", checkedIn.GetProperty("headline").GetString(), StringComparison.Ordinal);
    }

    /// <summary>
    /// No debts: when a reversal raises a partner's share back but they have spent the refund, the
    /// reconcile does NOT take them below zero — the rest is unpaid, theirs to pay until the deadline.
    /// </summary>
    [SkippableFact]
    public async Task A_share_the_partner_cannot_cover_is_left_unpaid_never_overdrawn()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plnodebt");
        await club.CreditAsync(f, club.Sam, 16);
        var start = DateTimeOffset.UtcNow.AddMinutes(-10);
        var bookingId = await club.InsertBookingAsync(f, start);
        await club.CreditAsync(f, club.Organiser, 32);
        var seat = await AddPartnerAsync(club, f, bookingId, club.Sam);
        Assert.Equal(HttpStatusCode.OK, (await AcceptAsync(club, f, club.Sam, bookingId, seat)).StatusCode);
        Assert.Equal(0, await PlayersClub.BalanceAsync(f, club.Sam));

        await new NoShowWorker(f.Services, f.Services.GetRequiredService<IEventBus>(), NullLogger<NoShowWorker>.Instance)
            .TickAsync(DateTimeOffset.UtcNow, default);
        // Owed = ⌊30% of 32⌋ = 9; Sam's half of it is ⌊4.5⌋ = 4, so 12 of his 16 came back.
        Assert.Equal(12, await PlayersClub.BalanceAsync(f, club.Sam));
        // Sam spends the refund elsewhere.
        await club.WriteAsync(f, db => db.LedgerEntries.Add(new LedgerEntry
        {
            TenantId = club.TenantId, UserId = club.Sam, Type = LedgerEntryType.AdminAdjustment, AmountMinutes = -12, ActorUserId = club.Admin,
        }));

        await club.InClubAsync(f, async sp =>
        {
            var row = await sp.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(b => b.Id == bookingId);
            return await sp.GetRequiredService<BookingService>().ReverseNoShowAsync(row, start.AddMinutes(1), Guid.Empty, default);
        });
        await SettleAsync(club, f, bookingId);

        Assert.Equal(0, await PlayersClub.BalanceAsync(f, club.Sam));
        var view = await JsonAsync(await club.Client(f, club.Organiser).GetAsync($"/api/v1/bookings/{bookingId}"));
        var unpaid = view.GetProperty("money").GetProperty("unpaid_minutes");
        Assert.Equal(JsonValueKind.Number, unpaid.ValueKind);
        Assert.Equal("12", unpaid.GetRawText());
    }

    /// <summary>A displaced booking owes nothing (S8), so neither does any partner on it.</summary>
    [SkippableFact]
    public async Task A_displaced_booking_returns_every_share()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "pldisp");
        await club.CreditAsync(f, club.Organiser, 100);
        await club.CreditAsync(f, club.Sam, 50);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        await AcceptAsync(club, f, club.Sam, bookingId, PlayersClub.SeatOf(body, 2));
        Assert.Equal(34, await PlayersClub.BalanceAsync(f, club.Sam));

        // What DisplacementAsync writes: the booking cancelled as ResoldTailRefunded, the charge refunded.
        await club.WriteAsync(f, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == bookingId);
            b.Status = BookingStatus.Cancelled;
            b.CancellationReason = BookingService.ResoldTailRefunded;
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = club.TenantId, UserId = club.Organiser, Type = LedgerEntryType.CancellationRefund,
                AmountMinutes = 32, ActorUserId = Guid.Empty, RelatedBookingId = bookingId, Reason = BookingService.ResoldTailRefunded,
            });
        });
        await SettleAsync(club, f, bookingId);

        Assert.Equal(50, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(100, await PlayersClub.BalanceAsync(f, club.Organiser));
    }

    // ------------------------------------------------------------------ withdraw, lapse, remove

    [SkippableFact]
    public async Task A_partner_may_withdraw_outside_the_window_and_is_refunded()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plwd");
        await club.CreditAsync(f, club.Organiser, 100);
        await club.CreditAsync(f, club.Sam, 50);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, SamAndAlex(club));
        var samSeat = PlayersClub.SeatOf(body, 2);
        await AcceptAsync(club, f, club.Sam, bookingId, samSeat);

        var response = await club.Client(f, club.Sam).PostAsync($"/api/v1/bookings/{bookingId}/players/{samSeat}/withdraw", null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(50, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(ParticipantStatus.Withdrawn, (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == samSeat).Status);
    }

    [SkippableFact]
    public async Task Inside_the_late_cancel_window_a_partner_cannot_withdraw()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plwdlate");
        await club.CreditAsync(f, club.Sam, 50);
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddMinutes(10));
        var seat = await AddPartnerAsync(club, f, bookingId, club.Sam);
        await AcceptAsync(club, f, club.Sam, bookingId, seat);

        var response = await club.Client(f, club.Sam).PostAsync($"/api/v1/bookings/{bookingId}/players/{seat}/withdraw", null);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(PlayerErrors.WithdrawWindowClosed, (await JsonAsync(response)).GetProperty("error").GetString());
        Assert.Equal(34, await PlayersClub.BalanceAsync(f, club.Sam));
    }

    /// <summary>
    /// 48 hours after the sold end an unanswered invite lapses: the organiser's cover stands, both
    /// are told once, nobody owes anybody, and the invite can no longer be accepted.
    /// </summary>
    [SkippableFact]
    public async Task An_unanswered_share_lapses_after_the_deadline()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "pllapse");
        await club.CreditAsync(f, club.Sam, 50);
        var start = DateTimeOffset.UtcNow.AddHours(-50);
        var bookingId = await club.InsertBookingAsync(f, start);
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).Status = BookingStatus.Completed);
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16);
        var seat = await club.InsertSeatAsync(f, bookingId, 2, club.Sam, ParticipantStatus.Invited, 16, start.AddDays(-1));

        // Before the deadline it may still be paid...
        var deadline = start.AddMinutes(32).AddHours(48);   // the sold end (4 × 8-minute slices) + 48 h
        var worker = f.Services.GetRequiredService<ShareWorker>();
        await worker.TickAsync(deadline.AddMinutes(-1), default);
        Assert.Equal(ParticipantStatus.Invited, (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).Status);

        // ...and after it, it has closed.
        await worker.TickAsync(deadline.AddMinutes(1), default);
        await worker.TickAsync(deadline.AddMinutes(2), default);

        var lapsed = (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat);
        Assert.Equal(ParticipantStatus.Lapsed, lapsed.Status);
        Assert.NotNull(lapsed.LapsedAt);
        Assert.Empty(await club.SharesAsync(f, bookingId));
        Assert.Equal(50, await PlayersClub.BalanceAsync(f, club.Sam));
        var told = await PlayersClub.ReadAsync(f, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Kind == MemberEventCatalogue.Lapsed).Select(n => n.UserId).ToListAsync());
        Assert.Equal(new[] { club.Organiser, club.Sam }.Order(), told.Order());

        var accept = await AcceptAsync(club, f, club.Sam, bookingId, seat);
        Assert.Equal(HttpStatusCode.Conflict, accept.StatusCode);
        Assert.Equal(PlayerErrors.InviteClosed, (await JsonAsync(accept)).GetProperty("error").GetString());
    }

    [SkippableFact]
    public async Task Removing_a_paid_partner_refunds_them_and_tells_them()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plremove");
        await club.CreditAsync(f, club.Organiser, 100);
        await club.CreditAsync(f, club.Sam, 50);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, SamAndAlex(club));
        var samSeat = PlayersClub.SeatOf(body, 2);
        await AcceptAsync(club, f, club.Sam, bookingId, samSeat);

        var response = await club.Client(f, club.Organiser).DeleteAsync($"/api/v1/bookings/{bookingId}/players/{samSeat}");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(50, await PlayersClub.BalanceAsync(f, club.Sam));
        // R5 (M5-8): the notice names the seat — the removed member reads 404 from the booking itself.
        var link = await PlayersClub.ReadAsync(f, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.UserId == club.Sam && n.Kind == MemberEventCatalogue.GameChanged).Select(n => n.Link).SingleAsync());
        Assert.Equal($"/bookings/{bookingId}?seat={samSeat}", link);
    }

    // ------------------------------------------------------------------ re-split and consent

    /// <summary>Raising a share asks again and takes nothing; the partner's own yes collects the difference. Lowering refunds.</summary>
    [SkippableFact]
    public async Task Raising_a_share_needs_the_partners_consent_and_lowering_it_refunds()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plresplit");
        await club.CreditAsync(f, club.Organiser, 100);
        await club.CreditAsync(f, club.Sam, 50);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var samSeat = PlayersClub.SeatOf(body, 2);
        await AcceptAsync(club, f, club.Sam, bookingId, samSeat);
        Assert.Equal(34, await PlayersClub.BalanceAsync(f, club.Sam));
        var organiser = club.Client(f, club.Organiser);

        var raise = await organiser.PutAsJsonAsync($"/api/v1/bookings/{bookingId}/split",
            new { mode = "amount", seats = new[] { new { participantId = samSeat, amount = 24m } } });
        Assert.Equal(HttpStatusCode.OK, raise.StatusCode);
        Assert.True((await JsonAsync(raise)).GetProperty("shares").EnumerateArray()
            .Single(s => s.GetProperty("participant_id").GetGuid() == samSeat).GetProperty("needs_consent").GetBoolean());
        Assert.Equal(34, await PlayersClub.BalanceAsync(f, club.Sam));

        Assert.Equal(HttpStatusCode.OK, (await AcceptAsync(club, f, club.Sam, bookingId, samSeat)).StatusCode);
        Assert.Equal(26, await PlayersClub.BalanceAsync(f, club.Sam));

        var lower = await organiser.PutAsJsonAsync($"/api/v1/bookings/{bookingId}/split",
            new { mode = "amount", seats = new[] { new { participantId = samSeat, amount = 5m } } });
        Assert.Equal(HttpStatusCode.OK, lower.StatusCode);
        Assert.Equal(45, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(100 - 32 + 5, await PlayersClub.BalanceAsync(f, club.Organiser));
    }

    // ------------------------------------------------------------------ D12 — the partner's cap

    [SkippableFact]
    public async Task Accepting_counts_against_the_partners_daily_cap()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plcap");
        await club.CreditAsync(f, club.Organiser, 100);
        await club.CreditAsync(f, club.Sam, 100);

        // Sam is invited, and only then takes his own hour for that day (R16 J16-11: an invite to a
        // member already at the cap is refused at the add, so the accept is where a later booking bites).
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var own = await club.Client(f, club.Sam).PostAsJsonAsync("/api/v1/bookings",
            new { courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(10), sliceCount = 4 });
        Assert.Equal(HttpStatusCode.OK, own.StatusCode);

        var response = await AcceptAsync(club, f, club.Sam, bookingId, PlayersClub.SeatOf(body, 2));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var refusal = await JsonAsync(response);
        Assert.Equal(PlayerErrors.PartnerCapExceeded, refusal.GetProperty("error").GetString());
        Assert.Equal("slots", refusal.GetProperty("cap").GetString());
        Assert.Equal(4, refusal.GetProperty("booked_slots").GetInt32());
        Assert.Empty(await club.SharesAsync(f, bookingId));

        // And the other way round: an accepted seat counts when the partner books for themselves.
        var (other, otherBody) = await club.BookWithPlayersAsync(f, [new { userId = club.Jo }], at: PlayersClub.Tomorrow(12).AddDays(1));
        await club.CreditAsync(f, club.Jo, 50);
        Assert.Equal(HttpStatusCode.OK, (await AcceptAsync(club, f, club.Jo, other, PlayersClub.SeatOf(otherBody, 2))).StatusCode);
        var jos = await club.Client(f, club.Jo).PostAsJsonAsync("/api/v1/bookings",
            new { courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(8).AddDays(1), sliceCount = 1 });
        Assert.Equal(HttpStatusCode.Conflict, jos.StatusCode);
        Assert.Equal("per_day_slot_cap_exceeded", (await JsonAsync(jos)).GetProperty("error").GetString());
    }

    // ------------------------------------------------------------------ access at the court and the door

    /// <summary>
    /// An ACCEPTED partner finds the game at the court box and checks in — the booking and their own
    /// seat — without becoming its payer; an invited one finds nothing.
    /// </summary>
    [SkippableFact]
    public async Task An_accepted_partner_can_open_the_court_and_checks_in_without_paying_for_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plcourt");
        await club.CreditAsync(f, club.Sam, 50);
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddMinutes(2));
        var samSeat = await AddPartnerAsync(club, f, bookingId, club.Sam);
        var alexSeat = await AddPartnerAsync(club, f, bookingId, club.Alex);

        var invitedFinds = await club.InClubAsync(f, sp =>
            sp.GetRequiredService<CourtActivationService>().FindForUserAsync(club.CourtId, club.Alex, DateTimeOffset.UtcNow, default));
        Assert.Null(invitedFinds);

        await AcceptAsync(club, f, club.Sam, bookingId, samSeat);
        var result = await club.InClubAsync(f, async sp =>
        {
            var activation = sp.GetRequiredService<CourtActivationService>();
            var booking = await activation.FindForUserAsync(club.CourtId, club.Sam, DateTimeOffset.UtcNow, default);
            Assert.NotNull(booking);
            var court = await sp.GetRequiredService<MainframeDbContext>().Courts.FirstAsync(c => c.Id == club.CourtId);
            // Even a payer override is ignored on a split booking: the scan checks Sam in and nothing else.
            return await activation.ActivateAsync(court, booking!, club.Sam, payerOverrideUserId: club.Sam, "qr", default);
        });

        Assert.IsType<ActivationResult.Activated>(result);
        var row = await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == bookingId));
        Assert.NotNull(row.CheckedInAt);
        Assert.Equal(club.Organiser, row.PaidByUserId);
        Assert.NotNull((await club.SeatsAsync(f, bookingId)).Single(s => s.Id == samSeat).CheckedInAt);
        Assert.Null((await club.SeatsAsync(f, bookingId)).Single(s => s.Id == alexSeat).CheckedInAt);
        Assert.True(await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().IsSplitAsync(bookingId, default)));
    }

    /// <summary>Under the booking-window door policy an accepted partner is due on a court; an invited one is not.</summary>
    [SkippableFact]
    public async Task An_accepted_partner_is_let_in_at_the_door_under_the_booking_window_policy()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "plgate");
        await club.CreditAsync(f, club.Sam, 50);
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddMinutes(10));
        var samSeat = await AddPartnerAsync(club, f, bookingId, club.Sam);

        async Task<GateDecision> DoorAsync(Guid who) => await club.InClubAsync(f, async sp =>
        {
            var codes = sp.GetRequiredService<AccessCodeService>();
            var code = await codes.MintIdentAsync(who, TimeSpan.FromMinutes(5), default);
            var settings = await sp.GetRequiredService<TenantSettingsAccessor>().GetAsync(default) with
            {
                GateAccessPolicy = GateAccessPolicies.BookingWindow,
            };
            var door = new Device
            {
                TenantId = club.TenantId, DeviceCode = "gate-pl", Name = "Door", Kind = DeviceKind.Gate,
                Hardware = DeviceHardware.Esp32, MacAddress = "ff0000000177", CourtNumbers = [], GateKey = "front",
            };
            return await GateAccess.DecideAsync(
                sp.GetRequiredService<MainframeDbContext>(), codes, new GateContext(door, settings, "qr", code.Code, DateTimeOffset.UtcNow), default);
        });

        Assert.False((await DoorAsync(club.Sam)).Opened);
        await AcceptAsync(club, f, club.Sam, bookingId, samSeat);
        Assert.True((await DoorAsync(club.Sam)).Opened);
        Assert.False((await DoorAsync(club.Bystander)).Opened);
    }

    // ------------------------------------------------------------------ helpers

    /// <summary>Adds a member to a booking through the organiser's own route and answers their seat.</summary>
    private static async Task<Guid> AddPartnerAsync(PlayersClub club, TestWebAppFactory f, Guid bookingId, Guid who)
    {
        var response = await club.Client(f, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
            new { players = new object[] { new { userId = who } } });
        var body = await JsonAsync(response);
        Assert.True(response.IsSuccessStatusCode, body.ToString());
        return body.GetProperty("participants")[0].GetProperty("participant_id").GetGuid();
    }
}
