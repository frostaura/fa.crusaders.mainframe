using System.Globalization;
using System.Net;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// The weekly streak through real bookings and check-ins on Postgres (<c>docs/specs/play.md</c>
/// §5.2–5.4): a <c>Europe/London</c> club walking examples A and C at a stated instant, and the
/// injury pause's routes and refusals.
/// </summary>
public sealed class PlayStreakHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

    private static DateTimeOffset At(string s) => DateTimeOffset.Parse(s, CultureInfo.InvariantCulture);

    private static async Task<PlayRecord> RecordAtAsync(PlayersClub club, TestWebAppFactory f, Guid user, DateTimeOffset now) =>
        await club.InClubAsync(f, async sp => await PlayRecord.LoadAsync(
            sp.GetRequiredService<MainframeDbContext>(), await sp.GetRequiredService<TenantSettingsAccessor>().GetAsync(default), user, now, default));

    private static Task PauseAsync(PlayersClub club, TestWebAppFactory f, Guid user, DateTimeOffset from, DateTimeOffset? to) =>
        club.WriteAsync(f, db => db.MemberStreakPauses.Add(new MemberStreakPause
        {
            TenantId = club.TenantId, UserId = user, StartedAt = from, EndedAt = to, CreatedAt = from,
        }));

    /// <summary>
    /// Example A played for real in London: one session a week (19:00 local), the Sunday-night
    /// session of 25 Oct at 23:30Z that belongs to the week of 19 Oct, and the pause of 11–20 Nov.
    /// </summary>
    [SkippableFact]
    public async Task Example_A_walks_through_real_check_ins_in_a_London_club()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "st-london", timezone: "Europe/London");
        foreach (var monday in new[] { "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-12", "2026-10-26", "2026-11-02", "2026-12-07" })
        {
            await club.GameAsync(f, At($"{monday}T18:00:00Z").AddDays(1), club.Organiser, [club.Sam]);
        }
        await club.GameAsync(f, At("2026-10-25T23:30:00Z"), club.Organiser, [club.Sam]);
        await PauseAsync(club, f, club.Sam, At("2026-11-11T12:00:00Z"), At("2026-11-20T12:00:00Z"));

        var record = await RecordAtAsync(club, f, club.Sam, At("2026-12-08T12:00:00Z"));
        var states = record.Walk.Weeks.Select(w => (w.Week.ToString("MM-dd", CultureInfo.InvariantCulture), w.State, w.StreakAfter)).ToList();
        Assert.Equal(
            [
                ("09-07", "attended", 1), ("09-14", "attended", 2), ("09-21", "attended", 3), ("09-28", "attended", 4),
                ("10-05", "rest", 4), ("10-12", "attended", 5), ("10-19", "attended", 6), ("10-26", "attended", 7),
                ("11-02", "attended", 8), ("11-09", "paused", 8), ("11-16", "paused", 8), ("11-23", "rest", 8),
                ("11-30", "missed", 0), ("12-07", "attended", 1),
            ],
            states);
        Assert.Equal(2, record.Coverage.UsedIn(2026));

        // The organiser played the same weeks and paused nothing: 11-09 spends the rest week, 11-16 breaks.
        var olive = await RecordAtAsync(club, f, club.Organiser, At("2026-12-08T12:00:00Z"));
        Assert.Equal(1, olive.Walk.State.Streak);
        Assert.Equal(8, olive.Walk.State.Longest);

        var badges = BadgeRules.Qualified(record.BadgeInputs).Select(b => b.Key).ToList();
        Assert.Contains(BadgeCatalogue.Streak4, badges);
        Assert.DoesNotContain(BadgeCatalogue.Streak12, badges);
    }

    /// <summary>Example C in London: sessions on Sat 2 Jan 2027 and Mon 4 Jan 2027 are consecutive weeks; the allowance is the Monday's year.</summary>
    [SkippableFact]
    public async Task Example_C_the_new_year_week_and_the_pause_allowance_through_real_rows()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "st-newyear", timezone: "Europe/London");
        await club.GameAsync(f, At("2027-01-02T10:00:00Z"), club.Organiser, [club.Sam]);
        await club.GameAsync(f, At("2027-01-04T10:00:00Z"), club.Organiser, [club.Sam]);
        var olive = await RecordAtAsync(club, f, club.Organiser, At("2027-01-05T12:00:00Z"));
        Assert.Equal(2, olive.Walk.State.Streak);

        await PauseAsync(club, f, club.Jo, At("2026-06-02T09:00:00Z"), At("2026-07-15T09:00:00Z")); // weeks 06-01 … 07-13: seven
        await PauseAsync(club, f, club.Jo, At("2026-12-23T09:00:00Z"), null);
        var jo = await RecordAtAsync(club, f, club.Jo, At("2027-01-05T12:00:00Z"));
        Assert.Contains(new DateOnly(2026, 12, 21), jo.Coverage.Paused);
        Assert.DoesNotContain(new DateOnly(2026, 12, 28), jo.Coverage.Paused);
        Assert.Contains(new DateOnly(2027, 1, 4), jo.Coverage.Paused);
        Assert.Equal((8, 1), (jo.Coverage.UsedIn(2026), jo.Coverage.UsedIn(2027)));
    }

    [SkippableFact]
    public async Task The_pause_turns_on_and_off_and_refuses_twice_and_past_the_allowance()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "st-pause");
        var sam = club.Client(f, club.Sam);

        var on = await sam.PostAsync("/api/v1/me/play/pause", null);
        Assert.Equal(HttpStatusCode.OK, on.StatusCode);
        var pause = await on.JsonAsync();
        Assert.True(pause.GetProperty("active").GetBoolean());
        Assert.Equal(1, pause.GetProperty("weeks_used_this_year").GetInt32());
        Assert.Equal(8, pause.GetProperty("weeks_per_year").GetInt32());
        Assert.Equal("pause_active", (await (await sam.PostAsync("/api/v1/me/play/pause", null)).JsonAsync()).GetProperty("error").GetString());

        var off = await sam.DeleteAsync("/api/v1/me/play/pause");
        Assert.Equal(HttpStatusCode.OK, off.StatusCode);
        Assert.False((await off.JsonAsync()).GetProperty("active").GetBoolean());
        var again = await sam.DeleteAsync("/api/v1/me/play/pause");
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
        Assert.Equal("pause_not_active", (await again.JsonAsync()).GetProperty("error").GetString());
        Assert.True((await MyGameAsync(sam)).GetProperty("pause").GetProperty("weeks_used_this_year").GetInt32() >= 1);

        // Eight weeks already used this club year: no allowance left.
        var year = DateTimeOffset.UtcNow.Year;
        var jan = new DateTimeOffset(year, 1, 5, 9, 0, 0, TimeSpan.Zero);
        await PauseAsync(club, f, club.Jo, jan, jan.AddDays(7 * 8 - 3));
        var used = await club.Client(f, club.Jo).PostAsync("/api/v1/me/play/pause", null);
        Assert.Equal(HttpStatusCode.Conflict, used.StatusCode);
        var body = await used.JsonAsync();
        Assert.Equal(("pause_allowance_used", 8), (body.GetProperty("error").GetString(), body.GetProperty("weeks_per_year").GetInt32()));
    }

    [SkippableFact]
    public async Task With_pausing_off_the_pause_is_refused()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "st-nopause", "\"streak_pause_weeks_per_year\":0");
        var refused = await club.Client(f, club.Sam).PostAsync("/api/v1/me/play/pause", null);
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        Assert.Equal(0, (await refused.JsonAsync()).GetProperty("weeks_per_year").GetInt32());
        Assert.Equal(0, await PlayersClub.ReadAsync(f, db => db.MemberStreakPauses.IgnoreQueryFilters().CountAsync(p => p.UserId == club.Sam)));
    }
}
