using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 4, A4-4: the desk cancelling a member's booking is on the club's change record,
/// in the cancellation's own save, and a refused cancellation leaves no row.
/// </summary>
public sealed class R4AdminCancelRecordHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private static async Task<Guid> BookAsync(TestWebAppFactory factory, DoorClub club)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var booking = new Booking
        {
            TenantId = club.TenantId,
            CourtId = club.CourtId,
            UserId = club.MemberUserId,
            BookedByUserId = club.MemberUserId,
            PaidByUserId = club.MemberUserId,
            ActorUserId = club.MemberUserId,
            StartsAt = DateTimeOffset.UtcNow.AddDays(2),
            EndsAt = DateTimeOffset.UtcNow.AddDays(2).AddHours(1),
            SliceMinutes = 15,
            SliceCount = 4,
            AmountChargedCredits = 32m,
            Status = BookingStatus.Booked,
            ChargedAt = DateTimeOffset.UtcNow,
        };
        db.Bookings.Add(booking);
        await db.SaveChangesAsync();
        return booking.Id;
    }

    private static async Task<List<AdminChangeLog>> RowsAsync(TestWebAppFactory factory, Guid tenantId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AdminChangeLogs.IgnoreQueryFilters().AsNoTracking()
            .Where(r => r.TenantId == tenantId && r.Action == AdminChangeActions.BookingCancelledByAdmin)
            .ToListAsync();
    }

    [SkippableFact]
    public async Task A_desk_cancellation_is_on_the_record_about_the_member_with_its_reason()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await DoorClub.SeedAsync(factory, "r4cxl", DoorClub.DefaultSettings);
        var bookingId = await BookAsync(factory, club);

        var cancel = await club.AdminClient(factory).PostAsJsonAsync(
            $"/api/v1/admin/bookings/{bookingId}/cancel", new { waivePenalty = false, reason = "Court leaking" });
        Assert.Equal(HttpStatusCode.OK, cancel.StatusCode);

        var row = Assert.Single(await RowsAsync(factory, club.TenantId));
        Assert.Equal(AdminChangeSubjects.User, row.SubjectKind);
        Assert.Equal(club.MemberUserId, row.SubjectId);
        Assert.Equal(club.AdminUserId, row.ActorUserId);
        Assert.Equal("Court leaking", row.Reason);
        using var before = JsonDocument.Parse(row.BeforeJson!);
        Assert.Equal(bookingId, before.RootElement.GetProperty("booking_id").GetGuid());
        using var after = JsonDocument.Parse(row.AfterJson!);
        Assert.Equal("cancelled", after.RootElement.GetProperty("status").GetString());
    }

    /// <summary>The waiver's reason still counts as the reason — an older console sends only it.</summary>
    [SkippableFact]
    public async Task A_waive_reason_alone_is_the_reason()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await DoorClub.SeedAsync(factory, "r4cxlw", DoorClub.DefaultSettings);
        var bookingId = await BookAsync(factory, club);

        var cancel = await club.AdminClient(factory).PostAsJsonAsync(
            $"/api/v1/admin/bookings/{bookingId}/cancel", new { waivePenalty = true, waiveReason = "Club's fault" });
        Assert.Equal(HttpStatusCode.OK, cancel.StatusCode);
        Assert.Equal("Club's fault", Assert.Single(await RowsAsync(factory, club.TenantId)).Reason);
    }

    /// <summary>A second cancellation of the same booking is refused and writes no second row.</summary>
    [SkippableFact]
    public async Task A_refused_cancellation_leaves_no_row()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await DoorClub.SeedAsync(factory, "r4cxl2", DoorClub.DefaultSettings);
        var bookingId = await BookAsync(factory, club);
        var admin = club.AdminClient(factory);

        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync(
            $"/api/v1/admin/bookings/{bookingId}/cancel", new { reason = "First" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.PostAsJsonAsync(
            $"/api/v1/admin/bookings/{bookingId}/cancel", new { reason = "Second" })).StatusCode);

        Assert.Equal("First", Assert.Single(await RowsAsync(factory, club.TenantId)).Reason);
    }
}
