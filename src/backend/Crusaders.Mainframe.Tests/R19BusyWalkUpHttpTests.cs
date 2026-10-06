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
/// R19 BE19L — a walk-up answered <c>503 service_busy</c> part-way through is bought once when the box asks again.
///
/// <para>
/// <b>Found under load</b> (the sharded run filled the test server's slots): a walk-up that could
/// not get a database connection was answered <c>503 service_busy</c> + <c>Retry-After</c>, the
/// box's retry of the SAME nonce 2 s later was answered <c>409 code_used</c>. "No connection" is
/// not "nothing ran": a request gets a connection per command, so the one it was refused can be
/// its fifth, after the code's use was claimed or the purchase committed.
/// </para>
///
/// <para>
/// The refusal is raised by a connection interceptor as PostgreSQL's own <c>53300 too many
/// clients</c> on the N-th connection the walk-up opens, for every N the walk-up reaches; then the
/// box asks again with the same nonce. Every retry must be answered 200, for one purchase, lit.
/// </para>
/// </summary>
public sealed class R19BusyWalkUpHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    [SkippableFact]
    public async Task A_walk_up_refused_a_connection_at_any_point_is_bought_once_when_the_box_asks_again()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var refuse = new RefuseNthOpen();
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = MemberCodeClub.Wired(factory, new StubEmailService()).WithWebHostBuilder(b => b.ConfigureServices(s =>
            s.ConfigureDbContext<MainframeDbContext>(o => o.AddInterceptors(refuse))));
        var device = app.CreateClient();
        var wrong = new List<string>();
        var swept = 0;

        for (var n = 1; ; n++)
        {
            var club = await MemberCodeClub.SeedAsync(app, $"wubusy{n}", MemberCodeClub.SettingsAtNoon());
            var code = club.Code(club.Pam);
            var nonce = $"b0b0b0b0b0b0{n:D4}";

            refuse.Arm(n);
            using var first = await device.SendAsync(club.WalkUp(code, court: 3, nonce));
            var reached = refuse.Disarm();
            if (!reached)
            {
                Assert.Equal(HttpStatusCode.OK, first.StatusCode);
                break;
            }
            swept = n;

            var firstSaid = $"{(int)first.StatusCode} {await first.Content.ReadAsStringAsync()}";
            using var again = await device.SendAsync(club.WalkUp(code, court: 3, nonce));
            var againSaid = $"{(int)again.StatusCode} {await again.Content.ReadAsStringAsync()}";
            var outcome = await OutcomeAsync(app, club);
            if (again.StatusCode != HttpStatusCode.OK || outcome != "185 min, 1 booking lit, 1 money use")
            {
                wrong.Add($"open #{n} refused: first {firstSaid}; retry {againSaid}; after: {outcome}");
            }
        }

        // A sweep that refused nothing proves nothing: the walk-up opens a connection per step.
        Assert.True(swept >= 3, $"only {swept} connection opens were refused");
        Assert.True(wrong.Count == 0, $"{wrong.Count} of {swept}:{Environment.NewLine}{string.Join(Environment.NewLine, wrong)}");
    }

    /// <summary>
    /// Two identical walk-ups in flight (a box retrying), and the first is refused a connection
    /// after claiming the code's money use: it gives the claim back. The twin's claim met that row
    /// (ON CONFLICT DO NOTHING) and then went to read it — after it was gone — and was answered
    /// <c>409 code_used</c> for a purchase nobody had made. A use that vanished between the two is
    /// free: the twin claims it again.
    /// </summary>
    [SkippableFact]
    public async Task A_twin_whose_claim_met_a_use_given_back_meanwhile_claims_it_and_buys()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var race = new ClaimRace(ClaimRace.Plan.GivenBackBeforeTheTwinReadsIt);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = race.Wire(MemberCodeClub.Wired(factory, new StubEmailService()));
        var club = await MemberCodeClub.SeedAsync(app, "wutwinv", MemberCodeClub.SettingsAtNoon());
        var device = app.CreateClient();
        var code = club.Code(club.Pam);

        race.Arm();
        var first = device.SendAsync(club.WalkUp(code, court: 3, nonce: "c1c1c1c1c1c1c1c1"));
        await race.FirstHasClaimedAsync();
        using var twin = await device.SendAsync(club.WalkUp(code, court: 3, nonce: "c1c1c1c1c1c1c1c1"));
        using var refused = await first;

        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.StatusCode);
        Assert.Equal(HttpStatusCode.OK, twin.StatusCode);
        Assert.Equal("185 min, 1 booking lit, 1 money use", await OutcomeAsync(app, club));
    }

    /// <summary>
    /// The other order: the twin re-entered the first request's claim (same box, same nonce), then
    /// the first was refused a connection and gave the claim back — and the twin bought on a use
    /// that no longer existed. The purchase stood with NO money use behind it, so the same code
    /// bought a second walk-up under another nonce. A twin that buys on a re-entered claim holds
    /// the use again once its purchase has committed.
    /// </summary>
    [SkippableFact]
    public async Task A_twin_that_bought_on_a_use_given_back_under_it_still_holds_the_use()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var race = new ClaimRace(ClaimRace.Plan.GivenBackAfterTheTwinReEnteredIt);
        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        await using var app = race.Wire(MemberCodeClub.Wired(factory, new StubEmailService()));
        var club = await MemberCodeClub.SeedAsync(app, "wutwinr", MemberCodeClub.SettingsAtNoon());
        var device = app.CreateClient();
        var code = club.Code(club.Pam);

        race.Arm();
        var first = device.SendAsync(club.WalkUp(code, court: 3, nonce: "c2c2c2c2c2c2c2c2"));
        await race.FirstHasClaimedAsync();
        using var twin = await device.SendAsync(club.WalkUp(code, court: 3, nonce: "c2c2c2c2c2c2c2c2"));
        using var refused = await first;

        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.StatusCode);
        Assert.Equal(HttpStatusCode.OK, twin.StatusCode);
        Assert.Equal("185 min, 1 booking lit, 1 money use", await OutcomeAsync(app, club));

        // …and the use is spent: the same code buys nothing more at this box.
        using var again = await device.SendAsync(club.WalkUp(code, court: 2, nonce: "c3c3c3c3c3c3c3c3"));
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
        Assert.Contains(MemberCodeIdentity.CodeUsed, await again.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Equal(200 - 15, await club.BalanceAsync(app, club.Pam));
    }

    private static async Task<string> OutcomeAsync(Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> app, MemberCodeClub club)
    {
        var balance = await club.BalanceAsync(app, club.Pam);
        var bookings = await club.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters()
            .Where(b => b.TenantId == club.TenantId && b.UserId == club.Pam && b.Status == BookingStatus.Booked).ToListAsync());
        var lit = bookings.Count(b => b.CheckedInAt != null);
        var uses = await club.UsesAsync(app, MemberCodeUseClass.Money);
        return $"{balance} min, {bookings.Count} booking{(bookings.Count == 1 ? "" : "s")}{(lit == bookings.Count && lit > 0 ? " lit" : $" ({lit} lit)")}, {uses} money use{(uses == 1 ? "" : "s")}";
    }

    /// <summary>Refuses the N-th connection opened while armed with PostgreSQL's "too many clients" (53300).</summary>
    private sealed class RefuseNthOpen : DbConnectionInterceptor
    {
        private readonly Lock _gate = new();
        private int _nth;
        private int _opened;
        private bool _armed;
        private bool _refused;

        public void Arm(int nth)
        {
            lock (_gate)
            {
                (_nth, _opened, _armed, _refused) = (nth, 0, true, false);
            }
        }

        /// <summary>Disarms; whether the armed request reached its N-th open (and was refused it).</summary>
        public bool Disarm()
        {
            lock (_gate)
            {
                _armed = false;
                return _refused;
            }
        }

        public override ValueTask<InterceptionResult> ConnectionOpeningAsync(
            DbConnection connection, ConnectionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
        {
            Refuse();
            return ValueTask.FromResult(result);
        }

        public override InterceptionResult ConnectionOpening(DbConnection connection, ConnectionEventData eventData, InterceptionResult result)
        {
            Refuse();
            return result;
        }

        private void Refuse()
        {
            lock (_gate)
            {
                if (!_armed || _refused || ++_opened != _nth) return;
                _refused = true;
            }
            throw new PostgresException("sorry, too many clients already", "FATAL", "FATAL", "53300");
        }
    }

    /// <summary>
    /// Drives the race between a first walk-up and its identical twin through the money-use claim,
    /// step by step: the first claims, is held until the twin reaches the planned point, is then
    /// refused its next connection (53300) and gives its claim back, and only then is the twin let go.
    /// Every wait is bounded, so a race that does not happen fails the test instead of hanging it.
    /// </summary>
    private sealed class ClaimRace(ClaimRace.Plan plan)
    {
        public enum Plan
        {
            /// <summary>The twin's insert met the first's use; the use is given back before the twin reads it.</summary>
            GivenBackBeforeTheTwinReadsIt,

            /// <summary>The twin read the first's use and re-entered it; the use is given back before the twin buys.</summary>
            GivenBackAfterTheTwinReEnteredIt,
        }

        private static readonly TimeSpan Bound = TimeSpan.FromSeconds(15);
        private readonly TaskCompletionSource _firstClaimed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _twinAtPoint = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _givenBack = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly Lock _gate = new();
        private bool _armed;
        private bool _firstHeld;
        private bool _refuseNextOpen;
        private bool _twinConflicted;
        private bool _twinHeld;

        public void Arm()
        {
            lock (_gate) _armed = true;
        }

        public Task FirstHasClaimedAsync() => _firstClaimed.Task.WaitAsync(Bound);

        public Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> Wire(Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> app)
        {
            return app.WithWebHostBuilder(b => b.ConfigureServices(s =>
                s.ConfigureDbContext<MainframeDbContext>(o => o.AddInterceptors(new Commands(this), new Opens(this)))));
        }

        private static bool IsClaim(DbCommand c) => c.CommandText.Contains("INSERT INTO member_code_uses", StringComparison.Ordinal);

        private static bool IsGiveBack(DbCommand c) => c.CommandText.Contains("DELETE FROM member_code_uses", StringComparison.Ordinal);

        private static bool IsUseRead(DbCommand c) =>
            c.CommandText.Contains("FROM member_code_uses", StringComparison.Ordinal) && c.CommandText.TrimStart().StartsWith("SELECT", StringComparison.Ordinal);

        /// <summary>After a claim: the first's (1 row) is held; the twin's (0 rows) may be the planned point.</summary>
        private async Task ClaimedAsync(int rows)
        {
            bool holdFirst, holdTwin;
            lock (_gate)
            {
                holdFirst = _armed && rows == 1 && !_firstHeld;
                if (holdFirst) _firstHeld = true;
                holdTwin = _armed && rows == 0 && !_twinConflicted && plan == Plan.GivenBackBeforeTheTwinReadsIt;
                if (rows == 0) _twinConflicted = true;
            }
            if (holdFirst)
            {
                _firstClaimed.TrySetResult();
                await _twinAtPoint.Task.WaitAsync(Bound);
                lock (_gate) _refuseNextOpen = true;
            }
            if (holdTwin) await ReleaseFirstAndWaitAsync();
        }

        /// <summary>After the twin read the use it conflicted with: the planned point for a re-entry.</summary>
        private async Task UseReadAsync()
        {
            bool holdTwin;
            lock (_gate)
            {
                holdTwin = _armed && _twinConflicted && !_twinHeld && plan == Plan.GivenBackAfterTheTwinReEnteredIt;
                if (holdTwin) _twinHeld = true;
            }
            if (holdTwin) await ReleaseFirstAndWaitAsync();
        }

        private async Task ReleaseFirstAndWaitAsync()
        {
            _twinAtPoint.TrySetResult();
            await _givenBack.Task.WaitAsync(Bound);
        }

        private void Opening()
        {
            lock (_gate)
            {
                if (!_refuseNextOpen) return;
                _refuseNextOpen = false;
            }
            throw new PostgresException("sorry, too many clients already", "FATAL", "FATAL", "53300");
        }

        private sealed class Commands(ClaimRace race) : DbCommandInterceptor
        {
            public override async ValueTask<int> NonQueryExecutedAsync(
                DbCommand command, CommandExecutedEventData eventData, int result, CancellationToken cancellationToken = default)
            {
                if (IsClaim(command)) await race.ClaimedAsync(result);
                if (IsGiveBack(command)) race._givenBack.TrySetResult();
                return result;
            }

            public override async ValueTask<DbDataReader> ReaderExecutedAsync(
                DbCommand command, CommandExecutedEventData eventData, DbDataReader result, CancellationToken cancellationToken = default)
            {
                if (IsUseRead(command)) await race.UseReadAsync();
                return result;
            }
        }

        private sealed class Opens(ClaimRace race) : DbConnectionInterceptor
        {
            public override ValueTask<InterceptionResult> ConnectionOpeningAsync(
                DbConnection connection, ConnectionEventData eventData, InterceptionResult result, CancellationToken cancellationToken = default)
            {
                race.Opening();
                return ValueTask.FromResult(result);
            }
        }
    }
}
