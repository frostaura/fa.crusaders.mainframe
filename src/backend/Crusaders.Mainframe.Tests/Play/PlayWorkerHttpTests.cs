using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using static Crusaders.Mainframe.Tests.Play.PlayKit;

namespace Crusaders.Mainframe.Tests.Play;

/// <summary>
/// <c>PlayWorker</c> at stated instants (<c>docs/specs/play.md</c> §7.1, §7.3): the auto-confirm
/// batch, the marker staged in the check-in's own save and drained with no hook ever running, the
/// guarded clear, and the five-minute push-back of a booking whose evaluation fails.
/// </summary>
public sealed class PlayWorkerHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private TestWebAppFactory CreateFactory() => new() { ConnectionString = pg.ConnectionString };

    [SkippableFact]
    public async Task The_minute_sweep_confirms_every_result_whose_deadline_has_passed_and_no_other()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "wk-confirm");
        var olive = club.Client(f, club.Organiser);
        var start = DateTimeOffset.UtcNow.AddHours(-20).Storable();
        var bookings = new List<Guid>();
        for (var i = 0; i < 3; i++)
        {
            var b = await club.GameAsync(f, start.AddHours(i * 2), club.Organiser, [club.Sam]);
            await RecordAsync(olive, b, [U(club.Organiser)], [U(club.Sam)]);
            bookings.Add(b);
        }
        var dues = new List<DateTimeOffset>();
        foreach (var b in bookings) dues.Add((await ResultRowAsync(f, b))!.ConfirmDueAt!.Value);

        await PlayKit.TickAsync(f, dues[1]);
        Assert.Equal(MatchResultStatus.Confirmed, (await ResultRowAsync(f, bookings[0]))!.Status);
        Assert.Equal(MatchResultStatus.Confirmed, (await ResultRowAsync(f, bookings[1]))!.Status);
        Assert.Equal(MatchResultStatus.Pending, (await ResultRowAsync(f, bookings[2]))!.Status);
        var first = (await ResultRowAsync(f, bookings[0]))!;
        Assert.True(first.AutoConfirmed);
        Assert.Equal(dues[0], first.ConfirmedAt);

        await PlayKit.TickAsync(f, dues[2]);
        Assert.Equal(MatchResultStatus.Confirmed, (await ResultRowAsync(f, bookings[2]))!.Status);
    }

    /// <summary>
    /// A check-in whose hook never ran (a check-in is not hooked at all): its own save staged the
    /// marker, and the next pass evaluates the players and clears it.
    /// </summary>
    [SkippableFact]
    public async Task A_check_in_stages_the_marker_in_its_own_save_and_the_worker_evaluates_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "wk-marker");
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-1).Storable(), club.Organiser, [club.Sam], checkIn: false);
        await ClearMarkerAsync(f, booking);

        await club.CheckInAsync(f, booking, DateTimeOffset.UtcNow.AddMinutes(-50));
        var marker = await MarkerAsync(f, booking);
        Assert.NotNull(marker);
        Assert.Empty(await BadgesAsync(f, club.Sam));

        await PlayKit.TickAsync(f, DateTimeOffset.UtcNow);
        Assert.Null(await MarkerAsync(f, booking));
        Assert.Contains(await BadgesAsync(f, club.Sam), b => b.BadgeKey == BadgeCatalogue.FirstSession);
        Assert.Contains(await BadgesAsync(f, club.Organiser), b => b.BadgeKey == BadgeCatalogue.FirstSession);
    }

    /// <summary>A seat's own arrival, a status change and a booking born checked in stage the marker; an admin block, with no players, never does.</summary>
    [SkippableFact]
    public async Task Seat_changes_stage_the_marker_and_an_admin_block_never_does()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "wk-seats");
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-1).Storable(), club.Organiser, [club.Sam], checkIn: false);
        await ClearMarkerAsync(f, booking);
        await club.WriteAsync(f, db => db.BookingParticipants.IgnoreQueryFilters().First(p => p.BookingId == booking && p.UserId == club.Sam).CheckedInAt = DateTimeOffset.UtcNow);
        Assert.NotNull(await MarkerAsync(f, booking));
        await ClearMarkerAsync(f, booking);
        await club.WriteAsync(f, db => db.BookingParticipants.IgnoreQueryFilters().First(p => p.BookingId == booking && p.UserId == club.Sam).Status = ParticipantStatus.Removed);
        Assert.NotNull(await MarkerAsync(f, booking));
        await ClearMarkerAsync(f, booking);
        await club.WriteAsync(f, db => db.BookingParticipants.IgnoreQueryFilters().First(p => p.BookingId == booking && p.UserId == club.Sam).NudgeCount = 3);
        Assert.Null(await MarkerAsync(f, booking));

        // A booking born checked in (a walk-up) carries the marker in its own INSERT.
        var walkUp = new Booking
        {
            TenantId = club.TenantId, CourtId = club.CourtId, UserId = club.Jo, BookedByUserId = club.Jo, PaidByUserId = club.Jo, ActorUserId = club.Jo,
            StartsAt = DateTimeOffset.UtcNow.AddDays(-2), EndsAt = DateTimeOffset.UtcNow.AddDays(-2).AddMinutes(30), SliceMinutes = 15, SliceCount = 2,
            CheckedInAt = DateTimeOffset.UtcNow.AddDays(-2).Storable(),
        };
        await club.WriteAsync(f, db => db.Bookings.Add(walkUp));
        Assert.NotNull(await MarkerAsync(f, walkUp.Id));

        var block = new Booking
        {
            TenantId = club.TenantId, CourtId = club.CourtId, UserId = null, ActorUserId = club.Admin, Status = BookingStatus.AdminBlock,
            StartsAt = DateTimeOffset.UtcNow.AddDays(3), EndsAt = DateTimeOffset.UtcNow.AddDays(3).AddHours(1), SliceMinutes = 15, SliceCount = 4,
        };
        await club.WriteAsync(f, db => db.Bookings.Add(block));
        await club.WriteAsync(f, db => db.Bookings.IgnoreQueryFilters().First(b => b.Id == block.Id).CheckedInAt = DateTimeOffset.UtcNow);
        Assert.Null(await MarkerAsync(f, block.Id));
    }

    /// <summary>
    /// The guarded clear: a change that commits while the pass is evaluating moves the marker past
    /// the pass's start, and the pass must not clear it. The "change during the pass" is a trigger
    /// on the evaluator's own profile stamp, which commits inside the evaluation.
    /// </summary>
    [SkippableFact]
    public async Task A_change_that_lands_during_the_pass_keeps_its_marker()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "wk-guard");
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-1).Storable(), club.Organiser, [club.Sam]);
        var later = DateTimeOffset.UtcNow.AddMinutes(1).Storable();
        // Test-owned DDL with no outside input: the values are a Guid and an instant formatted here.
        var touch = $"""
            CREATE OR REPLACE FUNCTION p12_touch() RETURNS trigger AS $$
            BEGIN
              UPDATE bookings SET "PlayRecomputeDueAt" = '{later:O}' WHERE "Id" = '{booking}';
              RETURN NEW;
            END $$ LANGUAGE plpgsql;
            CREATE TRIGGER p12_touch AFTER INSERT OR UPDATE ON member_play_profiles FOR EACH ROW EXECUTE FUNCTION p12_touch();
            """;
        await PlayersClub.ReadAsync(f, db => db.Database.ExecuteSqlRawAsync(touch));
        try
        {
            await PlayKit.TickAsync(f, DateTimeOffset.UtcNow);
            Assert.Equal(later, await MarkerAsync(f, booking));
        }
        finally
        {
            await PlayersClub.ReadAsync(f, db => db.Database.ExecuteSqlRawAsync(
                "DROP TRIGGER IF EXISTS p12_touch ON member_play_profiles; DROP FUNCTION IF EXISTS p12_touch();"));
        }
        await PlayKit.TickAsync(f, later.AddSeconds(1));
        Assert.Null(await MarkerAsync(f, booking));
    }

    /// <summary>A booking whose evaluation fails is pushed five minutes ahead — a line every five minutes, not every minute.</summary>
    [SkippableFact]
    public async Task A_failing_booking_is_pushed_five_minutes_ahead_and_retried_then()
    {
        Skip.IfNot(pg.Available, Skipped);
        await using var f = CreateFactory();
        var club = await SeedAsync(f, "wk-fail");
        var booking = await club.GameAsync(f, DateTimeOffset.UtcNow.AddHours(-1).Storable(), club.Organiser, [club.Sam]);
        var poison = $"""
            CREATE OR REPLACE FUNCTION p12_poison() RETURNS trigger AS $$
            BEGIN
              IF NEW."UserId" = '{club.Sam}' THEN RAISE EXCEPTION 'poisoned'; END IF;
              RETURN NEW;
            END $$ LANGUAGE plpgsql;
            CREATE TRIGGER p12_poison BEFORE INSERT ON member_badges FOR EACH ROW EXECUTE FUNCTION p12_poison();
            """;
        await PlayersClub.ReadAsync(f, db => db.Database.ExecuteSqlRawAsync(poison));
        var now = DateTimeOffset.UtcNow.Storable();
        try
        {
            await PlayKit.TickAsync(f, now);
            Assert.Equal(now.AddMinutes(5), await MarkerAsync(f, booking));
            await PlayKit.TickAsync(f, now.AddMinutes(1));
            Assert.Equal(now.AddMinutes(5), await MarkerAsync(f, booking));
        }
        finally
        {
            await PlayersClub.ReadAsync(f, db => db.Database.ExecuteSqlRawAsync(
                "DROP TRIGGER IF EXISTS p12_poison ON member_badges; DROP FUNCTION IF EXISTS p12_poison();"));
        }
        await PlayKit.TickAsync(f, now.AddMinutes(5));
        Assert.Null(await MarkerAsync(f, booking));
        Assert.Contains(await BadgesAsync(f, club.Sam), b => b.BadgeKey == BadgeCatalogue.FirstSession);
    }
}
