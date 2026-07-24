namespace Crusaders.Mainframe.Api.Domain;

public enum BookingStatus
{
    Booked = 0,
    Cancelled = 1,
    NoShow = 2,
    Completed = 3,
    AdminBlock = 4,
}

/// <summary>
/// A reservation of a court for a slice of time. Per the Crusaders client blueprint Rev 2 (A.9), a
/// booking is a <b>hold</b> — it reserves the slot and verifies the player has enough credits, but
/// the ledger debit (<see cref="LedgerEntryType.BookingCharge"/>) only fires when the player is
/// identified at the courtside touchpad ("charge on lights-on"). See BiometricService.MatchAtCourtAsync.
/// </summary>
public sealed class Booking : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid CourtId { get; set; }

    /// <summary>
    /// Legacy: who's playing. New code should treat this as <see cref="BookedByUserId"/> for the
    /// player who made the booking. <see cref="PaidByUserId"/> is the player who actually gets
    /// debited (defaults to UserId; can be set by an at-court "I'll pay" override per blueprint B.2).
    /// Nullable for <see cref="BookingStatus.AdminBlock"/>.
    /// </summary>
    public Guid? UserId { get; set; }

    /// <summary>Per blueprint B.2 — the player who made the booking (defaults to UserId).</summary>
    public Guid? BookedByUserId { get; set; }

    /// <summary>Per blueprint B.2 — the player whose account is debited at lights-on. Defaults to BookedByUserId; can be overridden at the court.</summary>
    public Guid? PaidByUserId { get; set; }

    public Guid ActorUserId { get; set; }          // who initiated (admin if on-behalf)

    public DateTimeOffset StartsAt { get; set; }
    public DateTimeOffset EndsAt { get; set; }
    public int SliceMinutes { get; set; }
    public int SliceCount { get; set; } = 1;

    /// <summary>The price quoted to the player at booking time, locked in until cancellation. In credits (legacy column name kept for migration stability).</summary>
    public decimal AmountChargedZar { get; set; }

    public BookingStatus Status { get; set; } = BookingStatus.Booked;

    public string? BlockLabel { get; set; }        // for AdminBlock
    public DateTimeOffset? CancelledAt { get; set; }
    public string? CancellationReason { get; set; }
    public bool CancellationPenaltyWaived { get; set; }

    // Lights-cue idempotency markers — set by LightsCueWorker only. Do NOT use these as a
    // proxy for attendance; LightsCueWorker fires a few seconds after the slot start
    // regardless of whether anyone actually showed up. Attendance lives on CheckedInAt.
    public DateTimeOffset? LightsOnCuedAt { get; set; }
    public DateTimeOffset? LightsOffCuedAt { get; set; }

    // Attendance signal — set by BiometricService.MatchAtCourtAsync when the player's
    // fingerprint matches their booking. NoShowWorker uses this (NOT LightsOnCuedAt)
    // as the source of truth for "did the player show up?".
    public DateTimeOffset? CheckedInAt { get; set; }

    /// <summary>Set when the booking_charge ledger entry has been posted. Prevents double-charge if the player taps the pad twice.</summary>
    public DateTimeOffset? ChargedAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
