using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 17, lane BE17b — a booking somebody else decides between our read and our write.
///
/// <para>
/// J17-1: five members scanning one booking at once each read it unlit and each stamped it; the
/// booking's <c>Version</c> let one UPDATE through and the other four answered the box 500, the
/// partner's own check-in lost. Now a save that loses that race is decided again on the rows as they
/// are — a lit booking is a repeat arrival — and an optimistic miss nobody re-decided is 503
/// <c>conflict_retry</c>, never 500. J17-4: every seat's check-in is on the record
/// (<c>court.checked_in</c>), not only the first scanner's.
/// </para>
///
/// <para>
/// Proved two ways, as R16's deadlock suite does: real parallel requests, and a command interceptor that
/// lets "another writer" win — it commits a change to the row on its own connection just before our
/// UPDATE runs, so our UPDATE matches no row exactly as a real loser's does — once, twice, and past every retry.
/// </para>
/// </summary>
public sealed class R17BookingRaceHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string CheckedIn = "court.checked_in";
    private const string Activated = "court.activated";

    // ---- The rig -------------------------------------------------------------------------------------

    private sealed record Rig(MemberCodeClub Club, WebApplicationFactory<Program> App, OtherWriter Winner) : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => App.DisposeAsync();
    }

    private async Task<Rig> RigAsync(string prefix, string? settings = null)
    {
        var winner = new OtherWriter(pg.ConnectionString!);
        var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService()).WithWebHostBuilder(b => b.ConfigureServices(s =>
            s.ConfigureDbContext<MainframeDbContext>(o => o.AddInterceptors(winner))));
        var club = await MemberCodeClub.SeedAsync(app, prefix, settings ?? MemberCodeClub.Settings);
        return new Rig(club, app, winner);
    }

    /// <summary>An active member of the club with a code of their own.</summary>
    private static async Task<Guid> MemberAsync(WebApplicationFactory<Program> app, MemberCodeClub club, string handle)
    {
        var user = new User
        {
            TenantId = club.TenantId,
            Email = $"{handle}-{club.Slug}@test.local",
            PasswordHash = new Pbkdf2PasswordHasher().Hash("OldPass!123"),
            EmailVerified = true,
        };
        var used = club.Refs.Values.ToHashSet();
        var reference = Enumerable.Range(0, 64).Select(_ => Random.Shared.Next(1, MemberCodeMath.MaxRefValue)).First(r => !used.Contains(r));
        await club.WriteAsync(app, db =>
        {
            db.Users.Add(user);
            db.Memberships.Add(new Membership
            {
                TenantId = club.TenantId,
                UserId = user.Id,
                FullName = $"{char.ToUpperInvariant(handle[0])}{handle[1..]} Partner",
                MembershipNumber = $"{handle}-{club.Slug}",
                Status = MembershipStatus.Active,
            });
            db.MemberCodes.Add(new MemberCode { TenantId = club.TenantId, UserId = user.Id, Ref = reference });
            return Task.CompletedTask;
        });
        club.Refs[user.Id] = reference;
        return user.Id;
    }

    /// <summary>Olga's game on court 1, two minutes off: Olga on seat 1, then every partner ACCEPTED with a share.</summary>
    private static async Task<(Booking Booking, List<Guid> Players)> GameAsync(Rig r, int partners, int startsInMinutes = 2)
    {
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: startsInMinutes, minutes: 60);
        var players = new List<Guid> { c.Olga, c.Pam };
        for (var i = 1; i < partners; i++) players.Add(await MemberAsync(r.App, c, $"p{i}x"));
        players = [.. players.Take(partners + 1)];
        await c.WriteAsync(r.App, db =>
        {
            var now = DateTimeOffset.UtcNow;
            for (var seat = 0; seat < players.Count; seat++)
            {
                db.BookingParticipants.Add(new BookingParticipant
                {
                    TenantId = c.TenantId,
                    BookingId = booking.Id,
                    Seat = seat + 1,
                    UserId = players[seat],
                    Status = ParticipantStatus.Accepted,
                    ShareMinutes = 0,
                    ConsentedMinutes = 0,
                    ShareWeight = 1,
                    SplitMode = seat == 0 ? SplitModes.Equal : null,
                    InvitedAt = now,
                    CreatedAt = now,
                    UpdatedAt = now,
                    RespondedAt = now,
                });
            }
            return Task.CompletedTask;
        });
        return (booking, players);
    }

    private static Task<Booking> BookingAsync(Rig r, Guid id) =>
        r.Club.ReadAsync(r.App, db => db.Bookings.IgnoreQueryFilters().AsNoTracking().SingleAsync(b => b.Id == id));

    private static Task<List<BookingParticipant>> SeatsAsync(Rig r, Guid bookingId) =>
        r.Club.ReadAsync(r.App, db => db.BookingParticipants.IgnoreQueryFilters().AsNoTracking()
            .Where(p => p.BookingId == bookingId).OrderBy(p => p.Seat).ToListAsync());

    private static Task<List<AuditLog>> AuditsAsync(Rig r, string action) =>
        r.Club.ReadAsync(r.App, db => db.AuditLogs.IgnoreQueryFilters().AsNoTracking()
            .Where(a => a.TenantId == r.Club.TenantId && a.Action == action).ToListAsync());

    private static Task<List<LedgerEntry>> RowsOfAsync(Rig r, Guid bookingId) =>
        r.Club.ReadAsync(r.App, db => db.LedgerEntries.IgnoreQueryFilters().AsNoTracking()
            .Where(l => l.TenantId == r.Club.TenantId && l.RelatedBookingId == bookingId).ToListAsync());

    private static async Task<Dictionary<Guid, int>> BalancesAsync(Rig r, IEnumerable<Guid> players)
    {
        var balances = new Dictionary<Guid, int>();
        foreach (var p in players) balances[p] = await r.Club.BalanceAsync(r.App, p);
        return balances;
    }

    private static JsonElement Details(AuditLog row) => JsonDocument.Parse(row.DetailsJson!).RootElement;

    // ---- J17-1: real parallel scans ------------------------------------------------------------------

    /// <summary>
    /// Every player of a game scans at the same instant. One lights the court; every other is a repeat
    /// arrival — 200, activated, their own seat stamped. Never a 500, one <c>court.activated</c>, one
    /// <c>court.checked_in</c> per seat, and not a minute moves (charged at booking).
    /// </summary>
    [SkippableTheory]
    [InlineData(1)]
    [InlineData(3)]
    public async Task Every_player_scanning_at_once_is_checked_in_and_the_court_lit_once(int partners)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"r17par{partners}");
        var (booking, players) = await GameAsync(r, partners);
        var before = await BalancesAsync(r, players);
        var rowsBefore = (await RowsOfAsync(r, booking.Id)).Count;

        var answers = await Task.WhenAll(players.Select(p => r.App.CreateClient().SendAsync(r.Club.Activate(r.Club.Code(p)))));

        foreach (var answer in answers)
        {
            Assert.True(answer.StatusCode == HttpStatusCode.OK, $"{(int)answer.StatusCode}: {await answer.Content.ReadAsStringAsync()}");
            Assert.True((await MemberCodeClub.JsonAsync(answer)).GetProperty("activated").GetBoolean());
        }
        Assert.NotNull((await BookingAsync(r, booking.Id)).CheckedInAt);
        Assert.All(await SeatsAsync(r, booking.Id), s => Assert.NotNull(s.CheckedInAt));
        Assert.Single(await AuditsAsync(r, Activated));
        var checkedIn = await AuditsAsync(r, CheckedIn);
        Assert.Equal(players.Order(), checkedIn.Select(a => a.SubjectUserId!.Value).Order());
        Assert.Single(checkedIn, a => Details(a).GetProperty("lit_court").GetBoolean());
        Assert.Equal(before, await BalancesAsync(r, players));
        Assert.Equal(rowsBefore, (await RowsOfAsync(r, booking.Id)).Count);
    }

    // ---- J17-1: the interceptor — another writer wins first -------------------------------------------

    /// <summary>
    /// Pam scans; just before her check-in UPDATE runs, another scan lights the booking (CheckedInAt set,
    /// Version moved). Decided again, hers is a repeat arrival: her seat and her <c>court.checked_in</c>,
    /// no <c>court.activated</c> of her own, no money.
    /// </summary>
    [SkippableFact]
    public async Task A_scan_whose_booking_another_scan_lit_first_stamps_only_the_scanners_seat()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r17lit");
        var (booking, players) = await GameAsync(r, 1);
        var before = await BalancesAsync(r, players);
        r.Winner.Arm("UPDATE bookings SET", $"""UPDATE bookings SET "Version" = "Version" + 1, "CheckedInAt" = now() WHERE "Id" = '{booking.Id}'""", 1);

        var answer = await r.App.CreateClient().SendAsync(r.Club.Activate(r.Club.Code(r.Club.Pam)));

        Assert.Equal(1, r.Winner.Won);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        Assert.True((await MemberCodeClub.JsonAsync(answer)).GetProperty("activated").GetBoolean());
        var seats = await SeatsAsync(r, booking.Id);
        Assert.NotNull(seats.Single(s => s.UserId == r.Club.Pam).CheckedInAt);
        Assert.Null(seats.Single(s => s.UserId == r.Club.Olga).CheckedInAt);
        Assert.Empty(await AuditsAsync(r, Activated));
        var row = Assert.Single(await AuditsAsync(r, CheckedIn));
        Assert.False(Details(row).GetProperty("lit_court").GetBoolean());
        Assert.Equal(before, await BalancesAsync(r, players));
    }

    /// <summary>The booking's Version moves under the check-in once, then twice: lit once, stamped once, charged nothing at the box.</summary>
    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_check_in_that_loses_the_booking_row_is_decided_again_and_lights_once(int times)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"r17ver{times}");
        var (booking, players) = await GameAsync(r, 1);
        var before = await BalancesAsync(r, players);
        r.Winner.Arm("UPDATE bookings SET", $"""UPDATE bookings SET "Version" = "Version" + 1 WHERE "Id" = '{booking.Id}'""", times);

        var answer = await r.App.CreateClient().SendAsync(r.Club.Activate(r.Club.Code(r.Club.Olga)));

        Assert.Equal(times, r.Winner.Won);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        Assert.NotNull((await BookingAsync(r, booking.Id)).CheckedInAt);
        Assert.Single(await AuditsAsync(r, Activated));
        var row = Assert.Single(await AuditsAsync(r, CheckedIn));
        Assert.True(Details(row).GetProperty("lit_court").GetBoolean());
        Assert.Equal(before, await BalancesAsync(r, players));
    }

    /// <summary>A repeat arrival whose OWN seat moves under it (a share reconcile, say) once, then twice: stamped once.</summary>
    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_repeat_arrival_that_loses_its_seat_row_is_decided_again_and_stamped_once(int times)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"r17seat{times}");
        var (booking, players) = await GameAsync(r, 1);
        Assert.Equal(HttpStatusCode.OK, (await r.App.CreateClient().SendAsync(r.Club.Activate(r.Club.Code(r.Club.Olga)))).StatusCode);
        r.Winner.Arm("UPDATE booking_participants SET",
            $"""UPDATE booking_participants SET "Version" = "Version" + 1 WHERE "BookingId" = '{booking.Id}' AND "UserId" = '{r.Club.Pam}'""", times);

        var answer = await r.App.CreateClient().SendAsync(r.Club.Activate(r.Club.Code(r.Club.Pam)));

        Assert.Equal(times, r.Winner.Won);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        Assert.NotNull((await SeatsAsync(r, booking.Id)).Single(s => s.UserId == r.Club.Pam).CheckedInAt);
        Assert.Equal(2, (await AuditsAsync(r, CheckedIn)).Count);   // Olga's and Pam's, once each
        Assert.Single(await AuditsAsync(r, Activated));
        _ = players;
    }

    /// <summary>
    /// Past every retry the booking keeps moving: 503 <c>conflict_retry</c> with Retry-After — the global
    /// net under any optimistic miss nobody re-decided — and nothing stamped, recorded or charged.
    /// </summary>
    [SkippableFact]
    public async Task A_check_in_that_loses_every_attempt_is_503_conflict_retry_and_writes_nothing()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r17net");
        var (booking, players) = await GameAsync(r, 1);
        var before = await BalancesAsync(r, players);
        r.Winner.Arm("UPDATE bookings SET", $"""UPDATE bookings SET "Version" = "Version" + 1 WHERE "Id" = '{booking.Id}'""", int.MaxValue);

        var answer = await r.App.CreateClient().SendAsync(r.Club.Activate(r.Club.Code(r.Club.Olga)));

        Assert.Equal(DatabaseRetry.Attempts, r.Winner.Won);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, answer.StatusCode);
        Assert.Equal("""{"error":"conflict_retry"}""", await answer.Content.ReadAsStringAsync());
        Assert.Equal(TimeSpan.FromSeconds(1), answer.Headers.RetryAfter?.Delta);
        Assert.Null((await BookingAsync(r, booking.Id)).CheckedInAt);
        Assert.All(await SeatsAsync(r, booking.Id), s => Assert.Null(s.CheckedInAt));
        Assert.Empty(await AuditsAsync(r, Activated));
        Assert.Empty(await AuditsAsync(r, CheckedIn));
        Assert.Equal(before, await BalancesAsync(r, players));
    }

    // ---- J17-4: court.checked_in on every seat's stamp -----------------------------------------------

    /// <summary>
    /// The organiser lights the court, then the partner scans: each seat's check-in is a row — the
    /// seat's member as actor and subject, the organiser named, whether this scan lit the court.
    /// A booking with no seats writes none (its check-in is <c>court.activated</c>).
    /// </summary>
    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Each_seat_checked_in_at_the_box_is_on_the_record(bool seated)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"r17rec{seated}");
        var c = r.Club;
        var booking = seated ? (await GameAsync(r, 1)).Booking : await c.BookAsync(r.App, c.Olga, courtIndex: 0, startsInMinutes: 2);

        Assert.Equal(HttpStatusCode.OK, (await r.App.CreateClient().SendAsync(c.Activate(c.Code(c.Olga)))).StatusCode);
        var pam = await MemberCodeClub.JsonAsync(await r.App.CreateClient().SendAsync(c.Activate(c.Code(c.Pam))));

        var rows = await AuditsAsync(r, CheckedIn);
        if (!seated)
        {
            Assert.Empty(rows);
            Assert.False(pam.GetProperty("activated").GetBoolean());   // not her game
            return;
        }
        Assert.Equal(2, rows.Count);
        var seats = await SeatsAsync(r, booking.Id);
        foreach (var (who, lit) in new[] { (c.Olga, true), (c.Pam, false) })
        {
            var row = Assert.Single(rows, a => a.SubjectUserId == who);
            Assert.Equal(who, row.ActorUserId);
            Assert.Equal(seats.Single(s => s.UserId == who).CheckedInAt, row.ScanAt);
            var d = Details(row);
            Assert.Equal(booking.Id, d.GetProperty("booking_id").GetGuid());
            Assert.Equal(seats.Single(s => s.UserId == who).Id, d.GetProperty("participant_id").GetGuid());
            Assert.Equal(c.Olga, d.GetProperty("organiser_user_id").GetGuid());
            Assert.Equal(1, d.GetProperty("court_number").GetInt32());
            Assert.Equal("qr", d.GetProperty("method").GetString());
            Assert.Equal(lit, d.GetProperty("lit_court").GetBoolean());
            Assert.False(d.GetProperty("reversed_no_show").GetBoolean());
        }
    }

    /// <summary>A no-show reversed by the partner's uploaded scan: her seat's check-in is on the record, marked as the reversal.</summary>
    [SkippableFact]
    public async Task A_seat_checked_in_by_a_late_upload_that_reverses_a_no_show_is_on_the_record()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r17rev");
        var c = r.Club;
        var (booking, _) = await GameAsync(r, 1, startsInMinutes: -20);
        await c.WriteAsync(r.App, async db => (await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id)).Status = BookingStatus.NoShow);

        var answer = await r.App.CreateClient().SendAsync(c.Events(c.BoxMac, 1, "activation", 0, c.Code(c.Pam)));

        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        Assert.Equal(BookingStatus.Booked, (await BookingAsync(r, booking.Id)).Status);
        var row = Assert.Single(await AuditsAsync(r, CheckedIn));
        Assert.Equal(c.Pam, row.SubjectUserId);
        Assert.True(Details(row).GetProperty("reversed_no_show").GetBoolean());
        Assert.True(Details(row).GetProperty("lit_court").GetBoolean());
    }

    // ---- E17-6 / J17-7: the desk's cancel of a booking that is not open -------------------------------

    [SkippableTheory]
    [InlineData(BookingStatus.NoShow, "no_show")]
    [InlineData(BookingStatus.Completed, "completed")]
    public async Task The_desk_cancelling_a_settled_booking_is_409_not_cancellable_with_its_status(BookingStatus status, string word)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"r17nc{word[..2]}");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 2, startsInMinutes: -90, checkedIn: status == BookingStatus.Completed);
        await c.WriteAsync(r.App, async db => (await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id)).Status = status);
        var before = await c.BalanceAsync(r.App, c.Olga);

        var answer = await c.Member(r.App, c.AdminId, "admin").PostAsJsonAsync($"/api/v1/admin/bookings/{booking.Id}/cancel", new { reason = "Wrong court" });

        Assert.Equal(HttpStatusCode.Conflict, answer.StatusCode);
        var body = await MemberCodeClub.JsonAsync(answer);
        Assert.Equal("not_cancellable", body.GetProperty("error").GetString());
        Assert.Equal(word, body.GetProperty("status").GetString());
        Assert.Equal(status, (await BookingAsync(r, booking.Id)).Status);
        Assert.Equal(before, await c.BalanceAsync(r.App, c.Olga));
        Assert.Equal(0, await ChangeRecordsAsync(r));
    }

    /// <summary>Already cancelled: the desk reads 409 booking_not_open (the split and add routes' word) — R18 J18-8: and so does its member.</summary>
    [SkippableFact]
    public async Task Cancelling_a_cancelled_booking_is_409_booking_not_open_at_the_desk_and_for_its_member()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r17nopen");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 2, startsInMinutes: 300);
        Assert.Equal(HttpStatusCode.OK, (await c.Member(r.App, c.Olga).PostAsJsonAsync($"/api/v1/bookings/{booking.Id}/cancel", new { })).StatusCode);
        var balance = await c.BalanceAsync(r.App, c.Olga);

        var desk = await c.Member(r.App, c.AdminId, "admin").PostAsJsonAsync($"/api/v1/admin/bookings/{booking.Id}/cancel", new { reason = "Tidy up" });
        var member = await c.Member(r.App, c.Olga).PostAsJsonAsync($"/api/v1/bookings/{booking.Id}/cancel", new { });

        Assert.Equal(HttpStatusCode.Conflict, desk.StatusCode);
        Assert.Equal("""{"error":"booking_not_open"}""", await desk.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.Conflict, member.StatusCode);
        Assert.Equal("""{"error":"booking_not_open"}""", await member.Content.ReadAsStringAsync());
        Assert.Equal(balance, await c.BalanceAsync(r.App, c.Olga));
        Assert.Single(await RowsOfAsync(r, booking.Id), l => l.Type == LedgerEntryType.CancellationRefund);
    }

    /// <summary>
    /// The desk's cancel loses its booking to a member's own cancel committed just before it: decided
    /// again, 409 booking_not_open — never "not found" for a booking on the desk's screen, never a 500.
    /// </summary>
    [SkippableFact]
    public async Task A_desk_cancel_that_loses_the_row_to_a_cancel_is_decided_again_as_booking_not_open()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r17cnrace");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 2, startsInMinutes: 300);
        var before = await c.BalanceAsync(r.App, c.Olga);
        r.Winner.Arm("UPDATE bookings SET",
            $"""UPDATE bookings SET "Version" = "Version" + 1, "Status" = 1, "CancelledAt" = now() WHERE "Id" = '{booking.Id}'""", 1);

        var answer = await c.Member(r.App, c.AdminId, "admin").PostAsJsonAsync($"/api/v1/admin/bookings/{booking.Id}/cancel", new { reason = "Court closed" });

        Assert.Equal(1, r.Winner.Won);
        Assert.Equal(HttpStatusCode.Conflict, answer.StatusCode);
        Assert.Equal("""{"error":"booking_not_open"}""", await answer.Content.ReadAsStringAsync());
        Assert.Equal(before, await c.BalanceAsync(r.App, c.Olga));   // the winner here moved no money; neither did we
        Assert.Empty(await AuditsAsync(r, "booking.cancelled"));
        Assert.Equal(0, await ChangeRecordsAsync(r));
    }

    /// <summary>The booking's Version moves under a cancel once, twice: cancelled once, refunded exactly once, recorded once.</summary>
    [SkippableTheory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task A_cancel_that_loses_the_booking_row_is_decided_again_and_refunds_once(int times)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"r17cnver{times}");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 2, startsInMinutes: 300);
        var before = await c.BalanceAsync(r.App, c.Olga);
        r.Winner.Arm("UPDATE bookings SET", $"""UPDATE bookings SET "Version" = "Version" + 1 WHERE "Id" = '{booking.Id}'""", times);

        var answer = await c.Member(r.App, c.AdminId, "admin").PostAsJsonAsync($"/api/v1/admin/bookings/{booking.Id}/cancel", new { reason = "Court closed" });

        Assert.Equal(times, r.Winner.Won);
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        Assert.Equal(60, (await MemberCodeClub.JsonAsync(answer)).GetProperty("refunded_minutes").GetInt32());
        Assert.Equal(before + 60, await c.BalanceAsync(r.App, c.Olga));
        Assert.Single(await RowsOfAsync(r, booking.Id), l => l.Type == LedgerEntryType.CancellationRefund);
        Assert.Single(await AuditsAsync(r, "booking.cancelled"));
        Assert.Equal(1, await ChangeRecordsAsync(r));
    }

    /// <summary>Two desks (or a double-tap) cancel at once: one cancels, the other is told it is no longer open; money once.</summary>
    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Two_cancels_at_once_refund_exactly_once(bool desk)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"r17cnpar{desk}");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 3, startsInMinutes: 300);
        var before = await c.BalanceAsync(r.App, c.Olga);

        var answers = await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => desk
            ? c.Member(r.App, c.AdminId, "admin").PostAsJsonAsync($"/api/v1/admin/bookings/{booking.Id}/cancel", new { reason = "Court closed" })
            : c.Member(r.App, c.Olga).PostAsJsonAsync($"/api/v1/bookings/{booking.Id}/cancel", new { })));

        var codes = answers.Select(a => a.StatusCode).Order().ToList();
        // R18 J18-8: the member's losing twin says why too (409 booking_not_open), as the desk's does.
        Assert.Equal([HttpStatusCode.OK, HttpStatusCode.Conflict], codes);
        Assert.Equal(before + 60, await c.BalanceAsync(r.App, c.Olga));
        Assert.Single(await RowsOfAsync(r, booking.Id), l => l.Type == LedgerEntryType.CancellationRefund);
        Assert.Single(await AuditsAsync(r, "booking.cancelled"));
        Assert.Equal(desk ? 1 : 0, await ChangeRecordsAsync(r));
    }

    private static Task<int> ChangeRecordsAsync(Rig r) =>
        r.Club.ReadAsync(r.App, db => db.AdminChangeLogs.IgnoreQueryFilters()
            .CountAsync(l => l.TenantId == r.Club.TenantId && l.Action == AdminChangeActions.BookingCancelledByAdmin));

    // ---- E17-7: what the desk's cancel did, on its change record and its audit row ---------------------

    /// <summary>
    /// A future booking cancelled outside the penalty window (nothing to waive), and a started one a
    /// partner checked in to: the change record says the refund, the penalty, the waiver, whether it had
    /// started and who had checked in; the audit row keeps the desk's words as <c>reason</c>, and
    /// <c>waive_reason</c> only when a penalty was waived.
    /// </summary>
    [SkippableTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task The_desk_cancels_change_record_says_what_the_cancellation_did(bool started)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"r17cr{started}");
        var c = r.Club;
        Booking booking;
        if (started)
        {
            (booking, _) = await GameAsync(r, 1);
            Assert.Equal(HttpStatusCode.OK, (await r.App.CreateClient().SendAsync(c.Activate(c.Code(c.Pam)))).StatusCode);
        }
        else
        {
            booking = await c.BookAsync(r.App, c.Olga, courtIndex: 2, startsInMinutes: 300);
        }

        var answer = await c.Member(r.App, c.AdminId, "admin").PostAsJsonAsync(
            $"/api/v1/admin/bookings/{booking.Id}/cancel", new { reason = "Court flooded", waivePenalty = true });

        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        var record = await c.ReadAsync(r.App, db => db.AdminChangeLogs.IgnoreQueryFilters().AsNoTracking()
            .SingleAsync(l => l.TenantId == c.TenantId && l.Action == AdminChangeActions.BookingCancelledByAdmin));
        var after = JsonDocument.Parse(record.AfterJson!).RootElement;
        Assert.Equal("cancelled", after.GetProperty("status").GetString());
        Assert.Equal(started ? 0 : 60, after.GetProperty("refunded_minutes").GetInt32());
        Assert.Equal(0, after.GetProperty("penalty_minutes").GetInt32());
        Assert.False(after.GetProperty("penalty_waived").GetBoolean());
        Assert.Equal(started, after.GetProperty("started").GetBoolean());
        if (started)
        {
            Assert.Equal(c.Pam, after.GetProperty("checked_in_by").GetProperty("user_id").GetGuid());
            Assert.Equal("Pam Payer", after.GetProperty("checked_in_by").GetProperty("name").GetString());
            Assert.NotEqual(JsonValueKind.Null, after.GetProperty("checked_in_at").ValueKind);
        }
        else
        {
            Assert.Equal(JsonValueKind.Null, after.GetProperty("checked_in_by").ValueKind);
        }

        var audit = Details(Assert.Single(await AuditsAsync(r, "booking.cancelled")));
        Assert.Equal("Court flooded", audit.GetProperty("reason").GetString());
        Assert.False(audit.GetProperty("waived").GetBoolean());
        Assert.Equal(JsonValueKind.Null, audit.GetProperty("waive_reason").ValueKind);
    }

    /// <summary>Inside the penalty window with the waiver ticked: the penalty waived, the reason under both keys.</summary>
    [SkippableFact]
    public async Task A_waived_penalty_keeps_its_reason_as_waive_reason_too()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r17crw");
        var c = r.Club;
        var booking = await c.BookAsync(r.App, c.Olga, courtIndex: 2, startsInMinutes: 5);

        var answer = await c.Member(r.App, c.AdminId, "admin").PostAsJsonAsync(
            $"/api/v1/admin/bookings/{booking.Id}/cancel", new { reason = "Our fault", waivePenalty = true });

        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        var audit = Details(Assert.Single(await AuditsAsync(r, "booking.cancelled")));
        Assert.True(audit.GetProperty("waived").GetBoolean());
        Assert.Equal("Our fault", audit.GetProperty("reason").GetString());
        Assert.Equal("Our fault", audit.GetProperty("waive_reason").GetString());
        var record = await c.ReadAsync(r.App, db => db.AdminChangeLogs.IgnoreQueryFilters().AsNoTracking()
            .SingleAsync(l => l.TenantId == c.TenantId && l.Action == AdminChangeActions.BookingCancelledByAdmin));
        var after = JsonDocument.Parse(record.AfterJson!).RootElement;
        Assert.True(after.GetProperty("penalty_waived").GetBoolean());
        Assert.Equal(60, after.GetProperty("refunded_minutes").GetInt32());
    }

    // ---- J17-6: a desk movement's replay quotes its own balances ---------------------------------------

    /// <summary>
    /// The double-click, both clicks in flight together: one posts, the other replays — and both quote
    /// the same before/after, the pair the movement actually moved between. Posted once.
    /// </summary>
    [SkippableFact]
    public async Task A_raced_duplicate_desk_movement_answers_the_twins_own_balances()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r17dup");
        var c = r.Club;
        var start = await c.BalanceAsync(r.App, c.Pam);

        for (var round = 0; round < 4; round++)
        {
            var key = $"r17-dup-{round}";
            var answers = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => c.Member(r.App, c.AdminId, "admin")
                .PostAsJsonAsync($"/api/v1/admin/minutes/{c.Pam}/adjust", new { amountMinutes = 11, reason = "Goodwill", reasonCode = "goodwill", idempotencyKey = key })));
            var expected = start + (11 * round);
            foreach (var answer in answers)
            {
                Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
                var body = await MemberCodeClub.JsonAsync(answer);
                Assert.Equal(expected, body.GetProperty("balance_before_minutes").GetInt32());
                Assert.Equal(expected + 11, body.GetProperty("balance_after_minutes").GetInt32());
            }
        }
        Assert.Equal(start + 44, await c.BalanceAsync(r.App, c.Pam));
    }

    /// <summary>A replay after the wallet moved again still quotes the movement's own pair, not today's balance.</summary>
    [SkippableFact]
    public async Task A_replayed_desk_movement_quotes_the_pair_it_moved_between_after_the_wallet_moved_on()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync("r17replay");
        var c = r.Club;
        var admin = c.Member(r.App, c.AdminId, "admin");
        var start = await c.BalanceAsync(r.App, c.Pam);
        object Body(int minutes, string key) => new { amountMinutes = minutes, reason = "Goodwill", reasonCode = "goodwill", idempotencyKey = key };

        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"/api/v1/admin/minutes/{c.Pam}/adjust", Body(11, "r17-a"))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync($"/api/v1/admin/minutes/{c.Pam}/adjust", Body(5, "r17-b"))).StatusCode);
        var replay = await MemberCodeClub.JsonAsync(await admin.PostAsJsonAsync($"/api/v1/admin/minutes/{c.Pam}/adjust", Body(11, "r17-a")));

        Assert.Equal(start, replay.GetProperty("balance_before_minutes").GetInt32());
        Assert.Equal(start + 11, replay.GetProperty("balance_after_minutes").GetInt32());
        Assert.Equal(start + 16, await c.BalanceAsync(r.App, c.Pam));
    }

    // ---- E17-1: a desk-made booking's charge frame names the club, the court and the day ---------------

    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_booking_charge_frame_names_the_club_when_the_desk_made_it(bool desk)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"r17frm{desk}", MemberCodeClub.SettingsAtNoon());
        var c = r.Club;
        var wallet = r.App.Services.GetRequiredService<Crusaders.Mainframe.Api.Services.Realtime.IRealtimeBus>()
            .Subscribe(Crusaders.Mainframe.Api.Services.Realtime.RealtimeTopic.Wallet(c.TenantId, c.Pam));
        var at = DateTimeOffset.UtcNow.AddHours(3);
        var startsAt = new DateTimeOffset(at.Year, at.Month, at.Day, at.Hour, 0, 0, TimeSpan.Zero);

        var answer = desk
            ? await c.Member(r.App, c.AdminId, "admin").PostAsJsonAsync("/api/v1/admin/bookings/", new { courtId = c.Courts[1], userId = c.Pam, startsAt, sliceCount = 2 })
            : await c.Member(r.App, c.Pam).PostAsJsonAsync("/api/v1/bookings/", new { courtId = c.Courts[1], startsAt, sliceCount = 2 });

        Assert.True(answer.IsSuccessStatusCode, $"{(int)answer.StatusCode}: {await answer.Content.ReadAsStringAsync()}");
        var frames = new List<JsonElement>();
        while (wallet.Reader.TryRead(out var m))
        {
            if (m.Event == LedgerService.BalanceEvent) frames.Add(JsonDocument.Parse(m.JsonPayload).RootElement.Clone());
        }
        var frame = Assert.Single(frames, f => f.GetProperty("reason").GetString() == "booking_charge");
        Assert.Equal(-30, frame.GetProperty("delta_minutes").GetInt32());
        Assert.Equal("Court 2", frame.GetProperty("court_name").GetString());
        Assert.Equal(startsAt, frame.GetProperty("booking_starts_at").GetDateTimeOffset());
        if (desk) Assert.Equal("The club", frame.GetProperty("actor_name").GetString());
        else Assert.Equal(JsonValueKind.Null, frame.GetProperty("actor_name").ValueKind);
    }

    // ---- E17-9 (BE17c's ask): the scanner's own frame says it was their scan -------------------------

    /// <summary>
    /// A no-show reversed by a late upload: the organiser's reversal frame says <c>checked_in_by_you</c>
    /// when the scan was theirs, and names the partner (<c>checked_in_by_name</c>) when it was hers.
    /// </summary>
    [SkippableTheory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_reversal_frame_tells_the_scanner_it_was_their_own_scan(bool ownScan)
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        await using var r = await RigAsync($"r17you{ownScan}");
        var c = r.Club;
        var (booking, _) = await GameAsync(r, 1, startsInMinutes: -10);
        await new Crusaders.Mainframe.Api.Webhooks.NoShowWorker(r.App.Services, r.App.Services.GetRequiredService<Crusaders.Mainframe.Api.Webhooks.IEventBus>(),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<Crusaders.Mainframe.Api.Webhooks.NoShowWorker>.Instance).TickAsync(default);
        Assert.Equal(BookingStatus.NoShow, (await BookingAsync(r, booking.Id)).Status);
        var wallet = r.App.Services.GetRequiredService<Crusaders.Mainframe.Api.Services.Realtime.IRealtimeBus>()
            .Subscribe(Crusaders.Mainframe.Api.Services.Realtime.RealtimeTopic.Wallet(c.TenantId, c.Olga));

        var answer = await r.App.CreateClient().SendAsync(c.Events(c.BoxMac, 1, "activation", 0, c.Code(ownScan ? c.Olga : c.Pam)));

        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        Assert.Equal(BookingStatus.Booked, (await BookingAsync(r, booking.Id)).Status);
        var frames = new List<JsonElement>();
        while (wallet.Reader.TryRead(out var m))
        {
            if (m.Event == LedgerService.BalanceEvent) frames.Add(JsonDocument.Parse(m.JsonPayload).RootElement.Clone());
        }
        var frame = Assert.Single(frames, f => f.GetProperty("delta_minutes").GetInt32() != 0);
        Assert.Equal(ownScan, frame.GetProperty("checked_in_by_you").GetBoolean());
        if (ownScan) Assert.Equal(JsonValueKind.Null, frame.GetProperty("checked_in_by_name").ValueKind);
        else Assert.Equal("Pam Payer", frame.GetProperty("checked_in_by_name").GetString());
    }

    // ---- The other writer ------------------------------------------------------------------------------

    /// <summary>
    /// Just before the first <c>times</c> commands carrying <c>marker</c> run, commits <c>sql</c> on a
    /// connection of its own — another request winning the row — so the command that follows matches no
    /// row under its concurrency token, exactly as a real loser's does.
    /// </summary>
    private sealed class OtherWriter(string connectionString) : DbCommandInterceptor
    {
        private readonly Lock _gate = new();
        private string? _marker;
        private string? _sql;
        private int _times;
        private int _won;

        public int Won
        {
            get
            {
                lock (_gate) return _won;
            }
        }

        public void Arm(string marker, string sql, int times)
        {
            lock (_gate) (_marker, _sql, _times) = (marker, sql, times);
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
            string sql;
            lock (_gate)
            {
                if (_marker is null || _won >= _times || !command.CommandText.Contains(_marker, StringComparison.Ordinal)) return;
                _won++;
                sql = _sql!;
            }
            await using var connection = new NpgsqlConnection(connectionString);
            await connection.OpenAsync();
            await using var winner = new NpgsqlCommand(sql, connection);
            await winner.ExecuteNonQueryAsync();
        }
    }
}
