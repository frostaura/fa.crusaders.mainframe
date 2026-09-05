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
    public decimal AmountChargedCredits { get; set; }

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

    /// <summary>
    /// Optimistic concurrency token. Incremented by <c>MainframeDbContext.SaveChanges</c> on
    /// every modification, so no caller has to remember to.
    ///
    /// <para>
    /// A booking is decided by several actors at once — the member cancelling, an admin
    /// cancelling on their behalf, the court box checking somebody in, and the no-show sweep
    /// reversing a charge — and every one of them read the row, decided, and wrote, with
    /// nothing in between. Two of those raced into real money:
    /// </para>
    ///
    /// <list type="bullet">
    ///   <item>A double-tap on the PWA's cancel button had both requests load a
    ///   <c>Booked</c> row and both post a full refund, so a 200-credit booking paid back 400.</item>
    ///   <item>The no-show sweep materialises its due list once per tick and never re-reads
    ///   <c>CheckedInAt</c>. With a blocking email send per booking in between, a member who
    ///   identified at the pad seconds after the tick began was refunded and penalised for a
    ///   court they were playing on — leaving a row that is checked in and <c>NoShow</c> at
    ///   the same time, which nothing else in the system expects.</item>
    /// </list>
    ///
    /// <para>
    /// EF puts the original value in the UPDATE's WHERE clause, so the second writer matches
    /// no rows and throws <c>DbUpdateConcurrencyException</c> instead of overwriting. Because
    /// <c>LedgerService.PostAsync</c> saves through the same tracked context, the refusal
    /// takes the ledger rows down with it: either the whole decision lands or none of it does.
    /// </para>
    /// </summary>
    public int Version { get; set; }

    /// <summary>Set when the booking_charge ledger entry has been posted. Prevents double-charge if the player taps the pad twice.</summary>
    public DateTimeOffset? ChargedAt { get; set; }

    /// <summary>
    /// When a settled no-show was undone by late attendance evidence
    /// (<c>BookingService.ReverseNoShowAsync</c>). Null on every row the sweep never touched.
    ///
    /// <para>
    /// It is not decoration. <see cref="EndsAt"/> on a reversed row is a <i>provisional</i>
    /// lit end derived from the activation's grant, and the box's own <c>release</c> event
    /// arrives at least one request later carrying the measurement that corrects it (see
    /// <c>docs/specs/settlement-model.md</c> §4, I8). This flag is what tells the release
    /// handler that this row's end is a provisional one it may narrow — an ordinary
    /// booking's end is what the member bought and is never moved by a relay measurement.
    /// </para>
    /// </summary>
    public DateTimeOffset? NoShowReversedAt { get; set; }

    /// <summary>
    /// The booking whose late attendance evidence displaced this one, when
    /// <see cref="CancellationReason"/> is <c>ResoldTailRefunded</c>.
    ///
    /// <para>
    /// Carried on the row rather than parsed back out of a ledger reference because two
    /// rules need it at speed: a displaced booking is never charged for being lit and its
    /// audit row must name what displaced it (settlement model I5), and the release that
    /// disproves the displacement has to find every row it displaced to reinstate them (I9).
    /// </para>
    /// </summary>
    public Guid? DisplacedByBookingId { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
