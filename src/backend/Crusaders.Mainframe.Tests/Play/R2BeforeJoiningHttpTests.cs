using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// Review round 2, F2-16: the streak strip drew the weeks before a member joined as "missed" — a
/// new member's first look at My game was a row of failures they could not have avoided. An
/// unwalked week before the member joined (their approval, else the membership's creation) is
/// <c>before_joining</c>; a week they missed after joining is still <c>missed</c>.
/// </summary>
public sealed class R2BeforeJoiningHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

    [SkippableFact]
    public async Task Weeks_before_the_member_joined_are_before_joining_and_weeks_after_are_missed()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "r2joined");
        var now = DateTimeOffset.UtcNow;
        // Joined five weeks ago: the approval is the audit trail's.
        await club.WriteAsync(f, db => db.AuditLogs.Add(new AuditLog
        {
            TenantId = club.TenantId, ActorUserId = club.Admin, SubjectUserId = club.Sam, Action = "member.approved", CreatedAt = now.AddDays(-35),
        }));

        var play = await (await club.Client(f, club.Sam).GetAsync("/api/v1/me/play")).Content.ReadFromJsonAsync<JsonElement>();
        var weeks = play.GetProperty("streak").GetProperty("weeks").EnumerateArray()
            .Select(w => (DateOnly.Parse(w.GetProperty("week_start").GetString()!), w.GetProperty("state").GetString())).ToList();
        var joinedWeek = ClubWeek.KeyOf(TimeZoneInfo.Utc, now.AddDays(-35));

        Assert.All(weeks.Where(w => w.Item1 < joinedWeek), w => Assert.Equal(WeekStates.BeforeJoining, w.Item2));
        Assert.All(weeks.Where(w => w.Item1 >= joinedWeek && w.Item1 < weeks[^1].Item1), w => Assert.Equal(WeekStates.Missed, w.Item2));
        Assert.Contains(weeks, w => w.Item2 == WeekStates.BeforeJoining);
        Assert.Contains(weeks, w => w.Item2 == WeekStates.Missed);
    }

    [Fact]
    public void An_attended_week_is_never_before_joining_and_no_join_week_changes_nothing()
    {
        var current = new DateOnly(2026, 9, 28);
        var walk = StreakMath.Walk(new HashSet<DateOnly> { current.AddDays(-21) }, new HashSet<DateOnly>(), current, new StreakRules(4, 2, 8));
        var strip = StreakMath.Strip(walk, new HashSet<DateOnly>(), current, count: 6, joinedWeek: current);
        Assert.Equal(WeekStates.Attended, strip.Single(w => w.Week == current.AddDays(-21)).State);
        Assert.Equal(WeekStates.BeforeJoining, strip[0].State);
        Assert.DoesNotContain(StreakMath.Strip(walk, new HashSet<DateOnly>(), current, count: 6), w => w.State == WeekStates.BeforeJoining);
    }
}
