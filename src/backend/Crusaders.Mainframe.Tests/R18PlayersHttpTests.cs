using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Crusaders.Mainframe.Tests.Play;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A command interceptor that lets "a twin" win: just before the first command whose text carries the
/// armed marker runs, it runs the twin to completion (another HTTP request to the same app, or SQL on its
/// own connection), so our save meets exactly what a real loser meets. Strikes once per arming.
/// </summary>
internal sealed class TwinWriter : DbCommandInterceptor
{
    private readonly Lock _gate = new();
    private string? _marker;
    private Func<Task>? _twin;
    private int _won;

    public int Won
    {
        get
        {
            lock (_gate) return _won;
        }
    }

    public void Arm(string marker, Func<Task> twin)
    {
        lock (_gate) (_marker, _twin, _won) = (marker, twin, 0);
    }

    public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
    {
        await StrikeAsync(command);
        return result;
    }

    public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        await StrikeAsync(command);
        return result;
    }

    private async Task StrikeAsync(DbCommand command)
    {
        Func<Task> twin;
        lock (_gate)
        {
            if (_marker is null || _won >= 1 || !command.CommandText.Contains(_marker, StringComparison.Ordinal)) return;
            _won++;
            twin = _twin!;
        }
        await twin();
    }
}

/// <summary>Shared set-up for the R18 lane BE18a classes below.</summary>
internal static class R18Kit
{
    public sealed record Rig(R16Kit.Game Game, TwinWriter Twin);

    /// <summary>
    /// <see cref="R16Kit.GameAsync"/>'s game — Olive's 32-minute court three days out, Sam (and Alex)
    /// invited — on a host whose contexts carry a <see cref="TwinWriter"/>; accepted and paid when
    /// <paramref name="accept"/>.
    /// </summary>
    public static async Task<Rig> GameAsync(PostgresFixture pg, string prefix, int partners, bool accept)
    {
        var twin = new TwinWriter();
        var mail = new CapturingMail();
        var app = CapturingMail.On(pg.SharedHost, mail).WithWebHostBuilder(b => b.ConfigureServices(s =>
            s.ConfigureDbContext<MainframeDbContext>(o => o.AddInterceptors(twin))));
        var club = await PlayersClub.SeedAsync(app, prefix);
        var who = new[] { club.Sam, club.Alex }.Take(partners).ToArray();
        foreach (var p in who) await club.CreditAsync(app, p, 50);
        await club.CreditAsync(app, club.Organiser, 100);
        var start = PlayersClub.Tomorrow(8).AddDays(2);
        var bookingId = await club.InsertBookingAsync(app, start);
        if (who.Length > 0)
        {
            (await club.Client(app, club.Organiser).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players",
                new { players = who.Select(p => (object)new { userId = p }).ToArray() })).EnsureSuccessStatusCode();
        }
        var seatOf = new Dictionary<Guid, Guid>();
        foreach (var seat in await club.SeatsAsync(app, bookingId))
        {
            if (seat.Seat == 1 || seat.UserId is not { } user) continue;
            seatOf[user] = seat.Id;
            if (!accept) continue;
            (await club.Client(app, user).PostAsJsonAsync($"/api/v1/bookings/{bookingId}/players/{seat.Id}/accept",
                new { expectedShareMinutes = seat.ShareMinutes })).EnsureSuccessStatusCode();
        }
        await R16Kit.DeliverAsync(app);
        mail.Sent.Clear();
        return new Rig(new R16Kit.Game(club, app, mail, bookingId, start, seatOf), twin);
    }

    /// <summary>Sends <paramref name="n"/> copies of one request at the same instant and answers every response.</summary>
    public static async Task<HttpResponseMessage[]> AtOnceAsync(int n, Func<Task<HttpResponseMessage>> send)
    {
        using var go = new ManualResetEventSlim(false);
        var tasks = Enumerable.Range(0, n).Select(_ => Task.Run(async () =>
        {
            go.Wait();
            return await send();
        })).ToArray();
        go.Set();
        return await Task.WhenAll(tasks);
    }

    public static async Task<string> DescribeAsync(HttpResponseMessage r) => $"{(int)r.StatusCode} {await r.Content.ReadAsStringAsync()}";

    public static async Task<string?> ErrorAsync(HttpResponseMessage r) =>
        (await r.Content.ReadFromJsonAsync<JsonElement>()).TryGetProperty("error", out var e) ? e.GetString() : null;

    public static Task<int> ChangesAsync(R16Kit.Game g, string action, Guid subject) =>
        PlayersClub.ReadAsync(g.App, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .CountAsync(c => c.TenantId == g.Club.TenantId && c.Action == action && c.SubjectId == subject));

    public static Task<int> AuditsAsync(R16Kit.Game g, string action, Guid subject) =>
        PlayersClub.ReadAsync(g.App, db => db.AuditLogs.IgnoreQueryFilters()
            .CountAsync(a => a.TenantId == g.Club.TenantId && a.Action == action && a.SubjectUserId == subject));

    public static Task<List<MemberNotification>> LinesAsync(R16Kit.Game g, Guid user) =>
        PlayersClub.ReadAsync(g.App, db => db.MemberNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == g.Club.TenantId && n.UserId == user).OrderBy(n => n.CreatedAt).ToListAsync());

    public static Task<BookingParticipant> SeatAsync(R16Kit.Game g, Guid seatId) =>
        PlayersClub.ReadAsync(g.App, db => db.BookingParticipants.IgnoreQueryFilters().AsNoTracking().SingleAsync(p => p.Id == seatId));

    public static async Task<int> BalanceAsync(R16Kit.Game g, Guid user) => await PlayersClub.BalanceAsync(g.App, user);

    public static string Url(R16Kit.Game g, Guid seat, string act, bool admin) =>
        admin ? $"/api/v1/admin/bookings/{g.BookingId}/players/{seat}/{act}" : $"/api/v1/bookings/{g.BookingId}/players/{seat}/{act}";
}

/// <summary>
/// Review round 18, lane BE18a — a seat act that meets its own twin (J18-2, J18-3, J18-4).
/// <list type="bullet">
/// <item>J18-2: two desk accepts on a member's behalf at once → 500: the loser's save hit the
/// outbox's dedupe index (<c>IX_admin_notifications_TenantId_DedupeKey</c>, 23505) and nothing caught it.</item>
/// <item>J18-3: a second "paid by hand" on a seat already settled wrote a second change record, audit
/// row, Night line and notices, and moved <c>SettledOutsideAt</c>.</item>
/// <item>J18-4: twin declines / withdrawals / removals answered <c>409 seat_taken</c> ("That seat was
/// taken") for a 23505 on a notice the twin had already written.</item>
/// </list>
/// Proved with real parallel requests AND an interceptor that lets the twin finish first, every time.
/// Money is asserted exactly once.
/// </summary>
public sealed class R18SeatTwinHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task Parallel_accepts_on_behalf_all_answer_200_and_are_said_once(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, $"r18a-aob{partners}", partners, accept: false)).Game;
        var seat = g.SeatOf[g.Club.Sam];
        var before = await R18Kit.BalanceAsync(g, g.Club.Sam);

        var answers = await R18Kit.AtOnceAsync(4, () => g.Admin.PostAsJsonAsync(R18Kit.Url(g, seat, "accept", admin: true), new { reason = "Phoned in" }));

        foreach (var a in answers) Assert.True(a.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(a));
        Assert.Equal(ParticipantStatus.Accepted, (await R18Kit.SeatAsync(g, seat)).Status);
        Assert.Equal(1, await R18Kit.ChangesAsync(g, AdminChangeActions.BookingPlayerAcceptedOnBehalf, g.Club.Sam));
        Assert.Equal(1, await R18Kit.AuditsAsync(g, PlayersService.AcceptedByClubAction, g.Club.Sam));
        Assert.Single(await R18Kit.LinesAsync(g, g.Club.Sam), n => n.DedupeKey.Contains("club-accepted", StringComparison.Ordinal));
        Assert.Equal(before, await R18Kit.BalanceAsync(g, g.Club.Sam));
        Assert.DoesNotContain(await g.Club.SharesAsync(g.App, g.BookingId), l => l.UserId == g.Club.Sam);
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task An_accept_on_behalf_whose_twin_saved_first_answers_200(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var rig = await R18Kit.GameAsync(pg, $"r18a-aot{partners}", partners, accept: false);
        var g = rig.Game;
        var seat = g.SeatOf[g.Club.Sam];
        HttpResponseMessage? twin = null;
        rig.Twin.Arm("INSERT INTO admin_notifications", async () =>
            twin = await g.Admin.PostAsJsonAsync(R18Kit.Url(g, seat, "accept", admin: true), new { reason = "Phoned in" }));

        var ours = await g.Admin.PostAsJsonAsync(R18Kit.Url(g, seat, "accept", admin: true), new { reason = "Phoned in" });

        Assert.Equal(1, rig.Twin.Won);
        Assert.True(twin!.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(twin));
        Assert.True(ours.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(ours));
        Assert.Equal("accepted", (await ours.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString());
        Assert.Equal(1, await R18Kit.ChangesAsync(g, AdminChangeActions.BookingPlayerAcceptedOnBehalf, g.Club.Sam));
        Assert.Equal(1, await R18Kit.AuditsAsync(g, PlayersService.AcceptedByClubAction, g.Club.Sam));
    }

    [SkippableTheory]
    [InlineData(1, true)]
    [InlineData(1, false)]
    [InlineData(2, true)]
    public async Task Settling_by_hand_twice_writes_once_and_moves_the_share_once(int partners, bool paidInApp)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, $"r18a-so{partners}{(paidInApp ? "p" : "z")}", partners, accept: false)).Game;
        var seat = g.SeatOf[g.Club.Sam];
        if (paidInApp)
        {
            var share = (await R18Kit.SeatAsync(g, seat)).ShareMinutes;
            (await g.As(g.Club.Sam).PostAsJsonAsync(R18Kit.Url(g, seat, "accept", admin: false), new { expectedShareMinutes = share })).EnsureSuccessStatusCode();
        }
        else
        {
            (await g.Admin.PostAsJsonAsync(R18Kit.Url(g, seat, "accept", admin: true), new { reason = "Phoned in" })).EnsureSuccessStatusCode();
        }

        (await g.Admin.PostAsJsonAsync(R18Kit.Url(g, seat, "settle-outside", admin: true), new { reason = "Cash" })).EnsureSuccessStatusCode();
        var settledAt = (await R18Kit.SeatAsync(g, seat)).SettledOutsideAt;
        var lines = (await R18Kit.LinesAsync(g, g.Club.Sam)).Count + (await R18Kit.LinesAsync(g, g.Club.Organiser)).Count;

        var again = await g.Admin.PostAsJsonAsync(R18Kit.Url(g, seat, "settle-outside", admin: true), new { reason = "Cash, again" });

        Assert.True(again.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(again));
        Assert.Equal(settledAt, (await R18Kit.SeatAsync(g, seat)).SettledOutsideAt);
        Assert.Equal(1, await R18Kit.ChangesAsync(g, AdminChangeActions.BookingShareSettledOutside, g.Club.Sam));
        Assert.Equal(1, await R18Kit.AuditsAsync(g, PlayersService.SettledOutsideAction, g.Club.Sam));
        Assert.Equal(lines, (await R18Kit.LinesAsync(g, g.Club.Sam)).Count + (await R18Kit.LinesAsync(g, g.Club.Organiser)).Count);
        // Whatever Sam paid in the app went back once: he is exactly where he started.
        Assert.Equal(50, await R18Kit.BalanceAsync(g, g.Club.Sam));
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task Parallel_settles_by_hand_all_answer_200_and_return_the_share_once(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, $"r18a-sop{partners}", partners, accept: true)).Game;
        var seat = g.SeatOf[g.Club.Sam];
        Assert.True(await R18Kit.BalanceAsync(g, g.Club.Sam) < 50);
        var organiser = await R18Kit.BalanceAsync(g, g.Club.Organiser);
        var samPaid = 50 - await R18Kit.BalanceAsync(g, g.Club.Sam);

        var answers = await R18Kit.AtOnceAsync(4, () => g.Admin.PostAsJsonAsync(R18Kit.Url(g, seat, "settle-outside", admin: true), new { reason = "Cash" }));

        foreach (var a in answers) Assert.True(a.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(a));
        Assert.Equal(1, await R18Kit.ChangesAsync(g, AdminChangeActions.BookingShareSettledOutside, g.Club.Sam));
        Assert.Equal(1, await R18Kit.AuditsAsync(g, PlayersService.SettledOutsideAction, g.Club.Sam));
        Assert.Equal(50, await R18Kit.BalanceAsync(g, g.Club.Sam));
        Assert.Equal(organiser - samPaid, await R18Kit.BalanceAsync(g, g.Club.Organiser));
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task Parallel_declines_all_answer_200_and_are_said_once(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, $"r18a-dc{partners}", partners, accept: false)).Game;
        var seat = g.SeatOf[g.Club.Sam];
        var organiserLines = (await R18Kit.LinesAsync(g, g.Club.Organiser)).Count;

        var answers = await R18Kit.AtOnceAsync(3, () => g.As(g.Club.Sam).PostAsync(R18Kit.Url(g, seat, "decline", admin: false), null));

        foreach (var a in answers) Assert.True(a.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(a));
        Assert.Equal(ParticipantStatus.Declined, (await R18Kit.SeatAsync(g, seat)).Status);
        Assert.Equal(1, await R18Kit.AuditsAsync(g, PlayersService.DeclinedAction, g.Club.Sam));
        Assert.Equal(organiserLines + 1, (await R18Kit.LinesAsync(g, g.Club.Organiser)).Count);
        Assert.Equal(50, await R18Kit.BalanceAsync(g, g.Club.Sam));
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_decline_whose_twin_saved_first_answers_200_never_seat_taken(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var rig = await R18Kit.GameAsync(pg, $"r18a-dt{partners}", partners, accept: false);
        var g = rig.Game;
        var seat = g.SeatOf[g.Club.Sam];
        HttpResponseMessage? twin = null;
        rig.Twin.Arm("INSERT INTO member_notifications", async () =>
            twin = await g.As(g.Club.Sam).PostAsync(R18Kit.Url(g, seat, "decline", admin: false), null));

        var ours = await g.As(g.Club.Sam).PostAsync(R18Kit.Url(g, seat, "decline", admin: false), null);

        Assert.Equal(1, rig.Twin.Won);
        Assert.True(twin!.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(twin));
        Assert.True(ours.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(ours));
        Assert.Equal("declined", (await ours.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString());
        Assert.Equal(1, await R18Kit.AuditsAsync(g, PlayersService.DeclinedAction, g.Club.Sam));
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task Parallel_withdrawals_all_answer_200_and_return_the_share_once(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, $"r18a-wd{partners}", partners, accept: true)).Game;
        var seat = g.SeatOf[g.Club.Sam];
        var organiser = await R18Kit.BalanceAsync(g, g.Club.Organiser);
        var samPaid = 50 - await R18Kit.BalanceAsync(g, g.Club.Sam);
        Assert.True(samPaid > 0);

        var answers = await R18Kit.AtOnceAsync(3, () => g.As(g.Club.Sam).PostAsync(R18Kit.Url(g, seat, "withdraw", admin: false), null));

        foreach (var a in answers) Assert.True(a.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(a));
        Assert.Equal(ParticipantStatus.Withdrawn, (await R18Kit.SeatAsync(g, seat)).Status);
        Assert.Equal(1, await R18Kit.AuditsAsync(g, PlayersService.WithdrewAction, g.Club.Sam));
        Assert.Equal(50, await R18Kit.BalanceAsync(g, g.Club.Sam));
        Assert.Equal(organiser - samPaid, await R18Kit.BalanceAsync(g, g.Club.Organiser));
    }

    [SkippableTheory]
    [InlineData(1, false)]
    [InlineData(2, false)]
    [InlineData(1, true)]
    [InlineData(2, true)]
    public async Task Parallel_removals_all_answer_200_and_return_the_share_once(int partners, bool byClub)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, $"r18a-rm{partners}{(byClub ? "c" : "o")}", partners, accept: true)).Game;
        var seat = g.SeatOf[g.Club.Sam];
        var organiser = await R18Kit.BalanceAsync(g, g.Club.Organiser);
        var samPaid = 50 - await R18Kit.BalanceAsync(g, g.Club.Sam);

        var answers = await R18Kit.AtOnceAsync(3, () => byClub
            ? g.Admin.PostAsJsonAsync(R18Kit.Url(g, seat, "remove", admin: true), new { reason = "Injured" })
            : g.As(g.Club.Organiser).DeleteAsync($"/api/v1/bookings/{g.BookingId}/players/{seat}"));

        foreach (var a in answers) Assert.True(a.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(a));
        Assert.Equal(ParticipantStatus.Removed, (await R18Kit.SeatAsync(g, seat)).Status);
        Assert.Equal(1, await R18Kit.AuditsAsync(g, SeatFacts.RemovedAction, g.Club.Sam));
        Assert.Equal(50, await R18Kit.BalanceAsync(g, g.Club.Sam));
        Assert.Equal(organiser - samPaid, await R18Kit.BalanceAsync(g, g.Club.Organiser));
    }

    /// <summary>The control: a decline that meets a DIFFERENT answer is still refused for what happened.</summary>
    [SkippableFact]
    public async Task A_decline_after_an_accept_is_still_not_invited()
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, "r18a-dca", 1, accept: true)).Game;
        var no = await g.As(g.Club.Sam).PostAsync(R18Kit.Url(g, g.SeatOf[g.Club.Sam], "decline", admin: false), null);
        Assert.Equal(HttpStatusCode.Conflict, no.StatusCode);
        Assert.Equal(PlayerErrors.NotInvited, await R18Kit.ErrorAsync(no));
    }
}

/// <summary>
/// Review round 18, lane BE18a — the organiser's cancel and a partner's accept (J18-5), who is told when
/// the club cancels (J18-9), and who had checked in on the "your share stands" frame (E18-2).
/// </summary>
public sealed class R18AcceptCancelHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    [SkippableTheory]
    [InlineData(1, false)]
    [InlineData(2, false)]
    [InlineData(1, true)]
    [InlineData(2, true)]
    public async Task An_accept_on_a_cancelled_game_is_booking_not_open_and_moves_nothing(int partners, bool byClub)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, $"r18a-ac{partners}{(byClub ? "c" : "o")}", partners, accept: false)).Game;
        var cancel = byClub
            ? await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/cancel", new { reason = "Court repairs" })
            : await g.As(g.Club.Organiser).PostAsync($"/api/v1/bookings/{g.BookingId}/cancel", null);
        Assert.True(cancel.IsSuccessStatusCode, await R18Kit.DescribeAsync(cancel));
        var seat = g.SeatOf[g.Club.Sam];
        var share = (await R18Kit.SeatAsync(g, seat)).ShareMinutes;

        var accept = await g.As(g.Club.Sam).PostAsJsonAsync(R18Kit.Url(g, seat, "accept", admin: false), new { expectedShareMinutes = share });

        Assert.Equal(HttpStatusCode.Conflict, accept.StatusCode);
        var body = await accept.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(PlayerErrors.BookingNotOpen, body.GetProperty("error").GetString());
        Assert.Equal(g.BookingId, body.GetProperty("booking_id").GetGuid());
        Assert.Equal(50, await R18Kit.BalanceAsync(g, g.Club.Sam));
        Assert.DoesNotContain(await g.Club.SharesAsync(g.App, g.BookingId), l => l.UserId == g.Club.Sam);
    }

    /// <summary>
    /// The cancel commits while the accept is deciding (between its read of the booking and its save).
    /// The accept must hold the booking for its decision: either the cancel waits behind it (and is then
    /// refused here by the lock timeout, the accept going through on a live game) or the accept sees it.
    /// What may never happen is the old outcome — a share taken on a game that was already off.
    /// </summary>
    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_cancel_landing_while_the_accept_decides_never_takes_a_share_on_a_cancelled_game(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var rig = await R18Kit.GameAsync(pg, $"r18a-acr{partners}", partners, accept: false);
        var g = rig.Game;
        var seat = g.SeatOf[g.Club.Sam];
        var share = (await R18Kit.SeatAsync(g, seat)).ShareMinutes;
        var cancelled = false;
        rig.Twin.Arm("INSERT INTO ledger_entries", async () =>
        {
            await using var connection = new NpgsqlConnection(pg.ConnectionString!);
            await connection.OpenAsync();
            await using var tx = await connection.BeginTransactionAsync();
            await using (var timeout = new NpgsqlCommand("SET LOCAL lock_timeout = '1500ms'", connection, tx)) await timeout.ExecuteNonQueryAsync();
            try
            {
                await using var off = new NpgsqlCommand(
                    "UPDATE bookings SET \"Status\" = 1, \"CancelledAt\" = now(), \"Version\" = \"Version\" + 1 WHERE \"Id\" = @id", connection, tx);
                off.Parameters.AddWithValue("id", g.BookingId);
                await off.ExecuteNonQueryAsync();
                await tx.CommitAsync();
                cancelled = true;
            }
            catch (PostgresException e) when (e.SqlState == PostgresErrorCodes.LockNotAvailable)
            {
                // The accept holds the booking: the cancel waits its turn, as a real one does.
            }
        });

        var accept = await g.As(g.Club.Sam).PostAsJsonAsync(R18Kit.Url(g, seat, "accept", admin: false), new { expectedShareMinutes = share });

        var samShares = (await g.Club.SharesAsync(g.App, g.BookingId)).Where(l => l.UserId == g.Club.Sam).ToList();
        var status = await PlayersClub.ReadAsync(g.App, db => db.Bookings.IgnoreQueryFilters().Where(b => b.Id == g.BookingId).Select(b => b.Status).FirstAsync());
        Assert.False(cancelled && accept.IsSuccessStatusCode,
            $"a share was taken on a game cancelled before the accept saved: {await R18Kit.DescribeAsync(accept)}, rows {samShares.Count}");
        if (cancelled)
        {
            Assert.Equal(PlayerErrors.BookingNotOpen, await R18Kit.ErrorAsync(accept));
            Assert.Empty(samShares);
        }
        else
        {
            Assert.True(accept.StatusCode == HttpStatusCode.OK, await R18Kit.DescribeAsync(accept));
            Assert.Equal(BookingStatus.Booked, status);
        }
    }

    /// <summary>Real parallel: the organiser cancels as each partner accepts. Every minute ends where it started.</summary>
    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task An_accept_racing_the_organisers_cancel_leaves_every_balance_exact(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        for (var round = 0; round < 3; round++)
        {
            var g = (await R18Kit.GameAsync(pg, $"r18a-acp{partners}{round}", partners, accept: false)).Game;
            var accepts = new List<Task<HttpResponseMessage>>();
            using var go = new ManualResetEventSlim(false);
            foreach (var (user, seat) in g.SeatOf)
            {
                var share = (await R18Kit.SeatAsync(g, seat)).ShareMinutes;
                accepts.Add(Task.Run(async () =>
                {
                    go.Wait();
                    return await g.As(user).PostAsJsonAsync(R18Kit.Url(g, seat, "accept", admin: false), new { expectedShareMinutes = share });
                }));
            }
            var cancel = Task.Run(async () =>
            {
                go.Wait();
                return await g.As(g.Club.Organiser).PostAsync($"/api/v1/bookings/{g.BookingId}/cancel", null);
            });
            go.Set();
            Assert.True((await cancel).IsSuccessStatusCode, await R18Kit.DescribeAsync(await cancel));
            foreach (var a in await Task.WhenAll(accepts))
            {
                Assert.True(a.StatusCode == HttpStatusCode.OK || await R18Kit.ErrorAsync(a) == PlayerErrors.BookingNotOpen, await R18Kit.DescribeAsync(a));
            }

            foreach (var user in g.SeatOf.Keys) Assert.Equal(50, await R18Kit.BalanceAsync(g, user));
            Assert.Equal(100, await R18Kit.BalanceAsync(g, g.Club.Organiser));
        }
    }

    // ------------------------------------------------------------------ J18-9

    [SkippableTheory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public async Task The_club_cancelling_tells_the_organiser_in_their_inbox_once(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, $"r18a-oc{partners}", partners, accept: true)).Game;

        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/cancel", new { reason = "Court repairs" })).EnsureSuccessStatusCode();
        await R16Kit.DeliverAsync(g.App);

        var line = Assert.Single(await R16Kit.InboxAsync(g, g.Club.Organiser, MemberEventCatalogue.GameCancelled));
        Assert.Equal($"The club cancelled your booking on {g.Where}", line.Headline);
        Assert.Equal($"/bookings/{g.BookingId}", line.Link);
        // Not mailed a second time: the cancellation mail is the organiser's mail.
        Assert.Empty(await PlayKit.OutboxAsync(g.App, g.Club.Organiser, MemberEventCatalogue.GameCancelled));
    }

    [SkippableTheory]
    [InlineData(0)]
    [InlineData(1)]
    public async Task The_organisers_own_cancel_adds_no_line_of_theirs(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, $"r18a-oo{partners}", partners, accept: true)).Game;
        (await g.As(g.Club.Organiser).PostAsync($"/api/v1/bookings/{g.BookingId}/cancel", null)).EnsureSuccessStatusCode();
        Assert.Empty(await R16Kit.InboxAsync(g, g.Club.Organiser, MemberEventCatalogue.GameCancelled));
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_started_game_the_club_cancels_still_gives_the_organiser_one_line(int partners)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, $"r18a-os{partners}", partners, accept: true)).Game;
        await R17Kit.StartedAsync(g);
        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/cancel", new { reason = "Flooded court" })).EnsureSuccessStatusCode();
        var line = Assert.Single(await R16Kit.InboxAsync(g, g.Club.Organiser, MemberEventCatalogue.GameCancelled));
        Assert.Contains("it had started", line.Headline, StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------ E18-2

    /// <summary>
    /// The "your share stands" frame names who checked in, as the organiser's own frame does: the scanner
    /// by name to everybody else, and "you" to the scanner.
    /// </summary>
    [SkippableTheory]
    [InlineData(1, false)]
    [InlineData(2, false)]
    [InlineData(1, true)]
    [InlineData(2, true)]
    public async Task The_share_stands_frame_names_who_checked_in(int partners, bool samScanned)
    {
        Skip.IfNot(pg.Available, R16Kit.Skipped);
        var g = (await R18Kit.GameAsync(pg, $"r18a-ss{partners}{(samScanned ? "s" : "o")}", partners, accept: true)).Game;
        await R17Kit.StartedAsync(g);
        if (samScanned)
        {
            await g.Club.WriteAsync(g.App, db =>
            {
                var at = db.Bookings.IgnoreQueryFilters().First(b => b.Id == g.BookingId).CheckedInAt;
                db.BookingParticipants.IgnoreQueryFilters().First(p => p.Id == g.SeatOf[g.Club.Sam]).CheckedInAt = at;
            });
        }
        var bus = g.App.Services.GetRequiredService<IRealtimeBus>();
        var wallets = g.SeatOf.Keys.ToDictionary(u => u, u => bus.Subscribe(RealtimeTopic.Wallet(g.Club.TenantId, u)));

        (await g.Admin.PostAsJsonAsync($"/api/v1/admin/bookings/{g.BookingId}/cancel", new { reason = "Flooded court" })).EnsureSuccessStatusCode();

        foreach (var user in g.SeatOf.Keys)
        {
            var frames = await R17Kit.FramesAsync(wallets[user], expectOne: true);
            var stands = Assert.Single(frames, f => f.GetProperty("reason").GetString() == ShareSweep.CancelledShareStandsReason);
            var you = samScanned && user == g.Club.Sam;
            Assert.Equal(you, stands.GetProperty("checked_in_by_you").GetBoolean());
            var name = stands.GetProperty("checked_in_by_name");
            if (you) Assert.Equal(JsonValueKind.Null, name.ValueKind);
            else Assert.Equal(samScanned ? "Sam Partner" : "Olive Organiser", name.GetString());
        }
    }
}

/// <summary>
/// Review round 18, lane BE18a — J18-1: a session the club cancelled after it had started took a result
/// (can_record true → record → confirm) and counted it as a match played while it counted 0 attended.
/// A cancelled game takes no result, and a result on a game since cancelled stops counting, by the ONE
/// definition of attended (<see cref="AttendanceQuery"/>).
/// </summary>
public sealed class R18ResultCancelledHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private static async Task<(PlayersClub Club, WebApplicationFactory<Program> App, Guid BookingId, List<Guid> Players)> StartedGameAsync(
        PostgresFixture pg, string prefix, int partners)
    {
        var f = pg.SharedHost;
        var club = await PlayKit.SeedAsync(f, prefix);
        var others = new[] { club.Sam, club.Alex, club.Jo }.Take(partners).ToList();
        var start = DateTimeOffset.UtcNow.AddMinutes(-20).Storable();
        var bookingId = await club.GameAsync(f, start, club.Organiser, others);
        return (club, f, bookingId, [club.Organiser, .. others]);
    }

    private static (string[] A, string[] B) Sides(List<Guid> players) =>
        players.Count == 2
            ? ([PlayKit.U(players[0])], [PlayKit.U(players[1])])
            : ([PlayKit.U(players[0]), PlayKit.U(players[1])], [PlayKit.U(players[2]), PlayKit.U(players[3])]);

    private static Task<HttpResponseMessage> ClubCancelAsync(PlayersClub club, WebApplicationFactory<Program> f, Guid bookingId) =>
        club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/bookings/{bookingId}/cancel", new { reason = "Flooded court" });

    private static async Task AssertCancelledRefusalAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.JsonAsync();
        Assert.Equal(ResultErrors.NotRecordable, body.GetProperty("error").GetString());
        Assert.Equal(ResultErrors.Cancelled, body.GetProperty("reason").GetString());
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(3)]
    public async Task A_game_the_club_cancelled_takes_no_result(int partners)
    {
        Skip.IfNot(pg.Available, PlayKit.Skipped);
        var (club, f, bookingId, players) = await StartedGameAsync(pg, $"r18a-rc{partners}", partners);
        (await ClubCancelAsync(club, f, bookingId)).EnsureSuccessStatusCode();
        var me = club.Client(f, club.Organiser);

        var read = await PlayKit.ReadResultAsync(me, bookingId);
        Assert.False(read.GetProperty("permissions").GetProperty("can_record").GetBoolean());
        Assert.Equal(ResultErrors.Cancelled, read.GetProperty("not_recordable_reason").GetString());

        var (a, b) = Sides(players);
        await AssertCancelledRefusalAsync(await PlayKit.RecordAsync(me, bookingId, a, b));
        Assert.Null(await PlayKit.ResultRowAsync(f, bookingId));
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(3)]
    public async Task A_pending_result_cannot_be_confirmed_or_edited_once_the_game_is_cancelled(int partners)
    {
        Skip.IfNot(pg.Available, PlayKit.Skipped);
        var (club, f, bookingId, players) = await StartedGameAsync(pg, $"r18a-rp{partners}", partners);
        var (a, b) = Sides(players);
        var recorded = await PlayKit.RecordAsync(club.Client(f, club.Organiser), bookingId, a, b);
        Assert.True(recorded.IsSuccessStatusCode, await R18Kit.DescribeAsync(recorded));
        var version = (await recorded.JsonAsync()).GetProperty("version").GetInt32();
        (await ClubCancelAsync(club, f, bookingId)).EnsureSuccessStatusCode();

        // The other side (Sam in singles, Alex in doubles) is the confirming side.
        var other = club.Client(f, players[partners == 1 ? 1 : 2]);
        await AssertCancelledRefusalAsync(await PlayKit.ActAsync(other, bookingId, "confirm", version));
        var edit = await club.Client(f, club.Organiser).PutAsJsonAsync($"/api/v1/bookings/{bookingId}/result", new
        {
            idempotencyKey = Guid.NewGuid().ToString("N"),
            expectedVersion = version,
            format = "best_of_5",
            sideA = a,
            sideB = b,
            games = PlayKit.ThreeOne,
        });
        await AssertCancelledRefusalAsync(edit);
        Assert.Equal(MatchResultStatus.Pending, (await PlayKit.ResultRowAsync(f, bookingId))!.Status);
    }

    [SkippableTheory]
    [InlineData(1)]
    [InlineData(3)]
    public async Task A_confirmed_result_on_a_game_since_cancelled_stops_counting(int partners)
    {
        Skip.IfNot(pg.Available, PlayKit.Skipped);
        var (club, f, bookingId, players) = await StartedGameAsync(pg, $"r18a-rx{partners}", partners);
        var (a, b) = Sides(players);
        var recorded = await PlayKit.RecordAsync(club.Client(f, club.Organiser), bookingId, a, b);
        Assert.True(recorded.IsSuccessStatusCode, await R18Kit.DescribeAsync(recorded));
        var version = (await recorded.JsonAsync()).GetProperty("version").GetInt32();
        var confirmer = players[partners == 1 ? 1 : 2];
        (await PlayKit.ActAsync(club.Client(f, confirmer), bookingId, "confirm", version)).EnsureSuccessStatusCode();
        foreach (var p in players)
        {
            Assert.Equal(1, (await PlayKit.MyGameAsync(club.Client(f, p))).GetProperty("stats").GetProperty("matches_played").GetInt32());
        }

        (await ClubCancelAsync(club, f, bookingId)).EnsureSuccessStatusCode();

        foreach (var p in players)
        {
            var game = await PlayKit.MyGameAsync(club.Client(f, p));
            var stats = game.GetProperty("stats");
            Assert.Equal(0, stats.GetProperty("sessions_attended").GetInt32());
            Assert.Equal(0, stats.GetProperty("matches_played").GetInt32());
            Assert.Equal(0, stats.GetProperty("matches_won").GetInt32());
            Assert.Equal(0, stats.GetProperty("games_won").GetInt32() + stats.GetProperty("games_lost").GetInt32());
            Assert.Empty(game.GetProperty("form").EnumerateArray());
            Assert.Empty(game.GetProperty("opponents").EnumerateArray());
        }
    }
}
