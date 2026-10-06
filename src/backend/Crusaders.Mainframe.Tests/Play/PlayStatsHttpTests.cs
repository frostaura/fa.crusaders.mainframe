using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// Personal stats on Postgres (<c>docs/specs/play.md</c> §1, §5.1, §6.2): what counts as attended,
/// played minutes as the row stands, confirmed results only, partners, opponents and form.
/// </summary>
public sealed class PlayStatsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    [SkippableFact]
    public async Task A_member_with_nothing_reads_zeros_and_empty_lists_never_a_404()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "ps-empty");
        var me = await MyGameAsync(club.Client(f, club.Bystander));

        Assert.Equal(0, me.GetProperty("stats").GetProperty("sessions_attended").GetInt32());
        Assert.Equal(System.Text.Json.JsonValueKind.Null, me.GetProperty("stats").GetProperty("win_rate_percent").ValueKind);
        Assert.Equal(System.Text.Json.JsonValueKind.Null, me.GetProperty("ring").ValueKind);
        Assert.Equal(0, me.GetProperty("partners").GetArrayLength());
        Assert.Equal(0, me.GetProperty("form").GetArrayLength());
        Assert.Equal(12, me.GetProperty("badges").GetArrayLength());
        Assert.All(me.GetProperty("badges").EnumerateArray(), b => Assert.False(b.GetProperty("earned").GetBoolean()));
        Assert.Equal(12, me.GetProperty("streak").GetProperty("weeks").GetArrayLength());
        Assert.Equal("pending", me.GetProperty("streak").GetProperty("this_week").GetString());
        Assert.Equal("UTC", me.GetProperty("timezone").GetString());
        Assert.True(me.GetProperty("settings").GetProperty("celebrations_enabled").GetBoolean());
    }

    /// <summary>
    /// One scan lights the court for everybody: a partner who walked in behind attended by the
    /// booking's check-in; a member who scanned their own seat attended whatever the seat is now;
    /// an invited (not accepted) member who never scanned did not; a door scan is not attendance.
    /// </summary>
    [SkippableFact]
    public async Task Attendance_is_the_members_own_scan_or_the_bookings_check_in_as_a_player()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "ps-attend");
        var start = DateTimeOffset.UtcNow.AddDays(-3).Storable();

        var shared = await club.GameAsync(f, start, club.Organiser, [club.Sam]);
        await club.InsertSeatAsync(f, shared, 3, club.Jo, ParticipantStatus.Invited, 0);

        // Alex scanned his own seat on a booking the box never marked, then withdrew.
        var own = await club.GameAsync(f, start.AddDays(1), club.Organiser, [club.Alex], checkIn: false);
        await club.WriteAsync(f, db =>
        {
            var seat = db.BookingParticipants.IgnoreQueryFilters().First(p => p.BookingId == own && p.UserId == club.Alex);
            seat.CheckedInAt = start.AddDays(1).AddMinutes(3);
            seat.Status = ParticipantStatus.Withdrawn;
        });

        // A door scan is not attendance: an audit row for the gate, and no check-in on the booking.
        var door = await club.GameAsync(f, start.AddDays(2), club.Bystander, [], checkIn: false);
        await club.WriteAsync(f, db => db.AuditLogs.Add(new AuditLog
        {
            TenantId = club.TenantId, ActorUserId = club.Bystander, SubjectUserId = club.Bystander, Action = "gate.opened",
            DetailsJson = $$"""{"booking_id":"{{door}}"}""",
        }));

        async Task<int> Sessions(Guid u) => (await MyGameAsync(club.Client(f, u))).GetProperty("stats").GetProperty("sessions_attended").GetInt32();
        Assert.Equal(1, await Sessions(club.Organiser)); // the box never saw Alex's booking, and the organiser did not scan it
        Assert.Equal(1, await Sessions(club.Sam));
        Assert.Equal(0, await Sessions(club.Jo));
        Assert.Equal(1, await Sessions(club.Alex));
        Assert.Equal(0, await Sessions(club.Bystander));
    }

    [SkippableFact]
    public async Task Played_minutes_come_from_the_row_as_it_stands_after_a_release_and_a_cancelled_session_is_not_attended()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "ps-minutes");
        var start = new DateTimeOffset(DateTimeOffset.UtcNow.Year, 1, 5, 10, 0, 0, TimeSpan.Zero);

        var released = await club.GameAsync(f, start, club.Organiser, [club.Sam]);
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == released).EndsAt = start.AddMinutes(37));
        var cancelled = await club.GameAsync(f, start.AddDays(1), club.Organiser, [club.Sam]);
        await club.WriteAsync(f, db =>
        {
            var b = db.Bookings.IgnoreQueryFilters().First(x => x.Id == cancelled);
            b.Status = BookingStatus.Cancelled;
            b.CancelledAt = start.AddDays(1).AddMinutes(20).AddSeconds(50);
        });
        await club.GameAsync(f, start.AddYears(-1), club.Organiser, [club.Sam]);

        var stats = (await MyGameAsync(club.Client(f, club.Sam))).GetProperty("stats");
        // An untouched game is PlayersClub's 4 slices of 8 minutes (P13: the fixture runs on 8-minute slices).
        // R17 J17-5: one definition of attended — a session the club cancelled after its check-in is not
        // one (it was 37 + 20 + 32 and 3 sessions before), on every figure alike.
        Assert.Equal(37 + 32, stats.GetProperty("minutes_on_court").GetInt32());
        Assert.Equal(37, stats.GetProperty("minutes_this_year").GetInt32());
        Assert.Equal(2, stats.GetProperty("sessions_attended").GetInt32());
    }

    [SkippableFact]
    public async Task Confirmed_results_make_the_record_and_a_void_drops_it_at_once()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "ps-record");
        var olive = club.Client(f, club.Organiser);
        var sam = club.Client(f, club.Sam);
        var start = DateTimeOffset.UtcNow.AddHours(-30).Storable();

        async Task<Guid> Played(int hoursLater, object[] games, bool confirm = true)
        {
            var b = await club.GameAsync(f, start.AddHours(hoursLater), club.Organiser, [club.Sam]);
            var body = await (await RecordAsync(olive, b, [U(club.Organiser)], [U(club.Sam)], games)).JsonAsync();
            if (confirm) await ActAsync(sam, b, "confirm", body.GetProperty("version").GetInt32());
            return body.GetProperty("result_id").GetGuid();
        }

        await Played(0, ThreeOne);                                    // Olive 3–1
        await Played(2, G((5, 11), (7, 11), (9, 11)));                // Sam 3–0
        var third = await Played(4, G((11, 1), (11, 2), (11, 3)));    // Olive 3–0
        await Played(6, ThreeOne, confirm: false);                    // pending: counts for nothing

        var s = (await MyGameAsync(olive)).GetProperty("stats");
        Assert.Equal((3, 2, 1, 6, 4, 67), (s.GetProperty("matches_played").GetInt32(), s.GetProperty("matches_won").GetInt32(),
            s.GetProperty("matches_lost").GetInt32(), s.GetProperty("games_won").GetInt32(), s.GetProperty("games_lost").GetInt32(),
            s.GetProperty("win_rate_percent").GetInt32()));
        var form = (await MyGameAsync(olive)).GetProperty("form").EnumerateArray().Select(x => x.GetProperty("outcome").GetString()).ToList();
        Assert.Equal(["won", "lost", "won"], form);
        var opponent = Assert.Single((await MyGameAsync(olive)).GetProperty("opponents").EnumerateArray());
        Assert.Equal((club.Sam, 3, 2, 1), (opponent.GetProperty("user_id").GetGuid(), opponent.GetProperty("matches").GetInt32(),
            opponent.GetProperty("won").GetInt32(), opponent.GetProperty("lost").GetInt32()));
        Assert.Equal("Sam Partner", opponent.GetProperty("name").GetString());

        var voided = await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/play/results/{third}/void", new { reason = "wrong game" });
        Assert.True(voided.IsSuccessStatusCode);
        s = (await MyGameAsync(olive)).GetProperty("stats");
        Assert.Equal((2, 1, 1), (s.GetProperty("matches_played").GetInt32(), s.GetProperty("matches_won").GetInt32(), s.GetProperty("matches_lost").GetInt32()));
        Assert.Equal(1, (await MyGameAsync(sam)).GetProperty("stats").GetProperty("matches_won").GetInt32());
    }

    [SkippableFact]
    public async Task Partners_are_the_top_three_members_by_shared_sessions_ties_to_the_most_recent()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "ps-partners");
        var start = DateTimeOffset.UtcNow.AddDays(-20).Storable();
        await club.GameAsync(f, start, club.Organiser, [club.Sam, club.Alex]);
        await club.GameAsync(f, start.AddDays(1), club.Organiser, [club.Sam]);
        await club.GameAsync(f, start.AddDays(2), club.Organiser, [club.Jo]);
        await club.GameAsync(f, start.AddDays(3), club.Organiser, [club.Bystander]);

        var partners = (await MyGameAsync(club.Client(f, club.Organiser))).GetProperty("partners").EnumerateArray()
            .Select(p => (p.GetProperty("user_id").GetGuid(), p.GetProperty("sessions").GetInt32())).ToList();
        Assert.Equal([(club.Sam, 2), (club.Bystander, 1), (club.Jo, 1)], partners);

        var badges = (await MyGameAsync(club.Client(f, club.Organiser))).GetProperty("badges").EnumerateArray()
            .ToDictionary(b => b.GetProperty("key").GetString()!);
        var progress = badges[BadgeCatalogue.Partners5].GetProperty("progress");
        Assert.Equal((4, 5), (progress.GetProperty("value").GetInt32(), progress.GetProperty("target").GetInt32()));
        Assert.Equal(System.Text.Json.JsonValueKind.Null, badges[BadgeCatalogue.EarlyBird].GetProperty("progress").ValueKind);
    }

    [SkippableFact]
    public async Task My_results_pages_the_live_results_newest_first_with_court_and_start()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "ps-list");
        var olive = club.Client(f, club.Organiser);
        var start = DateTimeOffset.UtcNow.AddHours(-20).Storable();
        var ids = new List<Guid>();
        for (var i = 0; i < 3; i++)
        {
            var b = await club.GameAsync(f, start.AddHours(i * 2), club.Organiser, [club.Sam]);
            ids.Add((await (await RecordAsync(olive, b, [U(club.Organiser)], [U(club.Sam)])).JsonAsync()).GetProperty("result_id").GetGuid());
        }
        var withdrawnBooking = await club.GameAsync(f, start.AddHours(8), club.Organiser, [club.Sam]);
        var w = await (await RecordAsync(olive, withdrawnBooking, [U(club.Organiser)], [U(club.Sam)])).JsonAsync();
        await ActAsync(olive, withdrawnBooking, "withdraw", w.GetProperty("version").GetInt32());

        var page1 = await (await olive.GetAsync("/api/v1/me/play/results?limit=2")).JsonAsync();
        Assert.Equal([ids[2], ids[1]], page1.GetProperty("items").EnumerateArray().Select(x => x.GetProperty("result_id").GetGuid()));
        Assert.Equal("Court 1", page1.GetProperty("items")[0].GetProperty("court_name").GetString());
        var cursor = page1.GetProperty("next_cursor").GetString();
        var page2 = await (await olive.GetAsync($"/api/v1/me/play/results?limit=2&cursor={cursor}")).JsonAsync();
        Assert.Equal([ids[0]], page2.GetProperty("items").EnumerateArray().Select(x => x.GetProperty("result_id").GetGuid()));
        Assert.Equal(System.Text.Json.JsonValueKind.Null, page2.GetProperty("next_cursor").ValueKind);
        Assert.Equal(System.Net.HttpStatusCode.BadRequest, (await olive.GetAsync("/api/v1/me/play/results?limit=51")).StatusCode);
    }
}
