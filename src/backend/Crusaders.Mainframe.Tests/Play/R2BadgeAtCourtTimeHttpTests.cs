using Crusaders.Mainframe.Api.Services;
using Microsoft.Extensions.DependencyInjection;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// Review round 2, B-11 (MJ, B15 residual): "First court" and "Early bird" were awarded at the
/// box scan — 06:24 for a 06:30 court, before a ball was hit. A session is attended from its court
/// time or its check-in, whichever is later: nothing is awarded before the court starts, the
/// check-in's recompute is due at the start, and the badge is dated then. A partner who walked in
/// behind the scanner still counts (founder default, unchanged).
/// </summary>
public sealed class R2BadgeAtCourtTimeHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

    [SkippableFact]
    public async Task A_check_in_during_early_entry_earns_nothing_until_the_court_time_starts()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "r2badge");
        var now = DateTimeOffset.UtcNow.Storable();
        var start = now.AddMinutes(10);
        var booking = await club.GameAsync(f, start, club.Organiser, [club.Sam], checkIn: false);

        await club.CheckInAsync(f, booking, now);              // the scan, ten minutes early
        Assert.Equal(start, await MarkerAsync(f, booking));     // evaluated when the court starts

        await TickAsync(f, now.AddMinutes(1));
        // And an evaluation that runs before the court time for any other reason finds nothing either.
        await club.InClubAsync(f, sp => sp.GetRequiredService<PlayEvaluator>().EvaluateAsync(club.Sam, now.AddMinutes(2), default));
        Assert.Empty(await BadgesAsync(f, club.Organiser));
        Assert.Empty(await BadgesAsync(f, club.Sam));
        Assert.Empty(await CelebrationsAsync(f, club.Sam));

        await TickAsync(f, start.AddMinutes(1));
        foreach (var member in new[] { club.Organiser, club.Sam })   // Sam walked in behind the scanner: still counts
        {
            var first = Assert.Single(await BadgesAsync(f, member), b => b.BadgeKey == BadgeCatalogue.FirstSession);
            Assert.Equal(start, first.AwardedAt);
        }
    }

    [Theory]
    [InlineData(-6, 0)]   // scanned 06:24 for 06:30: the court time
    [InlineData(4, 4)]    // scanned 06:34, late: the scan
    public void A_session_is_attended_from_the_later_of_its_start_and_its_check_in(int scanMinutes, int expectedMinutes)
    {
        var start = new DateTimeOffset(2026, 10, 1, 6, 30, 0, TimeSpan.Zero);
        Assert.Equal(start.AddMinutes(expectedMinutes), AttendanceQuery.AttendedAt(start, start.AddMinutes(scanMinutes)));
    }
}
