using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The demo data tells the same time as the product does.
///
/// <para>
/// <c>Seeder</c> wrote its booking-charge comment from the UTC instant while
/// <c>BookingService.SlotLabel</c> writes the tenant's own clock, so a seeded row read
/// "Booking Court 1 2026-09-12 <b>05:00</b>" for a court the grid, the confirmation email
/// and the wallet's own Time column all called <b>07:00</b> — and it sat two lines above a
/// genuine row in club time on the same admin Transactions screen. Demo data rather than a
/// money defect, which is exactly why it survived: it is in every screenshot of the ledger
/// anybody takes, and "05:00" is the sort of number that gets believed.
/// </para>
///
/// <para>
/// Asserted against <c>Booking.StartsAt</c> converted through the tenant's configured zone
/// rather than against a literal, so the test does not encode a second copy of the answer
/// and does not go red twice a year in a club that keeps DST.
/// </para>
/// </summary>
public sealed class SeededLedgerClockTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public SeededLedgerClockTests(PostgresFixture pg) => _pg = pg;

    [SkippableFact]
    public async Task Seeded_booking_comments_name_the_slot_in_club_time()
    {
        Skip.IfNot(_pg.Available, "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING");

        await using var factory = new TestWebAppFactory { ConnectionString = _pg.ConnectionString };
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await db.Database.MigrateAsync();

        await Seeder.SeedAsync(scope.ServiceProvider, NullLogger.Instance);

        // IgnoreQueryFilters throughout: this scope has no request and therefore no resolved
        // tenant, so the ordinary filters would hide everything the seeder just wrote.
        var charges = await db.LedgerEntries.IgnoreQueryFilters().AsNoTracking()
            .Where(l => l.Type == LedgerEntryType.BookingCharge && l.RelatedBookingId != null)
            .ToListAsync();
        Assert.NotEmpty(charges);

        var bookings = await db.Bookings.IgnoreQueryFilters().AsNoTracking()
            .ToDictionaryAsync(b => b.Id, b => b.StartsAt);
        var courts = await db.Courts.IgnoreQueryFilters().AsNoTracking()
            .ToDictionaryAsync(c => c.Id, c => c.Name);
        var bookingCourt = await db.Bookings.IgnoreQueryFilters().AsNoTracking()
            .ToDictionaryAsync(b => b.Id, b => b.CourtId);

        var tz = TimeZoneInfo.FindSystemTimeZoneById("Africa/Johannesburg");
        var checkedAtLeastOne = false;

        foreach (var charge in charges)
        {
            if (!bookings.TryGetValue(charge.RelatedBookingId!.Value, out var startsAt)) continue;
            var courtName = courts[bookingCourt[charge.RelatedBookingId!.Value]];
            var expected = $"Booking {courtName} · " + TimeZoneInfo
                .ConvertTimeFromUtc(startsAt.UtcDateTime, tz)
                .ToString(Crusaders.Mainframe.Api.Services.ClubDate.Format, System.Globalization.CultureInfo.InvariantCulture);

            Assert.Equal(expected, charge.Reason);
            checkedAtLeastOne = true;
        }

        Assert.True(checkedAtLeastOne, "the seeder wrote no booking charge naming a booking");
    }
}
