using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The money and booking events <c>docs/specs/webhooks.md</c> §9 promises and the bus never
/// carried.
///
/// <para>
/// Nine of the spec's classes had no emitter at all. These are the three that turned out to
/// have a real code path behind them and no event on it: a refund and a penalty are ledger
/// rows the club's accounting consumer has to see as movements — <c>booking.late_cancellation</c>
/// says a booking was cancelled late, it does not say how much money moved — and a booking
/// that ran to its end with the member actually there is the "played and finished" signal a
/// club's utilisation reporting is built on, distinct from <c>booking.lights_off</c>, which
/// also fires for a no-show.
/// </para>
/// </summary>
public class WebhookEventCoverageTests
{
    private static List<DomainEvent> Drain(TestHost host)
    {
        var bus = host.Services.GetRequiredService<IEventBus>();
        var emitted = new List<DomainEvent>();
        while (bus.Reader.TryRead(out var evt)) emitted.Add(evt);
        return emitted;
    }

    [Fact]
    public async Task A_cancellation_refund_row_emits_credit_refunded()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        Drain(host);

        var entry = await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.CancellationRefund, 8m, host.PlayerUser.Id,
            Reason: "Cancelled outside the penalty window"), default);

        var evt = Assert.Single(Drain(host), e => e.Type == "credit.refunded");
        Assert.Equal(entry.Id, evt.Data["entry_id"]);
        Assert.Equal(8m, evt.Data["amount_credits"]);
        Assert.Equal(host.PlayerUser.Id, evt.SubjectUserId);
    }

    [Theory]
    [InlineData(LedgerEntryType.NoShowPenalty)]
    [InlineData(LedgerEntryType.LateCancellationPenalty)]
    public async Task A_penalty_row_emits_credit_penalty_applied(LedgerEntryType type)
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        Drain(host);

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, type, -2.40m, host.AdminUser.Id), default);

        var evt = Assert.Single(Drain(host), e => e.Type == "credit.penalty_applied");
        Assert.Equal(type.ToString(), evt.Data["entry_type"]);
        Assert.Equal(-2.40m, evt.Data["amount_credits"]);
    }

    /// <summary>
    /// Both legs of a cancellation are posted in one unit of work, and both are mirrored —
    /// a consumer reconciling a wallet needs the refund and the penalty as separate
    /// movements for the same reason the ledger stores them as separate rows.
    /// </summary>
    [Fact]
    public async Task Both_legs_of_a_cancellation_are_mirrored_from_one_posting()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        Drain(host);

        await ledger.PostManyAsync(
        [
            new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.CancellationRefund, 8m, host.PlayerUser.Id),
            new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.LateCancellationPenalty, -2.40m, host.PlayerUser.Id),
        ], default);

        var types = Drain(host).Select(e => e.Type).ToList();
        Assert.Contains("credit.refunded", types);
        Assert.Contains("credit.penalty_applied", types);
    }

    /// <summary>
    /// <c>credit.adjusted</c> — the desk correction. The only movement in the system a human
    /// decides by hand, and the one an accounting pipe fed by webhooks was silently missing
    /// while it saw every automatic charge and refund.
    ///
    /// <para>
    /// Pinned on the ledger rather than on the admin endpoint deliberately: the endpoint is
    /// one caller of <see cref="LedgerService.PostAsync"/> with this entry type, and an event
    /// tied to the caller rather than to the row would go missing the moment a second path
    /// posts an adjustment.
    /// </para>
    /// </summary>
    [Fact]
    public async Task An_admin_adjustment_emits_credit_adjusted()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        Drain(host);

        var entry = await ledger.PostAsync(new LedgerPosting(
            host.PlayerUser.Id, LedgerEntryType.AdminAdjustment, 25m, host.AdminUser.Id,
            Reason: "Goodwill after the court was double-booked"), default);

        var evt = Assert.Single(Drain(host), e => e.Type == "credit.adjusted");
        Assert.Equal(entry.Id, evt.Data["entry_id"]);
        Assert.Equal(25m, evt.Data["amount_credits"]);
        Assert.Equal("Goodwill after the court was double-booked", evt.Data["reason"]);
        Assert.Equal(host.PlayerUser.Id, evt.SubjectUserId);

        // An admin moved somebody else's money, and the envelope has to say so — a consumer
        // reconciling a member's own actions against the club's must be able to tell them apart.
        Assert.True(evt.ActorIsAdmin);
        Assert.Equal(host.AdminUser.Id, evt.ActorUserId);
    }

    /// <summary>A top-up and a booking charge are not refunds; they have their own events or none.</summary>
    [Fact]
    public async Task An_ordinary_charge_does_not_masquerade_as_a_refund_or_a_penalty()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        Drain(host);

        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.TopUp, 100m, host.PlayerUser.Id), default);
        await ledger.PostAsync(new LedgerPosting(host.PlayerUser.Id, LedgerEntryType.BookingCharge, -8m, host.PlayerUser.Id), default);

        Assert.Empty(Drain(host));
    }

    /// <summary>
    /// <c>booking.completed</c> fires for a booking that ended with the member checked in,
    /// and not for one that ended without them — that one is a no-show, and the sweep, not
    /// this worker, owns it.
    /// </summary>
    [Fact]
    public async Task A_booking_that_ends_with_the_member_present_emits_booking_completed()
    {
        await using var host = await TestHost.CreateAsync();
        using var scope = host.NewScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var attended = NewBooking(host, checkedIn: true);
        var absent = NewBooking(host, checkedIn: false);
        db.Bookings.AddRange(attended, absent);
        await db.SaveChangesAsync();
        Drain(host);

        var worker = new LightsCueWorker(
            host.Services,
            host.Services.GetRequiredService<IEventBus>(),
            NullLogger<LightsCueWorker>.Instance);
        await worker.TickAsync(default);

        var completed = Drain(host).Where(e => e.Type == "booking.completed").ToList();
        var only = Assert.Single(completed);
        Assert.Equal(attended.Id, only.Data["booking_id"]);
        Assert.Equal(host.PlayerUser.Id, only.SubjectUserId);
    }

    private static Booking NewBooking(TestHost host, bool checkedIn)
    {
        var now = DateTimeOffset.UtcNow;
        return new Booking
        {
            TenantId = host.Tenant.Id,
            CourtId = host.Courts[0].Id,
            UserId = host.PlayerUser.Id,
            BookedByUserId = host.PlayerUser.Id,
            PaidByUserId = host.PlayerUser.Id,
            StartsAt = now.AddMinutes(-30),
            EndsAt = now.AddMinutes(-15),
            SliceMinutes = 15,
            SliceCount = 1,
            AmountChargedCredits = 8m,
            Status = BookingStatus.Booked,
            CheckedInAt = checkedIn ? now.AddMinutes(-29) : null,
        };
    }
}
