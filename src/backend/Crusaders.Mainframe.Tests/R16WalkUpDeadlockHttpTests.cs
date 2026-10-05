using System.Data.Common;
using System.Net;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 16, lane FX16 — a walk-up that loses a database deadlock is retried, never a 500.
///
/// <para>
/// <b>Found by looping</b> <c>MemberCodeMoneyFixesHttpTests.Identical_walk_up_retries_in_flight_together…</c>
/// under CPU load (1 in 10 class runs): PostgreSQL answered 40P01 "deadlock detected … while checking
/// exclusion constraint" on <c>ck_bookings_no_overlapping_slot</c>. The winning attempt's activation
/// UPDATEs its booking (a new tuple, so the constraint is checked again) while a twin's INSERT of the
/// same slot is checking against that row: each waits for the other, and PostgreSQL aborts one. The
/// victim was either side — the activation save, or the twin's purchase — and nothing on the walk-up
/// path caught it, so a box was answered 500 for a purchase that had in fact been made (or could be).
/// A deadlock is the database's own "try again": the transaction it aborted changed nothing.
/// </para>
///
/// <para>
/// The deadlock is raised here by a command interceptor as the real <see cref="PostgresException"/>
/// (SQLSTATE 40P01), so it reaches the code wrapped exactly as the driver and EF wrap it in production.
/// </para>
/// </summary>
public sealed class R16WalkUpDeadlockHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    /// <summary>The activation's save (it stamps <c>CheckedInAt</c>) is the deadlock's victim.</summary>
    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_walk_up_whose_activation_loses_a_deadlock_is_lit_and_charged_once(int deadlocks)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var victim = new DeadlockOn(sql => sql.Contains("UPDATE bookings", StringComparison.Ordinal)
            && sql.Contains("\"CheckedInAt\"", StringComparison.Ordinal), deadlocks);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService()).WithWebHostBuilder(b => b.ConfigureServices(s =>
            s.ConfigureDbContext<MainframeDbContext>(o => o.AddInterceptors(victim))));
        var club = await MemberCodeClub.SeedAsync(app, $"wudla{deadlocks}", MemberCodeClub.SettingsAtNoon());

        var answer = await app.CreateClient().SendAsync(club.WalkUp(club.Code(club.Pam), court: 3, nonce: "d1d1d1d1d1d1d1d1"));

        Assert.Equal(deadlocks, victim.Raised);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        await AssertOnePurchaseLitAsync(app, club);
    }

    /// <summary>The purchase's INSERT is the deadlock's victim: nothing committed, so it is made again.</summary>
    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_walk_up_whose_purchase_loses_a_deadlock_is_bought_once_and_lit(int deadlocks)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var victim = new DeadlockOn(sql => sql.Contains("INSERT INTO bookings", StringComparison.Ordinal), deadlocks);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService()).WithWebHostBuilder(b => b.ConfigureServices(s =>
            s.ConfigureDbContext<MainframeDbContext>(o => o.AddInterceptors(victim))));
        var club = await MemberCodeClub.SeedAsync(app, $"wudlb{deadlocks}", MemberCodeClub.SettingsAtNoon());

        var answer = await app.CreateClient().SendAsync(club.WalkUp(club.Code(club.Pam), court: 3, nonce: "d2d2d2d2d2d2d2d2"));

        Assert.Equal(deadlocks, victim.Raised);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        await AssertOnePurchaseLitAsync(app, club);
    }

    /// <summary>
    /// The race itself, wider than <c>MemberCodeMoneyFixesHttpTests</c>' six: twelve identical
    /// retries in flight together, eight times over on ONE warm host (four clubs, two buyers each) —
    /// the failure was seen on a warm class host, never on a cold one, so a twin's INSERT and the
    /// winner's activation UPDATE meet far more often here. Every one is answered 200, for one purchase.
    /// </summary>
    [SkippableFact]
    public async Task Bursts_of_identical_walk_ups_on_a_warm_host_are_all_answered_and_one_purchase_each()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService());
        var device = app.CreateClient();

        for (var c = 0; c < 4; c++)
        {
            var club = await MemberCodeClub.SeedAsync(app, $"wudlc{c}", MemberCodeClub.SettingsAtNoon());
            foreach (var (buyer, court) in new[] { (club.Olga, 2), (club.Pam, 3) })
            {
                var code = club.Code(buyer);
                var nonce = $"d3d3d3d3d3d3d3{c}{court}";
                var answers = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => device.SendAsync(club.WalkUp(code, court, nonce))));
                Assert.All(answers, a => Assert.Equal(HttpStatusCode.OK, a.StatusCode));
                await AssertOnePurchaseLitAsync(app, club, buyer);
            }
            Assert.Equal(2, await club.UsesAsync(app, MemberCodeUseClass.Money));
        }
    }

    private static async Task AssertOnePurchaseLitAsync(Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> app, MemberCodeClub club)
    {
        await AssertOnePurchaseLitAsync(app, club, club.Pam);
        Assert.Equal(1, await club.UsesAsync(app, MemberCodeUseClass.Money));
    }

    private static async Task AssertOnePurchaseLitAsync(Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> app, MemberCodeClub club, Guid buyer)
    {
        Assert.Equal(200 - 15, await club.BalanceAsync(app, buyer));
        var bookings = await club.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters()
            .Where(b => b.TenantId == club.TenantId && b.UserId == buyer).ToListAsync());
        var booking = Assert.Single(bookings);
        Assert.Equal(BookingStatus.Booked, booking.Status);
        Assert.NotNull(booking.CheckedInAt);
        Assert.Equal(1, await club.ReadAsync(app, db => db.AuditLogs.IgnoreQueryFilters()
            .CountAsync(a => a.TenantId == club.TenantId && a.Action == "court.activated" && a.SubjectUserId == buyer)));
    }

    /// <summary>Answers the first <c>times</c> matching commands with PostgreSQL's deadlock error instead of running them.</summary>
    private sealed class DeadlockOn(Func<string, bool> matches, int times) : DbCommandInterceptor
    {
        private readonly Lock _gate = new();
        private int _raised;

        public int Raised
        {
            get
            {
                lock (_gate) return _raised;
            }
        }

        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (matches(command.CommandText))
            {
                lock (_gate)
                {
                    if (_raised < times)
                    {
                        _raised++;
                        throw new PostgresException("deadlock detected", "ERROR", "ERROR", PostgresErrorCodes.DeadlockDetected);
                    }
                }
            }
            return ValueTask.FromResult(result);
        }
    }
}
