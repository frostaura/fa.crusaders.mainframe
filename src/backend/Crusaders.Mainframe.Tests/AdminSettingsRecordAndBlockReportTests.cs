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
/// Two defects that schedules turn from a nuisance into a permanent one.
///
/// <para>
/// <b>D2-B19</b> — the settings PUT wrote no record at all. Its sharpest form:
/// <c>door_log_retention_days</c> is the cutoff <c>RetentionWorker</c> DELETES audit rows
/// against, so lowering it to seven destroys the club's door record and left no trace of who
/// lowered it.
/// </para>
///
/// <para>
/// <b>D2-B35</b> — all three club reports counted <c>Status != Cancelled</c>, which includes
/// <c>AdminBlock</c>. Today that is a nuisance; with item 14's league seasons adding hundreds of
/// block rows a term, utilisation and the no-show percentage become materially and permanently
/// wrong.
/// </para>
/// </summary>
public sealed class AdminSettingsRecordAndBlockReportTests : IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _pg;

    public AdminSettingsRecordAndBlockReportTests(PostgresFixture pg) => _pg = pg;

    private const string Skipped = "Postgres not configured — set API_BOUNDARY_TEST_CONNECTION_STRING";
    private const string SettingsPath = "/api/v1/admin/settings/";

    private TestWebAppFactory CreateFactory() => new() { ConnectionString = _pg.ConnectionString };

    /// <summary>The PUT is a full replace of the required members, so every save sends all eight.</summary>
    private static Dictionary<string, object?> BaseSave() => new()
    {
        ["sliceMinutes"] = 15,
        ["slicePriceCredits"] = 8m,
        ["advanceBookingDays"] = 14,
        ["dayStartMinute"] = 0,
        ["dayEndMinute"] = 1440,
        ["penaltyPct"] = 30m,
        ["graceWindowMinutes"] = 5,
        ["penaltyWindowMinutes"] = 15,
    };

    private static async Task<List<AdminChangeLog>> ChangeRowsAsync(TestWebAppFactory factory, Guid tenantId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        return await db.AdminChangeLogs.IgnoreQueryFilters()
            .Where(a => a.TenantId == tenantId).ToListAsync();
    }

    // ------------------------------------------------------------------ D2-B19

    /// <summary>
    /// Narrowing the club's door retention writes an undeletable row naming who did it, with
    /// the old value and the new one.
    ///
    /// <para>
    /// This is the case the whole record exists for: the number decides what a background
    /// worker DELETES, and it was editable with no trace whatsoever.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Narrowing_the_door_retention_is_recorded_with_both_values()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "setrec");
        var client = club.AdminClient(factory);

        var first = BaseSave();
        first["doorLogRetentionDays"] = 90;
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, first)).StatusCode);

        var second = BaseSave();
        second["doorLogRetentionDays"] = 7;
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, second)).StatusCode);

        var rows = (await ChangeRowsAsync(factory, club.TenantId))
            .Where(r => r.Action == AdminChangeActions.SettingsUpdated).ToList();

        Assert.Equal(2, rows.Count);
        Assert.All(rows, r => Assert.Equal("Door Admin", r.ActorName));

        var narrowing = rows.Single(r => r.BeforeJson is not null && r.BeforeJson.Contains("90"));
        Assert.Contains("door_log_retention_days", narrowing.BeforeJson);
        Assert.Contains("7", narrowing.AfterJson);

        // And the read endpoint renders it as a sentence an admin can act on.
        var changes = await client.GetFromJsonAsync<JsonElement>("/api/v1/admin/changes?area=setting");
        var row = changes.GetProperty("rows").EnumerateArray()
            .First(r => r.GetProperty("changes").EnumerateArray()
                .Any(c => c.GetProperty("field").GetString() == "door_log_retention_days"));

        var field = row.GetProperty("changes").EnumerateArray()
            .Single(c => c.GetProperty("field").GetString() == "door_log_retention_days");
        Assert.Equal("90", field.GetProperty("before").GetString());
        Assert.Equal("7", field.GetProperty("after").GetString());
    }

    /// <summary>
    /// A save that changes nothing writes nothing.
    ///
    /// <para>
    /// The settings screen reads back what it was shown and PUTs it — that round trip is the
    /// defect <c>AdminSettingsHttpTests</c> is named for — so a record that logged every save
    /// would fill the one undeletable table in the product with rows saying "an admin opened a
    /// page". A record nobody can read is a record nobody reads.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Saving_the_same_settings_twice_records_the_change_once()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "setnoop");
        var client = club.AdminClient(factory);

        await client.PutAsJsonAsync(SettingsPath, BaseSave());
        var before = (await ChangeRowsAsync(factory, club.TenantId)).Count;

        await client.PutAsJsonAsync(SettingsPath, BaseSave());

        Assert.Equal(before, (await ChangeRowsAsync(factory, club.TenantId)).Count);
    }

    /// <summary>
    /// The schedule horizon may not be narrower than the club's own booking window.
    ///
    /// <para>
    /// A cross-field rule, refused where there is a person to tell. Left unrefused, a member
    /// books fourteen days out into a league night the materialiser has not written yet, and
    /// nobody finds out until the night.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_horizon_shorter_than_the_booking_window_is_refused()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "sethorizon");

        var save = BaseSave();
        save["advanceBookingDays"] = 30;
        save["scheduleMaterialisationDays"] = 14;

        var response = await club.AdminClient(factory).PutAsJsonAsync(SettingsPath, save);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("advance_days_exceed_schedule_horizon", body.GetProperty("error").GetString());
    }

    /// <summary>Each new number is bounded on the PUT with its own code.</summary>
    [SkippableTheory]
    [InlineData("adminBulkMaxItems", 0, "admin_bulk_max_items_out_of_range")]
    [InlineData("adminBulkMaxItems", 501, "admin_bulk_max_items_out_of_range")]
    [InlineData("scheduleMaterialisationDays", 3, "schedule_materialisation_days_out_of_range")]
    [InlineData("scheduleMaxRowsPerChange", 5, "schedule_max_rows_out_of_range")]
    [InlineData("scheduleWorkerIntervalSeconds", 5, "schedule_worker_interval_out_of_range")]
    [InlineData("memberTraceMaxEvents", 10, "member_trace_max_events_out_of_range")]
    [InlineData("memberTraceMaxEvents", 5000, "member_trace_max_events_out_of_range")]
    public async Task Each_new_number_is_bounded_on_the_put(string key, int value, string expected)
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "setbound");

        var save = BaseSave();
        save[key] = value;

        var response = await club.AdminClient(factory).PutAsJsonAsync(SettingsPath, save);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(expected, body.GetProperty("error").GetString());
    }

    /// <summary>
    /// A hand-edited column outside the bounds is CLAMPED on read, never a 500.
    ///
    /// <para>
    /// The PUT is not the only way a value reaches the settings column, and
    /// <c>DoorSettings</c>' own header states the rule these readers follow. A bulk ceiling of
    /// fifty thousand in a restored document is one request holding fifty thousand payer locks.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_hand_edited_column_is_clamped_on_read()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "setclamp");

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.TenantSettings.IgnoreQueryFilters()
                .FirstAsync(s => s.TenantId == club.TenantId);
            row.SettingsJson =
                """{"slice_minutes":15,"timezone":"UTC","admin_bulk_max_items":50000,"schedule_materialisation_days":9999,"schedule_worker_interval_seconds":1}""";
            await db.SaveChangesAsync();
        }

        using var read = factory.Services.CreateScope();
        read.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>()
            .Set(club.TenantId, club.Slug);
        var view = await read.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);

        Assert.Equal(BulkSettings.MaxMaxItems, BulkSettings.MaxItems(view));
        Assert.Equal(ScheduleSettings.MaxMaterialisationDays, ScheduleSettings.MaterialisationDays(view));
        Assert.Equal(
            TimeSpan.FromSeconds(ScheduleSettings.MinWorkerIntervalSeconds),
            ScheduleSettings.WorkerInterval(view));
    }

    /// <summary>
    /// The night-trace kill switch is a club decision, editable from the settings screen and
    /// round-tripped by it.
    ///
    /// <para>
    /// <b>Written as a real JSON boolean, and read as one.</b> The accessor's <c>TryBool</c>
    /// accepts <c>true</c>/<c>false</c> only; a coerced <c>"false"</c> would leave a club that
    /// believed it had switched the trace OFF with it on, which is the one direction this
    /// particular key must never fail in.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task The_night_trace_can_be_switched_off_and_the_switch_round_trips()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "settrace");
        var client = club.AdminClient(factory);

        // On by default, so a club that has never opened this page can still answer
        // "who was here last night" after a break-in.
        var before = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
        Assert.True(before.GetProperty("member_trace_enabled").GetBoolean());

        var save = BaseSave();
        save["memberTraceEnabled"] = false;
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(SettingsPath, save)).StatusCode);

        var after = await client.GetFromJsonAsync<JsonElement>(SettingsPath);
        Assert.False(after.GetProperty("member_trace_enabled").GetBoolean());

        using var scope = factory.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Multitenancy.ITenantContext>()
            .Set(club.TenantId, club.Slug);
        var view = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(default);
        Assert.False(TraceSettings.Enabled(view));
    }

    // ------------------------------------------------------------------ D2-B35

    /// <summary>
    /// Blocking four courts reports no paid use, and says how much time was held.
    ///
    /// <para>
    /// <b>A before/after fixture, because the point is that the numbers MOVE.</b> The same
    /// window is read with a member's booking alone and then again with four hours of blocks
    /// added; <c>booked_minutes</c> and <c>bookings</c> must be identical across the two, and
    /// <c>blocked_minutes</c> must account for the difference. A test that only asserted the
    /// second read could pass against the old behaviour with a different fixture.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task A_block_adds_held_minutes_and_no_booked_minutes()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "repblock");
        var day = DateTimeOffset.UtcNow.AddDays(-1).Date;
        var slot = new DateTimeOffset(day.AddHours(9), TimeSpan.Zero);

        await SeedAsync(factory, club, slot, BookingStatus.Booked, charged: 32m);
        var client = club.AdminClient(factory);
        var window = $"?from={day:yyyy-MM-dd}&to={day.AddDays(1):yyyy-MM-dd}";

        var before = await client.GetFromJsonAsync<JsonElement>("/api/v1/admin/reports/utilisation" + window);
        var beforeCourt = before.GetProperty("by_court").EnumerateArray().Single();
        var beforeMinutes = beforeCourt.GetProperty("booked_minutes").GetInt32();
        var beforeCount = beforeCourt.GetProperty("bookings").GetInt32();

        await SeedAsync(factory, club, new DateTimeOffset(day.AddHours(12), TimeSpan.Zero), BookingStatus.AdminBlock);
        await SeedAsync(factory, club, new DateTimeOffset(day.AddHours(13), TimeSpan.Zero), BookingStatus.AdminBlock);

        var after = await client.GetFromJsonAsync<JsonElement>("/api/v1/admin/reports/utilisation" + window);
        var afterCourt = after.GetProperty("by_court").EnumerateArray().Single();

        Assert.Equal(beforeMinutes, afterCourt.GetProperty("booked_minutes").GetInt32());
        Assert.Equal(beforeCount, afterCourt.GetProperty("bookings").GetInt32());
        Assert.Equal(120, afterCourt.GetProperty("blocked_minutes").GetInt32());
    }

    /// <summary>
    /// A block cannot be a no-show, so it does not dilute the percentage.
    ///
    /// <para>
    /// One booking, swept as a no-show, is 100%. Adding three blocked courts used to make it
    /// 25% — and with a league season in the denominator, permanently wrong.
    /// </para>
    /// </summary>
    [SkippableFact]
    public async Task Blocks_do_not_dilute_the_no_show_percentage()
    {
        Skip.IfNot(_pg.Available, Skipped);

        await using var factory = CreateFactory();
        var club = await DoorClub.SeedAsync(factory, "repnoshow");
        var day = DateTimeOffset.UtcNow.AddDays(-1).Date;
        var window = $"?from={day:yyyy-MM-dd}&to={day.AddDays(1):yyyy-MM-dd}";

        await SeedAsync(factory, club, new DateTimeOffset(day.AddHours(9), TimeSpan.Zero), BookingStatus.NoShow, 32m);
        var client = club.AdminClient(factory);

        var before = await client.GetFromJsonAsync<JsonElement>("/api/v1/admin/reports/no-shows" + window);
        Assert.Equal(100.0, before.GetProperty("no_show_pct").GetDouble());

        foreach (var hour in new[] { 12, 13, 14 })
        {
            await SeedAsync(factory, club, new DateTimeOffset(day.AddHours(hour), TimeSpan.Zero), BookingStatus.AdminBlock);
        }

        var after = await client.GetFromJsonAsync<JsonElement>("/api/v1/admin/reports/no-shows" + window);
        Assert.Equal(1, after.GetProperty("total").GetInt32());
        Assert.Equal(100.0, after.GetProperty("no_show_pct").GetDouble());
    }

    private static async Task SeedAsync(
        TestWebAppFactory factory, DoorClub club, DateTimeOffset startsAt,
        BookingStatus status, decimal charged = 0m)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var isBlock = status == BookingStatus.AdminBlock;

        db.Bookings.Add(new Booking
        {
            TenantId = club.TenantId,
            CourtId = club.CourtId,
            UserId = isBlock ? null : club.MemberUserId,
            BookedByUserId = isBlock ? null : club.MemberUserId,
            PaidByUserId = isBlock ? null : club.MemberUserId,
            ActorUserId = isBlock ? club.AdminUserId : club.MemberUserId,
            StartsAt = startsAt.ToUniversalTime(),
            EndsAt = startsAt.AddHours(1).ToUniversalTime(),
            SliceMinutes = 15,
            SliceCount = 4,
            AmountChargedCredits = charged,
            Status = status,
            BlockLabel = isBlock ? "Maintenance" : null,
        });
        await db.SaveChangesAsync();
    }
}
