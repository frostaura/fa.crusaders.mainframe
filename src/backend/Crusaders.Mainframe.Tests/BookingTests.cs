using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;
using Microsoft.Extensions.DependencyInjection;

namespace Crusaders.Mainframe.Tests;

public class BookingTests
{
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
        Assert.Equal(150m, ok.BalanceAfterZar);
        Assert.Equal(BookingStatus.Booked, ok.Booking.Status);
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
        Assert.Equal(0m, ib.CurrentZar);
        Assert.Equal(50m, ib.RequiredZar);
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
        var first = await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);
        Assert.IsType<BookingResult.Ok>(first);

        var second = await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt.AddMinutes(15), 1, default);
        Assert.IsType<BookingResult.SlotTaken>(second);
    }

    [Fact]
    public async Task Cancellation_inside_penalty_window_keeps_30pct_as_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200m, host.PlayerUser.Id), default);
        // Book starting in 5 minutes — well within the 15-minute penalty window.
        var startsAt = DateTimeOffset.UtcNow.AddMinutes(5);
        var booked = (BookingResult.Ok)await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);

        var cancelled = (CancellationResult.Ok)await booking.CancelAsync(booked.Booking.Id, host.PlayerUser.Id, waivePenalty: false, default);

        // 30% of R50 = R15 penalty; refund = R35
        Assert.Equal(35m, cancelled.RefundedZar);
        Assert.Equal(15m, cancelled.PenaltyZar);

        var balance = await ledger.GetBalanceAsync(host.PlayerUser.Id, default);
        // 200 - 50 (booking) + 35 (refund) = 185
        Assert.Equal(185m, balance);
    }

    [Fact]
    public async Task Cancellation_outside_penalty_window_refunds_full_amount()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var booking = scope.ServiceProvider.GetRequiredService<BookingService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 200m, host.PlayerUser.Id), default);
        var startsAt = DateTimeOffset.UtcNow.AddHours(3);
        var booked = (BookingResult.Ok)await booking.CreateAsync(host.Courts[0].Id, host.PlayerUser.Id, host.PlayerUser.Id, startsAt, 1, default);

        var cancelled = (CancellationResult.Ok)await booking.CancelAsync(booked.Booking.Id, host.PlayerUser.Id, waivePenalty: false, default);

        Assert.Equal(50m, cancelled.RefundedZar);
        Assert.Equal(0m, cancelled.PenaltyZar);

        var balance = await ledger.GetBalanceAsync(host.PlayerUser.Id, default);
        Assert.Equal(200m, balance);
    }
}
