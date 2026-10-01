using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Tests;

public class LedgerTests
{
    [Fact]
    public async Task Balance_equals_sum_of_entries()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 500, host.PlayerUser.Id, Reason: "TopUp"), default);
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.BookingCharge, -50, host.PlayerUser.Id, Reason: "Booking"), default);
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.AdminAdjustment, 25, host.AdminUser.Id, Reason: "Goodwill"), default);

        var balance = await ledger.GetBalanceAsync(host.PlayerUser.Id, default);
        Assert.Equal(475, balance);
    }

    [Fact]
    public async Task Posting_zero_or_signed_amounts_are_recorded_distinctly()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100, host.PlayerUser.Id), default);
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.BookingCharge, -25, host.PlayerUser.Id), default);

        var rows = await db.LedgerEntries.OrderBy(l => l.CreatedAt).ToListAsync();
        Assert.Equal(2, rows.Count);
        Assert.Equal(100, rows[0].AmountMinutes);
        Assert.Equal(-25, rows[1].AmountMinutes);
    }
}
