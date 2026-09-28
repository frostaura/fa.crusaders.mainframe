using System.Net;
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
/// The third refuter round on the P11 players fixes (D11), on Postgres: a waiting return is set
/// aside from what the organiser may spend, nothing strands after a worker outage, and the desk is
/// told when its hand-back is left waiting. Each test failed on the code it follows.
/// </summary>
[Collection(HttpTestCollection.Name)]
public sealed class PlayersRefute3HttpTests
{
    private readonly PostgresFixture _pg;

    public PlayersRefute3HttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    /// <summary>
    /// A played game whose deadline passed <paramref name="daysAgo"/> − 2 days ago, on which Sam
    /// paid 16 and the organiser spent it; Sam's seat is then taken off (straight to the table).
    /// With <paramref name="reconcile"/> the return is found uncovered and starts waiting.
    /// </summary>
    private static async Task<(Guid BookingId, Guid Seat)> ReturnDueAsync(PlayersClub club, TestWebAppFactory f, int daysAgo, bool reconcile)
    {
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(-daysAgo));
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).Status = BookingStatus.Completed);
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16m);
        var seat = await club.InsertSeatAsync(f, bookingId, 2, club.Sam, ParticipantStatus.Accepted, 16m);
        await club.WriteAsync(f, db =>
        {
            db.Bookings.IgnoreQueryFilters().First(b => b.Id == bookingId).ShareDeadlineAt = DateTimeOffset.UtcNow.AddDays(2 - daysAgo);
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
        await club.CreditAsync(f, club.Organiser, 32m);
        await club.CreditAsync(f, club.Organiser, -16m);
        await club.CreditAsync(f, club.Sam, 16m);
        await club.WriteAsync(f, db => db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == seat).Status = ParticipantStatus.Removed);
        if (reconcile) await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(bookingId, default));
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Organiser));
        return (bookingId, seat);
    }

    private static Task<HttpResponseMessage> TopUpAsync(PlayersClub club, TestWebAppFactory f, decimal credits) =>
        club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/credit/{club.Organiser}/adjust",
            new { amountCredits = credits, reason = "Cash at the desk", reasonCode = "top_up_cash" });

    // ------------------------------------------------------------------ M. a waiting return is set aside

    /// <summary>
    /// A 16-credit return waits. The organiser tops up 10: not enough, so it keeps waiting — and
    /// those 10 are SET ASIDE for it, not spendable on a new 8-credit court. Six more and Sam is paid.
    /// </summary>
    [SkippableFact]
    public async Task A_waiting_return_is_set_aside_from_what_the_organiser_may_spend()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r3aside");
        await ReturnDueAsync(club, f, daysAgo: 10, reconcile: true);

        Assert.True((await TopUpAsync(club, f, 10m)).IsSuccessStatusCode);
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Sam));

        var wallet = await JsonAsync(await club.Client(f, club.Organiser).GetAsync("/api/v1/wallet"));
        Assert.Equal(10m, wallet.GetProperty("balance_credits").GetDecimal());
        Assert.Equal(16m, wallet.GetProperty("owed_back_credits").GetDecimal());
        Assert.Equal(-6m, wallet.GetProperty("spendable_credits").GetDecimal());

        var spend = await club.Client(f, club.Organiser).PostAsJsonAsync("/api/v1/bookings",
            new { courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(8).AddDays(1), sliceCount = 1 });
        Assert.Equal(HttpStatusCode.PaymentRequired, spend.StatusCode);

        Assert.True((await TopUpAsync(club, f, 6m)).IsSuccessStatusCode);
        Assert.Equal(16m, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Organiser));
    }

    /// <summary>
    /// The AUTHORITATIVE spend check — under the organiser's lock, in the booking's own commit —
    /// counts a return that started waiting after the unlocked pre-check: forced here by holding the
    /// organiser's lock while the return is stamped. The court is refused, not bought with it.
    /// </summary>
    [SkippableFact]
    public async Task The_locked_spend_check_counts_a_return_that_started_waiting_after_the_pre_check()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r3locked");
        var (_, seat) = await ReturnDueAsync(club, f, daysAgo: 10, reconcile: false);
        await club.CreditAsync(f, club.Organiser, 10m);   // straight to the table: nothing retries, nothing stamps

        HttpResponseMessage spend;
        using (var scope = f.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            await using var tx = await db.Database.BeginTransactionAsync();
            await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock({0})", PayerLock.KeyFor(club.TenantId, club.Organiser));
            await db.BookingParticipants.IgnoreQueryFilters().Where(p => p.Id == seat)
                .ExecuteUpdateAsync(u => u.SetProperty(p => p.ReturnPendingSince, DateTimeOffset.UtcNow));

            var racing = club.Client(f, club.Organiser).PostAsJsonAsync("/api/v1/bookings",
                new { courtId = club.CourtId, startsAt = PlayersClub.Tomorrow(8).AddDays(1), sliceCount = 1 });
            await Task.Delay(1500);
            await tx.CommitAsync();
            spend = await racing;
        }

        Assert.Equal(HttpStatusCode.PaymentRequired, spend.StatusCode);
        Assert.Equal(10m, await PlayersClub.BalanceAsync(f, club.Organiser));
    }

    // ------------------------------------------------------------------ LOW. nothing strands after an outage

    /// <summary>An invite whose deadline passed a fortnight ago — the worker was down — still lapses.</summary>
    [SkippableFact]
    public async Task An_invite_whose_deadline_passed_long_ago_still_lapses()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r3lapse");
        var bookingId = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddDays(-16));
        await club.WriteAsync(f, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == bookingId);
            b.Status = BookingStatus.Completed;
            b.ShareDeadlineAt = DateTimeOffset.UtcNow.AddDays(-14);
        });
        await club.InsertSeatAsync(f, bookingId, 1, club.Organiser, ParticipantStatus.Accepted, 16m);
        var seat = await club.InsertSeatAsync(f, bookingId, 2, club.Sam, ParticipantStatus.Invited, 16m, DateTimeOffset.UtcNow.AddDays(-17));

        await club.InClubAsync(f, async sp =>
        {
            await sp.GetRequiredService<ShareSweep>().SweepAsync(DateTimeOffset.UtcNow, default);
            return 0;
        });

        Assert.Equal(ParticipantStatus.Lapsed, (await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).Status);
    }

    /// <summary>
    /// A return that fell due while the worker was down — never reconciled, never stamped, and
    /// outside the sweep's week — is found on the worker's first pass after it starts, and waits.
    /// </summary>
    [SkippableFact]
    public async Task A_return_due_during_an_outage_is_found_when_the_worker_starts()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r3outage");
        var (bookingId, seat) = await ReturnDueAsync(club, f, daysAgo: 12, reconcile: false);
        Assert.Null((await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ReturnPendingSince);

        await f.Services.GetRequiredService<ShareWorker>().TickAsync(DateTimeOffset.UtcNow, default);

        Assert.NotNull((await club.SeatsAsync(f, bookingId)).Single(s => s.Id == seat).ReturnPendingSince);
    }

    // ------------------------------------------------------------------ LOW. the desk is told when its hand-back waits

    /// <summary>
    /// An admin remove passes the coverage check, then the organiser spends before the reconcile
    /// takes their lock — forced here by holding that lock and spending under it. The remove still
    /// answers 200, and says the return is waiting and for how much.
    /// </summary>
    [SkippableFact]
    public async Task An_admin_remove_says_so_when_its_return_was_left_waiting()
    {
        Skip.IfNot(_pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await PlayersClub.SeedAsync(f, "r3told");
        await club.CreditAsync(f, club.Organiser, 32m);
        await club.CreditAsync(f, club.Sam, 50m);
        var (bookingId, body) = await club.BookWithPlayersAsync(f, [new { userId = club.Sam }]);
        var seat = PlayersClub.SeatOf(body, 2);
        var accept = await club.Client(f, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat}/accept", new { expectedShareCredits = 16m });
        Assert.True(accept.IsSuccessStatusCode);
        Assert.Equal(16m, await PlayersClub.BalanceAsync(f, club.Organiser));

        HttpResponseMessage removed;
        using (var scope = f.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            await using var tx = await db.Database.BeginTransactionAsync();
            await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock({0})", PayerLock.KeyFor(club.TenantId, club.Organiser));
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = club.TenantId, UserId = club.Organiser, Type = LedgerEntryType.AdminAdjustment, AmountCredits = -16m,
                ActorUserId = club.Admin, Reason = "spent elsewhere, in the race",
            });
            await db.SaveChangesAsync();

            var racing = club.Client(f, club.Admin, admin: true)
                .PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/players/{seat}/remove", new { reason = "Changed his mind" });
            await Task.Delay(1500);
            await tx.CommitAsync();
            removed = await racing;
        }

        Assert.Equal(HttpStatusCode.OK, removed.StatusCode);
        var answer = await JsonAsync(removed);
        Assert.True(answer.GetProperty("return_waiting").GetBoolean(), answer.ToString());
        Assert.Equal(16m, answer.GetProperty("return_credits").GetDecimal());
        Assert.Equal(0m, await PlayersClub.BalanceAsync(f, club.Organiser));
    }
}
