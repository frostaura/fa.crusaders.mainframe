using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The Development seeder runs on every boot against whatever database the developer has, so
/// it must be safe on a database that has lived.
///
/// <para>
/// It re-plants a week of sample bookings each boot and used to skip a slot only when a
/// <c>Booked</c> row started at exactly the same instant. On a long-lived local database that
/// misses both things that happen to a seeded booking there: <c>NoShowWorker</c> sweeps it to
/// <c>NoShow</c> (and truncates its end), and a developer books over or beside it. The next boot
/// then planted a second row on an occupied slot, <c>ck_bookings_no_overlapping_slot</c> — which
/// exempts <c>Cancelled</c> and nothing else — refused it, and because the whole week is one
/// save the boot seeded no bookings at all behind a logged "Seed failed".
/// </para>
/// </summary>
public sealed class SeederIdempotenceTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    [SkippableFact]
    public async Task Seeding_a_lived_in_database_skips_occupied_slots_and_keeps_the_rest()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        await Seeder.SeedAsync(scope.ServiceProvider, NullLogger.Instance);
        var total = await db.Bookings.IgnoreQueryFilters().CountAsync();
        var seeded = await db.Bookings.IgnoreQueryFilters().AsNoTracking()
            .Where(b => b.Status == BookingStatus.Booked)
            .OrderBy(b => b.StartsAt).ToListAsync();
        Assert.True(seeded.Count >= 3, "the seeder planted too few bookings to exercise");

        // A second boot on an untouched database changes nothing.
        await Seeder.SeedAsync(scope.ServiceProvider, NullLogger.Instance);
        Assert.Equal(total, await db.Bookings.IgnoreQueryFilters().CountAsync());

        // Now live in it, the two ways a local database does. One seeded booking is swept to
        // NoShow with its tail released, as NoShowWorker does; another is moved a quarter of an
        // hour, standing in for a developer's own booking that overlaps the seeded slot
        // without starting on it.
        var swept = await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == seeded[0].Id);
        swept.Status = BookingStatus.NoShow;
        swept.EndsAt = swept.StartsAt.AddMinutes(5);
        var moved = await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.Id == seeded[1].Id);
        moved.StartsAt = moved.StartsAt.AddMinutes(15);
        moved.EndsAt = moved.EndsAt.AddMinutes(15);
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();

        // The boot that used to throw the exclusion violation.
        await Seeder.SeedAsync(scope.ServiceProvider, NullLogger.Instance);

        var after = await db.Bookings.IgnoreQueryFilters().AsNoTracking().ToListAsync();
        Assert.Equal(total, after.Count);

        // …and nothing on any court overlaps anything else that is not cancelled, checked on
        // the rows rather than trusted to the constraint that would have thrown.
        var live = after.Where(b => b.Status != BookingStatus.Cancelled).ToList();
        foreach (var a in live)
        {
            Assert.DoesNotContain(live, b =>
                b.Id != a.Id && b.CourtId == a.CourtId && b.StartsAt < a.EndsAt && a.StartsAt < b.EndsAt);
        }

        // Every seeded booking still carries exactly one charge — the skipped slots posted none.
        var charges = await db.LedgerEntries.IgnoreQueryFilters().AsNoTracking()
            .Where(l => l.Type == LedgerEntryType.BookingCharge && l.RelatedBookingId != null)
            .GroupBy(l => l.RelatedBookingId)
            .Select(g => g.Count())
            .ToListAsync();
        Assert.Equal(after.Count, charges.Count);
        Assert.All(charges, n => Assert.Equal(1, n));
    }

    [SkippableFact]
    public async Task A_slot_freed_by_cancellation_is_planted_again()
    {
        Skip.IfNot(pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = pg.ConnectionString };
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        await Seeder.SeedAsync(scope.ServiceProvider, NullLogger.Instance);
        var before = await db.Bookings.IgnoreQueryFilters()
            .CountAsync(b => b.Status != BookingStatus.Cancelled);

        // A cancelled row does not hold its slot (the constraint exempts it), so the seeder
        // is free to plant the demo booking there again — "skip anything that exists" would
        // leave a hole in the demo grid for every booking anyone ever cancelled.
        var cancelled = await db.Bookings.IgnoreQueryFilters()
            .Where(b => b.Status == BookingStatus.Booked).OrderBy(b => b.StartsAt).FirstAsync();
        cancelled.Status = BookingStatus.Cancelled;
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();

        await Seeder.SeedAsync(scope.ServiceProvider, NullLogger.Instance);

        Assert.Equal(before, await db.Bookings.IgnoreQueryFilters()
            .CountAsync(b => b.Status != BookingStatus.Cancelled));
    }
}
