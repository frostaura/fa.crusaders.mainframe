using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Biometric;

/// <summary>
/// Biometric enrollment + court-side identification.
///
/// Phase 8 economics: <see cref="MatchAtCourtAsync"/> is the moment the ledger debit fires
/// (charge-on-lights-on per blueprint A.9). Supports the at-court "I'll pay" payer override per
/// blueprint B.2 by accepting an optional <paramref name="payerOverrideUserId"/>.
/// </summary>
public sealed class BiometricService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly IBiometricDevice _device;
    private readonly IEventBus _bus;
    private readonly BookingService _bookingService;
    private readonly IConfiguration _config;
    private readonly ILogger<BiometricService> _logger;

    public BiometricService(MainframeDbContext db, ITenantContext tenant, IBiometricDevice device, IEventBus bus, BookingService bookingService, IConfiguration config, ILogger<BiometricService> logger)
    { _db = db; _tenant = tenant; _device = device; _bus = bus; _bookingService = bookingService; _config = config; _logger = logger; }

    public async Task<BiometricEnrollmentResult> EnrollAsync(Guid memberUserId, Guid adminUserId, string? fingerLabel, string consentReceiptHash, CancellationToken ct)
    {
        var result = await _device.EnrollAsync(new EnrollmentRequest(_tenant.TenantId, memberUserId, adminUserId, fingerLabel, consentReceiptHash), ct);
        if (result.Ok && result.TemplateId is not null)
        {
            _db.EnrolledTemplates.Add(new EnrolledTemplate
            {
                TenantId = _tenant.TenantId,
                UserId = memberUserId,
                TemplateId = result.TemplateId,
                FingerLabel = fingerLabel,
                EnrolledByAdminUserId = adminUserId,
                ConsentReceiptHash = consentReceiptHash,
            });
            _db.AuditLogs.Add(new AuditLog
            {
                TenantId = _tenant.TenantId,
                ActorUserId = adminUserId,
                SubjectUserId = memberUserId,
                Action = "biometric.enrolled",
                DetailsJson = System.Text.Json.JsonSerializer.Serialize(new { template_id = result.TemplateId, finger_label = fingerLabel }),
            });
            await _db.SaveChangesAsync(ct);
        }
        return result;
    }

    /// <summary>
    /// Identifies the player at the courtside terminal and, on success, fires the booking_charge
    /// ledger entry and the lights_on event.
    /// </summary>
    /// <param name="payerOverrideUserId">
    /// Optional — per blueprint B.2 ("at-court payer override"). When set, the booking_charge is
    /// debited against this user's account instead of the booked player. Used when a different
    /// identified player presses "I'll pay" at the touchpad.
    /// </param>
    public async Task<BiometricMatchResult> MatchAtCourtAsync(int courtNumber, Guid? payerOverrideUserId, CancellationToken ct)
    {
        var court = await _db.Courts.FirstOrDefaultAsync(c => c.CourtNumber == courtNumber, ct);
        if (court is null)
            return new BiometricMatchResult(false, null, null, 0, 0, 0);

        var now = DateTimeOffset.UtcNow;
        var graceMin = _config.GetValue("Biometric:GraceMinutes", 5);
        var windowStart = now.AddMinutes(-graceMin);
        var windowEnd = now.AddHours(2);

        // Candidate set: users with a Booked booking on this court touching the current grace+forward window.
        var candidates = await (
            from b in _db.Bookings
            where b.CourtId == court.Id
                && b.Status == BookingStatus.Booked
                && b.StartsAt < windowEnd && b.EndsAt > windowStart
            join t in _db.EnrolledTemplates on b.UserId equals t.UserId
            where t.SupersededAt == null
            select new { b, t }
        ).ToListAsync(ct);

        var refs = candidates.Select(x => new EnrolledTemplateRef(x.t.TemplateId, x.t.UserId)).Distinct().ToList();
        var capture = await _device.CaptureAsync(new CaptureOptions(), ct);
        var match = await _device.IdentifyAsync(capture, refs, new IdentifyOptions(), ct);

        var booking = match.Matched
            ? candidates.FirstOrDefault(x => x.t.UserId == match.MatchedUserId)?.b
            : null;

        _db.BiometricMatchEvents.Add(new BiometricMatchEvent
        {
            TenantId = _tenant.TenantId,
            CourtId = court.Id,
            AttemptedAt = now,
            MatchedUserId = match.MatchedUserId,
            BookingId = booking?.Id,
            Confidence = match.Confidence,
            LivenessScore = match.LivenessScore,
            LatencyMs = match.LatencyMs,
            Outcome = match.Matched ? "match" : "no_match",
        });

        if (booking is not null && booking.CheckedInAt is null)
        {
            booking.CheckedInAt = now;
            if (booking.LightsOnCuedAt is null) booking.LightsOnCuedAt = now;

            // Phase 8 — post the ledger debit at this moment (charge-on-lights-on per blueprint A.9).
            // Supports payer override per blueprint B.2.
            var chargeResult = await _bookingService.ChargeOnActivationAsync(
                bookingId: booking.Id,
                payerOverrideUserId: payerOverrideUserId,
                actorUserId: match.MatchedUserId ?? booking.UserId ?? Guid.Empty,
                ct);
            switch (chargeResult)
            {
                case ChargeResult.InsufficientBalance ib:
                    _logger.LogWarning("booking {BookingId} matched but payer {Payer} has insufficient balance ({Current} < {Required}) — lights will fire but ledger remained unposted",
                        booking.Id, ib.PayerUserId, ib.Current, ib.Required);
                    break;
                case ChargeResult.Ok ok:
                    _logger.LogInformation("booking {BookingId} charged {Amount} credits to {Payer}", booking.Id, ok.AmountCredits, ok.ChargedUserId);
                    break;
            }

            await _bus.EmitAsync(new DomainEvent(
                Id: $"evt_{Guid.NewGuid():N}",
                Type: "booking.lights_on",
                TenantId: _tenant.TenantId, TenantSlug: _tenant.TenantSlug,
                OccurredAt: now, ActorUserId: booking.UserId, ActorIsAdmin: false, SubjectUserId: booking.UserId,
                Data: new()
                {
                    ["booking_id"] = booking.Id,
                    ["court_id"] = court.Id,
                    ["court_number"] = court.CourtNumber,
                    ["court_name"] = court.Name,
                    ["user_id"] = booking.UserId,
                    ["paid_by_user_id"] = booking.PaidByUserId,
                    ["duration_seconds"] = Math.Max(0, (int)(booking.EndsAt - now).TotalSeconds),
                }), ct);
        }

        await _db.SaveChangesAsync(ct);
        return match;
    }
}
