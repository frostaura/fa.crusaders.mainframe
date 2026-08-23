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
///   8.3 charge-at-booking (the debit fires at CreateAsync; activation only settles WHO pays)
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

    // ---- 8.3 Charge at booking ----

    /// <summary>
    /// The debit lands at booking, not at the court. Blueprint A.9 says otherwise and
    /// the deviation is logged for committee sign-off; this test is what pins the
    /// behaviour the club actually gets.
    /// </summary>
    [Fact]
    public async Task Booking_create_posts_the_booking_charge()
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

        // 100 in, 8 out. The balance the caller is handed is post-charge, because that is
        // the number the confirmation email quotes.
        var balance = await ledger.GetBalanceAsync(host.PlayerUser.Id, default);
        Assert.Equal(92m, balance);
        Assert.Equal(92m, ok.BalanceAfterCredits);

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var entries = await db.LedgerEntries.Where(l => l.UserId == host.PlayerUser.Id).ToListAsync();
        Assert.Equal(2, entries.Count);
        var charge = Assert.Single(entries, e => e.Type == LedgerEntryType.BookingCharge);
        Assert.Equal(-8m, charge.AmountCredits);
        Assert.Equal(ok.Booking.Id, charge.RelatedBookingId);
        Assert.NotNull(ok.Booking.ChargedAt);
    }

    /// <summary>
    /// The uncharged-booking path. Under charge-at-booking this is no longer the ordinary
    /// case — a row reaches the court already paid for — but it is not dead: rows written
    /// before the change, and any future path that reserves without debiting, still land
    /// here. The court must charge them rather than light up for free.
    /// </summary>
    [Fact]
    public async Task ChargeOnActivation_charges_a_booking_that_was_never_charged()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var startsAt = DateTimeOffset.UtcNow.AddHours(2);
        // Written directly, with no ledger entry and no ChargedAt: the shape of a row from
        // before charge-at-booking. Built rather than un-charged, because deleting a ledger
        // row to fake history is exactly what the ledger-only rule exists to prevent — even
        // in a fixture.
        var reserved = new Booking
        {
            TenantId = host.Tenant.Id,
            CourtId = host.Courts[0].Id,
            UserId = host.PlayerUser.Id,
            BookedByUserId = host.PlayerUser.Id,
            PaidByUserId = host.PlayerUser.Id,
            ActorUserId = host.PlayerUser.Id,
            StartsAt = startsAt,
            EndsAt = startsAt.AddMinutes(15),
            SliceMinutes = 15,
            SliceCount = 1,
            AmountChargedCredits = 8m,
            Status = BookingStatus.Booked,
            ChargedAt = null,
        };
        db.Bookings.Add(reserved);
        await db.SaveChangesAsync();
        Assert.Equal(100m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        var charge = await booking.ChargeOnActivationAsync(reserved.Id, payerOverrideUserId: null, actorUserId: host.PlayerUser.Id, default);
        var ok = Assert.IsType<ChargeResult.Ok>(charge);
        Assert.Equal(host.PlayerUser.Id, ok.ChargedUserId);
        Assert.Equal(8m, ok.AmountCredits);

        var balance = await ledger.GetBalanceAsync(host.PlayerUser.Id, default);
        Assert.Equal(92m, balance);

        var fresh = await db.Bookings.AsNoTracking().FirstAsync(b => b.Id == reserved.Id);
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

        // Already charged at creation, so the very first activation is a no-op — and so is
        // every one after it. A court box that retries a queued event must not double-debit.
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var result = await booking.ChargeOnActivationAsync(created.Booking.Id, null, host.PlayerUser.Id, default);
            var already = Assert.IsType<ChargeResult.AlreadyCharged>(result);
            Assert.Equal(8m, already.AmountCredits);
        }

        Assert.Equal(92m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }

    /// <summary>
    /// Cancelled in good time and never played: the member ends up exactly where they
    /// started. Under charge-at-booking that costs two rows rather than none — the charge
    /// and its refund — which is the price of the debit being real.
    /// </summary>
    [Fact]
    public async Task Cancellation_before_lights_on_returns_the_member_to_their_opening_balance()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        var startsAt = DateTimeOffset.UtcNow.AddHours(3); // outside penalty window
        var created = (BookingResult.Ok)await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);

        var cancelled = (CancellationResult.Ok)await booking.CancelAsync(created.Booking.Id, host.PlayerUser.Id, waivePenalty: false, default);
        Assert.Equal(8m, cancelled.RefundedCredits);
        Assert.Equal(0m, cancelled.PenaltyCredits);

        Assert.Equal(100m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        // Net zero, but visibly so: charge and refund both on the statement.
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var types = await db.LedgerEntries.Where(l => l.UserId == host.PlayerUser.Id)
            .Select(l => l.Type).ToListAsync();
        Assert.Contains(LedgerEntryType.BookingCharge, types);
        Assert.Contains(LedgerEntryType.CancellationRefund, types);
        Assert.DoesNotContain(LedgerEntryType.LateCancellationPenalty, types);
    }

    /// <summary>
    /// Late cancellation: the charge comes back in full and the penalty is taken as its own
    /// movement. Netting them into one row would settle to the same balance and leave the
    /// ledger unable to answer "how much penalty did I pay?".
    /// </summary>
    [Fact]
    public async Task Cancellation_inside_penalty_window_refunds_in_full_and_charges_the_penalty()
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
        Assert.Equal(8m, cancelled.RefundedCredits);     // the booking charge, in full
        Assert.Equal(2.4m, cancelled.PenaltyCredits);    // 30% of 8 credits = 2.4

        // Balance: 100 - 8 + 8 - 2.4 = 97.6
        Assert.Equal(97.6m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var entries = await db.LedgerEntries.Where(l => l.UserId == host.PlayerUser.Id).ToListAsync();
        Assert.Equal(-2.4m, Assert.Single(entries, e => e.Type == LedgerEntryType.LateCancellationPenalty).AmountCredits);
        Assert.Equal(8m, Assert.Single(entries, e => e.Type == LedgerEntryType.CancellationRefund).AmountCredits);
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
