using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A repeating booking against court-time nobody can cancel — a no-show, a game already played.
///
/// <para>
/// <b>The bug this pins (2026-10-06):</b> an admin creating a schedule was shown a no-show as a
/// conflict, could not cancel it (a no-show is settled — 409 <c>not_cancellable</c>), and was
/// refused <c>schedule_conflicts</c> on every retry with nothing left to try. Two halves: the
/// dry run reported conflicts for occurrences that had already started — which the materialiser
/// never writes, so they cannot conflict with anything — and a conflict that genuinely holds the
/// court but cannot be cancelled had no way through, because the wire had no way to leave a date
/// out. Now past occurrences are not checked, every conflict says whether it can be cancelled,
/// and <c>skipDates</c> leaves a date out on purpose, recorded as a skipped date on the series.
/// </para>
/// </summary>
public sealed class ScheduleUnclearableConflictHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public ScheduleUnclearableConflictHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string Path = "/api/v1/admin/schedules";

    private TestWebAppFactory CreateFactory() => _pg.SharedHost;

    private static Task<DoorClub> ClubAsync(TestWebAppFactory factory, string prefix)
        => DoorClub.SeedAsync(factory, prefix, DoorClub.DefaultSettings);

    /// <summary>The Tuesday <paramref name="weeksAhead"/> weeks on — negative is in the past.</summary>
    private static DateOnly Tuesday(int weeksAhead)
    {
        var day = DateOnly.FromDateTime(DateTime.UtcNow.Date).AddDays(weeksAhead * 7);
        while (day.DayOfWeek != DayOfWeek.Tuesday) day = day.AddDays(1);
        return day;
    }

    private static DateTimeOffset At(DateOnly day, int hour)
        => new(day.ToDateTime(new TimeOnly(hour, 0)), TimeSpan.Zero);

    private static object Body(DoorClub club, DateOnly from, DateOnly to, DateOnly[]? skipDates = null)
        => new
        {
            name = "Tuesday league",
            label = "League — Div 1",
            days = new[] { "tue" },
            start = "18:00",
            end = "21:00",
            startDate = from.ToString("yyyy-MM-dd"),
            endDate = to.ToString("yyyy-MM-dd"),
            intervalWeeks = 1,
            courts = new[] { club.CourtId },
            skipDates = skipDates?.Select(d => d.ToString("yyyy-MM-dd")).ToArray(),
        };

    private static async Task<Guid> SeedAsync(
        TestWebAppFactory factory, DoorClub club, DateTimeOffset startsAt, BookingStatus status)
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
            StartsAt = startsAt.ToUniversalTime(),
            EndsAt = startsAt.AddHours(1).ToUniversalTime(),
            SliceMinutes = 15,
            SliceCount = 4,
            AmountChargedMinutes = 60,
            Status = status,
            ChargedAt = DateTimeOffset.UtcNow,
        };
        db.Bookings.Add(booking);
        await db.SaveChangesAsync();
        return booking.Id;
    }

    /// <summary>
    /// A series that started weeks ago does not report the no-shows and played games on its
    /// past dates. Those dates are never written, so nothing on them is in the way — and before
    /// the fix this create was refused for good, because neither row can be cancelled.
    /// </summary>
    [SkippableFact]
    public async Task Settled_bookings_on_dates_already_past_are_not_in_the_way()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "unclrpast");
        var from = Tuesday(-3);
        await SeedAsync(factory, club, At(Tuesday(-2), 18), BookingStatus.NoShow);
        await SeedAsync(factory, club, At(Tuesday(-1), 19), BookingStatus.Completed);
        var client = club.AdminClient(factory);

        var preview = await client.PostAsJsonAsync(Path + "/preview", Body(club, from, Tuesday(3)));
        Assert.Equal(HttpStatusCode.OK, preview.StatusCode);
        var previewBody = await preview.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(previewBody.GetProperty("conflicts").EnumerateArray());

        var created = await client.PostAsJsonAsync(Path + "/", Body(club, from, Tuesday(3)));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
    }

    /// <summary>
    /// Every conflict says whether the admin can cancel it, so the screen never offers a cancel
    /// that the server will refuse. A member's open booking can be; a no-show cannot.
    /// </summary>
    [SkippableFact]
    public async Task Each_conflict_says_whether_it_can_be_cancelled()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "unclrflag");
        var open = await SeedAsync(factory, club, At(Tuesday(1), 18), BookingStatus.Booked);
        // A no-show still holding the court. In life that is today's game past its grace window
        // with the occurrence later in its hour; a future row is the deterministic stand-in.
        var noShow = await SeedAsync(factory, club, At(Tuesday(2), 18), BookingStatus.NoShow);

        var response = await club.AdminClient(factory)
            .PostAsJsonAsync(Path + "/preview", Body(club, Tuesday(1), Tuesday(3)));

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var conflicts = body.GetProperty("conflicts").EnumerateArray()
            .ToDictionary(c => c.GetProperty("booking_id").GetGuid());
        Assert.Equal(2, conflicts.Count);
        Assert.True(conflicts[open].GetProperty("cancellable").GetBoolean());
        Assert.False(conflicts[noShow].GetProperty("cancellable").GetBoolean());
        Assert.Equal("no_show", conflicts[noShow].GetProperty("status").GetString());
        Assert.Equal(0, conflicts[noShow].GetProperty("would_refund_minutes").GetInt32());
    }

    /// <summary>
    /// The way past a conflict nobody can cancel: leave that date out. The series is created,
    /// the date is on it as a skipped date with a reason, no hold is written on it, and every
    /// other date is held as usual.
    /// </summary>
    [SkippableFact]
    public async Task Leaving_out_the_date_of_a_no_show_lets_the_series_be_created()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "unclrskip");
        var blocked = Tuesday(2);
        await SeedAsync(factory, club, At(blocked, 18), BookingStatus.NoShow);
        var client = club.AdminClient(factory);

        var refused = await client.PostAsJsonAsync(Path + "/", Body(club, Tuesday(1), Tuesday(3)));
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);

        var preview = await client.PostAsJsonAsync(Path + "/preview", Body(club, Tuesday(1), Tuesday(3), [blocked]));
        var previewBody = await preview.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(previewBody.GetProperty("conflicts").EnumerateArray());
        Assert.Equal(2, previewBody.GetProperty("occurrences").GetInt32());

        var created = await client.PostAsJsonAsync(Path + "/", Body(club, Tuesday(1), Tuesday(3), [blocked]));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var body = await created.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(2, body.GetProperty("rows_created").GetInt32());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var exception = await db.BookingScheduleExceptions.IgnoreQueryFilters()
            .SingleAsync(x => x.TenantId == club.TenantId);
        Assert.Equal(blocked, exception.OccurrenceDate);
        Assert.Equal(ScheduleExceptionKind.Skipped, exception.Kind);
        Assert.False(string.IsNullOrWhiteSpace(exception.Reason));

        var holds = await db.Bookings.IgnoreQueryFilters()
            .Where(b => b.TenantId == club.TenantId && b.ScheduleId != null).ToListAsync();
        Assert.DoesNotContain(holds, h => h.ScheduleOccurrenceDate == blocked);
    }

    /// <summary>
    /// A date to leave out that the rule never produces is not a skipped date — nothing is
    /// recorded about a Wednesday on a Tuesday series.
    /// </summary>
    [SkippableFact]
    public async Task A_date_the_rule_never_produces_is_not_recorded_as_skipped()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "unclrnoop");

        var created = await club.AdminClient(factory)
            .PostAsJsonAsync(Path + "/", Body(club, Tuesday(1), Tuesday(2), [Tuesday(1).AddDays(1)]));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Empty(await db.BookingScheduleExceptions.IgnoreQueryFilters()
            .Where(x => x.TenantId == club.TenantId).ToListAsync());
    }

    /// <summary>
    /// Bulk-cancel never reports a no-show or a played game as "already cancelled": the court is
    /// still held, so the row fails <c>not_cancellable</c> — and the rest of the batch still runs.
    /// </summary>
    [SkippableFact]
    public async Task Bulk_cancel_reports_a_no_show_as_not_cancellable_and_carries_on()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "unclrbulk");
        var noShow = await SeedAsync(factory, club, At(Tuesday(-1), 18), BookingStatus.NoShow);
        var played = await SeedAsync(factory, club, At(Tuesday(-1), 20), BookingStatus.Completed);
        var open = await SeedAsync(factory, club, At(Tuesday(1), 18), BookingStatus.Booked);

        var response = await club.AdminClient(factory).PostAsJsonAsync("/api/v1/admin/bookings/bulk-cancel", new
        {
            idempotencyKey = "unclr_bulk_1",
            reason = "League night",
            items = new[] { new { bookingId = noShow }, new { bookingId = played }, new { bookingId = open } },
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var results = body.GetProperty("results").EnumerateArray().ToList();
        Assert.Equal("failed", results[0].GetProperty("status").GetString());
        Assert.Equal("not_cancellable", results[0].GetProperty("error").GetString());
        Assert.Equal("failed", results[1].GetProperty("status").GetString());
        Assert.Equal("not_cancellable", results[1].GetProperty("error").GetString());
        Assert.Equal("cancelled", results[2].GetProperty("status").GetString());
        Assert.Equal(1, body.GetProperty("succeeded").GetInt32());
        Assert.Equal(2, body.GetProperty("failed").GetInt32());
    }
}
