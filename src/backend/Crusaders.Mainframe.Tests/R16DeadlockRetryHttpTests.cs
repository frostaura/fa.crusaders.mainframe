using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 16, lane BE16c — a booking write that loses a PostgreSQL deadlock (40P01) or a
/// serialization failure (40001) is run again, and charges exactly once; one that outlives its
/// retries answers <c>503 {"error":"conflict_retry"}</c> with <c>Retry-After</c>, never a 500.
///
/// <para>
/// FX16 found the shape on the walk-up (<see cref="R16WalkUpDeadlockHttpTests"/>): an INSERT of a
/// booking that <c>ck_bookings_no_overlapping_slot</c> checks against a row another transaction is
/// UPDATING at that moment, each waiting on the other. Every other path that inserts or updates a
/// booking under that constraint had the same 500: the app booking, the desk booking, both bulks, the
/// block, the pay-for, the check-in at <c>/activate</c>, the cancel and the reversal at <c>/events</c>.
/// </para>
///
/// <para>
/// The abort is raised by a command interceptor as the real <see cref="PostgresException"/>, before the
/// command runs, on the first <c>times</c> matching commands — so the test reaches each retry with the
/// exception wrapped exactly as EF wraps the driver's, and the unit around it rolled back.
/// </para>
/// </summary>
public sealed class R16DeadlockRetryHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string InsertBooking = "INSERT INTO bookings";

    private static bool UpdatesBooking(string sql, string column) =>
        sql.Contains("UPDATE bookings", StringComparison.Ordinal) && sql.Contains($"\"{column}\"", StringComparison.Ordinal);

    private sealed record Rig(MemberCodeClub Club, WebApplicationFactory<Program> App, AbortOn Victim) : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => App.DisposeAsync();
    }

    private async Task<Rig> RigAsync(string prefix, Func<string, bool> matches, int times, string sqlState = PostgresErrorCodes.DeadlockDetected)
    {
        var victim = new AbortOn(matches, 0, sqlState);
        var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService()).WithWebHostBuilder(b => b.ConfigureServices(s =>
            s.ConfigureDbContext<MainframeDbContext>(o => o.AddInterceptors(victim))));
        var club = await MemberCodeClub.SeedAsync(app, prefix, MemberCodeClub.SettingsAtNoon());
        victim.Arm(times);   // armed only once the fixture's own writes are in
        return new Rig(club, app, victim);
    }

    /// <summary>A slot hours from now, on the slice grid, inside the club's day (its local noon is now).</summary>
    private static DateTimeOffset Later(int hours)
    {
        var at = DateTimeOffset.UtcNow.AddHours(hours);
        return new DateTimeOffset(at.Year, at.Month, at.Day, at.Hour, 0, 0, TimeSpan.Zero);
    }

    private static Task<List<Booking>> BookingsOfAsync(Rig r, Guid? user) =>
        r.Club.ReadAsync(r.App, db => db.Bookings.IgnoreQueryFilters().AsNoTracking()
            .Where(b => b.TenantId == r.Club.TenantId && b.UserId == user).ToListAsync());

    private static Task<List<LedgerEntry>> RowsOfAsync(Rig r, Guid bookingId) =>
        r.Club.ReadAsync(r.App, db => db.LedgerEntries.IgnoreQueryFilters().AsNoTracking()
            .Where(l => l.TenantId == r.Club.TenantId && l.RelatedBookingId == bookingId).ToListAsync());

    private static Task<int> AuditsAsync(Rig r, string action) =>
        r.Club.ReadAsync(r.App, db => db.AuditLogs.IgnoreQueryFilters()
            .CountAsync(a => a.TenantId == r.Club.TenantId && a.Action == action));

    // ---- The member's own booking, the desk's, both bulks, the block --------------------------------

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_member_booking_that_loses_a_deadlock_is_booked_and_charged_once(int deadlocks)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"dlmb{deadlocks}", sql => sql.Contains(InsertBooking, StringComparison.Ordinal), deadlocks);

        var answer = await r.Club.Member(r.App, r.Club.Olga).PostAsJsonAsync("/api/v1/bookings/",
            new { courtId = r.Club.Courts[0], startsAt = Later(3), sliceCount = 4 });

        Assert.Equal(deadlocks, r.Victim.Raised);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        var booking = Assert.Single(await BookingsOfAsync(r, r.Club.Olga));
        Assert.Equal(-60, Assert.Single(await RowsOfAsync(r, booking.Id)).AmountMinutes);
        Assert.Equal(140, await r.Club.BalanceAsync(r.App, r.Club.Olga));
        Assert.Equal(140, (await MemberCodeClub.JsonAsync(answer)).GetProperty("balance_after_minutes").GetInt32());
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_desk_booking_on_behalf_that_loses_a_deadlock_is_booked_and_charged_once(int deadlocks)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"dlab{deadlocks}", sql => sql.Contains(InsertBooking, StringComparison.Ordinal), deadlocks);

        var answer = await r.Club.Member(r.App, r.Club.AdminId, "admin").PostAsJsonAsync("/api/v1/admin/bookings/",
            new { courtId = r.Club.Courts[1], userId = r.Club.Pam, startsAt = Later(4), sliceCount = 2 });

        Assert.Equal(deadlocks, r.Victim.Raised);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        var booking = Assert.Single(await BookingsOfAsync(r, r.Club.Pam));
        Assert.Equal(r.Club.AdminId, booking.ActorUserId);
        Assert.Equal(-30, Assert.Single(await RowsOfAsync(r, booking.Id)).AmountMinutes);
        Assert.Equal(170, await r.Club.BalanceAsync(r.App, r.Club.Pam));
        // The desk's on-behalf record is written once, with its booking — not once per attempt.
        Assert.Equal(1, await r.Club.ReadAsync(r.App, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .CountAsync(c => c.TenantId == r.Club.TenantId && c.Action == AdminChangeActions.BookingBookedOnBehalf)));
    }

    /// <summary>Two slots in one batch: the first item's INSERT is the victim; both land, each charged once.</summary>
    [SkippableTheory]
    [InlineData(false, 1)]
    [InlineData(false, 2)]
    [InlineData(true, 1)]
    [InlineData(true, 2)]
    public async Task A_bulk_booking_whose_item_loses_a_deadlock_books_every_item_once(bool desk, int deadlocks)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"dlbk{(desk ? "a" : "m")}{deadlocks}", sql => sql.Contains(InsertBooking, StringComparison.Ordinal), deadlocks);
        var items = new[]
        {
            // Two half-hours: a member's day is capped at 60 minutes (member_per_day_max_minutes).
            // Before the evening's peak hours, which are league-only for a member.
            new { courtId = r.Club.Courts[2], startsAt = Later(2), sliceCount = 2 },
            new { courtId = r.Club.Courts[3], startsAt = Later(3), sliceCount = 2 },
        };

        var answer = desk
            ? await r.Club.Member(r.App, r.Club.AdminId, "admin").PostAsJsonAsync("/api/v1/admin/bookings/bulk",
                new { idempotencyKey = $"dl_admin_{deadlocks}", onBehalf = new { userId = r.Club.Olga }, items })
            : await r.Club.Member(r.App, r.Club.Olga).PostAsJsonAsync("/api/v1/bookings/bulk",
                new { idempotencyKey = $"dl_member_{deadlocks}", items });

        Assert.Equal(deadlocks, r.Victim.Raised);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        var bookings = await BookingsOfAsync(r, r.Club.Olga);
        Assert.Equal(2, bookings.Count);
        foreach (var booking in bookings) Assert.Single(await RowsOfAsync(r, booking.Id));
        Assert.Equal(200 - 30 - 30, await r.Club.BalanceAsync(r.App, r.Club.Olga));
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_block_that_loses_a_deadlock_is_placed_once(int deadlocks)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"dlbl{deadlocks}", sql => sql.Contains(InsertBooking, StringComparison.Ordinal), deadlocks);

        var answer = await r.Club.Member(r.App, r.Club.AdminId, "admin").PostAsJsonAsync("/api/v1/admin/blocks/",
            new { courtId = r.Club.Courts[0], startsAt = Later(2), sliceCount = 4, label = "Clinic" });

        Assert.Equal(deadlocks, r.Victim.Raised);
        Assert.True(answer.IsSuccessStatusCode, $"{(int)answer.StatusCode}: {await answer.Content.ReadAsStringAsync()}");
        var block = Assert.Single(await BookingsOfAsync(r, null));
        Assert.Equal(BookingStatus.AdminBlock, block.Status);
        Assert.Equal(1, await AuditsAsync(r, "booking.blocked"));
    }

    // ---- At the box: the pay-for, the check-in -------------------------------------------------------

    /// <summary>
    /// A started court paid for by somebody else: the reassignment's UPDATE is the victim. The refund
    /// and the debit post once, and the nonce row the endpoint staged to commit with them says paid.
    /// </summary>
    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_pay_for_whose_reassignment_loses_a_deadlock_moves_the_money_once(int deadlocks)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"dlpf{deadlocks}", sql => UpdatesBooking(sql, "PaidByUserId"), deadlocks);
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -10, checkedIn: true);
        var device = r.App.CreateClient();
        const string nonce = "dddd0000dddd0001";

        await device.SendAsync(c.PayFor(c.Code(c.Pam), 2, nonce, confirm: false));
        var paid = await device.SendAsync(c.PayFor(c.Code(c.Pam), 2, nonce, confirm: true, label: "60"));

        Assert.Equal(deadlocks, r.Victim.Raised);
        Assert.Equal(HttpStatusCode.OK, paid.StatusCode);
        Assert.True((await MemberCodeClub.JsonAsync(paid)).GetProperty("paid").GetBoolean());
        await AssertPaidOnceAsync(r, booking.Id, nonce);
    }

    /// <summary>
    /// A court nobody has started, paid for inside its cue window: the payer is charged AND checked in.
    /// Either save can be the victim — the reassignment, or the check-in after it committed.
    /// </summary>
    [SkippableTheory]
    [InlineData("PaidByUserId", 1)]
    [InlineData("PaidByUserId", 2)]
    [InlineData("CheckedInAt", 1)]
    [InlineData("CheckedInAt", 2)]
    public async Task A_pay_for_that_lights_the_court_and_loses_a_deadlock_pays_and_lights_once(string column, int deadlocks)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"dlpl{column[..3]}{deadlocks}", sql => UpdatesBooking(sql, column), deadlocks);
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: 2, minutes: 60);
        var device = r.App.CreateClient();
        const string nonce = "dddd0000dddd0002";

        await device.SendAsync(c.PayFor(c.Code(c.Pam), 1, nonce, confirm: false));
        var paid = await device.SendAsync(c.PayFor(c.Code(c.Pam), 1, nonce, confirm: true, label: "60"));

        Assert.Equal(deadlocks, r.Victim.Raised);
        Assert.Equal(HttpStatusCode.OK, paid.StatusCode);
        Assert.True((await MemberCodeClub.JsonAsync(paid)).GetProperty("granted_seconds").GetInt32() > 0);
        await AssertPaidOnceAsync(r, booking.Id, nonce);
        var stored = Assert.Single(await BookingsOfAsync(r, c.Olga));
        Assert.NotNull(stored.CheckedInAt);
        Assert.Equal(1, await AuditsAsync(r, "court.activated"));
    }

    private static async Task AssertPaidOnceAsync(Rig r, Guid bookingId, string nonce)
    {
        var c = r.Club;
        Assert.Equal(140, await c.BalanceAsync(r.App, c.Pam));
        Assert.Equal(200, await c.BalanceAsync(r.App, c.Olga));   // 200 − 60 at booking + 60 back
        var rows = await RowsOfAsync(r, bookingId);
        Assert.Equal(3, rows.Count);   // the booking's charge, the booker's refund, the payer's debit
        Assert.Equal(-60, rows.Single(l => l.UserId == c.Pam).AmountMinutes);
        Assert.Equal(c.Pam, (await c.ReadAsync(r.App, db => db.Bookings.IgnoreQueryFilters().AsNoTracking().FirstAsync(b => b.Id == bookingId))).PaidByUserId);
        Assert.Equal(1, await AuditsAsync(r, DevicePayForEndpoint.PaidAction));
        Assert.Equal(1, await AuditsAsync(r, "booking.payer_reassigned"));
        Assert.True(await c.ReadAsync(r.App, db => db.DevicePayFors.IgnoreQueryFilters().AnyAsync(p => p.Nonce == nonce && p.Paid)));
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_check_in_at_the_box_that_loses_a_deadlock_lights_once(int deadlocks)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"dlac{deadlocks}", sql => UpdatesBooking(sql, "CheckedInAt"), deadlocks);
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: 2, minutes: 60);

        var answer = await r.App.CreateClient().SendAsync(c.Activate(c.Code(c.Olga)));

        Assert.Equal(deadlocks, r.Victim.Raised);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        Assert.NotNull(Assert.Single(await BookingsOfAsync(r, c.Olga)).CheckedInAt);
        Assert.Equal(1, await AuditsAsync(r, "court.activated"));
        Assert.Equal(140, await c.BalanceAsync(r.App, c.Olga));   // charged at booking, nothing at the box
    }

    /// <summary>The same check-in, uploaded later by the box: the settlement's activation save is the victim.</summary>
    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task An_uploaded_check_in_that_loses_a_deadlock_is_settled_once(int deadlocks)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"dlev{deadlocks}", sql => UpdatesBooking(sql, "CheckedInAt"), deadlocks);
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -2, minutes: 60);   // relay 1 is Court 2

        var answer = await r.App.CreateClient().SendAsync(c.Events(c.BoxMac, 1, "activation", 1, c.Code(c.Olga)));

        Assert.Equal(deadlocks, r.Victim.Raised);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        Assert.Equal(1, (await MemberCodeClub.JsonAsync(answer)).GetProperty("recorded").GetInt32());
        Assert.NotNull(Assert.Single(await BookingsOfAsync(r, c.Olga)).CheckedInAt);
        Assert.Equal(1, await AuditsAsync(r, "court.activated"));
        Assert.Equal(140, await c.BalanceAsync(r.App, c.Olga));
    }

    /// <summary>
    /// A no-show, reversed by the box's uploaded scan: restoring the row is an UPDATE the slot constraint
    /// checks, and it is the victim. Reversed once — the same row and the same money as with no deadlock.
    /// </summary>
    [SkippableTheory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_no_show_reversal_that_loses_a_deadlock_is_reversed_once(int deadlocks)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"dlrv{deadlocks}", sql => UpdatesBooking(sql, "NoShowReversedAt"), deadlocks);
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 1, startsInMinutes: -20, minutes: 60);   // relay 1 is Court 2
        await c.WriteAsync(r.App, async db => (await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id)).Status = BookingStatus.NoShow);

        var answer = await r.App.CreateClient().SendAsync(c.Events(c.BoxMac, 1, "activation", 1, c.Code(c.Olga)));

        Assert.Equal(deadlocks, r.Victim.Raised);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        var stored = Assert.Single(await BookingsOfAsync(r, c.Olga));
        Assert.Equal(BookingStatus.Booked, stored.Status);
        Assert.NotNull(stored.NoShowReversedAt);
        Assert.Equal(1, await AuditsAsync(r, "booking.no_show_reversed"));
        Assert.Single(await RowsOfAsync(r, booking.Id));   // the booking's own charge; a no-show with nothing taken has nothing to give back
        Assert.Equal(140, await c.BalanceAsync(r.App, c.Olga));
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_cancel_that_loses_a_deadlock_refunds_once(int deadlocks)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"dlcn{deadlocks}", sql => UpdatesBooking(sql, "CancelledAt"), deadlocks);
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 2, startsInMinutes: 180, minutes: 60);

        var answer = await c.Member(r.App, c.Olga).PostAsJsonAsync($"/api/v1/bookings/{booking.Id}/cancel", new { });

        Assert.Equal(deadlocks, r.Victim.Raised);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        Assert.Equal(BookingStatus.Cancelled, Assert.Single(await BookingsOfAsync(r, c.Olga)).Status);
        Assert.Equal(60, Assert.Single(await RowsOfAsync(r, booking.Id), l => l.AmountMinutes > 0).AmountMinutes);
        Assert.Equal(200, await c.BalanceAsync(r.App, c.Olga));
    }

    // ---- The net under all of it -----------------------------------------------------------------------

    /// <summary>
    /// An abort that outlives every retry is the database's "ask again", not a server fault: 503
    /// <c>conflict_retry</c> with <c>Retry-After</c>, and nothing booked or charged — on a member route
    /// and a device route alike (a box keeps an event on any 5xx and retries it after its backoff).
    /// </summary>
    [SkippableTheory]
    [InlineData(PostgresErrorCodes.DeadlockDetected)]
    [InlineData(PostgresErrorCodes.SerializationFailure)]
    public async Task An_abort_past_every_retry_is_503_conflict_retry_and_moves_nothing(string sqlState)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"dlnet{sqlState}", sql => sql.Contains(InsertBooking, StringComparison.Ordinal), int.MaxValue, sqlState);

        var answer = await r.Club.Member(r.App, r.Club.Olga).PostAsJsonAsync("/api/v1/bookings/",
            new { courtId = r.Club.Courts[0], startsAt = Later(3), sliceCount = 4 });

        Assert.Equal(DatabaseRetry.Attempts, r.Victim.Raised);
        await AssertConflictRetryAsync(answer);
        Assert.Empty(await BookingsOfAsync(r, r.Club.Olga));
        Assert.Equal(200, await r.Club.BalanceAsync(r.App, r.Club.Olga));
    }

    [SkippableTheory]
    [InlineData(PostgresErrorCodes.DeadlockDetected)]
    [InlineData(PostgresErrorCodes.SerializationFailure)]
    public async Task A_device_check_in_past_every_retry_is_503_conflict_retry_and_is_not_stamped(string sqlState)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"dlnd{sqlState}", sql => UpdatesBooking(sql, "CheckedInAt"), int.MaxValue, sqlState);
        var c = r.Club;
        await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: 2, minutes: 60);

        var answer = await r.App.CreateClient().SendAsync(c.Activate(c.Code(c.Olga)));

        await AssertConflictRetryAsync(answer);
        Assert.Null(Assert.Single(await BookingsOfAsync(r, c.Olga)).CheckedInAt);
        Assert.Equal(0, await AuditsAsync(r, "court.activated"));
    }

    private static async Task AssertConflictRetryAsync(HttpResponseMessage answer)
    {
        Assert.Equal(HttpStatusCode.ServiceUnavailable, answer.StatusCode);
        Assert.Equal("""{"error":"conflict_retry"}""", await answer.Content.ReadAsStringAsync());
        Assert.Equal(TimeSpan.FromSeconds(1), answer.Headers.RetryAfter?.Delta);
    }

    /// <summary>Answers the first <c>times</c> matching commands with a PostgreSQL abort instead of running them.</summary>
    private sealed class AbortOn(Func<string, bool> matches, int times, string sqlState) : DbCommandInterceptor
    {
        private readonly Lock _gate = new();
        private int _times = times;
        private int _raised;

        public int Raised
        {
            get
            {
                lock (_gate) return _raised;
            }
        }

        public void Arm(int times)
        {
            lock (_gate) _times = times;
        }

        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            Strike(command);
            return ValueTask.FromResult(result);
        }

        public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            Strike(command);
            return ValueTask.FromResult(result);
        }

        private void Strike(DbCommand command)
        {
            if (!matches(command.CommandText)) return;
            lock (_gate)
            {
                if (_raised >= _times) return;
                _raised++;
            }
            throw new PostgresException("simulated abort", "ERROR", "ERROR", sqlState);
        }
    }
}
