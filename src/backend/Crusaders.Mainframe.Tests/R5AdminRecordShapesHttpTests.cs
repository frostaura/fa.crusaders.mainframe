using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 5 (lane F), the admin API shapes the console builds on:
/// A5-1 — lifting a club hold needs a reason, and the record keeps it;
/// A5-2 — a bulk cancel is on the record per booking as well as per batch, and both batch rows
/// name what they were about; A5-4 — the schedule read lists every rule the series has had.
/// </summary>
public sealed class R5AdminRecordShapesHttpTests(PostgresFixture pg) : IClassFixture<PostgresFixture>
{
    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";

    private TestWebAppFactory Factory => pg.SharedHost;

    private async Task<List<AdminChangeLog>> RowsAsync(Guid tenantId, string action)
    {
        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AdminChangeLogs.IgnoreQueryFilters().AsNoTracking()
            .Where(r => r.TenantId == tenantId && r.Action == action)
            .OrderBy(r => r.OccurredAt).ToListAsync();
    }

    private async Task<Guid> SeedAsync(DoorClub club, DateTimeOffset startsAt, BookingStatus status, string? label = null)
    {
        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var member = status == BookingStatus.Booked ? club.MemberUserId : (Guid?)null;
        var booking = new Booking
        {
            TenantId = club.TenantId,
            CourtId = club.CourtId,
            UserId = member,
            BookedByUserId = member,
            PaidByUserId = member,
            ActorUserId = member ?? club.AdminUserId,
            StartsAt = startsAt,
            EndsAt = startsAt.AddHours(1),
            SliceMinutes = 15,
            SliceCount = 4,
            AmountChargedMinutes = member is null ? 0 : 32,
            Status = status,
            ChargedAt = member is null ? null : DateTimeOffset.UtcNow,
            BlockLabel = label,
        };
        db.Bookings.Add(booking);
        if (member is { } payer)
        {
            db.LedgerEntries.Add(new LedgerEntry
            {
                TenantId = club.TenantId,
                UserId = payer,
                Type = LedgerEntryType.TopUp,
                AmountMinutes = 32,
                ActorUserId = Guid.Empty,
                Reason = "fixture float",
            });
        }
        await db.SaveChangesAsync();
        return booking.Id;
    }

    private static DateTimeOffset Day(int hour) => new(DateTime.UtcNow.Date.AddDays(3).AddHours(hour), TimeSpan.Zero);

    // ------------------------------------------------------------------ A5-1

    [SkippableFact]
    public async Task Lifting_a_hold_needs_a_reason_and_the_record_keeps_it()
    {
        Skip.IfNot(pg.Available, Skipped);
        var club = await DoorClub.SeedAsync(Factory, "r5fhold", DoorClub.DefaultSettings);
        var admin = club.AdminClient(Factory);
        var blockId = await SeedAsync(club, Day(10), BookingStatus.AdminBlock, "Coaching");
        var path = $"/api/v1/admin/blocks/{blockId}";

        var bare = await admin.DeleteAsync(path);
        Assert.Equal(HttpStatusCode.BadRequest, bare.StatusCode);
        Assert.Contains("reason_required", await bare.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.DeleteAsync(path + "?reason=%20%20")).StatusCode);
        var tooLong = await admin.DeleteAsync(path + "?reason=" + new string('x', 513));
        Assert.Equal(HttpStatusCode.BadRequest, tooLong.StatusCode);
        Assert.Contains("reason_too_long", await tooLong.Content.ReadAsStringAsync());
        Assert.Empty(await RowsAsync(club.TenantId, AdminChangeActions.BookingBlockLifted));

        Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync(path + "?reason=Coach%20is%20ill")).StatusCode);
        var row = Assert.Single(await RowsAsync(club.TenantId, AdminChangeActions.BookingBlockLifted));
        Assert.Equal("Coach is ill", row.Reason);

        // Gone now: the lookup's own answer, once the reason is there.
        Assert.Equal(HttpStatusCode.NotFound, (await admin.DeleteAsync(path + "?reason=again")).StatusCode);
    }

    [SkippableFact]
    public async Task A_reason_in_the_body_is_read_when_the_query_has_none()
    {
        Skip.IfNot(pg.Available, Skipped);
        var club = await DoorClub.SeedAsync(Factory, "r5fholdb", DoorClub.DefaultSettings);
        var blockId = await SeedAsync(club, Day(11), BookingStatus.AdminBlock, "Clinic");

        using var request = new HttpRequestMessage(HttpMethod.Delete, $"/api/v1/admin/blocks/{blockId}")
        {
            Content = new StringContent("{\"reason\":\"Clinic cancelled\"}", Encoding.UTF8, "application/json"),
        };
        Assert.Equal(HttpStatusCode.NoContent, (await club.AdminClient(Factory).SendAsync(request)).StatusCode);
        Assert.Equal("Clinic cancelled", Assert.Single(await RowsAsync(club.TenantId, AdminChangeActions.BookingBlockLifted)).Reason);
    }

    // ------------------------------------------------------------------ A5-2

    /// <summary>
    /// Two bookings and a hold in one batch: each booking has its own <c>booking.cancelled_by_admin</c>
    /// row about the member with the batch reason, the hold its lift row with the reason, and the
    /// batch row is labelled and lists all three. An item already cancelled writes no booking row.
    /// </summary>
    [SkippableFact]
    public async Task A_bulk_cancel_is_on_the_record_per_booking_and_names_its_bookings()
    {
        Skip.IfNot(pg.Available, Skipped);
        var club = await DoorClub.SeedAsync(Factory, "r5fbulk", DoorClub.DefaultSettings);
        var first = await SeedAsync(club, Day(9), BookingStatus.Booked);
        var second = await SeedAsync(club, Day(12), BookingStatus.Booked);
        var hold = await SeedAsync(club, Day(14), BookingStatus.AdminBlock, "Maintenance");
        var gone = await SeedAsync(club, Day(16), BookingStatus.Cancelled);

        var answer = await club.AdminClient(Factory).PostAsJsonAsync("/api/v1/admin/bookings/bulk-cancel", new
        {
            idempotencyKey = "r5f-bulk",
            reason = "Floor resurfacing",
            items = new[] { new { bookingId = first }, new { bookingId = second }, new { bookingId = hold }, new { bookingId = gone } },
        });
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);

        var perBooking = await RowsAsync(club.TenantId, AdminChangeActions.BookingCancelledByAdmin);
        Assert.Equal(2, perBooking.Count);
        Assert.All(perBooking, r =>
        {
            Assert.Equal((AdminChangeSubjects.User, club.MemberUserId, "Floor resurfacing"), (r.SubjectKind, r.SubjectId!.Value, r.Reason));
            using var after = JsonDocument.Parse(r.AfterJson!);
            Assert.True(after.RootElement.GetProperty("part_of_batch").GetBoolean());
        });
        Assert.Equal(
            new[] { first, second }.OrderBy(g => g),
            perBooking.Select(r => JsonDocument.Parse(r.BeforeJson!).RootElement.GetProperty("booking_id").GetGuid()).OrderBy(g => g));
        Assert.Equal("Floor resurfacing", Assert.Single(await RowsAsync(club.TenantId, AdminChangeActions.BookingBlockLifted)).Reason);

        var batch = Assert.Single(await RowsAsync(club.TenantId, AdminChangeActions.BookingsBulkCancelled));
        Assert.StartsWith("4 bookings — ", batch.SubjectLabel);
        Assert.Contains("Maintenance", batch.SubjectLabel);
        using var doc = JsonDocument.Parse(batch.AfterJson!);
        var items = doc.RootElement.GetProperty("bookings").EnumerateArray().ToList();
        Assert.Equal(4, items.Count);
        Assert.Equal("cancelled", items[0].GetProperty("status").GetString());
        Assert.Equal("Court 1", items[0].GetProperty("court").GetString());
        Assert.False(string.IsNullOrEmpty(items[0].GetProperty("member_name").GetString()));
        Assert.Equal("Maintenance", items[2].GetProperty("block_label").GetString());
        Assert.Equal(JsonValueKind.Null, items[2].GetProperty("member_name").ValueKind);
        Assert.Equal("already_cancelled", items[3].GetProperty("status").GetString());
    }

    [SkippableFact]
    public async Task A_bulk_book_row_is_labelled_with_its_payer_and_lists_its_items()
    {
        Skip.IfNot(pg.Available, Skipped);
        var club = await DoorClub.SeedAsync(Factory, "r5fbook", DoorClub.DefaultSettings);
        var answer = await club.AdminClient(Factory).PostAsJsonAsync("/api/v1/admin/bookings/bulk", new
        {
            idempotencyKey = "r5f-book",
            onBehalf = new { userId = club.MemberUserId },
            allowNegativeBalance = true,
            items = new[]
            {
                new { courtId = club.CourtId, startsAt = Day(10), sliceCount = 4 },
                new { courtId = club.CourtId, startsAt = Day(11), sliceCount = 4 },
            },
        });
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);

        string memberName;
        using (var scope = Factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            memberName = await db.Memberships.IgnoreQueryFilters()
                .Where(m => m.UserId == club.MemberUserId).Select(m => m.FullName).FirstAsync();
        }

        var batch = Assert.Single(await RowsAsync(club.TenantId, AdminChangeActions.BookingsBulkBooked));
        Assert.Equal(memberName, batch.SubjectLabel);
        using var doc = JsonDocument.Parse(batch.AfterJson!);
        var items = doc.RootElement.GetProperty("bookings").EnumerateArray().ToList();
        Assert.Equal(2, items.Count);
        Assert.All(items, i => Assert.Equal("Court 1", i.GetProperty("court").GetString()));
        Assert.Equal(Day(11), items[1].GetProperty("starts_at").GetDateTimeOffset());
    }

    // ------------------------------------------------------------------ A5-4

    /// <summary>
    /// Tuesdays changed to Wednesdays from the third week: the read lists both rules, the Tuesday
    /// one in force today and ending the day the Wednesday one starts.
    /// </summary>
    [SkippableFact]
    public async Task The_schedule_read_lists_every_rule_and_which_governs_today()
    {
        Skip.IfNot(pg.Available, Skipped);
        var club = await DoorClub.SeedAsync(Factory, "r5frules", DoorClub.DefaultSettings);
        var client = club.AdminClient(Factory);
        var first = DateOnly.FromDateTime(DateTime.UtcNow.Date).AddDays(7);
        while (first.DayOfWeek != DayOfWeek.Tuesday) first = first.AddDays(1);
        var from = first.AddDays(14);
        object Body(string day, DateOnly? effective) => new
        {
            name = "League",
            label = "League",
            days = new[] { day },
            start = "18:00",
            end = "21:00",
            startDate = first.ToString("yyyy-MM-dd"),
            endDate = first.AddDays(41).ToString("yyyy-MM-dd"),
            intervalWeeks = 1,
            courts = new[] { club.CourtId },
            effectiveFrom = effective?.ToString("yyyy-MM-dd"),
            reason = "Changed",
        };

        var created = await client.PostAsJsonAsync("/api/v1/admin/schedules/", Body("tue", null));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var schedule = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("schedule");
        var id = schedule.GetProperty("id").GetGuid();
        Assert.Equal(1, schedule.GetProperty("rules").GetArrayLength());

        Assert.Equal(HttpStatusCode.OK, (await client.PatchAsJsonAsync($"/api/v1/admin/schedules/{id}", Body("wed", from))).StatusCode);

        var rules = (await client.GetFromJsonAsync<JsonElement>($"/api/v1/admin/schedules/{id}"))
            .GetProperty("schedule").GetProperty("rules").EnumerateArray().ToList();
        Assert.Equal(2, rules.Count);
        Assert.Equal(first.ToString("yyyy-MM-dd"), rules[0].GetProperty("from").GetString());
        Assert.Equal(from.ToString("yyyy-MM-dd"), rules[0].GetProperty("until").GetString());
        Assert.Equal("tue", Assert.Single(rules[0].GetProperty("days").EnumerateArray()).GetString());
        Assert.True(rules[0].GetProperty("in_force").GetBoolean());
        Assert.Equal(from.ToString("yyyy-MM-dd"), rules[1].GetProperty("from").GetString());
        Assert.Equal(JsonValueKind.Null, rules[1].GetProperty("until").ValueKind);
        Assert.Equal("wed", Assert.Single(rules[1].GetProperty("days").EnumerateArray()).GetString());
        Assert.False(rules[1].GetProperty("in_force").GetBoolean());

        // The list carries the same field.
        var listed = (await client.GetFromJsonAsync<JsonElement>("/api/v1/admin/schedules"))
            .GetProperty("schedules").EnumerateArray().Single(s => s.GetProperty("id").GetGuid() == id);
        Assert.Equal(2, listed.GetProperty("rules").GetArrayLength());
    }
}
