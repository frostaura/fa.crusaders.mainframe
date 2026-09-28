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
    private readonly CourtActivationService _activation;
    private readonly ILogger<BiometricService> _logger;

    public BiometricService(MainframeDbContext db, ITenantContext tenant, IBiometricDevice device, IEventBus bus, CourtActivationService activation, ILogger<BiometricService> logger)
    { _db = db; _tenant = tenant; _device = device; _bus = bus; _activation = activation; _logger = logger; }

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
    /// <returns>
    /// The device's identification outcome, plus what activating on it did. The activation is
    /// null only when nobody was identified; it used to be swallowed here entirely, so an
    /// insufficient-balance refusal reached the kiosk as a plain successful match — the
    /// member was told nothing while the lights stayed off.
    /// </returns>
    public async Task<(BiometricMatchResult Match, ActivationResult? Activation)> MatchAtCourtAsync(
        int courtNumber, Guid? payerOverrideUserId, CancellationToken ct)
    {
        var court = await _db.Courts.FirstOrDefaultAsync(c => c.CourtNumber == courtNumber, ct);
        if (court is null)
            return (new BiometricMatchResult(false, null, null, 0, 0, 0), null);

        var now = DateTimeOffset.UtcNow;

        // The candidate list comes from CourtActivationService so biometric, PIN and QR read
        // the SAME ordered selector — window from tenant settings, rows ordered by StartsAt.
        // This path used to build a third, unordered bookings-join-templates query of its
        // own, which re-opened the two-back-to-back-bookings bug the shared selector fixed:
        // whichever row the store returned first was checked in, and a member scanning at
        // 16:58 holding 17:00 and 17:15 could activate the 17:15 slice while the 17:00 one
        // swept as a no-show under their feet.
        var candidates = await _activation.CandidatesAsync(court.Id, now, ct);
        // The organiser and every accepted partner (D11), earliest booking first.
        var players = await _activation.PlayersOfAsync(candidates, ct);
        var candidateUserIds = players.Select(p => p.UserId).Distinct().ToList();

        var templates = await _db.EnrolledTemplates
            .Where(t => candidateUserIds.Contains(t.UserId) && t.SupersededAt == null)
            .Select(t => new { t.TemplateId, t.UserId })
            .ToListAsync(ct);

        var refs = templates.Select(t => new EnrolledTemplateRef(t.TemplateId, t.UserId)).Distinct().ToList();
        var capture = await _device.CaptureAsync(new CaptureOptions(), ct);
        var match = await _device.IdentifyAsync(capture, refs, new IdentifyOptions(), ct);

        // The FIRST candidate is the earliest booking in the window — the one the player is
        // standing on — because CandidatesAsync orders by StartsAt.
        var booking = match.Matched
            ? players.Where(p => p.UserId == match.MatchedUserId).Select(p => p.Booking).FirstOrDefault()
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

        await _db.SaveChangesAsync(ct);

        ActivationResult? activation = null;
        if (booking is not null)
        {
            // Charge, check in and cue the lights through the shared path. Insufficient
            // balance refuses here rather than logging and lighting the court anyway.
            activation = await _activation.ActivateAsync(
                court, booking,
                identifiedUserId: match.MatchedUserId ?? booking.UserId ?? Guid.Empty,
                payerOverrideUserId: payerOverrideUserId,
                method: "biometric",
                ct);
        }
        else if (match.Matched)
        {
            // Identified, but holding no activatable booking on this court. Unreachable
            // while refs derive from the candidate list, but stated rather than left null
            // so a matched player always carries an activation outcome to the kiosk.
            activation = new ActivationResult.NoBooking();
        }

        return (match, activation);
    }
}
