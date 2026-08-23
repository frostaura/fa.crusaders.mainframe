using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>What happened when someone identified themselves at a court.</summary>
public abstract record ActivationResult
{
    /// <summary>Charged and checked in. <paramref name="AlreadyActive"/> marks a repeat scan of a live session.</summary>
    public sealed record Activated(Booking Booking, Guid PayerUserId, decimal AmountCredits, bool AlreadyActive) : ActivationResult;

    /// <summary>Identified, but with no booking on this court inside the window.</summary>
    public sealed record NoBooking : ActivationResult;

    /// <summary>The payer cannot afford it. <b>Nothing was stamped and no lights were cued.</b></summary>
    public sealed record InsufficientBalance(Guid PayerUserId, decimal Current, decimal Required) : ActivationResult;

    /// <summary>The booking is cancelled, expired or otherwise past charging.</summary>
    public sealed record NotChargeable : ActivationResult;
}

/// <summary>
/// The one path from "a player identified themselves at a court" to "the court is live".
///
/// <para>
/// It exists because there were three touchpoints and only one of them did anything.
/// <c>BiometricService.MatchAtCourtAsync</c> charged, stamped attendance and cued lights;
/// the PIN and QR endpoints were pure identity oracles that returned a <c>user_id</c> and
/// nothing else. A member who identified by PIN or QR therefore got a free game <i>and</i>
/// looked like a no-show to the sweep, because <c>CheckedInAt</c> was never set. The
/// blueprint calls those three a triple stack; in the money model they were not one.
/// </para>
///
/// <para>
/// <b>The ordering here is the fix, and it is deliberate.</b> The old code stamped
/// <c>CheckedInAt</c>, cued the lights and <i>then</i> attempted the charge — and on
/// insufficient balance merely logged a warning. So the lights came on unpaid, and because
/// <c>CheckedInAt</c> was set the booking was disqualified from <c>NoShowWorker</c>: the
/// session settled to free play with nothing to follow up. Charging happens <b>first</b>
/// now, and nothing is stamped and no event is emitted unless it succeeded.
/// </para>
/// </summary>
public sealed class CourtActivationService
{
    private readonly MainframeDbContext _db;
    private readonly BookingService _bookings;
    private readonly TenantSettingsAccessor _settings;
    private readonly ITenantContext _tenant;
    private readonly IEventBus _bus;
    private readonly ILogger<CourtActivationService> _logger;

    public CourtActivationService(
        MainframeDbContext db,
        BookingService bookings,
        TenantSettingsAccessor settings,
        ITenantContext tenant,
        IEventBus bus,
        ILogger<CourtActivationService> logger)
    {
        _db = db;
        _bookings = bookings;
        _settings = settings;
        _tenant = tenant;
        _bus = bus;
        _logger = logger;
    }

    /// <summary>How far ahead of a slot someone may identify and have it count.</summary>
    private static readonly TimeSpan ForwardWindow = TimeSpan.FromHours(2);

    /// <summary>
    /// The window in which an identification counts, from tenant settings.
    ///
    /// <para>
    /// There were three of these and they disagreed: biometric read
    /// <c>Biometric:GraceMinutes</c> from app config — a key absent from
    /// <c>appsettings.json</c>, so always its 5-minute default — while PIN and QR each
    /// hardcoded 30 minutes, and <c>NoShowWorker</c> used the tenant's
    /// <c>grace_window_minutes</c>. A member could be inside PIN's window and already swept
    /// as a no-show by the worker, which is not a grace period so much as a disagreement.
    /// One setting now governs all of them, per the every-configurable-number invariant.
    /// </para>
    /// </summary>
    public async Task<(DateTimeOffset Start, DateTimeOffset End)> WindowAsync(DateTimeOffset now, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        return (now.AddMinutes(-settings.GraceWindowMinutes), now.Add(ForwardWindow));
    }

    /// <summary>The bookings on this court that an identification could activate right now.</summary>
    public async Task<List<Booking>> CandidatesAsync(Guid courtId, DateTimeOffset now, CancellationToken ct)
    {
        var (start, end) = await WindowAsync(now, ct);

        return await _db.Bookings
            .Where(b => b.CourtId == courtId
                        && b.Status == BookingStatus.Booked
                        && b.StartsAt < end && b.EndsAt > start)
            .ToListAsync(ct);
    }

    /// <summary>This user's activatable booking on this court, if any.</summary>
    public async Task<Booking?> FindForUserAsync(Guid courtId, Guid userId, DateTimeOffset now, CancellationToken ct)
    {
        var (start, end) = await WindowAsync(now, ct);

        return await _db.Bookings
            .FirstOrDefaultAsync(b => b.CourtId == courtId
                                      && b.UserId == userId
                                      && b.Status == BookingStatus.Booked
                                      && b.StartsAt < end && b.EndsAt > start, ct);
    }

    /// <summary>
    /// Charges, checks in and cues the lights — in that order.
    ///
    /// <para>
    /// <paramref name="method"/> is recorded on the audit trail so a dispute can be
    /// answered with how the player identified, not merely that they did.
    /// </para>
    /// </summary>
    public async Task<ActivationResult> ActivateAsync(
        Court court,
        Booking booking,
        Guid identifiedUserId,
        Guid? payerOverrideUserId,
        string method,
        CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var alreadyActive = booking.CheckedInAt is not null;

        // Charge first. Everything below this line is a consequence of it having worked.
        var charge = await _bookings.ChargeOnActivationAsync(
            bookingId: booking.Id,
            payerOverrideUserId: payerOverrideUserId,
            actorUserId: identifiedUserId,
            ct);

        switch (charge)
        {
            case ChargeResult.InsufficientBalance ib:
                // Refused, loudly and with nothing written. The old code logged this and
                // carried on into the lights.
                _logger.LogWarning(
                    "court {Court}: {Method} identified {User} for booking {Booking} but payer {Payer} has {Current} of {Required} credits — refused, no lights",
                    court.CourtNumber, method, identifiedUserId, booking.Id, ib.PayerUserId, ib.Current, ib.Required);
                return new ActivationResult.InsufficientBalance(ib.PayerUserId, ib.Current, ib.Required);

            case ChargeResult.NotChargeable:
            case ChargeResult.NotFound:
                return new ActivationResult.NotChargeable();
        }

        var payerUserId = charge switch
        {
            ChargeResult.Ok ok => ok.ChargedUserId,
            _ => booking.PaidByUserId ?? booking.UserId ?? identifiedUserId,
        };

        var amount = charge switch
        {
            ChargeResult.Ok ok => ok.AmountCredits,
            ChargeResult.AlreadyCharged already => already.AmountCredits,
            _ => booking.AmountChargedCredits,
        };

        if (alreadyActive)
        {
            // A second scan of a live session. Idempotent: no second charge (the charge
            // service refuses one), no second event, no re-stamp.
            return new ActivationResult.Activated(booking, payerUserId, amount, AlreadyActive: true);
        }

        booking.CheckedInAt = now;
        booking.LightsOnCuedAt ??= now;

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = identifiedUserId,
            SubjectUserId = booking.UserId,
            Action = "court.activated",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
            {
                booking_id = booking.Id,
                court_number = court.CourtNumber,
                method,
                payer_user_id = payerUserId,
                amount_credits = amount,
            }),
        });

        // Saved before the event so a failure here cannot leave a cued light with no
        // attendance record. The remaining failure direction — charged, then a crash before
        // this save — leaves the booking looking like a no-show, which the sweep refunds.
        // That is the safe way round.
        await _db.SaveChangesAsync(ct);

        await _bus.EmitAsync(LightsOnEvent(court, booking, payerUserId, method, now), ct);

        return new ActivationResult.Activated(booking, payerUserId, amount, AlreadyActive: false);
    }

    /// <summary>
    /// The single <c>booking.lights_on</c> shape.
    ///
    /// <para>
    /// There were two producers with different payloads — this one and
    /// <c>LightsCueWorker</c>'s, which omitted <c>paid_by_user_id</c> and added
    /// <c>starts_at</c>/<c>ends_at</c>. A webhook URL templated from the admin catalogue
    /// would render for one and hard-fail for the other, because a missing template
    /// variable is a config error rather than a retryable failure.
    /// </para>
    /// </summary>
    private DomainEvent LightsOnEvent(Court court, Booking booking, Guid payerUserId, string method, DateTimeOffset now)
    {
        // Block body, not an expression body. lizard's C# parser mis-scopes any
        // expression-bodied member containing braces and emits a *global* pseudo-function
        // whose reported length is the whole file, tripping -L 200 with a warning that
        // names no real function. Recorded in memory/gotchas.md; the fix is this, not a
        // whitelizard entry.
        return new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: "booking.lights_on",
            TenantId: _tenant.TenantId,
            TenantSlug: _tenant.TenantSlug,
            OccurredAt: now,
            ActorUserId: booking.UserId,
            ActorIsAdmin: false,
            SubjectUserId: booking.UserId,
            Data: new()
            {
                ["booking_id"] = booking.Id,
                ["court_id"] = court.Id,
                ["court_number"] = court.CourtNumber,
                ["court_name"] = court.Name,
                ["user_id"] = booking.UserId,
                ["paid_by_user_id"] = payerUserId,
                ["starts_at"] = booking.StartsAt,
                ["ends_at"] = booking.EndsAt,
                ["identification_method"] = method,
                ["duration_seconds"] = Math.Max(0, (int)(booking.EndsAt - now).TotalSeconds),
            });
    }
}
