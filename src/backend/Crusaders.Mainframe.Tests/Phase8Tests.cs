using Crusaders.Mainframe.Api.Biometric;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Tests for Phase 8 client-blueprint deltas:
///   8.2 credits unit of account + class-driven conversion (R100 → 160 / 240 credits)
///   8.3 charge-on-lights-on (booking is a hold; debit fires at biometric match)
///   8.4 per-day cap (with same-day relaxation) + peak-hours league exclusivity
///   8.5 at-court payer override (BookedByUserId vs PaidByUserId)
/// </summary>
public class Phase8Tests
{
    // ---- 8.2 Credits + class-driven conversion ----

    [Fact]
    public async Task Top_up_for_regular_member_converts_R100_to_160_credits()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var settings = scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>();
        var s = await settings.GetAsync(default);

        // Simulate the TopUp callback's conversion logic.
        var membership = await scope.ServiceProvider.GetRequiredService<MainframeDbContext>().Memberships.FirstAsync(m => m.UserId == host.PlayerUser.Id);
        var rate = s.ConversionRateFor(membership.MemberClass);
        var credits = 100m * rate;

        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.TopUp, credits, host.PlayerUser.Id,
            ZarPaid: 100m, ConversionRate: rate, Reason: "test top-up"), default);

        var balance = await ledger.GetBalanceAsync(host.PlayerUser.Id, default);
        Assert.Equal(MemberClass.Regular, membership.MemberClass);
        Assert.Equal(1.6m, rate);
        Assert.Equal(160m, balance);
    }

    [Fact]
    public async Task Top_up_for_league_member_converts_R100_to_240_credits()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var settings = scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>();
        var s = await settings.GetAsync(default);

        var membership = await scope.ServiceProvider.GetRequiredService<MainframeDbContext>().Memberships.FirstAsync(m => m.UserId == host.LeaguePlayerUser.Id);
        var rate = s.ConversionRateFor(membership.MemberClass);
        var credits = 100m * rate;

        await ledger.PostAsync(new LedgerPosting(
            host.LeaguePlayerUser.Id, LedgerEntryType.TopUp, credits, host.LeaguePlayerUser.Id,
            ZarPaid: 100m, ConversionRate: rate, Reason: "test top-up"), default);

        var balance = await ledger.GetBalanceAsync(host.LeaguePlayerUser.Id, default);
        Assert.Equal(MemberClass.LeagueOrSenior, membership.MemberClass);
        Assert.Equal(2.4m, rate);
        Assert.Equal(240m, balance);
    }

    [Fact]
    public async Task Ledger_records_zar_paid_and_conversion_rate_on_topup_rows()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.TopUp, 160m, host.PlayerUser.Id,
            ZarPaid: 100m, ConversionRate: 1.6m, Reason: "R100 → 160c"), default);

        var entry = await db.LedgerEntries.SingleAsync();
        Assert.Equal(100m, entry.ZarPaid);
        Assert.Equal(1.6m, entry.ConversionRate);
        Assert.Equal(160m, entry.AmountCredits); // legacy column name, holds credits now
    }

    // ---- 8.3 Charge on lights-on ----

    [Fact]
    public async Task Booking_create_does_NOT_post_ledger_entry()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        // Fund the player with 100 credits; slice price is 8.
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id, ZarPaid: 62.50m, ConversionRate: 1.6m), default);

        var startsAt = DateTimeOffset.UtcNow.AddHours(2);
        var result = await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);
        var ok = Assert.IsType<BookingResult.Ok>(result);

        // Balance unchanged — only one entry (the top-up).
        var balance = await ledger.GetBalanceAsync(host.PlayerUser.Id, default);
        Assert.Equal(100m, balance);
        Assert.Equal(100m, ok.BalanceAfterCredits);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var entries = await db.LedgerEntries.Where(l => l.UserId == host.PlayerUser.Id).ToListAsync();
        Assert.Single(entries);
        Assert.Equal(LedgerEntryType.TopUp, entries[0].Type);
        Assert.Null(ok.Booking.ChargedAt);
    }

    [Fact]
    public async Task ChargeOnActivation_posts_booking_charge_and_sets_chargedat()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var startsAt = DateTimeOffset.UtcNow.AddHours(2);
        var created = (BookingResult.Ok)await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);

        var charge = await booking.ChargeOnActivationAsync(created.Booking.Id, payerOverrideUserId: null, actorUserId: host.PlayerUser.Id, default);
        var ok = Assert.IsType<ChargeResult.Ok>(charge);
        Assert.Equal(host.PlayerUser.Id, ok.ChargedUserId);
        Assert.Equal(8m, ok.AmountCredits);

        var balance = await ledger.GetBalanceAsync(host.PlayerUser.Id, default);
        Assert.Equal(92m, balance);

        var fresh = await db.Bookings.AsNoTracking().FirstAsync(b => b.Id == created.Booking.Id);
        Assert.NotNull(fresh.ChargedAt);
    }

    [Fact]
    public async Task ChargeOnActivation_is_idempotent()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var startsAt = DateTimeOffset.UtcNow.AddHours(2);
        var created = (BookingResult.Ok)await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);

        var first = await booking.ChargeOnActivationAsync(created.Booking.Id, null, host.PlayerUser.Id, default);
        Assert.IsType<ChargeResult.Ok>(first);

        var second = await booking.ChargeOnActivationAsync(created.Booking.Id, null, host.PlayerUser.Id, default);
        Assert.IsType<ChargeResult.AlreadyCharged>(second);

        Assert.Equal(92m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }

    [Fact]
    public async Task Cancellation_before_lights_on_produces_no_ledger_entry()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var startsAt = DateTimeOffset.UtcNow.AddHours(3); // outside penalty window
        var created = (BookingResult.Ok)await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);

        var cancelled = (CancellationResult.Ok)await booking.CancelAsync(created.Booking.Id, host.PlayerUser.Id, waivePenalty: false, default);
        Assert.Equal(0m, cancelled.RefundedCredits);
        Assert.Equal(0m, cancelled.PenaltyCredits);

        Assert.Equal(100m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }

    [Fact]
    public async Task Cancellation_inside_grace_window_posts_only_penalty_no_refund()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        // 5 min in the future — well within the 15-minute penalty window.
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(5);
        var created = (BookingResult.Ok)await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);

        // Use admin actor so the "can't self-cancel after start" guard doesn't trip on edge timing.
        var cancelled = (CancellationResult.Ok)await booking.CancelAsync(created.Booking.Id, host.AdminUser.Id, waivePenalty: false, default);
        Assert.Equal(0m, cancelled.RefundedCredits);     // no charge to refund
        Assert.Equal(2.4m, cancelled.PenaltyCredits);    // 30% of 8 credits = 2.4

        // Balance: 100 - 2.4 = 97.6
        Assert.Equal(97.6m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }

    // ---- 8.4 Per-day cap + peak-hours ----

    [Fact]
    public async Task Per_day_cap_blocks_advance_booking_beyond_60_minutes()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200m, host.PlayerUser.Id), default);

        // Tomorrow at 09:00 + 10:00 + 11:00 + 12:00 — five 15-min slices on tomorrow's date.
        var tomorrow = DateTime.UtcNow.Date.AddDays(2);
        for (var i = 0; i < 4; i++)
        {
            var startsAt = new DateTimeOffset(tomorrow.AddHours(9 + i), TimeSpan.Zero);
            var result = await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);
            Assert.IsType<BookingResult.Ok>(result); // 4 * 15 = 60 mins — exactly at the cap.
        }

        // 5th slice would push total to 75 minutes for the same day → blocked.
        var fifthStart = new DateTimeOffset(tomorrow.AddHours(13), TimeSpan.Zero);
        var fifth = await booking.CreateAsync(host.Courts[1].Id, host.PlayerUser.Id, host.PlayerUser.Id, fifthStart, 1, default);
        Assert.IsType<BookingResult.PerDayCapExceeded>(fifth);
    }

    [Fact]
    public async Task Admin_bypasses_per_day_cap()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200m, host.PlayerUser.Id), default);

        var tomorrow = DateTime.UtcNow.Date.AddDays(2);
        // Pile in 5 bookings — admin acts on behalf, so the cap doesn't apply.
        for (var i = 0; i < 5; i++)
        {
            var startsAt = new DateTimeOffset(tomorrow.AddHours(9 + i), TimeSpan.Zero);
            var result = await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.AdminUser.Id, startsAt, 1, default);
            Assert.IsType<BookingResult.Ok>(result);
        }
    }

    [Fact]
    public async Task Peak_hours_block_regular_member_outside_advance_window()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200m, host.PlayerUser.Id), default);

        // Pick a slot inside 16:00–19:00 UTC tomorrow (test fixture uses UTC timezone).
        var tomorrowPeak = new DateTimeOffset(DateTime.UtcNow.Date.AddDays(1).AddHours(17), TimeSpan.Zero);
        var blocked = await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, tomorrowPeak, 1, default);
        Assert.IsType<BookingResult.PeakHoursLeagueOnly>(blocked);
    }

    [Fact]
    public async Task Peak_hours_allow_league_member_anytime()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.LeaguePlayerUser.Id, LedgerEntryType.TopUp, 200m, host.LeaguePlayerUser.Id), default);
        var tomorrowPeak = new DateTimeOffset(DateTime.UtcNow.Date.AddDays(1).AddHours(17), TimeSpan.Zero);
        var result = await booking.CreateAsync(host.Courts[0].Id, host.LeaguePlayerUser.Id, host.LeaguePlayerUser.Id, tomorrowPeak, 1, default);
        Assert.IsType<BookingResult.Ok>(result);
    }

    [Fact]
    public async Task Peak_hours_allow_regular_member_within_advance_window()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200m, host.PlayerUser.Id), default);

        // peak_advance_hours_for_regular = 1 by default in the test fixture.
        // If "now" is currently within peak hours, this slot will be inside the 1h window; otherwise we skip.
        var now = DateTimeOffset.UtcNow;
        if (now.Hour < 15 || now.Hour >= 19) return; // not in peak — skip rather than build a brittle assertion.

        var startsAt = now.AddMinutes(30);
        var result = await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);
        Assert.IsType<BookingResult.Ok>(result);
    }

    // ---- 8.5 Payer override ----

    [Fact]
    public async Task Payer_override_debits_payer_not_booker()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        await ledger.PostAsync(new LedgerPosting(host.LeaguePlayerUser.Id, LedgerEntryType.TopUp, 100m, host.LeaguePlayerUser.Id), default);

        // Booked by PlayerUser (Regular). Use admin actor so peak-hours/per-day cap don't interfere.
        var startsAt = DateTimeOffset.UtcNow.AddHours(2);
        var created = (BookingResult.Ok)await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.AdminUser.Id, startsAt, 1, default);

        // At the court, LeaguePlayerUser presses "I'll pay" — charge goes to them.
        var charge = await booking.ChargeOnActivationAsync(created.Booking.Id, payerOverrideUserId: host.LeaguePlayerUser.Id, actorUserId: host.PlayerUser.Id, default);
        var ok = Assert.IsType<ChargeResult.Ok>(charge);
        Assert.Equal(host.LeaguePlayerUser.Id, ok.ChargedUserId);

        Assert.Equal(100m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));    // booker untouched
        Assert.Equal(92m, await ledger.GetBalanceAsync(host.LeaguePlayerUser.Id, default)); // payer debited
    }

    [Fact]
    public async Task Booking_records_booked_by_and_paid_by_user_ids()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var startsAt = DateTimeOffset.UtcNow.AddHours(2);
        var created = (BookingResult.Ok)await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);

        var fresh = await db.Bookings.AsNoTracking().FirstAsync(b => b.Id == created.Booking.Id);
        Assert.Equal(host.PlayerUser.Id, fresh.BookedByUserId);
        Assert.Equal(host.PlayerUser.Id, fresh.PaidByUserId);
        Assert.Equal(host.PlayerUser.Id, fresh.UserId); // legacy field preserved
    }
}
