using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Walk-ups: a member buying light time at the court, there and then.
///
/// <para>
/// The decision on record is that a walk-up is a <b>real booking</b> — in the member's name,
/// visible online immediately, charged and refunded by the same rules as one made from the
/// app. That is what keeps there being one money path instead of two, and it is why these
/// tests assert on ledger rows and schedule visibility rather than on a bespoke result type.
/// </para>
///
/// <para>
/// Two things are genuinely its own. A walk-up is <b>truncated at the next booking</b>, and it
/// is therefore <b>charged what it grants</b>: the whole minutes sold, rounded down off the wall
/// clock so the member keeps the part-minute (P13, contract §1.2). A twenty-minute sale costs 20.
/// </para>
/// </summary>
public class WalkUpBookingTests
{
    // TestHost fixture: 15-minute slices. A minute of court costs a minute (§1.1).
    private const int SliceMinutes = 15;

    private sealed record Fixture(
        TestHost Host, IServiceScope Scope, BookingService Bookings,
        LedgerService Ledger, MainframeDbContext Db, string ClubZone)
    {
        /// <summary>
        /// A slot this club will actually sell, chosen in <b>this club's</b> clock.
        ///
        /// <para>
        /// It is a method on the fixture rather than a call to
        /// <see cref="TestHost.BookableSlot"/> for the reason
        /// <see cref="TestHost.NowClearOfClosingAsync"/> gives about its own return value: a
        /// test that picks a slot in one statement and moves the club in another can lose
        /// the second and still compile. <see cref="CreateAsync"/> moves this club to
        /// <see cref="ClubZone"/>, and a slot cannot be got from here without it.
        /// </para>
        /// </summary>
        public DateTimeOffset BookableSlot(double hoursAhead = 2) =>
            TestHost.BookableSlotAt(ClubZone, hoursAhead);
    }

    private static async Task<Fixture> CreateAsync(int topUpMinutes = 200)
    {
        var host = await TestHost.CreateAsync();
        var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        if (topUpMinutes > 0)
        {
            await ledger.PostAsync(
                new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, topUpMinutes, host.PlayerUser.Id), default);
        }

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        // A walk-up is sold from the service's own UtcNow and cannot be moved the way
        // TestHost.BookableSlot moves a booking, so the club is moved instead: into a zone
        // where the whole hard cap still fits before local closing time. Without this,
        // three tests in this class assert 60 or 90 minutes and get whatever is left of the
        // local day — green for twenty-three hours out of twenty-four and red for the last
        // one. See TestHost.DayZoneFor.
        //
        // The zone travels on the Fixture because moving the club moves its peak window and
        // its midnight too: any BOOKING this class makes has to be placed in the club's
        // clock from here on. Fixture.BookableSlot is that, and it is the only way to ask.
        var clubZone = await TestHost.ClearOfClosingAsync(db, host.Tenant.Id, RelayHardCap.Minutes);

        return new Fixture(
            host, scope,
            scope.ServiceProvider.GetRequiredService<BookingService>(),
            ledger,
            db,
            clubZone);
    }

    /// <summary>
    /// Someone else's booking on the same court, placed relative to now.
    ///
    /// <para>
    /// The half-minute cushion is what makes the truncation assertions deterministic. The
    /// walk-up floors its granted time to whole minutes — it must never sell past the next
    /// booking's start — so a blocking booking placed at exactly <c>now + 20m</c> is
    /// <c>now + 19m 59.9s</c> by the time the service reads the clock, and the sale is
    /// nineteen minutes. That is the service behaving correctly and the test measuring
    /// carelessly. Offsetting by 30 seconds puts the boundary well inside a minute, so the
    /// floor lands on the same number however slowly the test runs.
    /// </para>
    /// </summary>
    private static async Task AddBookingAsync(Fixture f, int startsInMinutes, int minutes, int plusSeconds = 30)
    {
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(startsInMinutes).AddSeconds(plusSeconds);
        f.Db.Bookings.Add(new Booking
        {
            TenantId = f.Host.Tenant.Id,
            CourtId = f.Host.Courts[0].Id,
            UserId = f.Host.LeaguePlayerUser.Id,
            BookedByUserId = f.Host.LeaguePlayerUser.Id,
            PaidByUserId = f.Host.LeaguePlayerUser.Id,
            ActorUserId = f.Host.LeaguePlayerUser.Id,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(minutes),
            SliceMinutes = SliceMinutes,
            SliceCount = minutes / SliceMinutes,
            AmountChargedMinutes = minutes,
            Status = BookingStatus.Booked,
            ChargedAt = DateTimeOffset.UtcNow,
        });
        await f.Db.SaveChangesAsync();
    }

    private static Task<BookingResult> WalkUpAsync(Fixture f, int minutes) =>
        f.Bookings.CreateWalkUpAsync(
            f.Host.Courts[0].Id, f.Host.PlayerUser.Id, f.Host.PlayerUser.Id, minutes,
            DeviceEventEndpoints.WalkUpReference(Guid.NewGuid(), Guid.NewGuid().ToString("N")[..16]), default);

    /// <summary>
    /// The fix for five flakes, tested at every hour instead of at the hour the suite runs —
    /// the same discipline as <c>BookingTests.A_bookable_slot_is_never_inside_peak_hours…</c>,
    /// for the other kind of purchase.
    ///
    /// <para>
    /// A walk-up starts at the service's own <c>UtcNow</c> and cannot be moved, so the club
    /// is moved instead. This asserts the promise <see cref="TestHost.DayZoneFor"/> makes:
    /// whatever the wall clock says, the zone it picks leaves the whole hard cap in front of
    /// the purchase and is past opening. It converts through the real tzdb rather than
    /// repeating the helper's arithmetic, because <c>Etc/GMT+n</c> is <c>UTC−n</c> and a
    /// helper with the sign inverted would agree with itself perfectly.
    /// </para>
    ///
    /// <para>
    /// Minutes as well as hours: sweeping only on the hour would leave every local time at
    /// :00, and 22:00 + 90 minutes lands exactly on midnight, which passes while 22:50 does
    /// not.
    /// </para>
    /// </summary>
    [Fact]
    public void The_day_zone_leaves_room_at_every_hour_of_the_day()
    {
        var midnight = new DateTimeOffset(2026, 9, 1, 0, 0, 0, TimeSpan.Zero);
        foreach (var minute in new[] { 0, 1, 30, 45, 50, 59 })
        {
            for (var hour = 0; hour < 24; hour++)
            {
                var now = midnight.AddHours(hour).AddMinutes(minute);
                var zone = TimeZoneInfo.FindSystemTimeZoneById(TestHost.DayZoneFor(now, RelayHardCap.Minutes));
                var local = TimeZoneInfo.ConvertTime(now, zone);
                var minuteOfDay = (local.Hour * 60) + local.Minute;
                var where = $"(UTC {now:HH:mm} in {zone.Id}, local {local:HH:mm})";

                Assert.True(minuteOfDay >= 60, $"the club has only just opened {where}");
                Assert.True(
                    minuteOfDay + RelayHardCap.Minutes <= 24 * 60,
                    $"a {RelayHardCap.Minutes}-minute walk-up runs past local midnight {where}");
            }
        }
    }

    /// <summary>
    /// The other half of that promise, and the half that was missing: once the club has been
    /// moved, a <b>booking</b> made by the same fixture has to be placed in the club's clock
    /// too.
    ///
    /// <para>
    /// <c>A_walk_up_is_a_lights_purchase_and_a_booked_slot_is_a_booking_charge</c> asked
    /// <see cref="TestHost.BookableSlot"/> for a slot three hours out and was refused
    /// <c>PeakHoursLeagueOnly</c> — reproduced on the base commit at 23:50 UTC on
    /// 2026-09-07. 23:50 + 3h is 02:50 UTC, which no UTC peak window contains; but
    /// <see cref="CreateAsync"/> had moved this club to UTC+14 to keep the walk-up clear of
    /// closing, and 02:50 UTC is 16:50 there. The club's own peak window is where the slot
    /// has to be measured, and <see cref="TestHost.DayZoneFor"/> chooses a different zone
    /// every few hours, so the offending combination arrives and leaves on its own.
    /// </para>
    ///
    /// <para>
    /// <b>This one is not the thirty-minute window the other five share, and it is worth
    /// saying so because <c>memory/gotchas.md</c> lists all six together.</b> Driven at every
    /// hour with a synthetic clock, the base commit is red at 23:0x, 00:0x and 01:0x and
    /// green at the other twenty-one — three whole hours, because at UTC+14 those are the
    /// UTC hours whose three-hour-ahead slot lands in 16:00–19:00 local. It is a different
    /// mechanism (the club's peak window) from the other five (the club's midnight), and it
    /// arrives and leaves as <see cref="TestHost.DayZoneFor"/> changes zone.
    /// </para>
    ///
    /// <para>
    /// Every minute rather than every hour, and both distances the class asks for, because
    /// the helper's second clause is wider than the rule it protects: it steps out of local
    /// hour 23 entirely, and the violations of THAT clause sit at 06:00–10:00 UTC where a
    /// 15-minute booking still fits before midnight and nothing goes red. Sweeping the
    /// helper's own promise rather than one caller's consequence is what makes those visible.
    /// </para>
    /// </summary>
    /// <summary>
    /// The same promise, made through <b>the wrapper every fixture actually calls</b>.
    ///
    /// <para>
    /// The sweep below pins <see cref="TestHost.BookableSlotFrom(DateTimeOffset, double,
    /// TimeZoneInfo?)"/> — the arithmetic. <see cref="TestHost.BookableSlotAt"/> is what
    /// <c>Fixture.BookableSlot</c> calls, and it was unpinned: rewriting its body to pass
    /// <c>club: null</c>, which is precisely the defect the whole fix exists to remove, left
    /// every test in this class green when run at 02:31 UTC. A wrapper that reads its own clock
    /// is catchable only at the unlucky hours, which is the same trap one layer up — so the
    /// wrapper now takes the clock and this sweeps it.
    /// </para>
    /// </summary>
    [Fact]
    public void The_wrapper_the_fixtures_call_keeps_the_same_promise_at_every_minute()
    {
        var midnight = new DateTimeOffset(2026, 9, 1, 0, 0, 0, TimeSpan.Zero);
        for (var minute = 0; minute < 24 * 60; minute++)
        {
            var now = midnight.AddMinutes(minute);
            var zoneId = TestHost.DayZoneFor(now, RelayHardCap.Minutes);
            var zone = TimeZoneInfo.FindSystemTimeZoneById(zoneId);

            foreach (var hoursAhead in new[] { 2d, 3d })
            {
                var slot = TestHost.BookableSlotAt(zoneId, hoursAhead, now);
                var local = TimeZoneInfo.ConvertTime(slot, zone);
                var where = $"(UTC {now:HH:mm} + {hoursAhead}h -> {slot:HH:mm}Z, {zoneId} local {local:HH:mm})";

                Assert.True(
                    local.Hour is < 15 or >= 19,
                    $"the slot is inside the club's own 16:00-19:00 peak window {where}");
                Assert.True(local.Hour != 23, $"the slot runs into the club's own midnight {where}");
                Assert.True(slot > now, $"a bookable slot is in the future {where}");

                // …and it is the zone-aware answer, not merely an out-of-peak one. Without this
                // the wrapper could satisfy the three assertions above by any route that happens
                // to dodge peak, rather than by asking in the club's clock.
                Assert.Equal(TestHost.BookableSlotFrom(now, hoursAhead, zone), slot);
            }
        }
    }

    [Fact]
    public void A_slot_picked_for_a_moved_club_is_never_inside_that_clubs_peak_or_its_last_hour()
    {
        var midnight = new DateTimeOffset(2026, 9, 1, 0, 0, 0, TimeSpan.Zero);
        for (var minute = 0; minute < 24 * 60; minute++)
        {
            var now = midnight.AddMinutes(minute);
            var zoneId = TestHost.DayZoneFor(now, RelayHardCap.Minutes);
            var zone = TimeZoneInfo.FindSystemTimeZoneById(zoneId);

            foreach (var hoursAhead in new[] { 2d, 3d })
            {
                var slot = TestHost.BookableSlotFrom(now, hoursAhead, zone);
                var local = TimeZoneInfo.ConvertTime(slot, zone);
                var where = $"(UTC {now:HH:mm} + {hoursAhead}h -> {slot:HH:mm}Z, {zoneId} local {local:HH:mm})";

                Assert.True(
                    local.Hour is < 15 or >= 19,
                    $"the slot is inside the club's own 16:00-19:00 peak window {where}");

                // Callers book up to an hour on one slot, so the last local hour is out for
                // the same reason the club-less overload keeps out of it.
                Assert.True(local.Hour != 23, $"the slot runs into the club's own midnight {where}");

                Assert.True(slot > now, $"a bookable slot is in the future {where}");
            }
        }
    }

    /// <summary>
    /// The two-argument <see cref="TestHost.BookableSlotFrom(DateTimeOffset, double)"/> steps
    /// clear of peak <b>in whatever offset it is handed</b>, and that contract has a caller.
    ///
    /// <para>
    /// <c>MoneySurfaceTests.A_booking_charges_comment_is_in_the_clubs_wall_clock</c> moves its
    /// club to Africa/Johannesburg and hands this helper
    /// <c>ConvertTime(UtcNow, Africa/Johannesburg)</c> for exactly that reason — its own
    /// comment says a UTC-chosen slot is peak at a SAST club and cost it two red hours a day.
    /// Nothing pinned the contract, so adding the zone-aware overload beside it was one line
    /// away from measuring a SAST club's peak window on the runner's clock and re-creating
    /// that flake in a file nobody was looking at. This is that pin, swept over every minute
    /// of the day so it is red at any hour rather than at the unlucky ones.
    /// </para>
    /// </summary>
    [Fact]
    public void A_slot_chosen_in_a_clubs_own_offset_stays_out_of_that_clubs_peak()
    {
        var club = TimeZoneInfo.FindSystemTimeZoneById("Africa/Johannesburg");
        var midnight = new DateTimeOffset(2026, 9, 1, 0, 0, 0, TimeSpan.Zero);

        for (var minute = 0; minute < 24 * 60; minute++)
        {
            var clubNow = TimeZoneInfo.ConvertTime(midnight.AddMinutes(minute), club);
            var slot = TestHost.BookableSlotFrom(clubNow, 2);
            var local = TimeZoneInfo.ConvertTime(slot, club);
            var where = $"(UTC {midnight.AddMinutes(minute):HH:mm} -> SAST {local:HH:mm})";

            Assert.True(local.Hour is < 15 or >= 19, $"the slot is inside the club's peak window {where}");
            Assert.True(local.Hour != 23, $"the slot runs into the club's own midnight {where}");
        }
    }

    /// <summary>
    /// The helper the five walk-up tests rest on actually moves the club, at any hour.
    ///
    /// <para>
    /// The previous round's fix was effective and unpinned <b>against its own removal</b>: a
    /// refuter made <see cref="TestHost.ClearOfClosingAsync"/> a no-op with an early return
    /// and every test in this class, in <c>DeviceEventHttpTests</c> and in
    /// <c>ConcurrentDecisionTests</c> stayed green — the original flake restored in silence
    /// and visible for one hour a day.
    /// <c>The_day_zone_leaves_room_at_every_hour_of_the_day</c> could not catch it, because
    /// it exercises <see cref="TestHost.DayZoneFor"/>'s arithmetic in isolation and nothing
    /// asserted that anything calls it.
    /// </para>
    ///
    /// <para>
    /// This compares against the seeded literal as well as against the helper's own answer.
    /// The seed writes <c>"UTC"</c> and <see cref="TestHost.DayZoneFor"/> never returns that
    /// string — its UTC case is the tzdb id <c>Etc/UTC</c> — so a helper that writes nothing
    /// fails here at every hour of the day rather than at the unlucky ones.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Clearing_the_club_of_closing_actually_writes_the_zone()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var before = JsonDocument.Parse(
            (await db.TenantSettings.IgnoreQueryFilters().SingleAsync(x => x.TenantId == host.Tenant.Id)).SettingsJson);
        Assert.Equal("UTC", before.RootElement.GetProperty("timezone").GetString());

        var now = await TestHost.NowClearOfClosingAsync(db, host.Tenant.Id, RelayHardCap.Minutes);

        var after = JsonDocument.Parse(
            (await db.TenantSettings.IgnoreQueryFilters().SingleAsync(x => x.TenantId == host.Tenant.Id)).SettingsJson);
        var written = after.RootElement.GetProperty("timezone").GetString();

        Assert.NotEqual("UTC", written);
        Assert.Equal(TestHost.DayZoneFor(now, RelayHardCap.Minutes), written);

        // And the zone it wrote really does leave the room it promised, read back through
        // the tzdb rather than through the helper's own arithmetic.
        var local = TimeZoneInfo.ConvertTime(now, TimeZoneInfo.FindSystemTimeZoneById(written!));
        Assert.True(
            (local.Hour * 60) + local.Minute + RelayHardCap.Minutes <= 24 * 60,
            $"a {RelayHardCap.Minutes}-minute walk-up still runs past local midnight (local {local:HH:mm} in {written})");

        // Nothing else in the settings document moved: the club's prices, slice length and
        // windows are what the tests around this one are asserting on. Compared before
        // against after rather than against literals, so this stays a statement about the
        // helper rather than a second copy of the fixture.
        foreach (var key in new[] { "day_end_minute", "day_start_minute", "slice_minutes", "slice_price_credits", "peak_hours", "penalty_pct" })
        {
            Assert.Equal(
                before.RootElement.GetProperty(key).GetRawText(),
                after.RootElement.GetProperty(key).GetRawText());
        }
    }

    // ---- Pricing ----------------------------------------------------------

    /// <summary>
    /// A clear court sells exactly what was asked for, at what an online booking of the same
    /// length costs: an hour is 60 minutes, four fifteen-minute slices.
    /// </summary>
    [Fact]
    public async Task A_walk_up_on_a_clear_court_costs_the_ordinary_tariff()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var ok = Assert.IsType<BookingResult.Ok>(await WalkUpAsync(f, 60));

        Assert.Equal(60, ok.Booking.AmountChargedMinutes);
        Assert.Equal(200 - 60, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
        Assert.Equal(60, (int)(ok.Booking.EndsAt - ok.Booking.StartsAt).TotalMinutes);
    }

    /// <summary>
    /// A partial slice: twenty minutes on a fifteen-minute tariff. The sale is the whole minutes
    /// granted, not a slice count rounded up (that would be 30) — so a twenty-minute sale costs 20.
    /// </summary>
    [Fact]
    public async Task A_partial_slice_is_charged_the_whole_minutes_it_grants()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        // Someone has the court in 20 minutes, so that is all there is to sell.
        await AddBookingAsync(f, startsInMinutes: 20, minutes: 30);

        var ok = Assert.IsType<BookingResult.Ok>(await WalkUpAsync(f, 60));

        Assert.Equal(20, (int)(ok.Booking.EndsAt - ok.Booking.StartsAt).TotalMinutes);
        Assert.Equal(20, ok.Booking.AmountChargedMinutes);
        Assert.Equal(200 - 20, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
    }

    /// <summary>
    /// The row has to describe the time it actually sold. Every other booking satisfies
    /// <c>SliceMinutes × SliceCount == EndsAt − StartsAt</c>, and a walk-up that broke that
    /// would misreport its own duration to the schedule, the reports and the court box.
    /// </summary>
    [Fact]
    public async Task A_truncated_walk_up_describes_its_real_duration()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        await AddBookingAsync(f, startsInMinutes: 25, minutes: 30);

        var ok = Assert.IsType<BookingResult.Ok>(await WalkUpAsync(f, 60));
        var b = ok.Booking;

        Assert.Equal(
            (int)(b.EndsAt - b.StartsAt).TotalMinutes,
            b.SliceMinutes * b.SliceCount);
        Assert.Equal(25, b.SliceMinutes * b.SliceCount);
    }

    // ---- Truncation edges -------------------------------------------------

    /// <summary>A court someone is playing on right now has no time to sell at any price.</summary>
    [Fact]
    public async Task A_walk_up_on_a_court_that_is_in_use_is_refused()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        await AddBookingAsync(f, startsInMinutes: -5, minutes: 30, plusSeconds: 0);

        Assert.IsType<BookingResult.SlotTaken>(await WalkUpAsync(f, 30));
        Assert.Equal(200, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
    }

    /// <summary>
    /// Truncated to nothing. Reported apart from <see cref="BookingResult.SlotTaken"/> on
    /// purpose: the court is free and the next player is simply imminent, and a 16×2 LCD
    /// saying "court busy" when nobody is on it sends the member away for no reason.
    /// </summary>
    [Fact]
    public async Task A_walk_up_with_no_time_before_the_next_booking_is_refused_as_such()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        // Strictly ahead — so the court is genuinely free — but not by a whole minute, which
        // is the smallest unit that can be sold.
        await AddBookingAsync(f, startsInMinutes: 0, minutes: 30, plusSeconds: 30);

        var refused = Assert.IsType<BookingResult.NoTimeAvailable>(await WalkUpAsync(f, 30));
        Assert.Equal(30, refused.RequestedMinutes);
        Assert.Equal(200, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
    }

    /// <summary>A cancelled booking is history, not an obstruction — its slot is on sale.</summary>
    [Fact]
    public async Task A_cancelled_booking_does_not_truncate_a_walk_up()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        await AddBookingAsync(f, startsInMinutes: 20, minutes: 30);
        var blocking = await f.Db.Bookings.FirstAsync(b => b.UserId == f.Host.LeaguePlayerUser.Id);
        blocking.Status = BookingStatus.Cancelled;
        await f.Db.SaveChangesAsync();

        var ok = Assert.IsType<BookingResult.Ok>(await WalkUpAsync(f, 60));
        Assert.Equal(60, (int)(ok.Booking.EndsAt - ok.Booking.StartsAt).TotalMinutes);
    }

    // ---- It is a real booking ---------------------------------------------

    /// <summary>
    /// The point of the decision. A walk-up is in the member's name, in the schedule, and
    /// paid for out of the same ledger — not a side channel that reconciles separately.
    /// </summary>
    [Fact]
    public async Task A_walk_up_is_an_ordinary_booking_in_the_members_name()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var ok = Assert.IsType<BookingResult.Ok>(await WalkUpAsync(f, 30));

        var stored = await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == ok.Booking.Id);
        Assert.Equal(f.Host.PlayerUser.Id, stored.UserId);
        Assert.Equal(f.Host.PlayerUser.Id, stored.PaidByUserId);
        Assert.Equal(BookingStatus.Booked, stored.Status);
        Assert.NotNull(stored.ChargedAt);

        // LightsPurchase, not BookingCharge — see
        // A_walk_up_is_a_lights_purchase_and_a_booked_slot_is_a_booking_charge.
        var charge = Assert.Single(await f.Db.LedgerEntries
            .Where(l => l.RelatedBookingId == ok.Booking.Id && l.Type == LedgerEntryType.LightsPurchase)
            .ToListAsync());
        Assert.Equal(-30, charge.AmountMinutes);

        Assert.Single(await f.Db.AuditLogs.Where(a => a.Action == "booking.walk_up_created").ToListAsync());
    }

    /// <summary>
    /// Attendance is not stamped here. It comes from <c>CourtActivationService</c> like every
    /// other identification, so there is still exactly one producer of <c>CheckedInAt</c> and
    /// <c>booking.lights_on</c> — the whole point of extracting that service.
    /// </summary>
    [Fact]
    public async Task A_walk_up_is_checked_in_by_the_activation_path_not_at_creation()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var ok = Assert.IsType<BookingResult.Ok>(await WalkUpAsync(f, 30));
        Assert.Null(ok.Booking.CheckedInAt);

        var activation = f.Scope.ServiceProvider.GetRequiredService<CourtActivationService>();
        var result = await activation.ActivateAsync(
            f.Host.Courts[0], ok.Booking, f.Host.PlayerUser.Id, null, "qr", default);

        var activated = Assert.IsType<ActivationResult.Activated>(result);
        Assert.False(activated.AlreadyActive);

        var stored = await f.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == ok.Booking.Id);
        Assert.NotNull(stored.CheckedInAt);

        // Charged once, at creation — activation settles who pays, it does not re-charge.
        Assert.Single(await f.Db.LedgerEntries
            .Where(l => l.RelatedBookingId == ok.Booking.Id && l.Type == LedgerEntryType.LightsPurchase)
            .ToListAsync());
        Assert.Equal(200 - 30, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
    }

    /// <summary>
    /// The court does not light up on credit. Same rule as an online booking, and the same
    /// consequence: nothing is written, so there is nothing to unwind.
    /// </summary>
    [Fact]
    public async Task A_walk_up_the_member_cannot_afford_is_refused_and_writes_nothing()
    {
        var f = await CreateAsync(topUpMinutes: 5);
        await using var _ = f.Host;
        using var __ = f.Scope;

        var refused = Assert.IsType<BookingResult.InsufficientBalance>(await WalkUpAsync(f, 30));
        Assert.Equal(5, refused.CurrentMinutes);
        Assert.Equal(30, refused.RequiredMinutes);

        Assert.Empty(await f.Db.Bookings.ToListAsync());
        Assert.Equal(5, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
    }

    /// <summary>
    /// The two ways a member pays for court time, told apart in the ledger.
    ///
    /// <para>
    /// <see cref="LedgerEntryType.LightsPurchase"/> was declared for exactly this — "light
    /// time bought directly at the court, rather than as part of a booked slot… the club
    /// wants to see the two apart in reporting" — and then nothing ever posted it. Every
    /// walk-up landed as a <see cref="LedgerEntryType.BookingCharge"/>, so any report
    /// filtering on it was guaranteed to be empty and the split the club asked for did not
    /// exist in the data at all.
    /// </para>
    ///
    /// <para>
    /// Both types are in <c>LedgerEntryTypes.Spend</c>, so no bucket total moves and no
    /// balance changes — which is precisely why nothing failed when it was wrong.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_walk_up_is_a_lights_purchase_and_a_booked_slot_is_a_booking_charge()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var walkUp = Assert.IsType<BookingResult.Ok>(await WalkUpAsync(f, 30));

        var booked = Assert.IsType<BookingResult.Ok>(await f.Bookings.CreateAsync(
            f.Host.Courts[1].Id, f.Host.PlayerUser.Id, f.Host.PlayerUser.Id,
            f.BookableSlot(3), sliceCount: 1, default));

        var walkUpEntry = Assert.Single(await f.Db.LedgerEntries
            .Where(l => l.RelatedBookingId == walkUp.Booking.Id).ToListAsync());
        var bookedEntry = Assert.Single(await f.Db.LedgerEntries
            .Where(l => l.RelatedBookingId == booked.Booking.Id).ToListAsync());

        Assert.Equal(LedgerEntryType.LightsPurchase, walkUpEntry.Type);
        Assert.Equal(LedgerEntryType.BookingCharge, bookedEntry.Type);

        // Both still count as money spent, so the member's balance is unaffected by which
        // name the row carries.
        Assert.True(walkUpEntry.AmountMinutes < 0 && bookedEntry.AmountMinutes < 0);
    }

    /// <summary>
    /// A negative slice count credits the member.
    ///
    /// <para>
    /// <c>sliceCount</c> came straight off the request body unchecked, and the whole method
    /// runs backwards on a negative one: <c>endsAt</c> lands before <c>startsAt</c>, the
    /// overlap predicate cannot match an inverted range, the per-day cap sees negative
    /// minutes and passes, <c>totalCost</c> comes out negative, and the balance guard
    /// <c>balance &lt; totalCost</c> evaluates <c>0 &lt; -200</c> and passes as well. The
    /// posting is then <c>-(-200)</c>, which pays the member for booking a court.
    /// </para>
    ///
    /// <para>
    /// What stopped it in production was Postgres refusing an inverted <c>tstzrange</c> while
    /// maintaining the exclusion index — SQLSTATE 22000, not the 23P01 the overlap catch
    /// filters on, so a 500 rather than a refusal. This test runs on the in-memory provider,
    /// which has neither the constraint nor the numeric column, so before the guard it
    /// genuinely credited the account.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(-4)]
    [InlineData(-1)]
    [InlineData(0)]
    public async Task A_booking_of_no_positive_length_is_refused(int sliceCount)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var before = await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default);

        var refused = Assert.IsType<BookingResult.InvalidDuration>(await f.Bookings.CreateAsync(
            f.Host.Courts[0].Id, f.Host.PlayerUser.Id, f.Host.PlayerUser.Id,
            f.BookableSlot(3), sliceCount, default));

        Assert.Equal(sliceCount, refused.RequestedSlices);
        Assert.Empty(await f.Db.Bookings.ToListAsync());
        Assert.Equal(before, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
    }

    /// <summary>
    /// The other end of the same hole. An admin actor bypasses the per-day cap, so without an
    /// upper bound a single booking can span years and be priced accordingly.
    /// </summary>
    [Fact]
    public async Task A_booking_longer_than_a_day_is_refused()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var refused = Assert.IsType<BookingResult.InvalidDuration>(await f.Bookings.CreateAsync(
            f.Host.Courts[0].Id, f.Host.PlayerUser.Id, f.Host.AdminUser.Id,
            f.BookableSlot(3), sliceCount: 97, default));

        Assert.Equal(96, refused.MaxSlices);
        Assert.Empty(await f.Db.Bookings.ToListAsync());
    }

    // ---- The box's view: which court, how long, and again -----------------
    //
    // Driven through the endpoint's decision method rather than over HTTP, because the
    // questions here are about money and courts and not about signatures. The signed wire
    // is covered in DeviceEventHttpTests.

    /// <summary>The MAC every box in this suite announces. One box, so one MAC.</summary>
    private const string BoxMac = "ff0000000001";

    private static async Task<Device> BoxOnAsync(Fixture f, params int[] courtNumbers)
    {
        var device = new Device
        {
            TenantId = f.Host.Tenant.Id,
            DeviceCode = "court-box-1",
            Name = "The box",
            Kind = DeviceKind.CourtBox,
            MacAddress = BoxMac,
            CourtNumbers = [.. courtNumbers],
        };
        f.Db.Devices.Add(device);
        await f.Db.SaveChangesAsync();
        return device;
    }

    private static WalkUpServices ServicesOf(Fixture f) => new(
        f.Db,
        f.Bookings,
        f.Scope.ServiceProvider.GetRequiredService<CourtActivationService>(),
        f.Scope.ServiceProvider.GetRequiredService<IdentificationResolver>(),
        f.Scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>(),
        f.Ledger,
        f.Scope.ServiceProvider.GetRequiredService<DeviceFaultSink>(),
        f.Scope.ServiceProvider.GetRequiredService<AccessCodeService>(),
        f.Scope.ServiceProvider.GetRequiredService<MemberCodeService>(),
        f.Scope.ServiceProvider.GetRequiredService<TimeProvider>());

    private static async Task<string> CodeAsync(Fixture f) =>
        (await f.Scope.ServiceProvider.GetRequiredService<AccessCodeService>()
            .MintIdentAsync(f.Host.PlayerUser.Id, TimeSpan.FromSeconds(60), default)).Code;

    private static WalkUpRequest Request(string code, int court, int minutes = 30, string? nonce = null) =>
        new(BoxMac, minutes, "qr", code, court, nonce ?? Guid.NewGuid().ToString("N")[..16]);

    private static (int Status, JsonElement Body) Unwrap(IResult result) => (
        (result as IStatusCodeHttpResult)?.StatusCode ?? StatusCodes.Status200OK,
        JsonSerializer.SerializeToElement((result as IValueHttpResult)?.Value));

    /// <summary>
    /// The C5 headline. One box, four relays; the member pressed COURT B. Court A is busy
    /// and court B is free, and the ONLY court the answer may touch is B — booked, charged
    /// and activated — while A is left alone. The old contract carried no court, so the
    /// backend charged the box's configured court while the firmware lit the one pressed.
    /// </summary>
    [Fact]
    public async Task A_walk_up_books_charges_and_lights_the_court_the_member_selected_while_another_is_busy()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1, 2);
        await AddBookingAsync(f, startsInMinutes: -5, minutes: 30, plusSeconds: 0);   // court 1 is in use
        var courtB = f.Host.Courts[1];

        var (status, body) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(await CodeAsync(f), court: 2, minutes: 30), ServicesOf(f), default));

        Assert.Equal(200, status);
        Assert.Equal(30, body.GetProperty("granted_minutes").GetInt32());
        Assert.False(body.GetProperty("replayed").GetBoolean());

        var booking = await f.Db.Bookings.AsNoTracking().SingleAsync(b => b.UserId == f.Host.PlayerUser.Id);
        Assert.Equal(courtB.Id, booking.CourtId);
        Assert.NotEqual(f.Host.Courts[0].Id, booking.CourtId);
        Assert.NotNull(booking.CheckedInAt);
        Assert.Equal(booking.Id, body.GetProperty("booking_id").GetGuid());

        // Charged for court B, and the audit row says so.
        Assert.Equal(200 - 30, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
        var activated = Assert.Single(await f.Db.AuditLogs.Where(a => a.Action == "court.activated").ToListAsync());
        Assert.Contains($"\"court_number\":{courtB.CourtNumber}", activated.DetailsJson);
    }

    /// <summary>The same press on the busy court is refused as busy — the court named, not the box's first.</summary>
    [Fact]
    public async Task A_walk_up_on_the_selected_court_is_refused_when_that_court_is_busy()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1, 2);
        await AddBookingAsync(f, startsInMinutes: -5, minutes: 30, plusSeconds: 0);   // court 1 is in use

        var (status, body) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(await CodeAsync(f), court: 1), ServicesOf(f), default));

        Assert.Equal(409, status);
        Assert.Equal("court_in_use", body.GetProperty("error").GetString());
        Assert.Empty(await f.Db.Bookings.Where(b => b.UserId == f.Host.PlayerUser.Id).ToListAsync());
    }

    /// <summary>
    /// A court the box does not drive is refused before anything is looked up. A box that
    /// could name any court is a box that opens any court in the club.
    /// </summary>
    [Theory]
    [InlineData(3)]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task A_walk_up_on_a_court_the_box_does_not_drive_is_refused(int court)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1, 2);

        var (status, body) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(await CodeAsync(f), court), ServicesOf(f), default));

        Assert.Equal(400, status);
        Assert.Equal("court_not_on_device", body.GetProperty("error").GetString());
        Assert.Empty(await f.Db.Bookings.ToListAsync());
        Assert.Equal(200, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
    }

    /// <summary>
    /// Minutes past the relay hard cap are refused, whatever the tenant setting says. The
    /// bound was a hardcoded 240 while the relay bank cuts the lights at ninety — the member
    /// paid for the difference in darkness (review M1). A hand-edited setting of 240 must not
    /// reopen it, which is why the bound is the smaller of the two.
    /// </summary>
    [Theory]
    [InlineData(null, 91)]
    [InlineData(null, 240)]
    [InlineData(240, 120)]
    [InlineData(60, 61)]
    public async Task A_walk_up_longer_than_the_cap_is_refused(int? walkUpMaxSetting, int minutes)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        if (walkUpMaxSetting is { } configured)
        {
            var row = await f.Db.TenantSettings.FirstAsync();
            row.SettingsJson = row.SettingsJson.TrimEnd('}') + $",\"walk_up_max_minutes\":{configured}}}";
            await f.Db.SaveChangesAsync();
        }

        var box = await BoxOnAsync(f, 1);

        var (status, body) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(await CodeAsync(f), court: 1, minutes), ServicesOf(f), default));

        Assert.Equal(400, status);
        Assert.Equal("minutes_out_of_range", body.GetProperty("error").GetString());
        Assert.Equal(Math.Min(walkUpMaxSetting ?? RelayHardCap.Minutes, RelayHardCap.Minutes),
            body.GetProperty("max_minutes").GetInt32());
        Assert.Empty(await f.Db.Bookings.ToListAsync());
    }

    /// <summary>The cap itself is on sale: ninety minutes at the hard cap is a valid purchase.</summary>
    [Fact]
    public async Task A_walk_up_of_exactly_the_cap_is_sold()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1);

        var (status, body) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(await CodeAsync(f), court: 1, RelayHardCap.Minutes), ServicesOf(f), default));

        Assert.Equal(200, status);
        Assert.Equal(RelayHardCap.Minutes, body.GetProperty("granted_minutes").GetInt32());
    }

    /// <summary>
    /// The H3 headline. The box bought, lost the 200, and asked again with the same nonce.
    /// The answer is the original grant with <c>replayed: true</c> — same booking, same
    /// minutes — and the ledger shows one purchase, not two. Without this the retry hit the
    /// member's own fresh booking and was told "court in use": charged, dark, and stuck.
    /// </summary>
    [Fact]
    public async Task A_retried_walk_up_with_the_same_nonce_returns_the_original_grant_and_charges_once()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1, 2);
        var code = await CodeAsync(f);
        const string nonce = "9f2a4c6e8b0d1f3a";

        var (firstStatus, first) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(code, court: 2, minutes: 30, nonce), ServicesOf(f), default));
        Assert.Equal(200, firstStatus);
        Assert.False(first.GetProperty("replayed").GetBoolean());

        // The retry: same box, same nonce, same body.
        var (secondStatus, second) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(code, court: 2, minutes: 30, nonce), ServicesOf(f), default));

        Assert.Equal(200, secondStatus);
        Assert.True(second.GetProperty("replayed").GetBoolean());
        Assert.Equal(first.GetProperty("booking_id").GetGuid(), second.GetProperty("booking_id").GetGuid());
        Assert.Equal(first.GetProperty("granted_minutes").GetInt32(), second.GetProperty("granted_minutes").GetInt32());
        Assert.Equal(first.GetProperty("amount_minutes").GetDecimal(), second.GetProperty("amount_minutes").GetDecimal());

        // One booking, one debit, and the reference on it.
        var booking = Assert.Single(await f.Db.Bookings.Where(b => b.UserId == f.Host.PlayerUser.Id).ToListAsync());
        var charge = Assert.Single(await f.Db.LedgerEntries.Where(l => l.RelatedBookingId == booking.Id).ToListAsync());
        Assert.Equal(DeviceEventEndpoints.WalkUpReference(box.Id, nonce), charge.ExternalReference);
        Assert.Equal(200 - 30, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));
        Assert.Single(await f.Db.AuditLogs.Where(a => a.Action == "court.activated").ToListAsync());
    }

    /// <summary>A different nonce is a different purchase — and is refused, because the member's own walk-up now holds the court.</summary>
    [Fact]
    public async Task A_second_walk_up_with_a_new_nonce_is_a_new_purchase()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1);
        var code = await CodeAsync(f);

        var (firstStatus, _) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(code, court: 1, minutes: 30), ServicesOf(f), default));
        Assert.Equal(200, firstStatus);

        var (secondStatus, second) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(code, court: 1, minutes: 30), ServicesOf(f), default));
        Assert.Equal(409, secondStatus);
        Assert.Equal("court_in_use", second.GetProperty("error").GetString());
    }

    [Theory]
    [InlineData(null, "nonce_required")]
    [InlineData("", "nonce_required")]
    [InlineData("   ", "nonce_required")]
    [InlineData("0123456789abcdef0123456789abcdef0", "nonce_too_long")]
    public async Task A_walk_up_without_a_usable_nonce_is_refused(string? nonce, string error)
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1);

        var (status, body) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, new WalkUpRequest(BoxMac, 30, "qr", await CodeAsync(f), 1, nonce), ServicesOf(f), default));

        Assert.Equal(400, status);
        Assert.Equal(error, body.GetProperty("error").GetString());
        Assert.Empty(await f.Db.Bookings.ToListAsync());
    }
    // ---- R9 after P13: no court is free, and the purchase row carries the box's nonce ----

    /// <summary>
    /// What the R9 free-court cases became. Courts carry no price since P13, so a walk-up can
    /// never cost zero and I10's walk-up carve-out is never reached at zero; what it protected
    /// — the purchase row under the box's nonce, the only record <c>ReplayAsync</c> reads — is
    /// pinned here on the second court of a two-court box, where a per-court price used to differ.
    /// The replay half is <see cref="A_retried_walk_up_with_the_same_nonce_returns_the_original_grant_and_charges_once"/>.
    /// </summary>
    [Fact]
    public async Task A_walk_up_on_any_court_charges_its_granted_minutes_under_the_box_reference()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1, 2);
        const string nonce = "0a1b2c3d4e5f6071";

        var (status, body) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(await CodeAsync(f), court: 2, minutes: 45, nonce), ServicesOf(f), default));

        Assert.Equal(200, status);
        Assert.Equal(JsonValueKind.Number, body.GetProperty("amount_minutes").ValueKind);
        Assert.Equal(45, body.GetProperty("amount_minutes").GetInt32());
        Assert.Equal(155, body.GetProperty("balance_after_minutes").GetInt32());
        Assert.Equal(155, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));

        var booking = await f.Db.Bookings.AsNoTracking().SingleAsync(b => b.UserId == f.Host.PlayerUser.Id);
        Assert.Equal(f.Host.Courts[1].Id, booking.CourtId);
        var charge = Assert.Single(
            await f.Db.LedgerEntries.AsNoTracking().Where(l => l.RelatedBookingId == booking.Id).ToListAsync());
        Assert.Equal(LedgerEntryType.LightsPurchase, charge.Type);
        Assert.Equal(-45, charge.AmountMinutes);
        Assert.Equal(DeviceEventEndpoints.WalkUpReference(box.Id, nonce), charge.ExternalReference);
    }

    // ---- R8: the confirmation follows the lights, and a refusal gives the money back ----

    private static WalkUpServices ServicesRefusingActivation(Fixture f) =>
        ServicesOf(f) with { Activation = new RefusingActivation(f.Scope) };

    /// <summary>
    /// A walk-up the court would not open costs the member nothing, and tells them nothing
    /// that is untrue.
    ///
    /// <para>
    /// The commit and the activation are two steps and the commit takes the money. Round 7
    /// mailed the confirmation from inside the commit — <i>"this is court time bought at the
    /// box, so it has already started… not refunded once the lights have been on, and there
    /// is nothing to cancel"</i> — and then refused the activation, leaving every clause of
    /// that sentence false and a charged, un-checked-in booking sitting on the court. Nothing
    /// repaired it: the box paints COURT NOT FREE, a fresh scan is a fresh nonce and is
    /// refused by the abandoned booking, and <c>NoShowWorker</c> settles it at the grace
    /// deadline with the club's no-show penalty on a member the API itself turned away.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_walk_up_the_court_refuses_is_undone_and_never_confirmed()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1);
        var opening = await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default);

        var (status, body) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(await CodeAsync(f), court: 1, minutes: 30),
            ServicesRefusingActivation(f), default));

        Assert.Equal(409, status);
        Assert.Equal("activation_refused", body.GetProperty("error").GetString());

        // The money is back, in full. This is the whole point: a refusal after a charge must
        // not strand credits.
        Assert.Equal(opening, await f.Ledger.GetBalanceAsync(f.Host.PlayerUser.Id, default));

        // Two rows, same type, opposite sign (I11) — never a netted one and never an edit.
        var booking = await f.Db.Bookings.AsNoTracking().SingleAsync(b => b.UserId == f.Host.PlayerUser.Id);
        var rows = await f.Db.LedgerEntries.AsNoTracking()
            .Where(l => l.RelatedBookingId == booking.Id)
            .OrderBy(l => l.AmountMinutes)
            .ToListAsync();
        Assert.Equal(2, rows.Count);
        Assert.All(rows, r => Assert.Equal(LedgerEntryType.LightsPurchase, r.Type));
        Assert.Equal(-rows[0].AmountMinutes, rows[1].AmountMinutes);
        Assert.True(rows[1].AmountMinutes > 0);

        // The slot is released and was never attended, so no sweep can reach it.
        Assert.Equal(BookingStatus.Cancelled, booking.Status);
        Assert.Null(booking.CheckedInAt);

        // Nothing was said that was not true. The confirmation is the sentence this test is
        // named after: it was composed inside the commit and is now composed after the
        // activation, so a refusal produces none at all.
        var sent = await SettledMailAsync(f);
        Assert.DoesNotContain(sent, m => m.Subject.StartsWith("Court time started", StringComparison.Ordinal));
        var told = Assert.Single(sent, m => m.Subject.StartsWith("Court time not started", StringComparison.Ordinal));
        // Both bodies: the reassurance is worth nothing in the half the member is not shown.
        foreach (var half in new[] { told.HtmlBody, MailText.Unwrap(told.PlainBody) })
        {
            Assert.Contains("Nothing was bought", half);
            // R15 J15-11: the verb agrees with the figure ("32 minutes have gone").
            Assert.Contains(" gone straight back onto your balance", half);
            Assert.DoesNotContain("minutes has gone", half);
            Assert.DoesNotContain("penalty", half);
        }

        // And the court is free again — the member can press the button a second time and be
        // sold what they were refused. Before the undo, their own abandoned booking answered
        // court_in_use for the length of the purchase.
        var (retryStatus, _) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(await CodeAsync(f), court: 1, minutes: 30), ServicesOf(f), default));
        Assert.Equal(200, retryStatus);
    }

    /// <summary>
    /// The other half of the same rule: when the court DOES open, the confirmation is sent —
    /// deferring it must not lose it. The mail describes a court that is lit, and the booking
    /// it names is checked in.
    /// </summary>
    [Fact]
    public async Task A_walk_up_that_lights_the_court_is_confirmed_once_it_is_lit()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1);

        var (status, _) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(await CodeAsync(f), court: 1, minutes: 30), ServicesOf(f), default));
        Assert.Equal(200, status);

        var booking = await f.Db.Bookings.AsNoTracking().SingleAsync(b => b.UserId == f.Host.PlayerUser.Id);
        Assert.NotNull(booking.CheckedInAt);

        var sent = await SettledMailAsync(f);
        var confirmation = Assert.Single(sent, m => m.Subject.StartsWith("Court time started", StringComparison.Ordinal));
        Assert.Contains("not refunded once the lights have been on", confirmation.HtmlBody);
        // And no undo mail, which would mean the money had been taken back off a lit court.
        Assert.DoesNotContain(sent, m => m.Subject.StartsWith("Court time not started", StringComparison.Ordinal));
    }

    /// <summary>
    /// The window the deferral opens, and the replay that closes it.
    ///
    /// <para>
    /// Holding the confirmation until the activation means a request that dies between the
    /// debit and the mail sends nothing at all — where the old ordering had already queued
    /// it from inside the commit. The box retries the same nonce, the replay re-activates
    /// the booking it finds (which is what the replay is for), and it owes the member the
    /// confirmation that attempt never sent. "Every player-affecting event sends an email"
    /// is an invariant, not a nicety: the member is standing on a court they paid for.
    /// </para>
    ///
    /// <para>
    /// The died-mid-request state is built the way it actually arises — a walk-up committed
    /// and charged, with nothing having activated it.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_replay_that_repairs_an_unactivated_purchase_sends_the_confirmation_it_never_got()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1);
        const string nonce = "abcdef0123456789";

        // The commit, and nothing after it: charged, unstamped, unconfirmed.
        var created = Assert.IsType<BookingResult.Ok>(await f.Bookings.CreateWalkUpAsync(
            f.Host.Courts[0].Id, f.Host.PlayerUser.Id, f.Host.PlayerUser.Id, 30,
            DeviceEventEndpoints.WalkUpReference(box.Id, nonce), default));
        Assert.NotNull(created.SendConfirmationAsync);
        Assert.Empty(f.Host.EmailService.Sent);

        var (status, body) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(await CodeAsync(f), court: 1, minutes: 30, nonce: nonce), ServicesOf(f), default));

        Assert.Equal(200, status);
        Assert.True(body.GetProperty("replayed").GetBoolean());
        Assert.Equal(created.Booking.Id, body.GetProperty("booking_id").GetGuid());

        var booking = await f.Db.Bookings.AsNoTracking().SingleAsync(b => b.Id == created.Booking.Id);
        Assert.NotNull(booking.CheckedInAt);

        var sent = await SettledMailAsync(f);
        var confirmation = Assert.Single(sent, m => m.Subject.StartsWith("Court time started", StringComparison.Ordinal));
        // The figures are re-derived in a different request from the purchase, so they are
        // asserted rather than assumed: the price on the row, and the balance it left behind.
        Assert.Contains(MoneyFormat.Minutes(30), confirmation.HtmlBody);
        Assert.Contains(MoneyFormat.Minutes(170), confirmation.HtmlBody);
        Assert.Contains("not refunded once the lights have been on", confirmation.HtmlBody);
    }

    /// <summary>
    /// And the ordinary replay — the box that retried because it never read the 200 — sends
    /// NO second confirmation. One purchase, one "you are on court".
    /// </summary>
    [Fact]
    public async Task A_replay_of_a_completed_purchase_does_not_confirm_it_twice()
    {
        var f = await CreateAsync();
        await using var _ = f.Host;
        using var __ = f.Scope;

        var box = await BoxOnAsync(f, 1);
        var code = await CodeAsync(f);
        const string nonce = "0f1e2d3c4b5a6978";

        var (first, _) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(code, court: 1, minutes: 30, nonce: nonce), ServicesOf(f), default));
        Assert.Equal(200, first);

        var (second, secondBody) = Unwrap(await DeviceEventEndpoints.WalkUpForDeviceAsync(
            box, Request(code, court: 1, minutes: 30, nonce: nonce), ServicesOf(f), default));
        Assert.Equal(200, second);
        Assert.True(secondBody.GetProperty("replayed").GetBoolean());

        var sent = await SettledMailAsync(f);
        Assert.Single(sent, m => m.Subject.StartsWith("Court time started", StringComparison.Ordinal));
    }

    /// <summary>
    /// Waits for the background sends to land rather than racing them, then returns
    /// everything sent. Bounded, so an absent mail costs a second rather than a hang.
    /// </summary>
    private static async Task<IReadOnlyList<Api.Email.EmailMessage>> SettledMailAsync(Fixture f, int timeoutMs = 3000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline && f.Host.EmailService.Sent.Count == 0) await Task.Delay(25);
        // One more grace period, so a second message arriving just behind the first is seen
        // and an assertion about what was NOT sent is not simply early.
        await Task.Delay(250);
        return [.. f.Host.EmailService.Sent];
    }
}
