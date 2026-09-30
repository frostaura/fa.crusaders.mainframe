using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Crusaders.Mainframe.Api.Workers;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The fourth refuter round on the P11 players fixes (D11), on Postgres: money held for a booking
/// is earmarked for that booking's partners, waiting returns are paid first come first served,
/// the start-up catch-up is bounded and retried per club, and the wallet is told when what is
/// set aside moves. Each test failed on the code it follows.
/// </summary>
public sealed class PlayersRefute4HttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    /// <summary>
    /// A played game past its deadline on which <paramref name="partner"/> paid 16; the organiser
    /// spent it (net 0 on this game) and the partner's seat comes off. With
    /// <paramref name="reconcile"/> the return is found uncovered and starts waiting.
    /// </summary>
    private static async Task<(Guid BookingId, Guid Seat)> ReturnDueAsync(
        PlayersClub club, TestWebAppFactory f, Guid partner, bool reconcile = true, int daysAgo = 10)
    {
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(-daysAgo));
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).Status = BookingStatus.Completed);
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16m);
        var seat = await club.InsertSeatAsync(f, bookingId, 2, partner, ParticipantStatus.Accepted, 16m);
        await PaidAsync(club, f, bookingId, seat, partner, deadlineDaysAgo: daysAgo - 2);
        await club.CreditAsync(f, club.Organiser, 32m);   // the court
        await club.CreditAsync(f, club.Organiser, -16m);  // the share, spent
        await club.CreditAsync(f, partner, 16m);
        await club.WriteAsync(f, db => db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).Status = ParticipantStatus.Removed);
        if (reconcile) await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(bookingId, default));
        return (bookingId, seat);
    }

    /// <summary>The partner's 16 paid to the organiser on a booking whose deadline is <paramref name="deadlineDaysAgo"/> days past.</summary>
    private static async Task PaidAsync(PlayersClub club, TestWebAppFactory f, Guid bookingId, Guid seat, Guid partner, int deadlineDaysAgo)
    {
        await club.WriteAsync(f, db =>
        {
            db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).ShareDeadlineAt = DateTimeOffset.UtcNow.AddDays(-deadlineDaysAgo);
            db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).ConsentedCredits = 16m;
            foreach (var posting in ShareLedger.Pair(new Booking { Id = bookingId }, new ShareMove(seat, partner, club.Organiser, 16m, 1), partner))
            {
                db.LedgerEntries.Add(new LedgerEntry
                {
                    TenantId = club.TenantId, UserId = posting.UserId, Type = posting.Type, AmountCredits = posting.AmountCredits,
                    ActorUserId = posting.ActorUserId, RelatedBookingId = bookingId, ExternalReference = posting.ExternalReference,
                });
            }
        });
    }

    // ------------------------------------------------------------------ HIGH. held money is earmarked

    /// <summary>
    /// Game X still holds Alex's 16; an unrelated game Y has a 16 return to Sam waiting. Alex
    /// withdraws from X: X's own hold covers his return, whatever waits elsewhere — he gets his 16
    /// back at once and nothing on X waits.
    /// </summary>
    [SkippableFact]
    public async Task A_return_up_to_its_own_bookings_hold_never_waits_behind_another_booking()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r4earmark");
        await ReturnDueAsync(club, f, club.Sam);                       // Y: 16 waiting to Sam, organiser 0
        await club.CreditAsync(f, club.Alex, 50m);
        var x = await club.InsertBookingAsync(f, PlayersClub.Tomorrow(8));
        await club.CreditAsync(f, club.Organiser, 32m);               // X paid for: organiser 0
        var add = await club.Client(f, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{x}/players",
            new { players = new object[] { new { userId = club.Alex } } });
        Assert.True(add.IsSuccessStatusCode, await add.Content.ReadAsStringAsync());
        var alex = (await add.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("participants")[0].GetProperty("participant_id").GetGuid();
        Assert.True((await club.Client(f, club.Alex).PostAsJsonAsync($"/api/v1/bookings/{x}/players/{alex}/accept",
            new { expectedShareCredits = 16m })).IsSuccessStatusCode);
        Assert.Equal(16m, await PlayersClub.BalanceAsync(f, club.Organiser));   // X holds 16; Y's 16 waits

        var withdraw = await club.Client(f, club.Alex).PostAsync($"/api/v1/bookings/{x}/players/{alex}/withdraw", null);

        Assert.Equal(HttpStatusCode.OK, withdraw.StatusCode);
        Assert.Equal(50m, await PlayersClub.BalanceAsync(f, club.Alex));
        Assert.Null((await club.SeatsAsync(f, x)).Single(s => s.Id == alex).ReturnPendingSince);
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Organiser));
    }

    // ------------------------------------------------------------------ MEDIUM. first come, first served

    /// <summary>
    /// Two returns wait, Sam's first. The organiser tops up 16 — enough for one: Sam's, the older,
    /// is paid; Jo's keeps waiting. They no longer block each other.
    /// </summary>
    [SkippableFact]
    public async Task Waiting_returns_are_paid_first_come_first_served()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r4fcfs");
        await ReturnDueAsync(club, f, club.Sam);
        await Task.Delay(20);
        var (joBooking, joSeat) = await ReturnDueAsync(club, f, club.Jo, daysAgo: 11);   // another day: one court
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Organiser));

        var topUp = await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/credit/{club.Organiser}/adjust",
            new { amountCredits = 16m, reason = "Cash at the desk", reasonCode = "top_up_cash", zarReceived = 10m });

        Assert.True(topUp.IsSuccessStatusCode);
        Assert.Equal(16m, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Jo));
        Assert.NotNull((await club.SeatsAsync(f, joBooking)).Single(s => s.Id == joSeat).ReturnPendingSince);
    }

    // ------------------------------------------------------------------ LOW. the catch-up

    /// <summary>
    /// The start-up catch-up picks, in SQL, only bookings where a return is due and not yet made —
    /// not every no-show or cancelled-after-check-in split game in history, settled long ago.
    /// </summary>
    [SkippableFact]
    public async Task The_catch_up_reconciles_only_bookings_with_a_return_due()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r4bound");
        var (due, _) = await ReturnDueAsync(club, f, club.Sam, reconcile: false);

        // A game cancelled after check-in, long ago, whose share is settled in full: nothing due.
        var settled = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(-40));
        await club.WriteAsync(f, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == settled);
            b.Status = BookingStatus.Cancelled;
            b.CheckedInAt = b.StartsAt;
        });
        await club.InsertSeatAsync(f, settled, 1, club.Organiser, ParticipantStatus.Accepted, 16m);
        var jo = await club.InsertSeatAsync(f, settled, 2, club.Jo, ParticipantStatus.Accepted, 16m);
        await PaidAsync(club, f, settled, jo, club.Jo, deadlineDaysAgo: 38);

        var reconciled = await club.InClubAsync(f, sp => sp.GetRequiredService<ShareSweep>().CatchUpAsync(default));

        Assert.Equal([due], reconciled);
    }

    /// <summary>
    /// A club whose catch-up failed on the first pass is caught up on the next one: the worker
    /// marks a club caught up only when its catch-up succeeded.
    /// </summary>
    [SkippableFact]
    public async Task A_club_whose_catch_up_failed_is_caught_up_on_the_next_pass()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r4retry");
        var (bookingId, seat) = await ReturnDueAsync(club, f, club.Sam, reconcile: false, daysAgo: 12);
        var worker = f.Services.GetRequiredService<ShareWorker>();

        // A settings row the reader cannot use makes this club's pass throw.
        await club.WriteAsync(f, db => db.TenantSettings.IgnoreQueryFilters().First(s => s.TenantId == club.TenantId).SettingsJson = "[]");
        await worker.TickAsync(DateTimeOffset.UtcNow, default);
        Assert.Null((await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ReturnPendingSince);

        await club.WriteAsync(f, db => db.TenantSettings.IgnoreQueryFilters().First(s => s.TenantId == club.TenantId).SettingsJson = PlayersClub.Settings);
        // Past the marker's first backoff interval (round 6): the failed booking was marked due, so
        // the marker — drained by the sweep — is what makes it good.
        await worker.TickAsync(DateTimeOffset.UtcNow.AddMinutes(2), default);

        Assert.NotNull((await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ReturnPendingSince);
    }

    // ------------------------------------------------------------------ LOW. the wallet hears about it

    /// <summary>
    /// A return starting to wait moves the organiser's spendable without a ledger row; their live
    /// wallet is told, with the amount now owed back.
    /// </summary>
    [SkippableFact]
    public async Task The_wallet_is_told_when_a_return_starts_waiting()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r4frame");
        var (bookingId, _) = await ReturnDueAsync(club, f, club.Sam, reconcile: false);
        var channel = f.Services.GetRequiredService<IRealtimeBus>().Subscribe(RealtimeTopic.Wallet(club.TenantId, club.Organiser));

        await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(bookingId, default));

        var frames = new List<RealtimeMessage>();
        while (channel.Reader.TryRead(out var frame)) frames.Add(frame);
        var balance = Assert.Single(frames, m => m.Event == LedgerService.BalanceEvent);
        Assert.Equal(16m, JsonDocument.Parse(balance.JsonPayload).RootElement.GetProperty("owed_back_credits").GetDecimal());
    }
}
