using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 7, the backend's words and counts with no database under them: the door a night
/// names (E7-4), an outage refund that is not a no-show (E7-1, E7-2), a penalty given back that is
/// not still counted (E7-7), and a package line that says its minutes once.
/// </summary>
public sealed class R7WordsTests
{
    [Theory]
    [InlineData("Front door", "gate-598a9a", "Front door")]
    [InlineData("  Front door ", null, "Front door")]
    [InlineData("Door gate", "gate-598a9a", "Unnamed scanner (gate-598a9a)")]
    [InlineData("", "gate-598a9a", "Unnamed scanner (gate-598a9a)")]
    [InlineData(null, "gate-598a9a", "Unnamed scanner (gate-598a9a)")]
    [InlineData("Door gate", null, "Unnamed scanner")]
    [InlineData(null, null, null)]
    public void A_door_is_named_by_the_consoles_rule(string? name, string? code, string? expected)
    {
        Assert.Equal(expected, TraceKinds.DoorLabel(name, code));
    }

    [Fact]
    public void A_night_never_calls_a_door_by_the_placeholder()
    {
        var headline = TraceKinds.Headline(TraceKinds.DoorOpened, new TraceFacts { DoorName = TraceKinds.DoorLabel("Door gate", "gate-1") });
        Assert.Equal("Came in through Unnamed scanner (gate-1)", headline);
        Assert.Equal("Came in through a door", TraceKinds.Headline(TraceKinds.DoorOpened, new TraceFacts { DoorName = TraceKinds.DoorLabel(null, null) }));
    }

    [Fact]
    public void An_outage_refund_is_not_told_as_a_no_show()
    {
        var outage = TraceKinds.Headline(TraceKinds.BookingNoShow, new TraceFacts { CourtName = "Court 1", CourtWasDark = true });
        Assert.Equal("The club refunded Court 1 in full — its box was offline", outage);
        Assert.DoesNotContain("no-show", outage, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(
            "The club's automatic check marked this as a no-show",
            TraceKinds.Headline(TraceKinds.BookingNoShow, new TraceFacts { CourtName = "Court 1" }));
    }

    [Fact]
    public void An_outage_refunds_ledger_line_does_not_say_no_show()
    {
        var court = new Court { CourtNumber = 1, Name = "Court 1" };
        Assert.Equal("Court 1 was offline — booking refunded in full", NoShowWorker.RefundReason(courtWasDark: true, court));
        Assert.Equal("The court was offline — booking refunded in full", NoShowWorker.RefundReason(courtWasDark: true, null));
        Assert.Equal("No-show — booking refunded", NoShowWorker.RefundReason(courtWasDark: false, court));
    }

    private static LedgerEntry Penalty(int minutes, Guid? booking) => new()
    {
        Id = Guid.NewGuid(),
        TenantId = Guid.NewGuid(),
        UserId = Guid.NewGuid(),
        Type = LedgerEntryType.NoShowPenalty,
        AmountMinutes = minutes,
        RelatedBookingId = booking,
        Reason = "test",
        CreatedAt = DateTimeOffset.UtcNow,
    };

    /// <summary>E7-7: "Penalty count 1" beside "Penalties 0 min" after the club gave the penalty back.</summary>
    [Fact]
    public void A_penalty_given_back_is_no_longer_counted()
    {
        var returned = Guid.NewGuid();
        var kept = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        var report = JsonSerializer.SerializeToElement(ReportingEndpoints.BuildWalletReport(
            [Penalty(-13, returned), Penalty(13, returned), Penalty(-9, kept), Penalty(-4, null)], now.AddDays(-30), now));

        Assert.Equal(2, report.GetProperty("penalty_count").GetInt32());
        Assert.Equal(13, report.GetProperty("penalties_minutes").GetInt32());
    }

    [Fact]
    public void A_returned_penalty_alone_counts_nothing()
    {
        var booking = Guid.NewGuid();
        Assert.Equal(0, ReportingEndpoints.PenaltyCount([Penalty(-13, booking), Penalty(13, booking)]));
    }

    /// <summary>The wallet read "PayFast purchase: 5 hours (5 hours) for R550.00".</summary>
    [Theory]
    [InlineData("5 hours", 300, "5 hours")]
    [InlineData("5 h", 300, "5 h")]
    [InlineData("Club night", 90, "Club night (1 hour 30 minutes)")]
    [InlineData("", 45, "45 minutes")]
    public void A_package_line_says_its_minutes_once(string name, int minutes, string expected)
    {
        Assert.Equal(expected, TopUpEndpoints.PackageWords(name, minutes));
    }

    [Fact]
    public void A_payfast_purchase_line_names_a_package_called_by_its_minutes_once()
    {
        var pending = new PendingTopup { IdempotencyKey = "k", PackageName = "5 hours", Minutes = 300, AmountZar = 550m };
        Assert.Equal("PayFast purchase: 5 hours for R550.00", TopUpEndpoints.PurchaseReason(pending, "R"));
    }
}
