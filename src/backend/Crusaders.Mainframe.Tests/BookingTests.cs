using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Booking semantics as they actually are.
///
/// <para>
/// These five tests were left deliberately red for months (recorded in
/// <c>memory/decisions.md</c>) because they encoded the pre-blueprint economics:
/// R50 per 30-minute slice, debited at booking. The fixture has since moved to
/// <b>8 credits per 15-minute slice</b> and the charge moved to activation, so
/// they were asserting a system that no longer existed.
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
/// The charge moves back to booking creation in a later phase, at which point the
/// balance assertions here change again — deliberately, with the invariant in
/// <c>CLAUDE.md</c> rewritten in the same commit.
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

        // Booking reserves the slot and verifies affordability; it does not debit.
        // The balance returned is therefore the unchanged pre-booking balance.
        Assert.Equal(200m, ok.BalanceAfterCredits);
        Assert.Equal(200m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
        Assert.Null(ok.Booking.ChargedAt);
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

        // Nothing was charged, so there is nothing to refund — only the penalty moves.
        // 30% of 8 credits = 2.40.
        Assert.Equal(0m, cancelled.RefundedCredits);
        Assert.Equal(2.40m, cancelled.PenaltyCredits);
        Assert.Equal(200m - 2.40m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
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

        // Never charged, cancelled in good time: no ledger movement at all.
        Assert.Equal(0m, cancelled.RefundedCredits);
        Assert.Equal(0m, cancelled.PenaltyCredits);
        Assert.Equal(200m, await ledger.GetBalanceAsync(host.PlayerUser.Id, default));
    }
}
