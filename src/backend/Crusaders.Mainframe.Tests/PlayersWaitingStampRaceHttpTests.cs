using System.Data.Common;
using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A waiting return's stamp (<c>ReturnPendingSince</c>) is never wiped by a reconcile that read it
/// before somebody else moved the money (2026-09-30, the players property test's CI flake).
///
/// <para>
/// <b>The race.</b> <see cref="ShareLedger.ReconcileAsync"/> estimates each seat WITHOUT a lock and
/// used to clear a stamp there whenever that estimate said nothing was owed back. The estimate is
/// several reads, so it can see the seat still stamped (read before a return posted) and the ledger
/// already paid (read after) — and by the time its clear runs, a NEW return may have started waiting
/// on the same seat, stamped under the organiser's lock. The unconditional clear wiped that fresh
/// stamp: the return was due, unpaid and no longer waiting — on a game past its deadline out of
/// <c>owed_back</c>, so the organiser could spend the partner's money; and on a game past the
/// sweep's week (which it reaches only through the stamp) never retried.
/// </para>
///
/// <para>
/// The interleaving is forced, not slept for: a command interceptor holds the racing reconcile (and
/// only it — an <see cref="AsyncLocal{T}"/> marks its flow) before its ledger read and again before
/// its clear, while the test commits the other two moves through the real endpoints.
/// </para>
/// </summary>
public sealed class PlayersWaitingStampRaceHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    /// <summary>Holds the marked flow at two commands: its first share-row read, and a stamp clear.</summary>
    private sealed class Gate : DbCommandInterceptor
    {
        public static readonly AsyncLocal<bool> Racing = new();

        public TaskCompletionSource AtLedgerRead { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource ReleaseLedgerRead { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource AtClear { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource ReleaseClear { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        private static readonly TimeSpan Patience = TimeSpan.FromSeconds(60);

        public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (Racing.Value && command.CommandText.Contains("\"ExternalReference\"", StringComparison.Ordinal) && AtLedgerRead.TrySetResult())
            {
                await ReleaseLedgerRead.Task.WaitAsync(Patience, cancellationToken);
            }
            return result;
        }

        public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (Racing.Value && command.CommandText.Contains("UPDATE booking_participants", StringComparison.Ordinal)
                && command.CommandText.Contains("\"ReturnPendingSince\"", StringComparison.Ordinal) && AtClear.TrySetResult())
            {
                await ReleaseClear.Task.WaitAsync(Patience, cancellationToken);
            }
            return result;
        }
    }

    /// <summary>
    /// Sam paid 16 on a game checked into and cancelled (S4); the organiser is 24 in the red. A
    /// goodwill 8 naming the game makes 4 due back to Sam, uncovered: it waits (stamp one). A
    /// reconcile R reads the seat — stamped — and is held. A top-up of 20 pays the 4 and clears the
    /// stamp. R reads the ledger — nothing owed back — and is held again before it clears. A debit and
    /// a second goodwill make ANOTHER 4 due, uncovered: it waits (stamp two). R goes on. Stamp two
    /// must still be there: the 4 is due, unpaid and waiting.
    /// </summary>
    [SkippableFact]
    public async Task A_reconcile_that_read_an_old_stamp_does_not_wipe_a_new_one()
    {
        Skip.IfNot(pg.Available, Skipped);
        var gate = new Gate();
        await using var host = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var f = host.WithWebHostBuilder(b => b.ConfigureServices(s =>
            s.ConfigureDbContext<MainframeDbContext>(o => o.AddInterceptors(gate))));
        var club = await PlayersClub.SeedAsync(f, "stamprace");
        var (x, sam) = await SpentS4Async(club, f, 16);
        await club.CreditAsync(f, club.Organiser, -24);

        await DeskAsync(club, f, 8, x, "goodwill");
        var first = await StampOfAsync(club, f, x, sam);
        Assert.NotNull(first);

        // R: the sweep's (or any caller's) reconcile, held with the seat read stamped.
        var racing = Task.Run(async () =>
        {
            Gate.Racing.Value = true;
            await club.InClubAsync(f, sp => sp.GetRequiredService<ShareLedger>().ReconcileAsync(x, default));
        });
        await Task.WhenAny(gate.AtLedgerRead.Task, racing).WaitAsync(TimeSpan.FromSeconds(60));
        Assert.True(gate.AtLedgerRead.Task.IsCompleted, "the racing reconcile never read the ledger");

        // The top-up's credit hook pays the waiting 4 and clears stamp one.
        await DeskAsync(club, f, 20, null, "goodwill");
        Assert.Null(await StampOfAsync(club, f, x, sam));
        Assert.Equal(38, await PlayersClub.BalanceAsync(f, club.Sam));

        // R reads the ledger now: nothing owed back. Held again if it goes to clear anything.
        gate.ReleaseLedgerRead.SetResult();
        await Task.WhenAny(gate.AtClear.Task, racing).WaitAsync(TimeSpan.FromSeconds(60));

        // Another 4 falls due, uncovered: it waits, stamp two.
        await club.CreditAsync(f, club.Organiser, -20);
        await DeskAsync(club, f, 8, x, "goodwill");
        var second = await StampOfAsync(club, f, x, sam);
        Assert.NotNull(second);

        gate.ReleaseClear.TrySetResult();
        await racing.WaitAsync(TimeSpan.FromSeconds(60));

        // Due, unpaid — and still waiting, on its own stamp, set aside from the organiser's spendable.
        // (Before the fix: the stamp was null, and the old-game sweep never came back for it.)
        Assert.Equal(38, await PlayersClub.BalanceAsync(f, club.Sam));
        Assert.Equal(second, await StampOfAsync(club, f, x, sam));
        var wallet = await club.Client(f, club.Organiser).GetFromJsonAsync<System.Text.Json.JsonElement>("/api/v1/wallet");
        // An S4 game's hold IS its pending returns, so the 4 is set aside as held, not again as owed back.
        Assert.Equal(4, wallet.GetProperty("held_minutes").GetInt32() + wallet.GetProperty("owed_back_minutes").GetInt32());
    }

    private static async Task DeskAsync(PlayersClub club, WebApplicationFactory<Program> f, decimal amount, Guid? booking, string code)
    {
        var response = await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/minutes/{club.Organiser}/adjust",
            new { amountMinutes = (int)amount, reason = "stamp race", reasonCode = code, relatedBookingId = booking });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    private static async Task<DateTimeOffset?> StampOfAsync(PlayersClub club, WebApplicationFactory<Program> f, Guid booking, Guid seat) =>
        (await club.SeatsAsync(f, booking)).Single(s => s.Id == seat).ReturnPendingSince;

    /// <summary>A game Sam paid <paramref name="share"/> on, checked into and cancelled (S4), its share spent. Organiser: 0.</summary>
    private static async Task<(Guid BookingId, Guid Seat)> SpentS4Async(PlayersClub club, WebApplicationFactory<Program> f, int share)
    {
        await club.CreditAsync(f, club.Sam, 50);
        await club.CreditAsync(f, club.Organiser, 32);
        var x = await club.InsertBookingAsync(f, DateTimeOffset.UtcNow.AddMinutes(40));
        var add = await club.Client(f, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{x}/players",
            new { players = new object[] { new { userId = club.Sam, amount = share } }, splitMode = "amount" });
        Assert.True(add.IsSuccessStatusCode, await add.Content.ReadAsStringAsync());
        var seat = (await add.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>()).GetProperty("participants")[0].GetProperty("participant_id").GetGuid();
        var accept = await club.Client(f, club.Sam).PostAsJsonAsync($"/api/v1/bookings/{x}/players/{seat}/accept", new { expectedShareMinutes = share });
        Assert.True(accept.IsSuccessStatusCode, await accept.Content.ReadAsStringAsync());
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == x).CheckedInAt = DateTimeOffset.UtcNow);
        // R15 D15-5: a member may not cancel once checked in — the S4 cancel is the desk's now (same money: (0, 0), shares owed).
        Assert.True((await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/bookings/{x}/cancel", new { reason = "Court flooded" })).IsSuccessStatusCode);
        await club.CreditAsync(f, club.Organiser, -share);
        Assert.Equal(0, await PlayersClub.BalanceAsync(f, club.Organiser));
        return (x, seat);
    }
}
