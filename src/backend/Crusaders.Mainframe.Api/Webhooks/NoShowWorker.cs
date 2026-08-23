using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;

namespace Crusaders.Mainframe.Api.Webhooks;

/// <summary>
/// Marks bookings as no-show after the grace window passes without a successful biometric match,
/// applies the configured penalty as a ledger entry, and emits booking.no_show.
/// </summary>
public sealed class NoShowWorker : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly IEventBus _bus;
    private readonly ILogger<NoShowWorker> _logger;

    public NoShowWorker(IServiceProvider services, IEventBus bus, ILogger<NoShowWorker> logger)
    { _services = services; _bus = bus; _logger = logger; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await TickAsync(stoppingToken); }
            catch (Exception ex) { _logger.LogError(ex, "NoShowWorker tick failed"); }
            await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
        }
    }

    // internal so the money-correctness regression test can drive one tick directly
    // rather than waiting on the 30s BackgroundService timer.
    internal async Task TickAsync(CancellationToken ct)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        var ledger = scope.ServiceProvider.GetRequiredService<LedgerService>();
        var settings = scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>();
        var email = scope.ServiceProvider.GetRequiredService<IEmailService>();

        var now = DateTimeOffset.UtcNow;

        // Pull all tenants and walk them — keeps the worker tenant-aware.
        var tenants = await db.Tenants.IgnoreQueryFilters().ToListAsync(ct);
        foreach (var tenant in tenants)
        {
            tenantContext.Set(tenant.Id, tenant.Slug);
            var tSettings = await settings.GetAsync(ct);
            var graceCutoff = now.AddMinutes(-tSettings.GraceWindowMinutes);

            // A booking is a no-show iff:
            //  - it's still in Booked status (not Cancelled/Completed/AdminBlock)
            //  - StartsAt + grace_window has passed
            //  - the player never checked in (no successful biometric match against this booking)
            // Note: we deliberately check CheckedInAt — NOT LightsOnCuedAt — because LightsCueWorker
            // sets LightsOnCuedAt automatically at slot start as a webhook-idempotency stamp,
            // independent of whether anyone actually showed up.
            // The lower bound matters: without it, switching on terminal check-in over a
            // backlog of historical un-checked-in Booked rows would mass-post no-shows
            // (and, before the refund guard below, mass-refund them) on the first tick.
            var lookbackFloor = now.AddDays(-tSettings.NoShowLookbackDays);

            var dueNoShow = await db.Bookings
                .Where(b => b.Status == BookingStatus.Booked
                    && b.CheckedInAt == null
                    && b.UserId != null
                    && b.StartsAt <= graceCutoff
                    && b.StartsAt >= lookbackFloor)
                .ToListAsync(ct);

            foreach (var b in dueNoShow)
            {
                if (b.UserId is null) continue;

                // Who pays is who was charged. Posting the penalty to the booker when
                // someone else paid (blueprint B.2 payer override) debits the wrong person.
                var payerUserId = b.PaidByUserId ?? b.UserId.Value;

                // Both movements are guarded on an actual charge having happened.
                //
                // Under charge-at-booking that guard is true for every row CreateAsync writes,
                // and the economics are the club's: the member paid at booking, did not turn
                // up, and gets the slot back less the penalty — the blueprint's own words.
                //
                // The guard is not therefore redundant. A reservation carrying no debit still
                // reaches this sweep, and refunding one credits a player for a slot nobody
                // paid for. That was live once: the refund ran on AmountChargedCredits > 0
                // alone, so under the old charge-on-activation model — where a no-show by
                // definition never checked in and so was never charged — failing to turn up
                // paid out 70% of the booking value.
                var wasCharged = b.ChargedAt is not null;

                // Zero rather than uncollected, so the email and the event quote it as zero
                // too — a penalty nobody was charged is not a penalty.
                var penalty = wasCharged
                    ? Math.Round(b.AmountChargedCredits * tSettings.PenaltyPct / 100m, 2, MidpointRounding.AwayFromZero)
                    : 0m;

                if (wasCharged && b.AmountChargedCredits > 0)
                {
                    await ledger.PostAsync(new LedgerPosting(
                        UserId: payerUserId, Type: LedgerEntryType.CancellationRefund, AmountCredits: b.AmountChargedCredits,
                        ActorUserId: Guid.Empty, RelatedBookingId: b.Id, Reason: "No-show — booking refunded"), ct);
                }

                // A penalty is only collectable against money that moved. Charging one for a
                // booking that was never paid for would drive the balance negative for a slot
                // the club never received anything for.
                if (penalty > 0)
                {
                    await ledger.PostAsync(new LedgerPosting(
                        UserId: payerUserId, Type: LedgerEntryType.NoShowPenalty, AmountCredits: -penalty,
                        ActorUserId: Guid.Empty, RelatedBookingId: b.Id,
                        Reason: $"No-show penalty ({tSettings.PenaltyPct}% of {b.AmountChargedCredits:0.00} credits)"), ct);
                }

                b.Status = BookingStatus.NoShow;

                var user = await db.Users.FirstAsync(u => u.Id == b.UserId, ct);
                var court = await db.Courts.FirstAsync(c => c.Id == b.CourtId, ct);
                // What the member is actually left with, which is nothing at all if nothing was
                // ever taken — quoting them a refund they did not receive is how a support
                // ticket starts.
                var netRefund = wasCharged ? b.AmountChargedCredits - penalty : 0m;
                try
                {
                    await email.SendAsync(EmailTemplates.BookingCancellation(user.Email, court.Name + " (no-show)", netRefund, penalty), ct);
                }
                catch (Exception ex) { _logger.LogWarning(ex, "No-show email failed for {BookingId}", b.Id); }

                await _bus.EmitAsync(new DomainEvent(
                    Id: $"evt_{Guid.NewGuid():N}",
                    Type: "booking.no_show",
                    TenantId: tenant.Id, TenantSlug: tenant.Slug,
                    OccurredAt: now, ActorUserId: null, ActorIsAdmin: false, SubjectUserId: b.UserId,
                    Data: new()
                    {
                        ["booking_id"] = b.Id,
                        ["court_id"] = b.CourtId,
                        ["court_number"] = court.CourtNumber,
                        ["user_id"] = b.UserId,
                        ["penalty_credits"] = penalty,
                        ["refund_credits"] = netRefund,
                    }), ct);
            }

            if (dueNoShow.Count > 0) await db.SaveChangesAsync(ct);
        }
    }
}
