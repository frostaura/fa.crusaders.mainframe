using Crusaders.Mainframe.Api.Services;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// Review round 3, cross-lens: a "First win" celebration was seen while the result still read
/// "Waiting for … to confirm". The award rule is confirmed-only (<c>BadgeRules</c> reads
/// <c>PlayRecord.ConfirmedResultsAsync</c>); this pins it end to end — through the record's own
/// hook, a worker tick, and the member's celebration queue — so the rule cannot drift. It could not
/// be made red: the backend already waits, and the report's evidence names no second path.
/// </summary>
public sealed class R3WinWaitsForConfirmHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

    [SkippableFact]
    public async Task A_recorded_win_awards_and_celebrates_nothing_until_it_is_confirmed()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "r3-winwait");
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-3).Storable(), club.Organiser, [club.Sam]);
        var created = await (await RecordAsync(club.Client(f, club.Organiser), booking, [U(club.Organiser)], [U(club.Sam)])).JsonAsync();
        await TickAsync(f, DateTimeOffset.UtcNow);

        foreach (var who in new[] { club.Organiser, club.Sam })
        {
            Assert.DoesNotContain(await BadgesAsync(f, who), b => b.BadgeKey is BadgeCatalogue.FirstWin or BadgeCatalogue.FirstResult);
            Assert.DoesNotContain(await CelebrationsAsync(f, who), c => c.BadgeKey is BadgeCatalogue.FirstWin or BadgeCatalogue.FirstResult);
        }

        Assert.True((await ActAsync(club.Client(f, club.Sam), booking, "confirm", created.GetProperty("version").GetInt32())).IsSuccessStatusCode);

        Assert.Contains(await BadgesAsync(f, club.Organiser), b => b.BadgeKey == BadgeCatalogue.FirstWin);
        Assert.Contains(await CelebrationsAsync(f, club.Organiser), c => c.BadgeKey == BadgeCatalogue.FirstWin);
        Assert.DoesNotContain(await CelebrationsAsync(f, club.Sam), c => c.BadgeKey == BadgeCatalogue.FirstWin);
    }
}
