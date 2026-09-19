using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Xunit;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The member wallet summary reads the ledger by row type. A reversed no-show posts a
/// positive row of the penalty type to give the money back, and that row must not read
/// as a second penalty — the count is of penalties charged, not of rows carrying the type.
/// </summary>
public sealed class WalletReportTests
{
    private static LedgerEntry Row(LedgerEntryType type, decimal amount) => new()
    {
        Id = Guid.NewGuid(),
        TenantId = Guid.NewGuid(),
        UserId = Guid.NewGuid(),
        Type = type,
        AmountCredits = amount,
        Reason = "test",
        CreatedAt = DateTimeOffset.UtcNow,
    };

    private static JsonElement Report(params LedgerEntry[] rows)
    {
        var now = DateTimeOffset.UtcNow;
        var report = ReportingEndpoints.BuildWalletReport([.. rows], now.AddDays(-30), now);
        return JsonSerializer.SerializeToElement(report);
    }

    [Fact]
    public void A_reversed_no_show_penalty_is_not_counted_twice()
    {
        var report = Report(
            Row(LedgerEntryType.NoShowPenalty, -8m),
            Row(LedgerEntryType.NoShowPenalty, 8m));

        Assert.Equal(1, report.GetProperty("penalty_count").GetInt32());
        Assert.Equal(2, report.GetProperty("count").GetInt32());
    }

    [Fact]
    public void Every_penalty_charged_counts_once()
    {
        var report = Report(
            Row(LedgerEntryType.NoShowPenalty, -8m),
            Row(LedgerEntryType.LateCancellationPenalty, -4m));

        Assert.Equal(2, report.GetProperty("penalty_count").GetInt32());
    }
}
