using System.Net;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 14, D14-4 (BE14a's ask to BE14b): the two device decisions <c>BookingService</c>
/// makes — a walk-up's start and a late check-in's reversal — read the injected clock, as every
/// device route around them now does. A walk-up started at the wall's instant and was checked in at
/// the club's; a reversal stamped <c>NoShowReversedAt</c> by the wall while the lights cues it is
/// compared with were stamped by the clock.
/// </summary>
public sealed class R14BookingClockHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private static void Near(DateTimeOffset expected, DateTimeOffset? actual, string what) =>
        Assert.True(actual is { } a && (a - expected).Duration() < TimeSpan.FromSeconds(1), $"{what}: {actual:o}, expected {expected:o}");

    [SkippableFact]
    public async Task A_walk_up_starts_at_the_clubs_instant()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var clock = new PinnedClock(DateTimeOffset.UtcNow.AddMinutes(-60).Storable());
        await using var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService(), clock);
        var club = await MemberCodeClub.SeedAsync(app, "r14wuclk", MemberCodeClub.SettingsAtNoon());

        var bought = await app.CreateClient().SendAsync(club.WalkUp(club.Code(club.Pam, at: clock.Now), court: 3, nonce: "cccccccccccccccc"));
        Assert.Equal(HttpStatusCode.OK, bought.StatusCode);

        var row = await club.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters().AsNoTracking()
            .SingleAsync(b => b.TenantId == club.TenantId && b.UserId == club.Pam));
        Near(clock.Now, row.StartsAt, "StartsAt");
    }

    [SkippableFact]
    public async Task A_late_check_in_reversal_is_stamped_at_the_clubs_instant()
    {
        Skip.IfNot(pg.Available, MemberCodeHttpTests.Skipped);
        var clock = new PinnedClock(DateTimeOffset.UtcNow.AddMinutes(-30).Storable());
        await using var app = MemberCodeClub.Wired(pg.SharedHost, new StubEmailService(), clock);
        var club = await MemberCodeClub.SeedAsync(app, "r14rvclk", MemberCodeClub.SettingsAtNoon());
        var booking = await club.BookAsync(app, club.Olga, courtIndex: 0, startsInMinutes: -50, minutes: 60);
        await club.WriteAsync(app, async db => (await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == booking.Id)).Status = BookingStatus.NoShow);

        using (var scope = app.Services.CreateScope())
        {
            scope.ServiceProvider.GetRequiredService<Api.Multitenancy.ITenantContext>().Set(club.TenantId, club.Slug);
            var row = await scope.ServiceProvider.GetRequiredService<MainframeDbContext>().Bookings.FirstAsync(b => b.Id == booking.Id);
            var result = await scope.ServiceProvider.GetRequiredService<BookingService>().ReverseNoShowAsync(
                row, booking.StartsAt.AddMinutes(2), Guid.Empty, default, scan: new ReversalScan(club.Olga, "member_code"));
            Assert.IsType<NoShowReversalResult.Ok>(result);
        }

        var reversed = await club.ReadAsync(app, db => db.Bookings.IgnoreQueryFilters().AsNoTracking().SingleAsync(b => b.Id == booking.Id));
        Near(clock.Now, reversed.NoShowReversedAt, "NoShowReversedAt");
    }
}
