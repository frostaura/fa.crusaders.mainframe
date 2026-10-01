using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// GOAL items 3 and 19 — the per-day caps that never worked, and the groups that decide them.
///
/// <para>
/// <b>The fixture is varied, not just the code.</b> The combinator at the heart of this
/// (<see cref="GroupRules"/>) is the classic shape that passes every example test while being
/// wrong: the one-group case passes trivially and hides it entirely, so the group tests run at 0,
/// 1, 2 and 3 groups. <c>memory/gotchas.md</c> records that one-field probes found four real
/// defects that mutation testing missed.
/// </para>
/// </summary>
public class BookingCapAndGroupTests
{
    private static async Task GiveSettingsAsync(TestHost host, string json)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var row = await db.TenantSettings.FirstAsync(s => s.TenantId == host.Tenant.Id);
        row.SettingsJson = json;
        await db.SaveChangesAsync();
    }

    /// <summary>A day far enough out that the peak window and "today" cannot interfere.</summary>
    private static DateTimeOffset NextWeekAt(int hour, int minute = 0)
        => new DateTimeOffset(DateTime.UtcNow.Date.AddDays(3).AddHours(hour).AddMinutes(minute), TimeSpan.Zero);

    /// <summary>
    /// A slot twenty minutes out — inside the same-day relaxation window — with room for a second
    /// one thirty minutes after it and for both to END before midnight. Null when the wall clock
    /// leaves no such room, which is the hidden input <c>gotchas-clock.md</c> is about.
    /// </summary>
    private static DateTimeOffset? SoonInsideTheDay()
    {
        // Placed on the club's own slice grid, forward rather than back, so the fixture is the
        // same shape at every hour of the day: a slot at :07 is not a slot the product's grid can
        // produce, and a test whose start wanders with the runner's clock is a test whose failures
        // wander with it too (memory/gotchas-clock.md).
        var start = OnTheGrid(DateTimeOffset.UtcNow.AddMinutes(20));
        return SameClubDay(start, start.AddMinutes(30 + 15)) ? start : null;
    }

    /// <summary>The next 15-minute boundary at or after an instant, on the CLUB'S clock.</summary>
    private static DateTimeOffset OnTheGrid(DateTimeOffset at)
    {
        var local = TimeZoneInfo.ConvertTime(at, ClubZone);
        var minutes = (local.Hour * 60) + local.Minute;
        var forward = (15 - (minutes % 15)) % 15;
        return at.AddMinutes(forward).AddSeconds(-local.Second).AddMilliseconds(-local.Millisecond);
    }

    private const string OpenAllHours =
        """{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"timezone":"UTC","peak_hours":""}""";

    private static string Settings(string extra)
        => $$"""{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"timezone":"UTC","peak_hours":"",{{extra}}}""";

    /// <summary>
    /// A club that is NOT in UTC — <c>memory/gotchas-postgres-offsets.md</c>: every test club in
    /// this repository runs UTC, where the offset is zero and a whole class of club-day defect is
    /// invisible, while every real club is outside it — and one where it is MORNING right now.
    /// </summary>
    /// <remarks>
    /// These tests are about TODAY on the club's clock, so they need enough of the club's day left
    /// to place their slots in. Pinned to Johannesburg they skipped every afternoon — the cap test
    /// from about 14:25 SAST — and a suite that skips its D2-B11 test half the day is a suite that
    /// does not test D2-B11 half the day. Choosing the zone rather than freezing a clock keeps the
    /// real day-window code under test; <c>DoorClub.DaytimeZone</c> is the same move for the
    /// opposite need. Johannesburg is still first, so the offset under test is the club's own
    /// whenever its morning allows.
    /// </remarks>
    private static string ClubInMorningZone(string extra)
        => $$"""{"slice_minutes":15,"day_start_minute":0,"day_end_minute":1440,"timezone":"{{ClubZoneId}}","peak_hours":"",{{extra}}}""";

    /// <summary>A real, non-UTC zone in which <paramref name="now"/> reads between 01:00 and noon.</summary>
    /// <remarks>
    /// The zones run from UTC-11 to UTC+14 with no gap wider than two hours, so an eleven-hour
    /// window always holds one of them; <see cref="Some_zone_is_in_its_morning_at_every_hour"/>
    /// pins that for all 24 hours rather than trusting the arithmetic.
    /// </remarks>
    internal static string MorningZone(DateTimeOffset now)
    {
        string[] zones =
        [
            "Africa/Johannesburg", "Asia/Dubai", "Asia/Kolkata", "Asia/Bangkok", "Asia/Tokyo",
            "Australia/Brisbane", "Pacific/Noumea", "Pacific/Auckland", "Pacific/Kiritimati",
            "Pacific/Pago_Pago", "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles",
            "America/Denver", "America/Chicago", "America/New_York", "America/Sao_Paulo",
            "Atlantic/Cape_Verde",
        ];
        return zones.First(
            z => TimeZoneInfo.ConvertTime(now, TimeZoneInfo.FindSystemTimeZoneById(z)).Hour is >= 1 and < 12);
    }

    private static readonly string ClubZoneId = MorningZone(DateTimeOffset.UtcNow);

    private static readonly TimeZoneInfo ClubZone = TimeZoneInfo.FindSystemTimeZoneById(ClubZoneId);

    [Theory]
    [MemberData(nameof(EveryHour))]
    public void Some_zone_is_in_its_morning_at_every_hour(int hour)
    {
        var now = new DateTimeOffset(2026, 9, 23, hour, 30, 0, TimeSpan.Zero);
        var zone = TimeZoneInfo.FindSystemTimeZoneById(MorningZone(now));

        Assert.InRange(TimeZoneInfo.ConvertTime(now, zone).Hour, 1, 11);
        Assert.NotEqual(TimeSpan.Zero, zone.GetUtcOffset(now));
    }

    public static TheoryData<int> EveryHour()
    {
        var data = new TheoryData<int>();
        for (var h = 0; h < 24; h++) data.Add(h);
        return data;
    }

    /// <summary>
    /// Whether a run of slots starting at <paramref name="start"/> all land on the CLUB'S day
    /// rather than straddling its midnight. The whole point of these tests is the club day, so a
    /// fixture that silently crosses it is testing something else.
    /// </summary>
    private static bool SameClubDay(DateTimeOffset start, DateTimeOffset lastEnd)
        => TimeZoneInfo.ConvertTime(start, ClubZone).Date == TimeZoneInfo.ConvertTime(lastEnd, ClubZone).Date
        && TimeZoneInfo.ConvertTime(start, ClubZone).Date
           == TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, ClubZone).Date;

    // ---- D2-B11: the cap did not work for TODAY, at all ---------------------

    /// <summary>
    /// <b>D2-B11, the finding itself.</b> <c>CheckPerDayCapAsync</c> returned "allow"
    /// UNCONDITIONALLY whenever the slot's local day was today — the comment beside it said the
    /// blueprint's relaxation also requires the slot to be otherwise empty, and that half was
    /// never evaluated. Four 15-minute slots today at a 60-minute cap all succeeded, and the cap
    /// bit only on future days. It is the hole GOAL item 19 exists to close.
    ///
    /// <para>
    /// Booked far enough ahead that the same-day relaxation window (two hours) cannot apply,
    /// which is the honest reading of the blueprint's rule: it is about filling a court that is
    /// about to go unused, not a blanket exemption for the rest of the day.
    /// </para>
    /// </summary>
    [Fact]
    public async Task A_member_cannot_fill_today_past_their_cap()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, ClubInMorningZone("\"member_per_day_max_minutes\":60"));
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        // Today, but hours away — past same_day_relaxation_window_minutes, so the blueprint's
        // relaxation cannot be what lets these through.
        var baseStart = OnTheGrid(DateTimeOffset.UtcNow.AddHours(6));

        // Skip rather than assert a falsehood when the club's own day has not enough left in it:
        // a test that books relative to UtcNow inherits the wall clock as a hidden input
        // (memory/gotchas-clock.md).
        // An assertion, not a skip: the club's zone is chosen so its morning always leaves room,
        // and a skip here would hide exactly the hours this test used to vanish in.
        Assert.True(SameClubDay(baseStart, baseStart.AddMinutes(215)),
            $"the club day in {ClubZoneId} has no room for four future slots — MorningZone is wrong");

        for (var i = 0; i < 4; i++)
        {
            var result = await booking.CreateAsync(
                host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, baseStart.AddMinutes(i * 30), 1, default);
            Assert.IsType<BookingResult.Ok>(result);
        }

        var fifth = await booking.CreateAsync(
            host.Courts[1].Id, host.PlayerUser.Id, host.PlayerUser.Id, baseStart.AddMinutes(195), 1, default);

        var refusal = Assert.IsType<BookingResult.PerDaySlotCapExceeded>(fifth);
        Assert.Equal(4, refusal.CapSlots);
        Assert.Equal(0, refusal.RemainingSlots);
    }

    /// <summary>
    /// And the relaxation is real, not decorative: a slot starting SOON on a court that is
    /// otherwise empty is allowed through a cap the member is already at. All four conditions
    /// have to hold, which is the half D2-B11 says was never evaluated.
    /// </summary>
    [Fact]
    public async Task A_free_court_starting_soon_is_allowed_through_the_cap()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, ClubInMorningZone("\"member_max_slots_per_day\":1,\"member_per_day_max_minutes\":0"));
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        var soon = SoonInsideTheDay();
        // gotchas-clock.md: a test that books relative to UtcNow inherits the wall clock as a
        // hidden input. Both slots and their lengths have to fit inside today, or the club's own
        // closing time refuses them and the test reads as a broken cap.
        Assert.True(soon is not null, $"the club day in {ClubZoneId} has no room for two short slots — MorningZone is wrong");

        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, soon!.Value, 1, default));

        // At the cap of one — and still allowed, because the court is free and it starts inside
        // the relaxation window.
        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[1].Id, host.PlayerUser.Id, host.PlayerUser.Id, soon.Value.AddMinutes(30), 1, default));
    }

    /// <summary>Turn the relaxation off and the same second booking is refused.</summary>
    [Fact]
    public async Task The_relaxation_can_be_turned_off()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, ClubInMorningZone(
            "\"member_max_slots_per_day\":1,\"member_per_day_max_minutes\":0,\"same_day_cap_relaxation\":false"));
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        var soon = SoonInsideTheDay();
        Assert.True(soon is not null, $"the club day in {ClubZoneId} has no room for two short slots — MorningZone is wrong");

        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, soon!.Value, 1, default));
        Assert.IsType<BookingResult.PerDaySlotCapExceeded>(await booking.CreateAsync(
            host.Courts[1].Id, host.PlayerUser.Id, host.PlayerUser.Id, soon.Value.AddMinutes(30), 1, default));
    }

    // ---- D2-B13: the admin exemption was an inference ------------------------

    /// <summary>
    /// <b>D2-B13.</b> <c>isAdminActor = actorId != userId</c> made an admin booking for
    /// THEMSELVES not exempt — refused by peak hours and by the cap — while never asking whether
    /// the actor held the role at all. GOAL item 19 says "with the exception of admins", and an
    /// admin booking their own court is still an admin.
    /// </summary>
    [Fact]
    public async Task An_admin_booking_for_themselves_is_exempt_from_the_cap()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, Settings("\"member_max_slots_per_day\":1,\"member_per_day_max_minutes\":0"));
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.AdminUser.Id, LedgerEntryType.TopUp, 5000, host.AdminUser.Id), default);

        for (var i = 0; i < 3; i++)
        {
            var payer = new BookingPayer(host.AdminUser.Id, host.AdminUser.Id, ActorIsAdmin: true);
            Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
                host.Courts[0].Id, payer, NextWeekAt(9 + i), 1, default));
        }
    }

    /// <summary>
    /// And a MEMBER cannot acquire the exemption by any route: the flag defaults false and the
    /// member's own endpoint reads it from the role claim, which they do not hold.
    /// </summary>
    [Fact]
    public async Task A_member_cannot_claim_the_exemption()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, Settings("\"member_max_slots_per_day\":1,\"member_per_day_max_minutes\":0"));
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, NextWeekAt(9), 1, default));

        // Default false: no call site acquires the exemption by accident.
        var payer = new BookingPayer(host.PlayerUser.Id, host.PlayerUser.Id);
        Assert.IsType<BookingResult.PerDaySlotCapExceeded>(await booking.CreateAsync(
            host.Courts[1].Id, payer, NextWeekAt(11), 1, default));
    }

    // ---- GOAL item 3: the combinator -----------------------------------------

    private static async Task<MemberGroup> GroupAsync(
        TestHost host, string name, Action<MemberGroup>? shape = null, params (DayOfWeek Day, int Start, int End)[] windows)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var group = new MemberGroup { TenantId = host.Tenant.Id, Name = name };
        shape?.Invoke(group);
        db.MemberGroups.Add(group);
        foreach (var (day, start, end) in windows)
        {
            db.MemberGroupWindows.Add(new MemberGroupWindow
            {
                TenantId = host.Tenant.Id,
                GroupId = group.Id,
                DayOfWeek = day,
                StartMinute = start,
                EndMinute = end,
            });
        }
        await db.SaveChangesAsync();
        return group;
    }

    private static async Task JoinAsync(TestHost host, Guid userId, params Guid[] groupIds)
    {
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        foreach (var groupId in groupIds)
        {
            db.MemberGroupMembers.Add(new MemberGroupMember
            {
                TenantId = host.Tenant.Id,
                GroupId = groupId,
                UserId = userId,
            });
        }
        await db.SaveChangesAsync();
    }

    /// <summary>
    /// A member in NO group is unrestricted at the club's own rules, and pays what everyone pays:
    /// the booking's length in minutes (P13, §1.1). Not refused, and not "the default group's
    /// rules" — a brand-new member must be able to book before an admin has classified them, and a
    /// club that never opens the groups screen must behave exactly as it does today. Two lengths so
    /// a flat per-booking charge cannot pass.
    /// </summary>
    [Theory]
    [InlineData(1, 15)]
    [InlineData(3, 45)]
    public async Task A_member_in_no_group_books_at_its_length_in_minutes(int slices, int expected)
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, OpenAllHours);
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        var ok = Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, NextWeekAt(3), slices, default));

        Assert.Equal(expected, ok.Booking.AmountChargedMinutes);
        Assert.Equal(5000 - expected, ok.BalanceAfterMinutes);
    }

    /// <summary>
    /// <b>Groups no longer set a price</b> (P13). What replaced the old "highest group price wins"
    /// combinator is that there is nothing to combine: a member in one, two or three groups —
    /// each with its own package discount, which is rand-only (§1.2: "A discount never changes
    /// minutes") — pays exactly what a member in none pays, the booking's minutes.
    ///
    /// <para>
    /// <b>Varied at 0 to 3 groups</b>, and at a 45-minute booking, so a discount leaking into the
    /// minutes (10% of 45 is 4.5) or a stale per-group multiplier would both show.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task A_member_pays_the_same_minutes_however_many_groups_they_are_in(int groupCount)
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, OpenAllHours);

        var ids = new List<Guid>();
        var discounts = new int?[] { 1_000, null, 5_000 };
        for (var i = 0; i < groupCount; i++)
        {
            var bps = discounts[i];
            var group = await GroupAsync(host, $"discount-{i}", g => g.PackageDiscountBps = bps);
            ids.Add(group.Id);
        }
        await JoinAsync(host, host.PlayerUser.Id, [.. ids]);

        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        var ok = Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[1].Id, host.PlayerUser.Id, host.PlayerUser.Id, NextWeekAt(3), 3, default));

        Assert.Equal(45, ok.Booking.AmountChargedMinutes);
        Assert.Equal(5000 - 45, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }

    /// <summary>
    /// A window rule bites, and the refusal carries the windows the member MAY book in — "not
    /// now" without "then" is a refusal a technology-averse member cannot act on.
    /// </summary>
    [Fact]
    public async Task A_booking_outside_the_groups_window_is_refused_with_the_windows_that_apply()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, OpenAllHours);

        var day = NextWeekAt(3);
        var group = await GroupAsync(host, "Off-peak only", null, (day.DayOfWeek, 17 * 60, 21 * 60));
        await JoinAsync(host, host.PlayerUser.Id, group.Id);

        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        var refusal = Assert.IsType<BookingResult.GroupWindow>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, day, 1, default));

        Assert.Equal(["Off-peak only"], refusal.GroupNames);
        Assert.Equal(("17:00", "21:00"), Assert.Single(refusal.AllowedWindows));
    }

    /// <summary>
    /// A booking straddling a window's edge is refused whole. One stretch, not the union: half
    /// the court time the member asked for is time they may not have, and the same whole-range
    /// rule already governs opening hours.
    /// </summary>
    [Fact]
    public async Task A_booking_across_a_window_edge_is_refused()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, OpenAllHours);

        var day = NextWeekAt(3);
        var group = await GroupAsync(host, "Mornings", null, (day.DayOfWeek, 6 * 60, 9 * 60));
        await JoinAsync(host, host.PlayerUser.Id, group.Id);

        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        // 08:45 for two slices runs to 09:15, which is past the edge.
        Assert.IsType<BookingResult.GroupWindow>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, NextWeekAt(8, 45), 2, default));

        // And one slice inside it is fine, so the rule is the edge and not the group.
        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, NextWeekAt(8, 30), 1, default));
    }

    /// <summary>
    /// The empty intersection — two groups whose windows do not overlap — is NAMED, not rendered
    /// as an empty grid. An empty grid reads to a member as the club being shut.
    /// </summary>
    [Fact]
    public async Task Two_groups_that_do_not_overlap_produce_a_named_refusal()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, OpenAllHours);

        var day = NextWeekAt(3);
        var mornings = await GroupAsync(host, "Mornings", null, (day.DayOfWeek, 6 * 60, 9 * 60));
        var evenings = await GroupAsync(host, "Evenings", null, (day.DayOfWeek, 17 * 60, 21 * 60));
        await JoinAsync(host, host.PlayerUser.Id, mornings.Id, evenings.Id);

        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        var refusal = Assert.IsType<BookingResult.NoBookableWindow>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, NextWeekAt(7), 1, default));

        Assert.Equal(2, refusal.GroupNames.Count);
        Assert.Contains("Mornings", refusal.GroupNames);
        Assert.Contains("Evenings", refusal.GroupNames);
    }

    /// <summary>
    /// A group's lower cap binds, and the refusal NAMES it — so the member's sentence is about
    /// the rule that actually stopped them rather than the club's headline number.
    /// </summary>
    [Fact]
    public async Task A_groups_lower_cap_binds_and_is_named()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, Settings("\"member_max_slots_per_day\":8,\"member_per_day_max_minutes\":0"));

        var group = await GroupAsync(host, "Non-league members", g => g.MaxSlotsPerDay = 1);
        await JoinAsync(host, host.PlayerUser.Id, group.Id);

        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, NextWeekAt(9), 1, default));

        var refusal = Assert.IsType<BookingResult.PerDaySlotCapExceeded>(await booking.CreateAsync(
            host.Courts[1].Id, host.PlayerUser.Id, host.PlayerUser.Id, NextWeekAt(11), 1, default));

        Assert.Equal(1, refusal.CapSlots);
        Assert.Equal("Non-league members", refusal.BoundByGroupName);
    }

    /// <summary>
    /// <b>Zero means unlimited, and the minimum must skip it.</b> A member in one unlimited group
    /// and one capped group gets the capped number — a naive <c>Math.Min</c> would answer 0 and
    /// the next reader would take that as either "no limit for everybody" or "nothing at all".
    /// </summary>
    [Fact]
    public async Task An_unlimited_group_does_not_lift_or_erase_another_groups_cap()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, Settings("\"member_max_slots_per_day\":8,\"member_per_day_max_minutes\":0"));

        var unlimited = await GroupAsync(host, "Committee", g => g.MaxSlotsPerDay = 0);
        var capped = await GroupAsync(host, "Juniors", g => g.MaxSlotsPerDay = 1);
        await JoinAsync(host, host.PlayerUser.Id, unlimited.Id, capped.Id);

        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, NextWeekAt(9), 1, default));
        var refusal = Assert.IsType<BookingResult.PerDaySlotCapExceeded>(await booking.CreateAsync(
            host.Courts[1].Id, host.PlayerUser.Id, host.PlayerUser.Id, NextWeekAt(11), 1, default));

        Assert.Equal(1, refusal.CapSlots);
    }

    /// <summary>An archived group stops contributing to a member's rules while keeping its rows.</summary>
    [Fact]
    public async Task An_archived_group_no_longer_binds()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, Settings("\"member_max_slots_per_day\":8,\"member_per_day_max_minutes\":0"));

        var group = await GroupAsync(host, "Juniors", g =>
        {
            g.MaxSlotsPerDay = 1;
            g.Status = MemberGroupStatus.Archived;
        });
        await JoinAsync(host, host.PlayerUser.Id, group.Id);

        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        for (var i = 0; i < 3; i++)
        {
            Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
                host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, NextWeekAt(9 + i), 1, default));
        }
    }

    /// <summary>
    /// Turning the whole feature off through <c>member_groups_enabled</c> leaves the club exactly
    /// as it was — the escape hatch a club needs if a group rule turns out to be wrong at 18:00
    /// on a Tuesday.
    /// </summary>
    [Fact]
    public async Task The_feature_can_be_switched_off_wholesale()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, Settings("\"member_groups_enabled\":false"));

        var day = NextWeekAt(3);
        var group = await GroupAsync(host, "Evenings only", null, (day.DayOfWeek, 17 * 60, 21 * 60));
        await JoinAsync(host, host.PlayerUser.Id, group.Id);

        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, day, 1, default));
    }

    /// <summary>
    /// The only thing the self-admin branch decides that the on-behalf path does not: an admin
    /// booking for THEMSELVES is not held to their own group's window either. D2 §4.6's table
    /// says so, and the reasoning is that a group window is a rule the club applies to a member,
    /// and the club booking its own staff a court is the club deciding.
    /// </summary>
    [Fact]
    public async Task An_admin_booking_for_themselves_is_not_held_to_their_own_group_window()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, OpenAllHours);

        var target = NextWeekAt(3);
        var group = await GroupAsync(host, "Evenings only", null, (target.DayOfWeek, 17 * 60, 21 * 60));
        await JoinAsync(host, host.AdminUser.Id, group.Id);

        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.AdminUser.Id, LedgerEntryType.TopUp, 5000, host.AdminUser.Id), default);

        var payer = new BookingPayer(host.AdminUser.Id, host.AdminUser.Id, ActorIsAdmin: true);
        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(host.Courts[0].Id, payer, target, 1, default));

        // And the same member WITHOUT the role is refused on the same fixture, so this cannot
        // pass against an implementation that simply never checks the window.
        var asMember = new BookingPayer(host.AdminUser.Id, host.AdminUser.Id);
        Assert.IsType<BookingResult.GroupWindow>(
            await booking.CreateAsync(host.Courts[1].Id, asMember, target, 1, default));
    }

    /// <summary>
    /// But an admin booking ON BEHALF of a member <b>is</b> held to that member's group window:
    /// the club's access rule about that member is not what a desk overrides by booking for them.
    /// The CAP is, and that is the distinction D2 §4.6 draws.
    /// </summary>
    /// <summary>
    /// A booking that runs past the end of the club's day is refused IN WORDS ABOUT THE DAY.
    ///
    /// <para>
    /// Found by the device end-to-end run, which books three hours ahead and therefore only
    /// crossed midnight when it happened to start after 20:15. What the desk got was
    /// <c>group_window</c> for a member in NO groups, naming <c>00:00–24:00</c> as the times
    /// they may book — a window that plainly contains the start. Every window in this product
    /// ends at minute 1440 or earlier, so a booking ending at 1466 fits none of them and the
    /// window rule refused it perfectly correctly while describing it wrongly.
    /// </para>
    ///
    /// <para>
    /// Only the on-behalf path reaches it: an ordinary member meets the opening-hours rule first,
    /// because a club close cannot be later than the end of the day. The desk is exempt from the
    /// hours on purpose — booking outside advertised hours is the club deciding to open — and
    /// that exemption walked into the day boundary with nothing to say about it.
    /// </para>
    /// </summary>
    [Fact]
    public async Task An_admin_booking_on_behalf_that_runs_past_midnight_says_so()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, Settings("\"member_max_slots_per_day\":0,\"member_per_day_max_minutes\":0"));
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        // 23:45 plus two fifteen-minute slices ends at 00:15 the next day.
        var payer = new BookingPayer(host.PlayerUser.Id, host.AdminUser.Id, ActorIsAdmin: true);
        var refusal = Assert.IsType<BookingResult.CrossesMidnight>(await booking.CreateAsync(
            host.Courts[0].Id, payer, NextWeekAt(23, 45), 2, default));

        // The sentence names the time it would have run to, which is the fact the desk needs in
        // order to shorten the booking. A refusal that only said "no" would be the old one again.
        Assert.Equal("23:45", refusal.StartsAt);
        Assert.Equal("00:15", refusal.EndsAt);
        Assert.Equal(15, refusal.MinutesPastMidnight);
    }

    /// <summary>
    /// And the boundary itself is bookable: a booking ending EXACTLY at the end of the day has
    /// not crossed anything. Without this, the fix above is one <c>&gt;=</c> away from making the
    /// last slot of every day unbookable, which is a worse bug than the one it replaced.
    /// </summary>
    [Fact]
    public async Task A_booking_that_ends_exactly_at_the_end_of_the_day_is_allowed()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, Settings("\"member_max_slots_per_day\":0,\"member_per_day_max_minutes\":0"));
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        var payer = new BookingPayer(host.PlayerUser.Id, host.AdminUser.Id, ActorIsAdmin: true);
        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[0].Id, payer, NextWeekAt(23, 45), 1, default));
    }

    [Fact]
    public async Task An_admin_booking_on_behalf_is_still_held_to_the_members_group_window()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, OpenAllHours);

        var target = NextWeekAt(3);
        var group = await GroupAsync(host, "Evenings only", g => g.MaxSlotsPerDay = 1,
            (target.DayOfWeek, 17 * 60, 21 * 60));
        await JoinAsync(host, host.PlayerUser.Id, group.Id);

        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        var payer = new BookingPayer(host.PlayerUser.Id, host.AdminUser.Id, ActorIsAdmin: true);

        // The window still refuses.
        Assert.IsType<BookingResult.GroupWindow>(
            await booking.CreateAsync(host.Courts[0].Id, payer, target, 1, default));

        // The cap does not: inside the window, the desk may book past the group's cap of one.
        var evening = NextWeekAt(18);
        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(host.Courts[0].Id, payer, evening, 1, default));
        Assert.IsType<BookingResult.Ok>(
            await booking.CreateAsync(host.Courts[1].Id, payer, evening.AddHours(1), 1, default));
    }

    // ---- The grid tells the same story as the POST ---------------------------

    /// <summary>
    /// <b>"available is a promise the grid makes", and it was broken once already.</b> The
    /// allowance the grid locks buttons on must be the allowance the POST enforces — otherwise
    /// item 19 repeats, for the cap, the peak-hours defect that drew 44 green cells a day and
    /// refused after Confirm.
    /// </summary>
    [Fact]
    public async Task The_grids_remaining_count_matches_what_the_post_allows()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, Settings("\"member_max_slots_per_day\":2,\"member_per_day_max_minutes\":0"));
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        var schedule = scope.ServiceProvider.GetRequiredService<ScheduleService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        var day = DateOnly.FromDateTime(NextWeekAt(9).UtcDateTime);

        var before = await schedule.GetDayAsync(day, host.PlayerUser.Id, default);
        Assert.Equal(2, before.Rules!.RemainingToday);

        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, NextWeekAt(9), 1, default));

        var after = await schedule.GetDayAsync(day, host.PlayerUser.Id, default);
        Assert.Equal(1, after.Rules!.RemainingToday);

        Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[1].Id, host.PlayerUser.Id, host.PlayerUser.Id, NextWeekAt(11), 1, default));

        var atTheWall = await schedule.GetDayAsync(day, host.PlayerUser.Id, default);
        Assert.Equal(0, atTheWall.Rules!.RemainingToday);

        // And zero on the grid means the POST refuses. That is the promise.
        Assert.IsType<BookingResult.PerDaySlotCapExceeded>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, NextWeekAt(13), 1, default));
    }

    /// <summary>
    /// The grid carries no price (contract §3.12). Review round 5 (I5-1) made it carry what THIS
    /// viewer paid on EACH court; since P13 a cell costs its minutes for everyone, so the client
    /// computes <c>slices × slice_minutes</c> and the server sends no figure that could drift from
    /// the charge. Pinned on the wire records, and on the charge for a discounted member on the
    /// second court, which is where a per-court or per-group price used to differ.
    /// </summary>
    [Fact]
    public async Task The_grid_carries_no_price_and_every_court_charges_its_minutes()
    {
        Assert.DoesNotContain(typeof(ScheduleRules).GetProperties(), p => p.Name.Contains("Price", StringComparison.Ordinal));
        Assert.DoesNotContain(typeof(ScheduleCourt).GetProperties(), p => p.Name.Contains("Price", StringComparison.Ordinal));
        Assert.DoesNotContain(typeof(ScheduleSlot).GetProperties(), p => p.Name.Contains("Price", StringComparison.Ordinal));

        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, OpenAllHours);
        var discounted = await GroupAsync(host, "Discounted", g => g.PackageDiscountBps = 5_000);
        await JoinAsync(host, host.PlayerUser.Id, discounted.Id);

        using var scope = host.NewScope();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        foreach (var (court, hour) in new[] { (0, 9), (1, 11) })
        {
            var ok = Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
                host.Courts[court].Id, host.PlayerUser.Id, host.PlayerUser.Id, NextWeekAt(hour), 2, default));
            Assert.Equal(30, ok.Booking.AmountChargedMinutes);
        }
    }

    /// <summary>
    /// An admin's grid states that they have no limit rather than showing them a number that
    /// does not apply to them.
    /// </summary>
    [Fact]
    public async Task An_admins_grid_reports_no_limit_rather_than_a_number()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, Settings("\"member_max_slots_per_day\":2"));
        using var scope = host.NewScope();
        var schedule = scope.ServiceProvider.GetRequiredService<ScheduleService>();

        var day = await schedule.GetDayAsync(
            DateOnly.FromDateTime(NextWeekAt(9).UtcDateTime), host.AdminUser.Id, viewerIsAdmin: true, default);

        Assert.True(day.Rules!.AdminExempt);
        Assert.Null(day.Rules.RemainingToday);
        Assert.Null(day.Rules.MaxSlotsPerDay);
    }

    /// <summary>
    /// The empty intersection reaches the grid as a named reason with both halves of the
    /// conditional — which groups, and which day — rather than as an empty list of windows the
    /// client has to interpret.
    /// </summary>
    [Fact]
    public async Task The_grid_names_an_empty_intersection_rather_than_drawing_a_shut_club()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, OpenAllHours);

        var target = NextWeekAt(9);
        var mornings = await GroupAsync(host, "Mornings", null, (target.DayOfWeek, 6 * 60, 9 * 60));
        var evenings = await GroupAsync(host, "Evenings", null, (target.DayOfWeek, 17 * 60, 21 * 60));
        await JoinAsync(host, host.PlayerUser.Id, mornings.Id, evenings.Id);

        using var scope = host.NewScope();
        var schedule = scope.ServiceProvider.GetRequiredService<ScheduleService>();
        var day = await schedule.GetDayAsync(DateOnly.FromDateTime(target.UtcDateTime), host.PlayerUser.Id, default);

        Assert.Empty(day.Rules!.AllowedWindows);
        Assert.NotNull(day.Rules.EmptyWindowReason);
        Assert.Equal(2, day.Rules.EmptyWindowReason!.Groups.Count);
        Assert.Equal(BookingRules.DayName(target.DayOfWeek), day.Rules.EmptyWindowReason.Day);
    }

    /// <summary>
    /// <b>D2-B34.</b> A court an admin has "deleted" is a soft delete, and the grid used to load
    /// only active courts while fetching bookings unfiltered — so a member's PAID booking on that
    /// court was on no screen in the product, could not be cancelled from the UI, and was still
    /// swept as a no-show with the penalty.
    /// </summary>
    [Fact]
    public async Task A_booking_on_a_deactivated_court_is_still_on_the_grid()
    {
        await using var host = await TestHost.CreateAsync();
        await GiveSettingsAsync(host, OpenAllHours);
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        var schedule = scope.ServiceProvider.GetRequiredService<ScheduleService>();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 5000, host.PlayerUser.Id), default);

        var target = NextWeekAt(9);
        var ok = Assert.IsType<BookingResult.Ok>(await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, target, 1, default));

        var court = await db.Courts.FirstAsync(c => c.Id == host.Courts[0].Id);
        court.IsActive = false;
        await db.SaveChangesAsync();

        var day = await schedule.GetDayAsync(DateOnly.FromDateTime(target.UtcDateTime), host.PlayerUser.Id, default);

        Assert.Contains(day.Slots, sl => sl.BookingId == ok.Booking.Id);
        Assert.False(Assert.Single(day.Courts, c => c.Id == host.Courts[0].Id).IsActive);
    }
}
