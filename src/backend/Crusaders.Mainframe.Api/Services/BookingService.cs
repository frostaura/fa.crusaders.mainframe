using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Booking lifecycle service.
///
/// Phase 8 economics (per client blueprint Rev 2):
/// <list type="bullet">
///   <item><b>Booking is a hold.</b> <see cref="CreateAsync"/> reserves the slot and verifies the
///         payer has enough credits, but does NOT post a ledger entry. The charge fires when the
///         player is identified at the courtside touchpad (BiometricService.MatchAtCourtAsync).</item>
///   <item><b>Per-day cap.</b> A member can't have more than <c>member_per_day_max_minutes</c> of
///         bookings on a single day (A.4). Same-day relaxation: a slot starting today can still be
///         booked even if the member is over their cap, as long as the slot is otherwise empty (B.3).</item>
///   <item><b>Peak-hours rule.</b> 16:00–19:00 slots are reserved for LeagueOrSenior members until
///         <c>peak_advance_hours_for_regular</c> hours before slot start (A.12). Admins bypass.</item>
///   <item><b>Payer override.</b> <see cref="BookedByUserId"/> defaults to the booking user;
///         <see cref="PaidByUserId"/> can be overridden at the court via a second identification (B.2).</item>
/// </list>
/// </summary>
public sealed class BookingService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly LedgerService _ledger;
    private readonly TenantSettingsAccessor _settings;
    private readonly IEmailService _email;
    private readonly IEventBus _bus;
    private readonly ILogger<BookingService> _logger;

    public BookingService(MainframeDbContext db, ITenantContext tenant, LedgerService ledger, TenantSettingsAccessor settings, IEmailService email, IEventBus bus, ILogger<BookingService> logger)
    { _db = db; _tenant = tenant; _ledger = ledger; _settings = settings; _email = email; _bus = bus; _logger = logger; }

    public async Task<BookingResult> CreateAsync(Guid courtId, Guid userId, Guid actorId, DateTimeOffset startsAt, int sliceCount, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        var court = await _db.Courts.FirstOrDefaultAsync(c => c.Id == courtId && c.IsActive, ct);
        if (court is null) return new BookingResult.NotFound();

        var endsAt = startsAt.AddMinutes(settings.SliceMinutes * sliceCount);
        if (startsAt < DateTimeOffset.UtcNow) return new BookingResult.PastTime();
        if (startsAt > DateTimeOffset.UtcNow.AddDays(settings.AdvanceBookingDays)) return new BookingResult.TooFarAhead();

        // Overlap check
        var overlap = await _db.Bookings.AnyAsync(b =>
            b.CourtId == courtId &&
            b.Status != BookingStatus.Cancelled &&
            b.StartsAt < endsAt && b.EndsAt > startsAt, ct);
        if (overlap) return new BookingResult.SlotTaken();

        // Class / peak-hours / per-day-cap rules — admins bypass everything.
        var isAdminActor = actorId != userId;
        if (!isAdminActor)
        {
            var membership = await _db.Memberships.AsNoTracking().FirstOrDefaultAsync(m => m.UserId == userId, ct);
            var memberClass = membership?.MemberClass ?? MemberClass.Regular;

            // A.12 — peak hours league/senior exclusivity.
            var peakResult = CheckPeakHoursRule(startsAt, endsAt, memberClass, settings);
            if (peakResult is not null) return peakResult;

            // A.4 / B.3 — per-day cap with same-day relaxation.
            var capResult = await CheckPerDayCapAsync(userId, startsAt, endsAt, settings, ct);
            if (capResult is not null) return capResult;
        }

        var pricePerSlice = court.SlicePriceCredits;      // Now in credits per blueprint A.8/A.9.
        var totalCost = pricePerSlice * sliceCount;
        var balance = await _ledger.GetBalanceAsync(userId, ct);
        if (balance < totalCost) return new BookingResult.InsufficientBalance(balance, totalCost);

        var booking = new Booking
        {
            TenantId = _tenant.TenantId,
            CourtId = courtId,
            UserId = userId,
            BookedByUserId = userId,
            PaidByUserId = userId,             // Default — overridable at court via the "I'll pay" flow.
            ActorUserId = actorId,
            StartsAt = startsAt,
            EndsAt = endsAt,
            SliceMinutes = settings.SliceMinutes,
            SliceCount = sliceCount,
            AmountChargedCredits = totalCost,      // Quoted price locked in; charged at lights-on.
            Status = BookingStatus.Booked,
        };
        _db.Bookings.Add(booking);

        // Phase 8: no ledger entry at booking creation. The charge fires at lights-on.

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorId,
            SubjectUserId = userId,
            Action = actorId == userId ? "booking.created" : "booking.created_on_behalf",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new { booking_id = booking.Id, court = court.Name, starts_at = startsAt, slice_count = sliceCount }),
        });

        await _db.SaveChangesAsync(ct);

        // Balance unchanged at booking time — we only verified affordability.
        var user = await _db.Users.FirstAsync(u => u.Id == userId, ct);
        // Build the message in the request scope; dispatch in the background so SMTP latency
        // (Mailhog/EHLO can take seconds) does not block the booking response.
        var confirmationMsg = EmailTemplates.BookingConfirmation(
            user.Email, court.Name,
            TimeZoneInfo.ConvertTimeFromUtc(startsAt.UtcDateTime, ResolveTz(settings.Timezone)).ToString("ddd dd MMM HH:mm"),
            $"{settings.SliceMinutes * sliceCount} min",
            totalCost, balance);
        SendEmailInBackground(confirmationMsg, $"booking confirmation for {booking.Id}");

        await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: "booking.created",
            TenantId: _tenant.TenantId, TenantSlug: _tenant.TenantSlug,
            OccurredAt: DateTimeOffset.UtcNow,
            ActorUserId: actorId, ActorIsAdmin: actorId != userId,
            SubjectUserId: userId,
            Data: new()
            {
                ["booking_id"] = booking.Id,
                ["court_id"] = court.Id,
                ["court_number"] = court.CourtNumber,
                ["court_name"] = court.Name,
                ["user_id"] = userId,
                ["starts_at"] = startsAt,
                ["ends_at"] = endsAt,
                ["slice_count"] = sliceCount,
                ["amount_credits"] = totalCost,
                ["balance_after_credits"] = balance,
            }), ct);

        return new BookingResult.Ok(booking, balance);
    }

    public async Task<CancellationResult> CancelAsync(Guid bookingId, Guid actorId, bool waivePenalty, CancellationToken ct)
    {
        var booking = await _db.Bookings.FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        if (booking is null || booking.Status != BookingStatus.Booked) return new CancellationResult.NotFound();
        if (booking.UserId is null) return new CancellationResult.NotFound();

        var isSelfCancel = actorId == booking.UserId.Value;
        if (isSelfCancel && booking.StartsAt <= DateTimeOffset.UtcNow)
            return new CancellationResult.AlreadyStarted();

        var settings = await _settings.GetAsync(ct);
        var minutesUntilStart = (booking.StartsAt - DateTimeOffset.UtcNow).TotalMinutes;
        var insidePenaltyWindow = minutesUntilStart < settings.PenaltyWindowMinutes;

        // Phase 8 cancel semantics (charge-on-lights-on):
        //  - If booking never charged (ChargedAt == null), no refund needed. Penalty (if inside grace)
        //    is posted as a standalone negative ledger entry.
        //  - If booking already charged at the court (mid-session cancel — rare), refund the unused
        //    fraction proportionally.
        decimal penaltyAmount = 0m;
        decimal refundAmount = 0m;
        var payerUserId = booking.PaidByUserId ?? booking.UserId.Value;

        if (booking.ChargedAt is not null)
        {
            // Mid-session cancel — refund unused proportional fraction.
            var totalSeconds = (booking.EndsAt - booking.StartsAt).TotalSeconds;
            var usedSeconds = Math.Max(0, (DateTimeOffset.UtcNow - booking.StartsAt).TotalSeconds);
            var remainingFraction = Math.Max(0m, 1m - (decimal)(usedSeconds / totalSeconds));
            refundAmount = Math.Round(booking.AmountChargedCredits * remainingFraction, 2, MidpointRounding.AwayFromZero);
        }
        else if (insidePenaltyWindow && !waivePenalty)
        {
            penaltyAmount = Math.Round(booking.AmountChargedCredits * settings.PenaltyPct / 100m, 2, MidpointRounding.AwayFromZero);
        }

        booking.Status = BookingStatus.Cancelled;
        booking.CancelledAt = DateTimeOffset.UtcNow;
        booking.CancellationPenaltyWaived = waivePenalty && insidePenaltyWindow;

        if (refundAmount > 0)
            await _ledger.PostAsync(new LedgerPosting(
                UserId: payerUserId,
                Type: LedgerEntryType.CancellationRefund,
                AmountCredits: refundAmount,
                ActorUserId: actorId,
                RelatedBookingId: booking.Id,
                Reason: "Mid-session cancellation refund (unused portion)"), ct);

        if (penaltyAmount > 0)
            await _ledger.PostAsync(new LedgerPosting(
                UserId: payerUserId,
                Type: LedgerEntryType.LateCancellationPenalty,
                AmountCredits: -penaltyAmount,
                ActorUserId: actorId,
                RelatedBookingId: booking.Id,
                Reason: $"Late-cancellation penalty {settings.PenaltyPct}% on uncharged booking"), ct);

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorId,
            SubjectUserId = booking.UserId.Value,
            Action = "booking.cancelled",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new { booking_id = booking.Id, refund = refundAmount, penalty = penaltyAmount, waived = waivePenalty, was_charged = booking.ChargedAt is not null }),
        });

        await _db.SaveChangesAsync(ct);

        var court = await _db.Courts.FirstAsync(c => c.Id == booking.CourtId, ct);
        var user = await _db.Users.FirstAsync(u => u.Id == booking.UserId, ct);
        var cancellationMsg = EmailTemplates.BookingCancellation(user.Email, court.Name, refundAmount, penaltyAmount > 0 ? penaltyAmount : null);
        SendEmailInBackground(cancellationMsg, $"cancellation for {booking.Id}");

        await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: penaltyAmount > 0 ? "booking.late_cancellation" : "booking.cancelled",
            TenantId: _tenant.TenantId, TenantSlug: _tenant.TenantSlug,
            OccurredAt: DateTimeOffset.UtcNow,
            ActorUserId: actorId, ActorIsAdmin: actorId != booking.UserId,
            SubjectUserId: booking.UserId,
            Data: new()
            {
                ["booking_id"] = booking.Id,
                ["court_id"] = court.Id,
                ["court_number"] = court.CourtNumber,
                ["user_id"] = booking.UserId,
                ["refund_credits"] = refundAmount,
                ["penalty_credits"] = penaltyAmount,
                ["was_charged"] = booking.ChargedAt is not null,
            }), ct);

        return new CancellationResult.Ok(refundAmount, penaltyAmount);
    }

    /// <summary>
    /// Posts the booking_charge ledger entry when the player is identified at the court (charge-on-lights-on per A.9).
    /// Idempotent: subsequent calls for the same booking are no-ops. Optional payer override per blueprint B.2.
    /// </summary>
    public async Task<ChargeResult> ChargeOnActivationAsync(Guid bookingId, Guid? payerOverrideUserId, Guid actorUserId, CancellationToken ct)
    {
        var booking = await _db.Bookings.FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        if (booking is null || booking.UserId is null) return new ChargeResult.NotFound();
        if (booking.Status != BookingStatus.Booked && booking.Status != BookingStatus.Completed) return new ChargeResult.NotChargeable();
        if (booking.ChargedAt is not null) return new ChargeResult.AlreadyCharged(booking.AmountChargedCredits);

        var payerUserId = payerOverrideUserId ?? booking.PaidByUserId ?? booking.UserId.Value;
        var court = await _db.Courts.FirstAsync(c => c.Id == booking.CourtId, ct);

        var balance = await _ledger.GetBalanceAsync(payerUserId, ct);
        if (balance < booking.AmountChargedCredits)
            return new ChargeResult.InsufficientBalance(payerUserId, balance, booking.AmountChargedCredits);

        await _ledger.PostAsync(new LedgerPosting(
            UserId: payerUserId,
            Type: LedgerEntryType.BookingCharge,
            AmountCredits: -booking.AmountChargedCredits,
            ActorUserId: actorUserId,
            RelatedBookingId: booking.Id,
            Reason: $"Booking {court.Name} {booking.StartsAt:yyyy-MM-dd HH:mm}"), ct);

        booking.PaidByUserId = payerUserId;
        booking.ChargedAt = DateTimeOffset.UtcNow;

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorUserId,
            SubjectUserId = payerUserId,
            Action = payerOverrideUserId is not null ? "booking.charged_by_payer_override" : "booking.charged",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new { booking_id = booking.Id, payer_user_id = payerUserId, amount_credits = booking.AmountChargedCredits }),
        });

        await _db.SaveChangesAsync(ct);
        return new ChargeResult.Ok(booking, payerUserId, booking.AmountChargedCredits);
    }

    // ---- helpers ----

    private static BookingResult? CheckPeakHoursRule(DateTimeOffset startsAt, DateTimeOffset endsAt, MemberClass memberClass, TenantSettingsView settings)
    {
        if (memberClass == MemberClass.LeagueOrSenior) return null;
        var peak = settings.PeakHours();
        if (peak is null) return null;
        var (pStart, pEnd) = peak.Value;

        // Convert to tenant-local time. If timezone is malformed, fall back to UTC.
        TimeZoneInfo tz;
        try { tz = TimeZoneInfo.FindSystemTimeZoneById(settings.Timezone); }
        catch { tz = TimeZoneInfo.Utc; }
        var local = TimeZoneInfo.ConvertTimeFromUtc(startsAt.UtcDateTime, tz);
        var slotStart = TimeOnly.FromDateTime(local);
        var inPeak = slotStart >= pStart && slotStart < pEnd;
        if (!inPeak) return null;

        // Regular members inside peak: only allowed within the last <peak_advance_hours_for_regular> hours before slot start.
        var hoursUntil = (startsAt - DateTimeOffset.UtcNow).TotalHours;
        if (hoursUntil > settings.PeakAdvanceHoursForRegular)
            return new BookingResult.PeakHoursLeagueOnly(pStart.ToString("HH:mm"), pEnd.ToString("HH:mm"), settings.PeakAdvanceHoursForRegular);
        return null;
    }

    private async Task<BookingResult?> CheckPerDayCapAsync(Guid userId, DateTimeOffset startsAt, DateTimeOffset endsAt, TenantSettingsView settings, CancellationToken ct)
    {
        if (settings.MemberPerDayMaxMinutes <= 0) return null;

        // Compute the local-day window for the booking's start.
        TimeZoneInfo tz;
        try { tz = TimeZoneInfo.FindSystemTimeZoneById(settings.Timezone); }
        catch { tz = TimeZoneInfo.Utc; }

        var localDay = TimeZoneInfo.ConvertTimeFromUtc(startsAt.UtcDateTime, tz).Date;
        // Build the local-day window in UTC — Npgsql requires offset 0 for timestamptz parameters.
        var localDayStartUtc = TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(localDay, DateTimeKind.Unspecified), tz);
        var localDayStart = new DateTimeOffset(localDayStartUtc, TimeSpan.Zero);
        var localDayEnd = localDayStart.AddDays(1);

        var existing = await _db.Bookings
            .Where(b => b.UserId == userId
                && b.Status != BookingStatus.Cancelled
                && b.StartsAt < localDayEnd && b.EndsAt > localDayStart)
            .ToListAsync(ct);

        var minutesAlreadyBooked = existing.Sum(b => (b.EndsAt - b.StartsAt).TotalMinutes);
        var thisBookingMinutes = (endsAt - startsAt).TotalMinutes;
        if (minutesAlreadyBooked + thisBookingMinutes <= settings.MemberPerDayMaxMinutes) return null;

        // Same-day relaxation per B.3: if the slot starts today AND there's no other booking on that
        // court for the same window, the cap doesn't block it. (We've already done the overlap check.)
        var bookingLocalDay = TimeZoneInfo.ConvertTimeFromUtc(startsAt.UtcDateTime, tz).Date;
        var todayLocal = TimeZoneInfo.ConvertTimeFromUtc(DateTimeOffset.UtcNow.UtcDateTime, tz).Date;
        if (bookingLocalDay == todayLocal) return null;

        return new BookingResult.PerDayCapExceeded(
            CapMinutes: settings.MemberPerDayMaxMinutes,
            AlreadyBookedMinutes: (int)Math.Round(minutesAlreadyBooked),
            AttemptedMinutes: (int)Math.Round(thisBookingMinutes));
    }

    private static TimeZoneInfo ResolveTz(string id)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch { return TimeZoneInfo.Utc; }
    }

    // Fire-and-forget email dispatch. IEmailService is registered as singleton so the captured
    // reference outlives the request scope safely. Errors are swallowed and logged.
    private void SendEmailInBackground(Email.EmailMessage message, string context)
    {
        var email = _email;
        var logger = _logger;
        _ = Task.Run(async () =>
        {
            try { await email.SendAsync(message, CancellationToken.None); }
            catch (Exception ex) { logger.LogWarning(ex, "Background email send failed ({Context})", context); }
        });
    }
}

public abstract record BookingResult
{
    public sealed record Ok(Booking Booking, decimal BalanceAfterCredits) : BookingResult;
    public sealed record NotFound : BookingResult;
    public sealed record PastTime : BookingResult;
    public sealed record TooFarAhead : BookingResult;
    public sealed record SlotTaken : BookingResult;
    public sealed record InsufficientBalance(decimal CurrentCredits, decimal RequiredCredits) : BookingResult;
    public sealed record PeakHoursLeagueOnly(string PeakStart, string PeakEnd, int RegularAdvanceHours) : BookingResult;
    public sealed record PerDayCapExceeded(int CapMinutes, int AlreadyBookedMinutes, int AttemptedMinutes) : BookingResult;
}

public abstract record CancellationResult
{
    public sealed record Ok(decimal RefundedCredits, decimal PenaltyCredits) : CancellationResult;
    public sealed record NotFound : CancellationResult;
    public sealed record AlreadyStarted : CancellationResult;
}

public abstract record ChargeResult
{
    public sealed record Ok(Booking Booking, Guid ChargedUserId, decimal AmountCredits) : ChargeResult;
    public sealed record NotFound : ChargeResult;
    public sealed record NotChargeable : ChargeResult;
    public sealed record AlreadyCharged(decimal AmountCredits) : ChargeResult;
    public sealed record InsufficientBalance(Guid PayerUserId, decimal Current, decimal Required) : ChargeResult;
}
