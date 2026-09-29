using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The eighth refuter round on the P11 players fixes (D11), on Postgres: a settlement or desk
/// credit that commits while its post-commit hook never runs — the admin's connection dropped, the
/// process restarted — must not strand the partners' returns on a game older than the sweep's
/// window. Both failed on the code they follow.
/// </summary>
public sealed class PlayersRefute8HttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

    /// <summary>
    /// A 32-credit game played 20 days ago (deadline long passed, far outside the sweep's window):
    /// Sam paid a 16 share, the organiser is at 0, and a goodwill credit of 16 naming the game is
    /// committed as the desk's own transaction commits it — the organiser now owes 16, so Sam is
    /// owed 8 back.
    /// </summary>
    private static async Task<Guid> PlayedAndCreditedAsync(PlayersClub club, TestWebAppFactory f)
    {
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(-20));
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).Status = BookingStatus.Completed);
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16m);
        var seat = await club.InsertSeatAsync(f, bookingId, 2, club.Sam, ParticipantStatus.Accepted, 16m);
        await club.CreditAsync(f, club.Sam, 16m);
        await club.CreditAsync(f, club.Organiser, 16m);
        await club.WriteAsync(f, db =>
        {
            db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).ShareDeadlineAt = DateTimeOffset.UtcNow.AddDays(-18);
            db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).ConsentedCredits = 16m;
            foreach (var posting in ShareLedger.Pair(new Booking { Id = bookingId }, new ShareMove(seat, club.Sam, club.Organiser, 16m, 1), club.Sam))
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
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Organiser));

        // The desk's goodwill credit, committed through the app's own context — and then nothing:
        // the request that would have run the hook is gone.
        await club.InClubAsync(f, async sp =>
        {
            var db = sp.GetRequiredService<MainframeDbContext>();
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = club.TenantId,
                UserId = club.Organiser,
                Type = LedgerEntryType.AdminAdjustment,
                AmountCredits = 16m,
                ActorUserId = club.Admin,
                RelatedBookingId = bookingId,
                Reason = "goodwill",
            });
            return await db.SaveChangesAsync();
        });
        return bookingId;
    }

    private static Task SweepAsync(PlayersClub club, TestWebAppFactory f) => club.InClubAsync(f, async sp =>
    {
        await sp.GetRequiredService<ShareSweep>().SweepAsync(DateTimeOffset.UtcNow, default);
        return 0;
    });

    /// <summary>The hook never runs: the marker the credit's own transaction staged brings the next sweep to it.</summary>
    [SkippableFact]
    public async Task A_credit_committed_without_its_hook_is_paid_back_by_the_next_sweep()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r8nohook");
        var bookingId = await PlayedAndCreditedAsync(club, f);
        Assert.NotNull(await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().Where(b => b.Id == bookingId).Select(b => b.ShareReconcileDueAt).FirstAsync()));

        await SweepAsync(club, f);

        Assert.Equal(8m, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(8m, await PlayersClub.BalanceAsync(f, club.Organiser));
        Assert.Null(await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().Where(b => b.Id == bookingId).Select(b => b.ShareReconcileDueAt).FirstAsync()));
    }

    /// <summary>
    /// The hook runs with the request's token already cancelled (the admin's connection dropped):
    /// the money follow-up does not honour it — Sam is paid at once, and the marker is cleared.
    /// </summary>
    [SkippableFact]
    public async Task A_hook_handed_a_cancelled_token_still_pays_the_return()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r8cancel");
        var bookingId = await PlayedAndCreditedAsync(club, f);

        await club.InClubAsync(f, async sp =>
        {
            var tenant = sp.GetRequiredService<ITenantContext>();
            await sp.GetRequiredService<ShareHook>().AfterSettlementAsync(tenant.TenantId, tenant.TenantSlug, [bookingId], new CancellationToken(true));
            return 0;
        });

        Assert.Equal(8m, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Null(await PlayersClub.ReadAsync(f, db => db.Bookings.IgnoreQueryFilters().Where(b => b.Id == bookingId).Select(b => b.ShareReconcileDueAt).FirstAsync()));

        await SweepAsync(club, f);
        Assert.Equal(8m, await PlayersClub.BalanceAsync(f, club.Sam));
    }
}
