using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// F3 — operating hours were configured, drawn on nothing and enforced by nobody.
///
/// <para>
/// <c>tenant_settings.operating_hours</c> has been written by the seeder since the first
/// commit and read by NOTHING: a grep of the whole tree found the seeder that writes it
/// and one validation string, and that was all. The consequences compounded. The grid was
/// drawn from a single flat <c>day_start_minute</c>/<c>day_end_minute</c> pair, so a club
/// that shuts at 20:00 on Saturday showed bookable slots to 21:45. <c>BookingService</c>
/// consulted neither the map nor the flat pair, so the API sold 03:00 on a Sunday — and
/// since the grid begins at 06:00, the member who bought it could not see it, could not
/// cancel it and could not be refunded from the app.
/// </para>
///
/// <para>
/// Times here are pinned absolutely rather than derived from <c>UtcNow</c>: a test about
/// opening hours that books "two hours from now" is a test that passes or fails depending
/// on when the suite runs, which is the trap <c>TestHost.BookableSlot</c> already exists
/// to close from the other direction.
/// </para>
/// </summary>
public class OperatingHoursTests
{
    /// <summary>
    /// A Saturday comfortably in the future, on the fixture's UTC clock.
    ///
    /// <para>
    /// The WEEKDAY is what these tests are about — the club's Saturday hours differ from
    /// its weekday hours — and the day must also be in the future, because
    /// <c>CreateAsync</c> refuses a past slot before it ever reaches the hours rule. A
    /// hard-coded date satisfies the first and stops satisfying the second the moment it
    /// passes, so it is computed. `advance_booking_days` is opened wide in the fixture
    /// below to let it through.
    /// </para>
    /// </summary>
    private static DateOnly Saturday
    {
        get
        {
            var d = DateOnly.FromDateTime(DateTime.UtcNow).AddDays(8);
            while (d.DayOfWeek != DayOfWeek.Saturday) d = d.AddDays(1);
            return d;
        }
    }

    private const string WeekdayHours = "06:00-22:00";
    private const string WeekendHours = "07:00-20:00";

    /// <summary>The Crusaders seed's own map, on the fixture's UTC clock so the local day and the UTC day agree.</summary>
    private static async Task GiveClubRealHoursAsync(TestHost host)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.TenantSettings.FirstAsync(s => s.TenantId == host.Tenant.Id);
        row.SettingsJson = """
            {"slice_minutes":15,"slice_price_credits":8,"penalty_pct":30,"grace_window_minutes":5,
             "penalty_window_minutes":15,"advance_booking_days":3650,"timezone":"UTC",
             "member_per_day_max_minutes":0,"peak_hours":"","day_start_minute":360,"day_end_minute":1320,
             "operating_hours":{"mon":"06:00-22:00","tue":"06:00-22:00","wed":"06:00-22:00","thu":"06:00-22:00",
                                "fri":"06:00-22:00","sat":"07:00-20:00","sun":"07:00-20:00"}}
            """;
        await db.SaveChangesAsync();
    }

    private static DateTimeOffset At(DateOnly day, int hour, int minute = 0)
        => new(day.Year, day.Month, day.Day, hour, minute, 0, TimeSpan.Zero);

    // ---- The setting is read at all ----

    [Fact]
    public void Operating_hours_are_read_off_the_settings_document_per_weekday()
    {
        using var doc = JsonDocument.Parse(
            $$$"""{"operating_hours":{"mon":"{{{WeekdayHours}}}","sat":"{{{WeekendHours}}}"}}""");
        var hours = OperatingHours.FromSettings(doc.RootElement);

        Assert.Equal((6 * 60, 22 * 60), hours.For(DayOfWeek.Monday));
        Assert.Equal((7 * 60, 20 * 60), hours.For(DayOfWeek.Saturday));
        // A day the map does not name has no answer of its own; the caller falls back.
        Assert.Null(hours.For(DayOfWeek.Sunday));
    }

    [Theory]
    // Nonsense must not close the club — it must fall through to the flat default.
    [InlineData("""{"operating_hours":{"mon":"not a range"}}""")]
    [InlineData("""{"operating_hours":{"mon":"22:00-06:00"}}""")]   // close before open is a typo, not an overnight club
    [InlineData("""{"operating_hours":{"mon":"06:00"}}""")]
    [InlineData("""{"operating_hours":"06:00-22:00"}""")]           // wrong shape entirely
    [InlineData("""{}""")]
    public void A_malformed_operating_hours_document_is_ignored_rather_than_obeyed(string json)
    {
        using var doc = JsonDocument.Parse(json);
        Assert.Null(OperatingHours.FromSettings(doc.RootElement).For(DayOfWeek.Monday));
    }

    // ---- The rule is enforced where the money is taken ----

    [Fact]
    public async Task A_member_cannot_book_after_the_club_shuts()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveClubRealHoursAsync(host);
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500, host.PlayerUser.Id), default);
        var before = await ledger.GetBalanceAsync(host.PlayerUser.Id, default);

        // 21:45 on a Saturday whose configured close is 20:00 — the exact slot finder B
        // was sold, and charged 50.00 credits for.
        var result = await booking.CreateAsync(
            host.Courts[3].Id, host.PlayerUser.Id, host.PlayerUser.Id, At(Saturday, 21, 45), sliceCount: 1, default);

        var refused = Assert.IsType<BookingResult.OutOfHours>(result);
        Assert.Equal("07:00", refused.OpensAt);
        Assert.Equal("20:00", refused.ClosesAt);
        // And nothing was taken. This is the half that made the finding "high": the
        // member was charged for court time that does not exist.
        Assert.Equal(before, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.Empty(await scope.ServiceProvider.GetRequiredService<MainframeDbContext>().Bookings.ToListAsync());
    }

    [Fact]
    public async Task A_member_cannot_book_the_small_hours_the_grid_can_never_draw()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveClubRealHoursAsync(host);
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500, host.PlayerUser.Id), default);

        // 03:00 on the Sunday. Before this rule existed the API answered 200 and debited
        // 50.00 for a slot that appears on no screen in the product.
        var result = await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, At(Saturday.AddDays(1), 3, 0), sliceCount: 1, default);

        Assert.IsType<BookingResult.OutOfHours>(result);
    }

    [Fact]
    public async Task A_booking_that_would_run_past_closing_is_refused_whole_rather_than_truncated()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveClubRealHoursAsync(host);
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500, host.PlayerUser.Id), default);

        // 19:45 + two 15-minute slices ends at 20:15, fifteen minutes past close. Half an
        // hour was asked for and half of it does not exist; selling the first half is a
        // decision the member never made.
        var result = await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, At(Saturday, 19, 45), sliceCount: 2, default);

        Assert.IsType<BookingResult.OutOfHours>(result);
    }

    [Fact]
    public async Task Inside_the_configured_window_the_booking_goes_through_untouched()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveClubRealHoursAsync(host);
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500, host.PlayerUser.Id), default);

        // 07:00 Saturday is the first bookable minute of the day and must not be refused
        // by an off-by-one; 19:45–20:00 is the last, ending exactly at close.
        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, At(Saturday, 7, 0), sliceCount: 1, default));
        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[1].Id, host.PlayerUser.Id, host.PlayerUser.Id, At(Saturday, 19, 45), sliceCount: 1, default));
    }

    [Fact]
    public async Task The_weekday_map_beats_the_flat_pair_where_it_names_the_day()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveClubRealHoursAsync(host);
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500, host.PlayerUser.Id), default);

        // The flat pair says 06:00-22:00 and the Saturday map says 07:00-20:00. 06:30 on a
        // Saturday is inside the flat pair and outside the map; the map has to win, or the
        // per-weekday setting means nothing whenever the flat default is wider.
        Assert.IsType<BookingResult.OutOfHours>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, At(Saturday, 6, 30), sliceCount: 1, default));

        // The following Monday IS in the map at 06:00-22:00, so 06:30 is fine there.
        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, At(Saturday.AddDays(2), 6, 30), sliceCount: 1, default));
    }

    [Fact]
    public async Task A_club_with_no_weekday_map_still_gets_the_flat_pair_enforced()
    {
        await using var host = await TestHost.CreateAsync();
        using (var seed = host.NewScope())
        {
            var db = seed.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.TenantSettings.FirstAsync(s => s.TenantId == host.Tenant.Id);
            row.SettingsJson = """
                {"slice_minutes":15,"slice_price_credits":8,"advance_booking_days":3650,"timezone":"UTC",
                 "member_per_day_max_minutes":0,"peak_hours":"","day_start_minute":360,"day_end_minute":1320}
                """;
            await db.SaveChangesAsync();
        }
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500, host.PlayerUser.Id), default);

        var refused = Assert.IsType<BookingResult.OutOfHours>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, At(Saturday, 23, 0), sliceCount: 1, default));
        Assert.Equal("06:00", refused.OpensAt);
        Assert.Equal("22:00", refused.ClosesAt);
    }

    [Fact]
    public async Task An_admin_booking_on_behalf_is_not_stopped_by_opening_hours()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveClubRealHoursAsync(host);
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500, host.PlayerUser.Id), default);

        // "Admin always bypasses caps and peak-hour rules" (A.6/A.11), and the club's own
        // staff are the people who legitimately need a court at 06:00 on a Saturday.
        // ActorIsAdmin is stated rather than inferred from actorId != userId (D2-B13).
        var payer = new BookingPayer(host.PlayerUser.Id, host.AdminUser.Id, ActorIsAdmin: true);
        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[0].Id, payer, At(Saturday, 6, 0), sliceCount: 1, default));
    }

    // ---- The grid is drawn to the same hours the rule enforces ----

    [Fact]
    public async Task The_schedule_reports_the_hours_of_the_day_it_was_asked_for()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveClubRealHoursAsync(host);
        using var scope = host.NewScope();
        var schedule = scope.ServiceProvider.GetRequiredService<ScheduleService>();

        var saturday = await schedule.GetDayAsync(Saturday, host.PlayerUser.Id, default);
        var monday = await schedule.GetDayAsync(Saturday.AddDays(2), host.PlayerUser.Id, default);

        // Same two field names on the wire, now answering per day rather than flat — which
        // is what makes the grid stop drawing rows nobody may book.
        Assert.Equal(7 * 60, saturday.DayStartMinute);
        Assert.Equal(20 * 60, saturday.DayEndMinute);
        Assert.Equal(6 * 60, monday.DayStartMinute);
        Assert.Equal(22 * 60, monday.DayEndMinute);
    }

    // ---- A walk-up at the box obeys the same clock ----

    [Fact]
    public async Task A_walk_up_is_truncated_at_closing_time_rather_than_selling_the_night()
    {
        await using var host = await TestHost.CreateAsync();
        using (var seed = host.NewScope())
        {
            var db = seed.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.TenantSettings.FirstAsync(s => s.TenantId == host.Tenant.Id);
            // A window that certainly contains "now" and certainly closes soon after it,
            // so the assertion is about truncation and not about what hour the suite runs.
            var now = DateTimeOffset.UtcNow;
            var closeMinute = Math.Min((now.Hour * 60) + now.Minute + 10, 24 * 60);
            row.SettingsJson =
                $$"""{"slice_minutes":15,"slice_price_credits":8,"timezone":"UTC","day_start_minute":0,"day_end_minute":{{closeMinute}}}""";
            await db.SaveChangesAsync();
        }
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500, host.PlayerUser.Id), default);

        // Ninety minutes asked for, roughly ten available. The box sells what is there.
        var result = await booking.CreateWalkUpAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, 90, "walkup:test:close", default);

        var ok = Assert.IsType<BookingResult.Ok>(result);
        var minutes = (ok.Booking.EndsAt - ok.Booking.StartsAt).TotalMinutes;
        Assert.InRange(minutes, 1, 11);
    }
    // ---- what the admin console writes is what the rule reads (R2 G-F2) ----

    /// <summary>
    /// The loop the settings screen depends on: the exact document
    /// <see cref="OperatingHours.TryParseWire"/> produces for the admin API is the document
    /// <see cref="OperatingHours.FromSettings"/> reads back, and <see cref="BookingService"/>
    /// then enforces it.
    ///
    /// <para>
    /// This is the half of G-F2 that a settings test cannot reach. A club could not change
    /// its opening hours at all — the console offered only the flat pair, the engine read the
    /// per-weekday map, and the two never met — so an editor for the map is only worth having
    /// if what it writes is refused and allowed at exactly the hours it names. Hours are given
    /// here in the loose form a person types (a missing leading zero) to prove the
    /// normalisation is the thing that closes the loop rather than a coincidence of format.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Hours_written_the_way_the_admin_API_writes_them_are_the_hours_enforced()
    {
        Assert.True(OperatingHours.TryParseWire(
            new Dictionary<string, string> { ["sat"] = "8:00-13:00" }, out var normalised, out var badDay));
        Assert.Null(badDay);
        Assert.Equal("08:00-13:00", normalised["sat"]);

        await using var host = await TestHost.CreateAsync();
        using (var seed = host.NewScope())
        {
            var db = seed.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var row = await db.TenantSettings.FirstAsync(s => s.TenantId == host.Tenant.Id);
            var map = JsonSerializer.Serialize(normalised);
            row.SettingsJson = $$"""
                {"slice_minutes":15,"slice_price_credits":8,"penalty_pct":30,"grace_window_minutes":5,
                 "penalty_window_minutes":15,"advance_booking_days":3650,"timezone":"UTC",
                 "member_per_day_max_minutes":0,"peak_hours":"","day_start_minute":360,"day_end_minute":1320,
                 "operating_hours":{{map}}}
                """;
            await db.SaveChangesAsync();
        }

        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500, host.PlayerUser.Id), default);

        // 13:00 is the new close, so the 13:00 slice is the first one that no longer exists.
        var refused = Assert.IsType<BookingResult.OutOfHours>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, At(Saturday, 13, 0), sliceCount: 1, default));
        Assert.Equal("08:00", refused.OpensAt);
        Assert.Equal("13:00", refused.ClosesAt);

        // 08:00 is the new open, and the club's old 07:00 Saturday is now shut.
        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, At(Saturday, 8, 0), sliceCount: 1, default));
        Assert.IsType<BookingResult.OutOfHours>(await booking.CreateAsync(
            host.Courts[1].Id, host.PlayerUser.Id, host.PlayerUser.Id, At(Saturday, 7, 0), sliceCount: 1, default));
    }

    [Fact]
    public void The_wire_form_of_a_map_is_what_the_settings_screen_shows()
    {
        using var doc = JsonDocument.Parse(
            """{"operating_hours":{"sat":"07:00-20:00","mon":"06:00-22:00","nonsense":"x"}}""");
        var wire = OperatingHours.FromSettings(doc.RootElement).ToWire();

        // Weekday order, whatever order the document was written in, and a key the engine
        // could not read is not shown as if it were in force.
        Assert.Equal(["mon", "sat"], wire.Keys.ToArray());
        Assert.Equal("06:00-22:00", wire["mon"]);
        Assert.Equal("07:00-20:00", wire["sat"]);
    }
}
