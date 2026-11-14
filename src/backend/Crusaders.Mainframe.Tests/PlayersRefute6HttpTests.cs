using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Workers;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The sixth refuter round on the P11 players fixes (D11), on Postgres: a game cancelled after
/// check-in no longer counts its own return twice, the start-up catch-up does not rerun for ever
/// behind a poisoned booking, the "reconcile due" marker backs off, is not erased by a reconcile
/// that started before a failure, and stays inside its club. Each test failed on the code it follows.
/// </summary>
public sealed class PlayersRefute6HttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    /// <summary>
    /// A game Sam paid <paramref name="share"/> on, checked into and cancelled (S4): nothing came
    /// back, the share stayed owed, and the organiser spent it. Organiser balance: 0.
    /// </summary>
    private static async Task<(Guid BookingId, Guid Seat)> SpentS4Async(PlayersClub club, TestWebAppFactory f, int share)
    {
        await club.CreditAsync(f, club.Sam, 50);
        await club.CreditAsync(f, club.Organiser, 32);
        var x = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddMinutes(40));
        var add = await club.Client(f, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{x}/players",
            new { players = new object[] { new { userId = club.Sam, amount = share } }, splitMode = "amount" });
        Assert.True(add.IsSuccessStatusCode, await add.Content.ReadAsStringAsync());
        var seat = (await JsonAsync(add)).GetProperty("participants")[0].GetProperty("participant_id").GetGuid();
        var accept = await club.Client(f, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{x}/players/{seat}/accept", new { expectedShareMinutes = share });
        Assert.True(accept.IsSuccessStatusCode, await accept.Content.ReadAsStringAsync());
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == x).CheckedInAt = DateTimeOffset.UtcNow);
        // R15 D15-5: a member may not cancel a booking once checked in — only the desk can (S4 is the desk's now).
        Assert.True((await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/bookings/{x}/cancel", new { reason = "Court flooded" })).IsSuccessStatusCode);
        await club.CreditAsync(f, club.Organiser, -share);
        Assert.Equal(0, await PlayersClub.BalanceAsync(f, club.Organiser));
        return (x, seat);
    }

    // ------------------------------------------------------------------ HIGH. an S4 return is not counted twice

    /// <summary>
    /// The organiser holds 20, nothing else set aside. The desk takes Sam off a game cancelled after
    /// check-in: the pre-check says 20 covers his 16 — and the ledger agrees. It is paid, not left
    /// waiting behind its own amount counted a second time.
    /// </summary>
    [SkippableFact]
    public async Task An_admin_remove_on_a_game_cancelled_after_check_in_pays_when_the_free_balance_covers_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r6remove");
        var (x, sam) = await SpentS4Async(club, f, 16);
        await club.CreditAsync(f, club.Organiser, 20);

        var removed = await club.Client(f, club.Admin, admin: true)
            .PostAsJsonAsync($"/api/v1/admin/bookings/{x}/players/{sam}/remove", new { reason = "Came off the sheet" });

        Assert.True(removed.IsSuccessStatusCode, await removed.Content.ReadAsStringAsync());
        Assert.False((await JsonAsync(removed)).GetProperty("return_waiting").GetBoolean());
        Assert.Equal(50, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(4, await PlayersClub.BalanceAsync(f, club.Organiser));
    }

    /// <summary>
    /// A goodwill credit of 32 naming a game cancelled after check-in, on which Sam paid 24: what the
    /// organiser owes falls to nothing, Sam is due his 24, and the 32 that just arrived pays it.
    /// </summary>
    [SkippableFact]
    public async Task A_goodwill_credit_naming_a_game_cancelled_after_check_in_releases_its_return()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r6goodwill");
        var (x, sam) = await SpentS4Async(club, f, 24);

        var credit = await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/minutes/{club.Organiser}/adjust",
            new { amountMinutes = 32, reason = "Court flooded", relatedBookingId = x, reasonCode = "goodwill" });

        Assert.True(credit.IsSuccessStatusCode, await credit.Content.ReadAsStringAsync());
        Assert.Equal(50, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(8, await PlayersClub.BalanceAsync(f, club.Organiser));
        Assert.Null((await club.SeatsAsync(f, x)).Single(s => s.Id == sam).ReturnPendingSince);
    }

    // ------------------------------------------------------------------ the marker

    /// <summary>
    /// A recent played game on which <paramref name="partner"/> paid 16 and came off: a return due,
    /// which the sweep makes (the organiser can cover it).
    /// </summary>
    private static async Task<Guid> DueAsync(PlayersClub club, TestWebAppFactory f, Guid partner, DateTimeOffset start)
    {
        var bookingId = await club.InsertBookingAsync(f, start);
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).Status = BookingStatus.Completed);
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16);
        var seat = await club.InsertSeatAsync(f, bookingId, 2, partner, ParticipantStatus.Removed, 16);
        await club.WriteAsync(f, db =>
        {
            db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).ConsentedMinutes = 16;
            foreach (var posting in ShareLedger.Pair(new Booking { Id = bookingId }, new ShareMove(seat, partner, club.Organiser, 16, 1), partner))
            {
                db.LedgerEntries.Add(new LedgerEntry
                {
                    TenantId = club.TenantId,
                    UserId = posting.UserId,
                    Type = posting.Type,
                    AmountMinutes = posting.AmountMinutes,
                    ActorUserId = posting.ActorUserId,
                    RelatedBookingId = bookingId,
                    ExternalReference = posting.ExternalReference,
                });
            }
        });
        await club.CreditAsync(f, club.Organiser, 32);
        await club.CreditAsync(f, partner, 16);
        return bookingId;
    }

    private static Task SweepAsync(PlayersClub club, TestWebAppFactory f, DateTimeOffset now) =>
        club.InClubAsync(f, async sp =>
        {
            await sp.GetRequiredService<ShareSweep>().SweepAsync(now, default);
            return 0;
        });

    private static Task<Booking> BookingAsync(TestWebAppFactory f, Guid id) =>
        PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().AsNoTracking().FirstAsync(b => b.Id == id));

    /// <summary>
    /// A club whose start-up catch-up met a poisoned booking is caught up once that booking is
    /// marked due — the marker covers it — rather than rerunning the whole catch-up every minute.
    /// </summary>
    [SkippableFact]
    public async Task A_catch_up_that_marked_its_failures_counts_as_caught_up()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r6caught");
        var old = await DueAsync(club, f, club.Sam, DateTimeOffset.UtcNow.AddDays(-30));
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(x => x.Id == old).ShareDeadlineAt = DateTimeOffset.UtcNow.AddDays(-28));
        var worker = f.Services.GetRequiredService<ShareWorker>();

        await using (await ShareSabotage.InstallAsync(f, old))
        {
            await worker.TickAsync(DateTimeOffset.UtcNow, default);
        }

        Assert.NotNull((await BookingAsync(f, old)).ShareReconcileDueAt);
        Assert.True(worker.IsCaughtUp(club.TenantId));
    }

    /// <summary>
    /// A booking that keeps failing is retried on an exponential backoff, not every minute: a sweep
    /// straight after the failure leaves it alone; one past the first interval tries again.
    /// </summary>
    [SkippableFact]
    public async Task A_booking_that_keeps_failing_is_retried_on_a_backoff()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r6backoff");
        var poisoned = await DueAsync(club, f, club.Sam, DateTimeOffset.UtcNow.AddHours(-3));

        await using (await ShareSabotage.InstallAsync(f, poisoned))
        {
            await SweepAsync(club, f, DateTimeOffset.UtcNow);
            Assert.Equal(1, (await BookingAsync(f, poisoned)).ShareReconcileAttempts);

            await SweepAsync(club, f, DateTimeOffset.UtcNow.AddSeconds(30));
            Assert.Equal(1, (await BookingAsync(f, poisoned)).ShareReconcileAttempts);

            await SweepAsync(club, f, DateTimeOffset.UtcNow.AddMinutes(3));
            Assert.Equal(2, (await BookingAsync(f, poisoned)).ShareReconcileAttempts);
        }

        await SweepAsync(club, f, DateTimeOffset.UtcNow.AddHours(2));
        var healed = await BookingAsync(f, poisoned);
        Assert.Null(healed.ShareReconcileDueAt);
        Assert.Equal(0, healed.ShareReconcileAttempts);
        Assert.Equal(16, await PlayersClub.BalanceAsync(f, club.Sam));
    }

    /// <summary>
    /// A reconcile clears only a marker set before it started: a failure recorded while it ran (a
    /// concurrent hook) survives it, for the next sweep.
    /// </summary>
    [SkippableFact]
    public async Task A_reconcile_does_not_erase_a_failure_recorded_after_it_started()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r6clear");
        var booking = await DueAsync(club, f, club.Sam, DateTimeOffset.UtcNow.AddHours(-3));
        var later = DateTimeOffset.UtcNow.AddMinutes(5);
        await club.WriteAsync(f, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == booking);
            b.ShareReconcileDueAt = DateTimeOffset.UtcNow.AddMinutes(-1);
            b.ShareReconcileAttempts = 1;
            b.ShareReconcileLastAttemptAt = later;   // a failure recorded after the reconcile below starts
        });

        await club.InClubAsync(f, async sp =>
        {
            await sp.GetRequiredService<ShareSweep>().SettleBookingAsync(booking, default);
            return 0;
        });

        Assert.NotNull((await BookingAsync(f, booking)).ShareReconcileDueAt);
    }

    /// <summary>
    /// The marker is a tenant-scoped column: one club's sweep never reconciles, nor clears the
    /// marker of, another club's booking.
    /// </summary>
    [SkippableFact]
    public async Task One_clubs_sweep_never_touches_another_clubs_marked_booking()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var home = await PlayersClub.SeedAsync(f, "r6home");
        var away = await PlayersClub.SeedAsync(f, "r6away");
        var marked = await DueAsync(away, f, away.Sam, DateTimeOffset.UtcNow.AddDays(-30));
        await away.WriteAsync(f, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == marked);
            b.ShareDeadlineAt = DateTimeOffset.UtcNow.AddDays(-28);
            b.ShareReconcileDueAt = DateTimeOffset.UtcNow.AddMinutes(-5);
        });

        await SweepAsync(home, f, DateTimeOffset.UtcNow);
        Assert.NotNull((await BookingAsync(f, marked)).ShareReconcileDueAt);
        Assert.Equal(0, await PlayersClub.BalanceAsync(f, away.Sam));

        await SweepAsync(away, f, DateTimeOffset.UtcNow);
        Assert.Null((await BookingAsync(f, marked)).ShareReconcileDueAt);
        Assert.Equal(16, await PlayersClub.BalanceAsync(f, away.Sam));
    }
}
