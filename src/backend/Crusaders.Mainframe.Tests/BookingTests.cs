using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Booking semantics as they actually are.
///
/// <para>
/// These five tests were left deliberately red for months (recorded in
/// <c>memory/decisions.md</c>) because they encoded the pre-blueprint economics:
/// R50 per 30-minute slice. The fixture has since moved to <b>8 credits per
/// 15-minute slice</b>, so they were asserting a system that no longer existed.
/// </para>
///
/// <para>
/// Worth noting for anyone reading the old failures: the overlap test was failing
/// because at 15-minute slices a booking at <c>startsAt + 15</c> is <em>adjacent</em>
/// to one at <c>startsAt</c>, not overlapping — accepting it was correct. It was
/// not, as it first appeared, a double-booking bug.
/// </para>
///
/// <para>
/// <b>The debit happens at booking.</b> That is the founder's decision and it
/// contradicts blueprint A.9, which debits on lights-on; the deviation is recorded
/// in <c>docs/specs/client-blueprint-deltas.md</c> for committee sign-off, and the
/// <c>CLAUDE.md</c> invariant was rewritten in the commit that moved it. What that
/// buys is a cancellation story with only one moving part: refund what was taken,
/// less a penalty if it is late, and refund nothing at all once someone has actually
/// checked in.
/// </para>
/// </summary>
public class BookingTests
{
    // TestHost fixture: slice_minutes 15, court price 8 credits, penalty_pct 30,
    // penalty_window_minutes 15.
    private const decimal SlicePriceCredits = 8m;

    [Fact]
    public async Task Booking_succeeds_when_balance_covers_cost_and_slot_free()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200m, host.PlayerUser.Id), default);
        var startsAt = DateTimeOffset.UtcNow.AddHours(2);
        var result = await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, sliceCount: 1, default);

        var ok = Assert.IsType<BookingResult.Ok>(result);
        Assert.Equal(BookingStatus.Booked, ok.Booking.Status);

        // Booking reserves the slot AND debits, in one unit of work. The balance
        // returned is what the member has left, which is what the confirmation email
        // and the booking.created event both quote.
        Assert.Equal(200m - SlicePriceCredits, ok.BalanceAfterCredits);
        Assert.Equal(200m - SlicePriceCredits, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.NotNull(ok.Booking.ChargedAt);
    }

    [Fact]
    public async Task Booking_fails_with_insufficient_balance()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        var startsAt = DateTimeOffset.UtcNow.AddHours(2);
        var result = await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);

        var ib = Assert.IsType<BookingResult.InsufficientBalance>(result);
        Assert.Equal(0m, ib.CurrentCredits);
        Assert.Equal(SlicePriceCredits, ib.RequiredCredits);
    }

    [Fact]
    public async Task Booking_fails_when_slot_overlaps_existing_booking()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500m, host.PlayerUser.Id), default);
        var startsAt = DateTimeOffset.UtcNow.AddHours(2);

        // Two slices = 30 minutes, so a booking 15 minutes in genuinely overlaps.
        var first = await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, sliceCount: 2, default);
        Assert.IsType<BookingResult.Ok>(first);

        var overlapping = await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt.AddMinutes(15), 1, default);
        Assert.IsType<BookingResult.SlotTaken>(overlapping);
    }

    [Fact]
    public async Task Booking_immediately_after_another_is_allowed()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500m, host.PlayerUser.Id), default);
        var startsAt = DateTimeOffset.UtcNow.AddHours(2);

        Assert.IsType<BookingResult.Ok>(
            await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default));

        // Back-to-back, not overlapping — the first ends exactly where this begins.
        Assert.IsType<BookingResult.Ok>(
            await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt.AddMinutes(15), 1, default));
    }

    [Fact]
    public async Task Cancellation_inside_penalty_window_charges_the_penalty_only()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200m, host.PlayerUser.Id), default);
        // Starts in 5 minutes — inside the 15-minute penalty window.
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(5);
        var booked = (BookingResult.Ok)await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);

        var cancelled = (CancellationResult.Ok)await booking.CancelAsync(booked.Booking.Id, host.PlayerUser.Id, waivePenalty: false, default);

        // The 8 credits taken at booking come back in full, and the penalty is taken as
        // its own movement rather than netted off the refund: a single net row cannot
        // answer "how much penalty did I pay?", which is the question a disputed
        // cancellation actually asks. 30% of 8 credits = 2.40.
        Assert.Equal(SlicePriceCredits, cancelled.RefundedCredits);
        Assert.Equal(2.40m, cancelled.PenaltyCredits);
        Assert.Equal(200m - 2.40m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        // Both movements are on the statement, in full.
        var entries = await ledger.GetEntriesAsync(
            host.PlayerUser.Id, DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1), default);
        Assert.Contains(entries, e => e.Type == LedgerEntryType.CancellationRefund && e.AmountCredits == SlicePriceCredits);
        Assert.Contains(entries, e => e.Type == LedgerEntryType.LateCancellationPenalty && e.AmountCredits == -2.40m);
    }

    [Fact]
    public async Task Cancellation_outside_penalty_window_costs_nothing()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200m, host.PlayerUser.Id), default);
        var startsAt = DateTimeOffset.UtcNow.AddHours(3);
        var booked = (BookingResult.Ok)await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);

        var cancelled = (CancellationResult.Ok)await booking.CancelAsync(booked.Booking.Id, host.PlayerUser.Id, waivePenalty: false, default);

        // Cancelled in good time: the booking charge comes straight back and no penalty
        // is taken, so the member is where they started.
        Assert.Equal(SlicePriceCredits, cancelled.RefundedCredits);
        Assert.Equal(0m, cancelled.PenaltyCredits);
        Assert.Equal(200m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }

    /// <summary>
    /// The one decision that survives from "charge on lights-on": <b>no refund once the
    /// lights have been on</b>. Under charge-at-booking that is the only branch where the
    /// member keeps nothing, so it is the branch worth guarding — get it wrong and every
    /// played game is refundable.
    ///
    /// <para>
    /// Cancelled by an admin, because a member cannot self-cancel a booking whose start
    /// has passed. Attendance is read from <c>CheckedInAt</c>, never from the clock.
    /// </para>
    /// </summary>
    [Fact]
    public async Task Cancellation_after_check_in_refunds_nothing()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();
        var db = scope.ServiceProvider.GetRequiredService<Crusaders.Mainframe.Api.Persistence.MainframeDbContext>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200m, host.PlayerUser.Id), default);
        var booked = (BookingResult.Ok)await booking.CreateAsync(
            host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, DateTimeOffset.UtcNow.AddMinutes(30), 1, default);
        Assert.Equal(200m - SlicePriceCredits, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));

        // They turned up and played. The clock is irrelevant; this stamp is not.
        var row = await db.Bookings.FirstAsync(b => b.Id == booked.Booking.Id);
        row.CheckedInAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();

        var cancelled = (CancellationResult.Ok)await booking.CancelAsync(
            booked.Booking.Id, host.AdminUser.Id, waivePenalty: false, default);

        Assert.Equal(0m, cancelled.RefundedCredits);
        Assert.Equal(0m, cancelled.PenaltyCredits);
        Assert.Equal(200m - SlicePriceCredits, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }
}
