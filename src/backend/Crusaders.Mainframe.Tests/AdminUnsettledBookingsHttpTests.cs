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
/// The list behind the <c>booking.unsettled</c> notice: the bookings the notice counts, and only
/// those — oldest first, paged, this club's only, admin only.
/// </summary>
public sealed class AdminUnsettledBookingsHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string ListPath = "/api/v1/admin/bookings/unsettled";

    [SkippableFact]
    public async Task The_list_is_exactly_what_the_notice_counts_oldest_first_and_paged()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var club = await ControlBoardClub.SeedAsync(factory, "unsettled");
        var court = await club.AddCourtAsync(factory, 1, "Court One");
        var now = DateTimeOffset.UtcNow;
        var oldest = await club.AddBookingAsync(factory, court, now.AddDays(-30), now.AddDays(-30).AddMinutes(45), club.MemberUserId, amountMinutes: 45);
        var older = await club.AddBookingAsync(factory, court, now.AddDays(-12), now.AddDays(-12).AddMinutes(30), club.AdminUserId, amountMinutes: 30);
        await club.AddBookingAsync(factory, court, now.AddDays(-3), now.AddDays(-3).AddMinutes(30), club.MemberUserId);
        await club.AddBookingAsync(factory, court, now.AddDays(-20), now.AddDays(-20).AddMinutes(30), club.MemberUserId, checkedInAt: now.AddDays(-20));
        await club.AddBookingAsync(factory, court, now.AddDays(-21), now.AddDays(-21).AddMinutes(30), club.MemberUserId, BookingStatus.Cancelled);
        await club.AddBookingAsync(factory, court, now.AddDays(-22), now.AddDays(-22).AddMinutes(30), club.MemberUserId, BookingStatus.NoShow);
        await club.AddBookingAsync(factory, court, now.AddDays(-23), now.AddDays(-23).AddMinutes(30), userId: null, BookingStatus.AdminBlock, blockLabel: "League");

        var admin = club.AdminClient(factory);
        var first = await admin.GetFromJsonAsync<JsonElement>(ListPath + "?limit=1");
        Assert.Equal(2, first.GetProperty("total").GetInt32());
        var row = Assert.Single(first.GetProperty("items").EnumerateArray());
        Assert.Equal(oldest, row.GetProperty("booking_id").GetGuid());
        Assert.Equal("Court One", row.GetProperty("court_name").GetString());
        Assert.Equal(45, row.GetProperty("charged_minutes").GetInt32());
        Assert.Equal("Priya Naidoo", row.GetProperty("member").GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.Null, row.GetProperty("payer").ValueKind);

        var second = await admin.GetFromJsonAsync<JsonElement>(ListPath + "?limit=1&cursor=" + Uri.EscapeDataString(first.GetProperty("next_cursor").GetString()!));
        Assert.Equal(older, Assert.Single(second.GetProperty("items").EnumerateArray()).GetProperty("booking_id").GetGuid());
        Assert.Equal(JsonValueKind.Null, second.GetProperty("next_cursor").ValueKind);

        // The notice counts the same bookings.
        await factory.Services.GetRequiredService<AdminNotificationSweep>().SweepAsync(now, default);
        using var scope = factory.Services.CreateScope();
        var notice = await scope.ServiceProvider.GetRequiredService<MainframeDbContext>().AdminNotifications.IgnoreQueryFilters()
            .SingleAsync(n => n.TenantId == club.TenantId && n.Kind == AdminEventCatalogue.BookingsUnsettled);
        Assert.Equal(2, JsonSerializer.Deserialize<BookingsUnsettledPayload>(notice.PayloadJson, AdminEventCatalogue.Json)!.Count);
        Assert.Equal("/admin/bookings", notice.Link);

        Assert.Equal(HttpStatusCode.BadRequest, (await admin.GetAsync(ListPath + "?cursor=not-a-cursor")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await club.MemberClient(factory).GetAsync(ListPath)).StatusCode);
    }

    /// <summary>Cross-tenant: another club's stranded booking is never on this club's list or in its count.</summary>
    [SkippableFact]
    public async Task Another_clubs_unsettled_booking_is_not_on_this_clubs_list()
    {
        Skip.IfNot(pg.Available, Skipped);
        var factory = pg.SharedHost;
        var a = await ControlBoardClub.SeedAsync(factory, "unsettled-a");
        var b = await ControlBoardClub.SeedAsync(factory, "unsettled-b");
        var courtB = await b.AddCourtAsync(factory, 1);
        var now = DateTimeOffset.UtcNow;
        var theirs = await b.AddBookingAsync(factory, courtB, now.AddDays(-30), now.AddDays(-30).AddMinutes(30), b.MemberUserId);

        var mine = await a.AdminClient(factory).GetFromJsonAsync<JsonElement>(ListPath);
        Assert.Equal(0, mine.GetProperty("total").GetInt32());
        Assert.Empty(mine.GetProperty("items").EnumerateArray());

        var their = await b.AdminClient(factory).GetFromJsonAsync<JsonElement>(ListPath);
        Assert.Equal(theirs, Assert.Single(their.GetProperty("items").EnumerateArray()).GetProperty("booking_id").GetGuid());
    }
}
