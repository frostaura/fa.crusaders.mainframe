using System.Net;
using System.Net.Http.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// Badges and celebrations on Postgres (<c>docs/specs/play.md</c> §5.5–5.6, §7.2): the silent
/// retro-award and the loud fresh one, idempotence under concurrent evaluation, the catalogue
/// catch-up, the goal that cannot celebrate itself, celebrations switched off, acknowledgement,
/// and a badge that is never taken back.
/// </summary>
public sealed class PlayBadgesHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => pg.SharedHost;

    private static Task<PlayEvaluator.Evaluation> EvaluateAsync(PlayersClub club, TestWebAppFactory f, Guid user) =>
        club.InClubAsync(f, sp => sp.GetRequiredService<PlayEvaluator>().EvaluateAsync(user, DateTimeOffset.UtcNow, default));

    [SkippableFact]
    public async Task An_old_history_is_awarded_silently_and_a_fresh_badge_is_celebrated_and_announced()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "bd-retro");
        // Noon, not "now minus 120 days": the history's time of day is the wall clock's, and from
        // 21:00 UTC it earned night owl retroactively — silently — so the fresh night owl below
        // had nothing left to celebrate (red 21:00–24:00 UTC, found by a synthetic-clock sweep).
        var start = new DateTimeOffset(DateTime.UtcNow.Date.AddDays(-120).AddHours(12), TimeSpan.Zero);
        for (var i = 0; i < 10; i++) await club.GameAsync(f, start.AddDays(i * 3), club.Organiser, [club.Sam]);

        await PlayKit.TickAsync(f, DateTimeOffset.UtcNow); // the catch-up: the first run from history
        var badges = await BadgesAsync(f, club.Sam);
        Assert.Contains(badges, b => b.BadgeKey == BadgeCatalogue.FirstSession && b.AwardedAt == start.AddMinutes(2));
        Assert.Contains(badges, b => b.BadgeKey == BadgeCatalogue.Sessions10 && b.AwardedAt == start.AddDays(27).AddMinutes(2));
        Assert.Empty(await CelebrationsAsync(f, club.Sam));
        Assert.Empty(await InboxAsync(f, club.Sam, MemberEventCatalogue.BadgeEarned));

        // A night-owl session yesterday is news.
        await club.GameAsync(f, new DateTimeOffset(DateTime.UtcNow.Date.AddDays(-1).AddHours(21), TimeSpan.Zero), club.Organiser, [club.Sam]);
        await EvaluateAsync(club, f, club.Sam);
        var celebration = Assert.Single(await CelebrationsAsync(f, club.Sam));
        Assert.Equal(("badge", "badge:night_owl", (DateTimeOffset?)null), (celebration.Kind, celebration.DedupeKey, celebration.SeenAt));
        var line = Assert.Single(await InboxAsync(f, club.Sam, MemberEventCatalogue.BadgeEarned));
        Assert.Equal("New badge: Night owl.", line.Headline);
        Assert.Equal("/profile#my-game", line.Link);

        var listed = await (await club.Client(f, club.Sam).GetAsync("/api/v1/me/play/celebrations")).JsonAsync();
        var item = Assert.Single(listed.GetProperty("items").EnumerateArray());
        Assert.Equal("Night owl", item.GetProperty("badge").GetProperty("name").GetString());
        var earned = (await MyGameAsync(club.Client(f, club.Sam))).GetProperty("badges").EnumerateArray().Single(b => b.GetProperty("key").GetString() == "sessions_10");
        Assert.True(earned.GetProperty("earned").GetBoolean());
    }

    [SkippableFact]
    public async Task Two_concurrent_evaluations_award_each_badge_once_and_celebrate_it_once()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "bd-race");
        // Yesterday noon rather than three hours ago: a session before 07:00 or from 21:00 club
        // time also earns early bird or night owl, a second celebration, and the Single()s below
        // went red from 00:00 to 10:00 UTC. Still well inside the fresh window.
        await club.GameAsync(f, new DateTimeOffset(DateTime.UtcNow.Date.AddDays(-1).AddHours(12), TimeSpan.Zero), club.Organiser, [club.Sam]);

        var runs = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => EvaluateAsync(club, f, club.Sam)));
        Assert.Single(await BadgesAsync(f, club.Sam), b => b.BadgeKey == BadgeCatalogue.FirstSession);
        Assert.Single(await CelebrationsAsync(f, club.Sam));
        Assert.Single(await InboxAsync(f, club.Sam, MemberEventCatalogue.BadgeEarned));
        Assert.Equal(1, runs.Sum(r => r.Awarded.Count));
    }

    [SkippableFact]
    public async Task A_profile_behind_the_catalogue_is_re_evaluated_and_a_current_one_is_left_alone()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "bd-version");
        await club.GameAsync(f, DateTimeOffset.UtcNow.AddDays(-40).Storable(), club.Organiser, [club.Sam]);
        await PlayKit.TickAsync(f, DateTimeOffset.UtcNow);
        var profile = await PlayersClub.ReadAsync(f, db => db.MemberPlayProfiles.IgnoreQueryFilters().FirstAsync(p => p.UserId == club.Sam));
        Assert.Equal(BadgeCatalogue.Version, profile.EvaluatorVersion);

        // Stale: an earlier catalogue. The badge rows are lost too, as if a new badge had been added.
        await club.WriteAsync(f, db => db.MemberPlayProfiles.IgnoreQueryFilters().First(p => p.UserId == club.Sam).EvaluatorVersion = 0);
        await PlayersClub.ReadAsync(f, db => db.MemberBadges.IgnoreQueryFilters().Where(b => b.UserId == club.Sam).ExecuteDeleteAsync());
        var caughtUp = await club.InClubAsync(f, sp => sp.GetRequiredService<PlaySweep>().CatchUpAsync(DateTimeOffset.UtcNow, default));
        Assert.Equal(1, caughtUp);
        Assert.Contains(await BadgesAsync(f, club.Sam), b => b.BadgeKey == BadgeCatalogue.FirstSession);
        Assert.Empty(await CelebrationsAsync(f, club.Sam)); // forty days old: silent
        Assert.Equal(0, await club.InClubAsync(f, sp => sp.GetRequiredService<PlaySweep>().CatchUpAsync(DateTimeOffset.UtcNow, default)));
    }

    [SkippableFact]
    public async Task A_goal_set_at_or_below_this_months_progress_celebrates_nothing()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "bd-goal");
        var sam = club.Client(f, club.Sam);
        var today = DateTimeOffset.UtcNow;
        var monthStart = new DateTimeOffset(today.Year, today.Month, 1, 0, 0, 0, TimeSpan.Zero);
        await club.GameAsync(f, (today.AddHours(-3) < monthStart ? monthStart : today.AddHours(-3)).Storable(), club.Organiser, [club.Sam]);

        Assert.Equal(HttpStatusCode.BadRequest, (await sam.PutAsJsonAsync("/api/v1/me/play/settings", new { monthlyGoalMinutes = 40 })).StatusCode);
        var tooSmall = await (await sam.PutAsJsonAsync("/api/v1/me/play/settings", new { monthlyGoalMinutes = 15 })).JsonAsync();
        Assert.Equal(("goal_out_of_range", 30, 6000, 15), (tooSmall.GetProperty("error").GetString(), tooSmall.GetProperty("min").GetInt32(),
            tooSmall.GetProperty("max").GetInt32(), tooSmall.GetProperty("step").GetInt32()));

        var set = await sam.PutAsJsonAsync("/api/v1/me/play/settings", new { monthlyGoalMinutes = 30 });
        Assert.Equal(HttpStatusCode.OK, set.StatusCode);
        Assert.Equal(30, (await set.JsonAsync()).GetProperty("monthly_goal_minutes").GetInt32());
        var goal = Assert.Single(await CelebrationsAsync(f, club.Sam), c => c.Kind == CelebrationKind.GoalReached);
        Assert.NotNull(goal.SeenAt);
        Assert.DoesNotContain((await (await sam.GetAsync("/api/v1/me/play/celebrations")).JsonAsync()).GetProperty("items").EnumerateArray(),
            c => c.GetProperty("kind").GetString() == "goal_reached");

        var ring = (await MyGameAsync(sam)).GetProperty("ring");
        // The game is PlayersClub's 4 slices of 8 minutes (P13), so 32 attended; the lowest goal (30) is at or below it.
        Assert.Equal((30, 32, 1, true), (ring.GetProperty("goal_minutes").GetInt32(), ring.GetProperty("attended_minutes").GetInt32(),
            ring.GetProperty("sessions").GetInt32(), ring.GetProperty("reached").GetBoolean()));

        // Absent leaves it; null removes it and the ring goes.
        await sam.PutAsJsonAsync("/api/v1/me/play/settings", new { celebrationsEnabled = true });
        Assert.Equal(30, (await MyGameAsync(sam)).GetProperty("settings").GetProperty("monthly_goal_minutes").GetInt32());
        await sam.PutAsJsonAsync("/api/v1/me/play/settings", new { monthlyGoalMinutes = (int?)null });
        Assert.Equal(System.Text.Json.JsonValueKind.Null, (await MyGameAsync(sam)).GetProperty("ring").ValueKind);
    }

    [SkippableFact]
    public async Task Reaching_a_goal_by_playing_is_celebrated_once_a_month()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "bd-goal2");
        var sam = club.Client(f, club.Sam);
        await sam.PutAsJsonAsync("/api/v1/me/play/settings", new { monthlyGoalMinutes = 30 });
        Assert.Empty(await CelebrationsAsync(f, club.Sam));

        var today = DateTimeOffset.UtcNow;
        var monthStart = new DateTimeOffset(today.Year, today.Month, 1, 0, 0, 0, TimeSpan.Zero);
        var at = (today.AddHours(-3) < monthStart ? monthStart : today.AddHours(-3)).Storable();
        await club.GameAsync(f, at, club.Organiser, [club.Sam]);
        await EvaluateAsync(club, f, club.Sam);
        await club.GameAsync(f, at.AddMinutes(-70) < monthStart ? at.AddMinutes(70) : at.AddMinutes(-70), club.Organiser, [club.Sam]);
        await EvaluateAsync(club, f, club.Sam);
        var goal = Assert.Single(await CelebrationsAsync(f, club.Sam), c => c.Kind == CelebrationKind.GoalReached);
        Assert.Null(goal.SeenAt);
        Assert.Equal($"goal:{today:yyyy-MM}", goal.DedupeKey);
    }

    [SkippableFact]
    public async Task With_celebrations_off_moments_are_written_already_seen()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "bd-quiet");
        var sam = club.Client(f, club.Sam);
        var off = await (await sam.PutAsJsonAsync("/api/v1/me/play/settings", new { celebrationsEnabled = false })).JsonAsync();
        Assert.False(off.GetProperty("celebrations_enabled").GetBoolean());

        await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-3).Storable(), club.Organiser, [club.Sam]);
        await EvaluateAsync(club, f, club.Sam);
        Assert.All(await CelebrationsAsync(f, club.Sam), c => Assert.NotNull(c.SeenAt));
        Assert.NotEmpty(await CelebrationsAsync(f, club.Sam));
        Assert.Empty((await (await sam.GetAsync("/api/v1/me/play/celebrations")).JsonAsync()).GetProperty("items").EnumerateArray());

        // Switching them back on replays nothing.
        await sam.PutAsJsonAsync("/api/v1/me/play/settings", new { celebrationsEnabled = true });
        Assert.Empty((await (await sam.GetAsync("/api/v1/me/play/celebrations")).JsonAsync()).GetProperty("items").EnumerateArray());
    }

    [SkippableFact]
    public async Task Acknowledging_is_idempotent_and_ignores_ids_that_are_not_the_callers()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "bd-seen");
        await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-3).Storable(), club.Organiser, [club.Sam]);
        await EvaluateAsync(club, f, club.Sam);
        await EvaluateAsync(club, f, club.Organiser);
        var mine = (await CelebrationsAsync(f, club.Sam)).Select(c => c.Id).ToList();
        var theirs = (await CelebrationsAsync(f, club.Organiser)).Select(c => c.Id).ToList();
        Assert.NotEmpty(mine);

        var sam = club.Client(f, club.Sam);
        var seen = await (await sam.PostAsJsonAsync("/api/v1/me/play/celebrations/seen", new { ids = mine.Concat(theirs) })).JsonAsync();
        Assert.Equal(mine.Count, seen.GetProperty("seen").GetInt32());
        Assert.Equal(0, (await (await sam.PostAsJsonAsync("/api/v1/me/play/celebrations/seen", new { ids = mine })).JsonAsync()).GetProperty("seen").GetInt32());
        Assert.All(await CelebrationsAsync(f, club.Organiser), c => Assert.Null(c.SeenAt));
        Assert.Equal(HttpStatusCode.BadRequest, (await sam.PostAsJsonAsync("/api/v1/me/play/celebrations/seen", new { ids = Array.Empty<Guid>() })).StatusCode);
    }

    /// <summary>The winner has "First win" by the time the confirmer's call returns (the hook), and a void never takes it back.</summary>
    [SkippableFact]
    public async Task A_confirmed_win_is_badged_at_once_and_a_void_takes_nothing_back()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "bd-win");
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-3).Storable(), club.Organiser, [club.Sam]);
        var created = await (await RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)])).JsonAsync();
        await ActAsync(club.Client(f, club.Sam), booking, "confirm", created.GetProperty("version").GetInt32());

        var olive = await BadgesAsync(f, club.Organiser);
        Assert.Contains(olive, b => b.BadgeKey == BadgeCatalogue.FirstWin);
        Assert.Contains(olive, b => b.BadgeKey == BadgeCatalogue.FirstResult);
        Assert.DoesNotContain(await BadgesAsync(f, club.Sam), b => b.BadgeKey == BadgeCatalogue.FirstWin);

        await club.Client(f, club.Admin, admin: true).PostAsJsonAsync($"/api/v1/admin/play/results/{created.GetProperty("result_id").GetGuid()}/void", new { reason = "wrong" });
        await PlayKit.TickAsync(f, DateTimeOffset.UtcNow);
        Assert.Contains(await BadgesAsync(f, club.Organiser), b => b.BadgeKey == BadgeCatalogue.FirstWin);
    }
}
