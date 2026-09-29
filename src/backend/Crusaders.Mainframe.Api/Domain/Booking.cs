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

    /// <summary>
    /// A free-text name an admin typed beside a real member when booking on their behalf —
    /// "Priya's guest". Rendered to ADMINS only.
    ///
    /// <para>
    /// <b>Its own column rather than an overload, and the two rejected alternatives are why.</b>
    /// <see cref="BlockLabel"/> is read by <c>AdminBlockService</c> and by the grid as "this is a
    /// block", so putting a name there on a member's paid booking would turn a charged row into
    /// one four readers treat as costing nobody anything. <see cref="CancellationReason"/> is
    /// already a money discriminator with exactly one owner — <c>SettleReleaseAsync</c> and
    /// <c>ChargeLitCancelledBookingAsync</c> compare it against one constant — so an admin's
    /// prose there is arbitrary text inside a money decision.
    /// </para>
    ///
    /// <para>
    /// <b>Admins only, because the grid's photo-and-name rule is a member-facing invariant.</b> A
    /// guest's name is not a member's name and no member screen may render it.
    /// </para>
    /// </summary>
    public string? AdminNote { get; set; }

    /// <summary>
    /// The repeating schedule that produced this row, when one did.
    ///
    /// <para>
    /// An occurrence is a real <c>AdminBlock</c> booking — that is what makes the GiST exclusion
    /// constraint reserve the court — and this column is what lets "edit this and future" find
    /// its rows and the grid say which league night a block belongs to.
    /// </para>
    /// </summary>
    public Guid? ScheduleId { get; set; }

    /// <summary>
    /// The CLUB-LOCAL date of the occurrence that produced this row.
    ///
    /// <para>
    /// Stored rather than derived from <see cref="StartsAt"/>, because the derivation needs the
    /// club's zone and a DST-correct day boundary, and every reader that wanted it would have to
    /// do that arithmetic again. It is also the key a single-date exception matches on.
    /// </para>
    /// </summary>
    public DateOnly? ScheduleOccurrenceDate { get; set; }
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

    /// <summary>
    /// D11 — the instant after which no share of this booking can be paid, changed or returned
    /// without an admin: the SOLD end plus <c>share_lapse_hours</c>, stamped ONCE, when the booking
    /// first gets players, from the setting at that moment. Null for a booking nobody added
    /// players to. Everything that asks "is this game still open" reads the stamp, so a club
    /// raising the lapse hours later cannot reopen a game whose held shares were already released
    /// and spent (<c>PlayerSettings.ShareDeadline</c>).
    /// </summary>
    public DateTimeOffset? ShareDeadlineAt { get; set; }

    /// <summary>
    /// D11 (review round 5): a reconcile of this booking's shares failed — the post-settlement hook
    /// threw, or the sweep did on this booking — so the next minute sweep must reconcile it,
    /// however old it is; cleared by a reconcile that succeeds. The durable half of "the hook
    /// never throws": a swallowed failure is remembered, not lost.
    /// </summary>
    public DateTimeOffset? ShareReconcileDueAt { get; set; }

    /// <summary>Failed reconciles since <see cref="ShareReconcileDueAt"/> was set — the backoff's step (review round 6).</summary>
    public int ShareReconcileAttempts { get; set; }

    /// <summary>
    /// The latest failed reconcile. The sweep waits an exponentially growing interval after it
    /// (capped at an hour) before trying again, and a reconcile clears the marker only when it
    /// STARTED after this — so a failure recorded while it ran is not erased (review round 6).
    /// </summary>
    public DateTimeOffset? ShareReconcileLastAttemptAt { get; set; }

    /// <summary>
    /// D14 (<c>docs/specs/play.md</c> §2.7, §7.1): a change that may move a member's play record —
    /// a check-in, a status, a seat's status or arrival, a result — happened on this booking and
    /// its players have not been re-evaluated for badges since. Staged by the SAVE that makes the
    /// change (<c>MainframeDbContext.PlayStaging</c>), never by a call site, and drained by
    /// <c>PlayWorker</c> with a guarded clear.
    /// </summary>
    public DateTimeOffset? PlayRecomputeDueAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
