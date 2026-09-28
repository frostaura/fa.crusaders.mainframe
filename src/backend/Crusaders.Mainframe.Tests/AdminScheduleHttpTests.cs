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
/// GOAL item 14 — repeating schedules, over HTTP and against the real schema.
///
/// <para>
/// <b>Postgres, because the whole design rests on one constraint.</b> Occurrences are
/// materialised as real <c>AdminBlock</c> rows precisely so that
/// <c>ck_bookings_no_overlapping_slot</c> — a GiST exclusion constraint that exists only on
/// Postgres — is what actually reserves the court. An in-memory suite would prove the loop runs
/// and nothing about whether league night is safe from a member's booking.
/// </para>
///
/// <para>
/// The recurrence ARITHMETIC is pinned separately and exhaustively in
/// <see cref="ScheduleOccurrenceTests"/>, across three clubs and a year of calendar. This file
/// is about the wire, the refusals, the conflict list and the rows on disk.
/// </para>
/// </summary>
public sealed class AdminScheduleHttpTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public AdminScheduleHttpTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string Path = "/api/v1/admin/schedules";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>A UTC club, so an occurrence's instant is its wall clock and a test can read it.</summary>
    private static Task<DoorClub> ClubAsync(TestWebAppFactory factory, string prefix)
        => DoorClub.SeedAsync(factory, prefix, DoorClub.DefaultSettings);

    /// <summary>The next Tuesday strictly after today, so nothing a test creates is already in the past.</summary>
    private static DateOnly NextTuesday(int weeksAhead = 1)
    {
        var day = DateOnly.FromDateTime(DateTime.UtcNow.Date).AddDays(weeksAhead * 7);
        while (day.DayOfWeek != DayOfWeek.Tuesday) day = day.AddDays(1);
        return day;
    }

    private static object Body(DoorClub club, DateOnly from, DateOnly? to = null, string name = "Tuesday league")
        => new
        {
            name,
            label = "League — Div 1",
            days = new[] { "tue" },
            start = "18:00",
            end = "21:00",
            startDate = from.ToString("yyyy-MM-dd"),
            endDate = to?.ToString("yyyy-MM-dd"),
            intervalWeeks = 1,
            courts = new[] { club.CourtId },
        };

    private static async Task<List<Booking>> OccurrenceRowsAsync(TestWebAppFactory factory, Guid tenantId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.Bookings.IgnoreQueryFilters()
            .Where(b => b.TenantId == tenantId && b.ScheduleId != null)
            .OrderBy(b => b.StartsAt).ToListAsync();
    }

    private static async Task<Guid> SeedMemberBookingAsync(
        TestWebAppFactory factory, DoorClub club, DateTimeOffset startsAt, decimal charged = 32m)
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
            AmountChargedCredits = charged,
            Status = BookingStatus.Booked,
            ChargedAt = DateTimeOffset.UtcNow,
        };
        db.Bookings.Add(booking);
        await db.SaveChangesAsync();
        return booking.Id;
    }

    // ------------------------------------------------------------------ create + materialise

    /// <summary>
    /// Creating a schedule writes real <c>AdminBlock</c> rows, and they are what reserves the
    /// court.
    ///
    /// <para>
    /// <b>The second half of this test is the one that matters.</b> A member booking over a
    /// materialised occurrence is refused by the exclusion constraint — not by schedule-aware
    /// code in <c>BookingService</c>, which does not exist and must not have to. That is the
    /// whole argument for materialising rather than resolving occurrences at read time: four
    /// readers already understand a block, and none of them would have understood a schedule.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_created_schedule_writes_blocks_that_actually_reserve_the_court()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schcreate");
        var from = NextTuesday();

        var response = await club.AdminClient(factory)
            .PostAsJsonAsync(Path + "/", Body(club, from, from.AddDays(21)));

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(4, body.GetProperty("rows_created").GetInt32());

        var rows = await OccurrenceRowsAsync(factory, club.TenantId);
        Assert.Equal(4, rows.Count);
        Assert.All(rows, r =>
        {
            Assert.Equal(BookingStatus.AdminBlock, r.Status);
            Assert.Null(r.UserId);
            Assert.Equal(0m, r.AmountChargedCredits);
            Assert.Equal("League — Div 1", r.BlockLabel);
            Assert.NotNull(r.ScheduleId);
            Assert.NotNull(r.ScheduleOccurrenceDate);
            Assert.Equal(18, r.StartsAt.UtcDateTime.Hour);
            Assert.Equal(3, (r.EndsAt - r.StartsAt).TotalHours);
        });

        // The constraint, not the code, is what stops a member booking league night.
        using var scope = factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>()
            .Set(club.TenantId, club.Slug);
        var bookings = scope.ServiceProvider.GetRequiredService<BookingService>();
        var outcome = await bookings.CreateAsync(
            club.CourtId, club.MemberUserId, club.MemberUserId, rows[0].StartsAt, 4, default);

        Assert.IsType<BookingResult.SlotTaken>(outcome);
    }

    /// <summary>
    /// An occurrence whose start has already passed is never written.
    ///
    /// <para>
    /// This is past-immutability at its source: a predicate on the one query that writes,
    /// rather than a rule four call sites have to remember.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task An_occurrence_already_in_the_past_is_never_written()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schpast");

        // Starts four weeks BEFORE today, runs four weeks past it.
        var start = NextTuesday(-4);
        var response = await club.AdminClient(factory)
            .PostAsJsonAsync(Path + "/", Body(club, start, start.AddDays(56)));

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        var rows = await OccurrenceRowsAsync(factory, club.TenantId);
        Assert.NotEmpty(rows);
        Assert.All(rows, r => Assert.True(
            r.StartsAt > DateTimeOffset.UtcNow,
            $"An occurrence at {r.StartsAt:o} is in the past and should never have been written."));
    }

    /// <summary>
    /// A materialised hold tells the grid WHICH plan it belongs to, by name.
    ///
    /// <para>
    /// The GRID lane renders a scheduled hold as the plan's name beside "Club hold". The
    /// cell's own words come from <c>BlockLabel</c> (the schedule's <c>Label</c>), which is
    /// not unique — two league nights can both be labelled "League". The NAME is unique per
    /// club, so it is what identifies the plan, and it is null on an ordinary booking and on a
    /// one-off admin block, which is how a cell tells a recurring hold from a hand-made one.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_scheduled_hold_names_its_plan_on_the_grid_read()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schgrid");
        var from = NextTuesday();
        var client = club.AdminClient(factory);

        await client.PostAsJsonAsync(Path + "/", Body(club, from, from.AddDays(7), "Tuesday league"));

        var grid = await client.GetFromJsonAsync<JsonElement>($"/api/v1/schedule?date={from:yyyy-MM-dd}");
        var hold = grid.GetProperty("slots").EnumerateArray()
            .Single(s => s.GetProperty("status").GetString() == "adminblock");

        Assert.Equal("Tuesday league", hold.GetProperty("scheduleName").GetString());
        Assert.NotEqual(JsonValueKind.Null, hold.GetProperty("scheduleId").ValueKind);
        // The cell's own words are still the LABEL, which is what the club wrote for the cell.
        Assert.Equal("League — Div 1", hold.GetProperty("blockLabel").GetString());
    }

    /// <summary>An ordinary booking names no plan, which is how the grid tells the two apart.</summary>
    [SkippableFact]
    public async Task An_ordinary_booking_names_no_plan()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schgridno");
        var day = DateOnly.FromDateTime(DateTime.UtcNow.Date).AddDays(3);
        await SeedMemberBookingAsync(
            factory, club, new DateTimeOffset(day.ToDateTime(new TimeOnly(9, 0)), TimeSpan.Zero));

        var grid = await club.AdminClient(factory)
            .GetFromJsonAsync<JsonElement>($"/api/v1/schedule?date={day:yyyy-MM-dd}");
        var slot = grid.GetProperty("slots").EnumerateArray().Single();

        Assert.Equal(JsonValueKind.Null, slot.GetProperty("scheduleId").ValueKind);
        Assert.Equal(JsonValueKind.Null, slot.GetProperty("scheduleName").ValueKind);
    }

    // ------------------------------------------------------------------ conflicts

    /// <summary>
    /// A member's booking in the way REFUSES the schedule and lists it — nothing is written, and
    /// the member keeps their court.
    ///
    /// <para>
    /// <b>There is no force flag and there will not be one.</b> A member who paid must be
    /// refunded deliberately, through a cancellation — the rule <c>AdminBlockService</c> already
    /// enforces for a single block, restated at the scale of a season. The conflict list carries
    /// <c>booking_id</c> and <c>would_refund_credits</c> so it can be pasted straight into
    /// bulk-cancel, which is the only reason items 5 and 14 were designed together.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_members_booking_in_the_way_refuses_the_schedule_and_lists_it()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schclash");
        var from = NextTuesday();
        var clashAt = new DateTimeOffset(from.ToDateTime(new TimeOnly(18, 0)), TimeSpan.Zero);
        var theirs = await SeedMemberBookingAsync(factory, club, clashAt, charged: 36m);

        var response = await club.AdminClient(factory)
            .PostAsJsonAsync(Path + "/", Body(club, from, from.AddDays(14)));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("schedule_conflicts", body.GetProperty("error").GetString());

        var conflict = body.GetProperty("conflicts").EnumerateArray().Single();
        Assert.Equal(theirs, conflict.GetProperty("booking_id").GetGuid());
        Assert.Equal("booking", conflict.GetProperty("kind").GetString());
        Assert.Equal("Door Member", conflict.GetProperty("member_name").GetString());
        Assert.Equal(36m, conflict.GetProperty("amount_credits").GetDecimal());
        Assert.True(conflict.GetProperty("would_refund_credits").GetDecimal() > 0m);

        // 409 writes NOTHING — not the schedule, not its courts, not one occurrence.
        Assert.Empty(await OccurrenceRowsAsync(factory, club.TenantId));
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        Assert.Empty(await db.BookingSchedules.IgnoreQueryFilters()
            .Where(s => s.TenantId == club.TenantId).ToListAsync());

        // And the member still has their court.
        var untouched = await db.Bookings.IgnoreQueryFilters().FirstAsync(b => b.Id == theirs);
        Assert.Equal(BookingStatus.Booked, untouched.Status);
    }

    /// <summary>
    /// The preview answers the same question without writing anything — which is what lets a
    /// calendar show the damage before an admin commits to it.
    /// </summary>
    [SkippableFact]
    public async Task The_preview_reports_the_same_conflicts_and_writes_nothing()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schprev");
        var from = NextTuesday();
        await SeedMemberBookingAsync(factory, club, new DateTimeOffset(from.ToDateTime(new TimeOnly(18, 0)), TimeSpan.Zero));

        var response = await club.AdminClient(factory)
            .PostAsJsonAsync(Path + "/preview", Body(club, from, from.AddDays(14)));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(3, body.GetProperty("occurrences").GetInt32());
        Assert.Equal(3, body.GetProperty("rows_to_create").GetInt32());
        Assert.Single(body.GetProperty("conflicts").EnumerateArray());
        Assert.Empty(await OccurrenceRowsAsync(factory, club.TenantId));
    }

    /// <summary>
    /// Two league nights on one court is a configuration error, and the refusal names the
    /// other schedule rather than reporting an anonymous clash.
    /// </summary>
    [SkippableFact]
    public async Task A_clash_with_another_schedule_names_that_schedule()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schvssch");
        var from = NextTuesday();
        var client = club.AdminClient(factory);

        var first = await client.PostAsJsonAsync(Path + "/", Body(club, from, from.AddDays(14), "Div 1 league"));
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);

        var second = await client.PostAsJsonAsync(Path + "/", Body(club, from, from.AddDays(14), "Div 2 league"));
        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);

        var body = await second.Content.ReadFromJsonAsync<JsonElement>();
        var conflict = body.GetProperty("conflicts").EnumerateArray().First();
        Assert.Equal("schedule", conflict.GetProperty("kind").GetString());
        Assert.Equal("Div 1 league", conflict.GetProperty("label").GetString());
        Assert.Equal(0m, conflict.GetProperty("would_refund_credits").GetDecimal());
    }

    // ------------------------------------------------------------------ refusals

    /// <summary>
    /// Every way a rule can be wrong has its own code, and the ones that need a figure carry it.
    ///
    /// <para>
    /// A volunteer admin told <c>schedule_not_slice_aligned</c> cannot act; told it with
    /// <c>slice_minutes: 15</c> beside it, they can.
    /// </para>
    /// </summary>
    [SkippableTheory]
    [InlineData("a", "League", "tue", "18:00", "21:00", 1, "schedule_name_invalid")]
    [InlineData("Tuesday league", "", "tue", "18:00", "21:00", 1, "schedule_label_invalid")]
    [InlineData("Tuesday league", "League", "funday", "18:00", "21:00", 1, "schedule_days_invalid")]
    [InlineData("Tuesday league", "League", "tue", "21:00", "18:00", 1, "schedule_time_range_invalid")]
    [InlineData("Tuesday league", "League", "tue", "18:05", "21:00", 1, "schedule_not_slice_aligned")]
    [InlineData("Tuesday league", "League", "tue", "18:00", "21:00", 9, "schedule_interval_out_of_range")]
    public async Task Every_way_a_rule_can_be_wrong_has_its_own_code(
        string name, string label, string day, string start, string end, int interval, string expected)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schbad");
        var from = NextTuesday();

        var response = await club.AdminClient(factory).PostAsJsonAsync(Path + "/", new
        {
            name,
            label,
            days = new[] { day },
            start,
            end,
            startDate = from.ToString("yyyy-MM-dd"),
            intervalWeeks = interval,
            courts = new[] { club.CourtId },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(expected, body.GetProperty("error").GetString());

        if (expected == "schedule_not_slice_aligned")
        {
            Assert.Equal(15, body.GetProperty("slice_minutes").GetInt32());
        }
    }

    /// <summary>A name is one name per club, and case is not a second name.</summary>
    [SkippableFact]
    public async Task A_name_another_schedule_already_has_is_refused_case_insensitively()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schname");
        var from = NextTuesday();
        var client = club.AdminClient(factory);

        await client.PostAsJsonAsync(Path + "/", Body(club, from, from.AddDays(7), "Tuesday League"));

        var response = await client.PostAsJsonAsync(
            Path + "/", Body(club, from.AddDays(1), from.AddDays(8), "tuesday league"));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("schedule_name_taken", body.GetProperty("error").GetString());
    }

    /// <summary>Another club's court is indistinguishable from an invented one.</summary>
    [SkippableFact]
    public async Task A_foreign_clubs_court_cannot_be_scheduled()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var clubA = await ClubAsync(factory, "schxta");
        var clubB = await ClubAsync(factory, "schxtb");

        var response = await clubA.AdminClient(factory)
            .PostAsJsonAsync(Path + "/", Body(clubB, NextTuesday()));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("schedule_courts_invalid", body.GetProperty("error").GetString());
    }

    /// <summary>One club cannot read, edit or end another club's schedule.</summary>
    [SkippableFact]
    public async Task A_foreign_clubs_schedule_is_not_found()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var clubA = await ClubAsync(factory, "schrda");
        var clubB = await ClubAsync(factory, "schrdb");
        var from = NextTuesday();

        var created = await clubB.AdminClient(factory)
            .PostAsJsonAsync(Path + "/", Body(clubB, from, from.AddDays(7)));
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("schedule").GetProperty("id").GetGuid();

        var client = clubA.AdminClient(factory);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"{Path}/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"{Path}/{id}/occurrences")).StatusCode);

        var ended = await client.PostAsJsonAsync($"{Path}/{id}/end", new { reason = "not mine" });
        Assert.Equal(HttpStatusCode.NotFound, ended.StatusCode);

        // And club B's own rows are untouched.
        Assert.NotEmpty(await OccurrenceRowsAsync(factory, clubB.TenantId));
    }

    /// <summary>A member cannot reach the schedules area at all.</summary>
    [SkippableFact]
    public async Task A_member_cannot_reach_the_schedules_area()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schrole");

        var response = await club.MemberClient(factory).GetAsync(Path + "/");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    // ------------------------------------------------------------------ editing

    /// <summary>
    /// A single date can be skipped, and its rows go — without touching any other date.
    /// </summary>
    [SkippableFact]
    public async Task Skipping_one_date_removes_only_that_dates_rows()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schskip");
        var from = NextTuesday();
        var client = club.AdminClient(factory);

        var created = await client.PostAsJsonAsync(Path + "/", Body(club, from, from.AddDays(21)));
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("schedule").GetProperty("id").GetGuid();
        Assert.Equal(4, (await OccurrenceRowsAsync(factory, club.TenantId)).Count);

        var skipped = from.AddDays(7);
        var response = await client.PatchAsJsonAsync(
            $"{Path}/{id}/occurrences/{skipped:yyyy-MM-dd}",
            new { skip = true, reason = "Hall hired out" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var rows = await OccurrenceRowsAsync(factory, club.TenantId);
        var live = rows.Where(r => r.Status != BookingStatus.Cancelled).ToList();
        Assert.Equal(3, live.Count);
        Assert.DoesNotContain(live, r => r.ScheduleOccurrenceDate == skipped);

        // And it stays skipped — a later materialisation must not quietly put it back.
        using (var scope = factory.Services.CreateScope())
        {
            scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>()
                .Set(club.TenantId, club.Slug);
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var schedules = scope.ServiceProvider.GetRequiredService<BookingScheduleService>();
            await schedules.MaterialiseAsync(await db.BookingSchedules.FirstAsync(s => s.Id == id), default);
        }

        var after = (await OccurrenceRowsAsync(factory, club.TenantId))
            .Where(r => r.Status != BookingStatus.Cancelled).ToList();
        Assert.Equal(3, after.Count);
        Assert.DoesNotContain(after, r => r.ScheduleOccurrenceDate == skipped);
    }

    /// <summary>
    /// A night a repeating booking cannot take — a member holds the court — is raised to the
    /// admins once (R23), however many sweeps re-collide with it while it stands: the notice is
    /// keyed on the schedule and its first clash, which is the night the horizon is stuck behind.
    /// </summary>
    [SkippableFact]
    public async Task A_clash_found_by_materialisation_is_one_admin_notice_across_sweeps()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schnotice");
        var from = NextTuesday();
        var created = await club.AdminClient(factory).PostAsJsonAsync(Path + "/", Body(club, from, from.AddDays(21)));
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("schedule").GetProperty("id").GetGuid();

        // Free one night the way a cancelled occurrence is freed, and let a member take it.
        var clash = from.AddDays(14);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.Bookings.IgnoreQueryFilters().SingleAsync(b => b.ScheduleId == id && b.ScheduleOccurrenceDate == clash);
            row.Status = BookingStatus.Cancelled;
            await db.SaveChangesAsync();
        }
        await SeedMemberBookingAsync(factory, club, new DateTimeOffset(clash.ToDateTime(new TimeOnly(18, 0)), TimeSpan.Zero));

        for (var i = 0; i < 3; i++)
        {
            using var scope = factory.Services.CreateScope();
            scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>().Set(club.TenantId, club.Slug);
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var outcome = await scope.ServiceProvider.GetRequiredService<BookingScheduleService>()
                .MaterialiseAsync(await db.BookingSchedules.FirstAsync(s => s.Id == id), default);
            Assert.Equal(1, outcome.Collisions);
        }

        var notices = await PeopleClub.ReadAsync(factory, db => db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.TenantId == club.TenantId && n.Kind == AdminEventCatalogue.ScheduleConflict).ToListAsync());
        var notice = Assert.Single(notices);
        Assert.Equal($"/admin/schedules/{id}", notice.Link);
        var payload = JsonSerializer.Deserialize<ScheduleConflictPayload>(notice.PayloadJson, AdminEventCatalogue.Json)!;
        Assert.Equal(clash.ToString("yyyy-MM-dd"), payload.FirstDate);
        Assert.Equal(1, payload.Collisions);
    }

    /// <summary>
    /// A past date cannot be skipped or re-timed, and the refusal names the date.
    ///
    /// <para>
    /// A date that was played, checked into, or that had a member's booking cancelled to make
    /// room for it is a fact, and a schedule edit must not rewrite the evidence.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_past_occurrence_cannot_be_edited()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schimmut");
        var start = NextTuesday(-4);
        var client = club.AdminClient(factory);

        var created = await client.PostAsJsonAsync(Path + "/", Body(club, start, start.AddDays(56)));
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("schedule").GetProperty("id").GetGuid();

        var response = await client.PatchAsJsonAsync(
            $"{Path}/{id}/occurrences/{start:yyyy-MM-dd}", new { skip = true, reason = "too late" });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("occurrence_in_past", body.GetProperty("error").GetString());
        // The date is echoed back, so a console can say WHICH date it refused rather than
        // "that is in the past" over a calendar with twelve of them on screen.
        Assert.Equal(start, DateOnly.Parse(body.GetProperty("occurrence_date").GetString()!));
    }

    /// <summary>
    /// Ending a series cancels its future and leaves its past exactly where it was.
    /// </summary>
    [SkippableFact]
    public async Task Ending_a_series_leaves_its_past_alone()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schend");
        var start = NextTuesday(-4);
        var client = club.AdminClient(factory);

        var created = await client.PostAsJsonAsync(Path + "/", Body(club, start, start.AddDays(56)));
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("schedule").GetProperty("id").GetGuid();

        var before = await OccurrenceRowsAsync(factory, club.TenantId);
        Assert.NotEmpty(before);

        var response = await client.PostAsJsonAsync($"{Path}/{id}/end", new { reason = "Season over" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var after = await OccurrenceRowsAsync(factory, club.TenantId);
        Assert.All(after, r => Assert.Equal(BookingStatus.Cancelled, r.Status));

        // The schedule survives — a series that ran is history, and there is no delete.
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.BookingSchedules.IgnoreQueryFilters().FirstAsync(s => s.Id == id);
        Assert.Equal(ScheduleStatus.Ended, row.Status);
    }

    /// <summary>
    /// Ending with an <c>effective_from</c> in the past is CLAMPED, and the response says so.
    ///
    /// <para>
    /// An admin typing last Tuesday means "from now on". Refusing would be pedantry; doing it
    /// silently would be worse, because the screen would then show a date the server did not use.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task An_effective_from_in_the_past_is_clamped_and_the_response_says_so()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schclamp");
        var from = NextTuesday();
        var client = club.AdminClient(factory);

        var created = await client.PostAsJsonAsync(Path + "/", Body(club, from, from.AddDays(21)));
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("schedule").GetProperty("id").GetGuid();

        var response = await client.PostAsJsonAsync($"{Path}/{id}/end", new
        {
            effectiveFrom = DateOnly.FromDateTime(DateTime.UtcNow.Date).AddDays(-30).ToString("yyyy-MM-dd"),
            reason = "Typed last month by mistake",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.NotEqual(JsonValueKind.Null, body.GetProperty("effective_from_clamped_to").ValueKind);
    }

    /// <summary>Ending without a reason is refused — somebody's court is about to go away.</summary>
    [SkippableFact]
    public async Task Ending_a_series_needs_a_reason()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schwhy");
        var from = NextTuesday();
        var client = club.AdminClient(factory);

        var created = await client.PostAsJsonAsync(Path + "/", Body(club, from, from.AddDays(7)));
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("schedule").GetProperty("id").GetGuid();

        var response = await client.PostAsJsonAsync($"{Path}/{id}/end", new { reason = "" });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // ------------------------------------------------------------------ the record

    /// <summary>
    /// Every schedule mutation lands in the change record nobody can delete from, with the
    /// field diff rendered in words.
    ///
    /// <para>
    /// A volunteer admin auditing their own club cannot be handed <c>1080</c> and asked to
    /// divide — the diff says "18:00".
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Creating_and_ending_a_schedule_both_land_in_the_undeletable_record()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await ClubAsync(factory, "schrec");
        var from = NextTuesday();
        var client = club.AdminClient(factory);

        var created = await client.PostAsJsonAsync(Path + "/", Body(club, from, from.AddDays(7)));
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("schedule").GetProperty("id").GetGuid();
        await client.PostAsJsonAsync($"{Path}/{id}/end", new { reason = "Season over" });

        var changes = await client.GetFromJsonAsync<JsonElement>("/api/v1/admin/changes?area=schedule");
        var rows = changes.GetProperty("rows").EnumerateArray().ToList();

        Assert.Equal(2, rows.Count);
        Assert.Contains(rows, r => r.GetProperty("action").GetString() == "schedule.created");
        Assert.Contains(rows, r => r.GetProperty("action").GetString() == "schedule.ended");

        var creation = rows.Single(r => r.GetProperty("action").GetString() == "schedule.created");
        Assert.Equal("Tuesday league", creation.GetProperty("subject").GetProperty("label").GetString());

        var diff = creation.GetProperty("changes").EnumerateArray().ToList();
        var startField = diff.Single(c => c.GetProperty("field").GetString() == "start_minute");
        Assert.Equal("18:00", startField.GetProperty("after").GetString());

        var daysField = diff.Single(c => c.GetProperty("field").GetString() == "days_of_week");
        Assert.Equal("Tue", daysField.GetProperty("after").GetString());

        // And the per-schedule view answers the same two rows.
        var mine = await client.GetFromJsonAsync<JsonElement>($"{Path}/{id}/changes");
        Assert.Equal(2, mine.GetProperty("rows").GetArrayLength());
    }
}
