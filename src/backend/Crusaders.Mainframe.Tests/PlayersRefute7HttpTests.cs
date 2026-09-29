using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The seventh refuter round on the P11 players fixes (D11), on Postgres: the credit hook survives
/// one poisoned booking, a "reconcile due" marker on a booking with no partner seats is cleared, and
/// a smaller later return on another game waits behind an older one (first come first served).
/// The first two failed on the code they follow; the third pins the FCFS rule against its mutant.
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class PlayersRefute7HttpTests
{
    private readonly PostgresFixture _pg;

    public PlayersRefute7HttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>A played game past its deadline whose 16 return to <paramref name="partner"/> waits on an organiser at 0.</summary>
    private static async Task<Guid> WaitingAsync(PlayersClub club, TestWebAppFactory f, Guid partner, int daysAgo)
    {
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(-daysAgo));
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).Status = BookingStatus.Completed);
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16m);
        var seat = await club.InsertSeatAsync(f, bookingId, 2, partner, ParticipantStatus.Removed, 16m);
        await club.WriteAsync(f, db =>
        {
            db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).ShareDeadlineAt = DateTimeOffset.UtcNow.AddDays(2 - daysAgo);
            db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).ConsentedCredits = 16m;
            foreach (var posting in ShareLedger.Pair(new Booking { Id = bookingId }, new ShareMove(seat, partner, club.Organiser, 16m, 1), partner))
            {
                db.LedgerEntries.Add(new LedgerEntry
                {
                    TenantId = club.TenantId,
                    UserId = posting.UserId,
                    Type = posting.Type,
                    AmountCredits = posting.AmountCredits,
                    ActorUserId = posting.ActorUserId,
                    RelatedBookingId = bookingId,
                    ExternalReference = posting.ExternalReference,
                });
            }
        });
        await club.CreditAsync(f, club.Organiser, 16m);   // the court paid, the share spent: 0
        await club.CreditAsync(f, partner, 16m);
        await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(bookingId, default));
        return bookingId;
    }

    /// <summary>
    /// Two returns wait, Sam's first — and Sam's game is poisoned. A top-up retries both: Sam's
    /// fails and is marked due, and Jo's, behind it, is still paid.
    /// </summary>
    [SkippableFact]
    public async Task The_credit_hook_goes_on_past_a_poisoned_booking_and_marks_it()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r7credit");
        var sams = await WaitingAsync(club, f, club.Sam, daysAgo: 10);
        await Task.Delay(20);
        await WaitingAsync(club, f, club.Jo, daysAgo: 11);
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Organiser));

        await using (await ShareSabotage.InstallAsync(f, sams))
        {
            var topUp = await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/credit/{club.Organiser}/adjust",
                new { amountCredits = 32m, reason = "Cash at the desk", reasonCode = "top_up_cash" });
            Assert.True(topUp.IsSuccessStatusCode, await topUp.Content.ReadAsStringAsync());
        }

        Assert.Equal(16m, await PlayersClub.BalanceAsync(f, club.Jo));
        Assert.NotNull(await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().Where(b => b.Id == sams).Select(b => b.ShareReconcileDueAt).FirstAsync()));
    }

    /// <summary>
    /// A marked booking with no partner seats — its players all came off before the failure, or it
    /// never had any — is still visited by the sweep, and its marker cleared.
    /// </summary>
    [SkippableFact]
    public async Task A_marker_on_a_booking_without_partner_seats_is_cleared_by_the_sweep()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r7noseats");
        var bare = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(-30));
        await club.InsertSeatAsync(f, bare, 1, club.Organiser, ParticipantStatus.Accepted, 32m);
        await club.WriteAsync(f, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == bare);
            b.Status = BookingStatus.Completed;
            b.ShareReconcileDueAt = DateTimeOffset.UtcNow.AddMinutes(-10);
            b.ShareReconcileAttempts = 1;
            b.ShareReconcileLastAttemptAt = DateTimeOffset.UtcNow.AddMinutes(-10);
        });

        await club.InClubAsync(f, async sp =>
        {
            await sp.GetRequiredService<ShareSweep>().SweepAsync(DateTimeOffset.UtcNow, default);
            return 0;
        });

        var row = await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().AsNoTracking().FirstAsync(b => b.Id == bare));
        Assert.Null(row.ShareReconcileDueAt);
        Assert.Equal(0, row.ShareReconcileAttempts);
    }

    /// <summary>
    /// Two games past their deadline (nothing held): Sam withdraws 16, then Jo 4, from an organiser
    /// with no free money — both wait, Sam's first. A top-up of 4 would cover Jo's alone, but Sam's
    /// older return is still waiting on other money: first come, first served, so Jo keeps waiting.
    /// </summary>
    [SkippableFact]
    public async Task A_smaller_later_return_on_another_game_waits_behind_an_older_one()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r7fcfs");
        await club.CreditAsync(f, club.Sam, 50m);
        await club.CreditAsync(f, club.Jo, 50m);
        await club.CreditAsync(f, club.Organiser, 64m);
        var organiser = club.Client(f, club.Organiser);
        async Task<Guid> GameAsync(Guid who, decimal share, int day)
        {
            var id = await club.InsertBookingAsync(f, PlayersClub.Tomorrow(8).AddDays(day));
            var add = await organiser.PostAsJsonAsync($"/api/v1/bookings/{id}/players",
                new { players = new object[] { new { userId = who, amount = share } }, splitMode = "amount" });
            Assert.True(add.IsSuccessStatusCode, await add.Content.ReadAsStringAsync());
            var seat = (await add.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>()).GetProperty("participants")[0].GetProperty("participant_id").GetGuid();
            Assert.True((await club.Client(f, who).PostAsJsonAsync($"/api/v1/bookings/{id}/players/{seat}/accept", new { expectedShareCredits = share })).IsSuccessStatusCode);
            await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == id).ShareDeadlineAt = DateTimeOffset.UtcNow.AddMinutes(-1));
            return seat;
        }
        var sam = await GameAsync(club.Sam, 16m, 1);
        var jo = await GameAsync(club.Jo, 4m, 2);
        await club.CreditAsync(f, club.Organiser, -20m);    // the 20 received (held no longer), spent
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Organiser));
        var samBooking = (await PlayersClub.ReadAsync(f, db => db.BookingParticipants.IgnoreQueryFilters().FirstAsync(p => p.Id == sam))).BookingId;
        var joBooking = (await PlayersClub.ReadAsync(f, db => db.BookingParticipants.IgnoreQueryFilters().FirstAsync(p => p.Id == jo))).BookingId;

        Assert.True((await club.Client(f, club.Sam).PostAsync($"/api/v1/bookings/{samBooking}/players/{sam}/withdraw", null)).IsSuccessStatusCode);
        await Task.Delay(20);
        Assert.True((await club.Client(f, club.Jo).PostAsync($"/api/v1/bookings/{joBooking}/players/{jo}/withdraw", null)).IsSuccessStatusCode);
        Assert.Equal(34m, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(46m, await PlayersClub.BalanceAsync(f, club.Jo));

        var topUp = await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/credit/{club.Organiser}/adjust",
            new { amountCredits = 4m, reason = "Cash at the desk", reasonCode = "top_up_cash" });
        Assert.True(topUp.IsSuccessStatusCode, await topUp.Content.ReadAsStringAsync());

        Assert.Equal(46m, await PlayersClub.BalanceAsync(f, club.Jo));
        Assert.Equal(34m, await PlayersClub.BalanceAsync(f, club.Sam));
    }
}
