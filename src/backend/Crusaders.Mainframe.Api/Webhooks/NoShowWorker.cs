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

    private async Task TickAsync(CancellationToken ct)
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
            var dueNoShow = await db.Bookings
                .Where(b => b.Status == BookingStatus.Booked
                    && b.CheckedInAt == null
                    && b.UserId != null
                    && b.StartsAt <= graceCutoff)
                .ToListAsync(ct);

            foreach (var b in dueNoShow)
            {
                if (b.UserId is null) continue;
                var penalty = Math.Round(b.AmountChargedZar * tSettings.PenaltyPct / 100m, 2, MidpointRounding.AwayFromZero);

                // Honest ledger: full refund of the original BookingCharge, then a signed penalty debit.
                // Net effect on user balance is identical to the old "partial refund + R0 penalty" pair,
                // but the rows now read truthfully — penalty totals in reports reflect actual money kept.
                if (b.AmountChargedZar > 0)
                    await ledger.PostAsync(new LedgerPosting(
                        UserId: b.UserId.Value, Type: LedgerEntryType.CancellationRefund, AmountZar: b.AmountChargedZar,
                        ActorUserId: Guid.Empty, RelatedBookingId: b.Id, Reason: "No-show — booking refunded"), ct);

                if (penalty > 0)
                    await ledger.PostAsync(new LedgerPosting(
                        UserId: b.UserId.Value, Type: LedgerEntryType.NoShowPenalty, AmountZar: -penalty,
                        ActorUserId: Guid.Empty, RelatedBookingId: b.Id,
                        Reason: $"No-show penalty ({tSettings.PenaltyPct}% of R{b.AmountChargedZar:0.00})"), ct);

                b.Status = BookingStatus.NoShow;

                var user = await db.Users.FirstAsync(u => u.Id == b.UserId, ct);
                var court = await db.Courts.FirstAsync(c => c.Id == b.CourtId, ct);
                var netRefund = b.AmountChargedZar - penalty;
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
                        ["penalty_zar"] = penalty,
                        ["refund_zar"] = netRefund,
                    }), ct);
            }

            if (dueNoShow.Count > 0) await db.SaveChangesAsync(ct);
        }
    }
}
