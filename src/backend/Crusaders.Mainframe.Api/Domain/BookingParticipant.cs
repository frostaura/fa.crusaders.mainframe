namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// Where one seat of a booking is in its life (D11). Stored as an integer; the database CHECK
/// names the same six.
///
/// <para>
/// <b>Only <see cref="Invited"/> and <see cref="Accepted"/> are live.</b> The seat-uniqueness
/// index is partial on exactly those two, so a declined or removed seat keeps its row — and the
/// money history hanging off it — while the seat number is free to be filled again.
/// </para>
/// </summary>
public enum ParticipantStatus
{
    /// <summary>Asked, not yet answered. Holds the seat. Owes nothing, pays nothing.</summary>
    Invited = 0,

    /// <summary>Playing. The organiser's own seat is always this; a guest seat is born this.</summary>
    Accepted = 1,

    /// <summary>Said no. Terminal.</summary>
    Declined = 2,

    /// <summary>Accepted, then pulled out themselves — outside the late-cancel window only. Refunded. Terminal.</summary>
    Withdrawn = 3,

    /// <summary>Taken off the booking by the organiser or an admin. Refunded. Terminal.</summary>
    Removed = 4,

    /// <summary>Never answered before the share deadline; the organiser covers the seat. Terminal.</summary>
    Lapsed = 5,
}

/// <summary>
/// One player on a booking — the organiser, a partner, an open invite-link seat or a named guest
/// (D11, "Partners &amp; split").
///
/// <para>
/// <b>The booking stays single-payer.</b> The organiser (the booking's payer, seat 1) is charged
/// the whole price at booking exactly as before, and every settlement path keeps posting against
/// the organiser alone. A partner's share moves to the organiser as a <see cref="LedgerEntryType.ShareTransfer"/>
/// pair when they accept — see <c>ShareLedger</c>. That is what lets the settlement model stay
/// untouched: <c>Owed(b)</c> is still the organiser's, and a share is a fraction of it.
/// </para>
///
/// <para>
/// <b>Money is never stored here.</b> <see cref="ShareMinutes"/> is what the organiser ASKED
/// for and <see cref="ConsentedMinutes"/> the most the partner AGREED to; what has actually moved
/// is read off the ledger by reference, never kept as a column.
/// </para>
///
/// <para>
/// <b>A booking with no rows is "just the booker".</b> Nothing is backfilled: seat 1 is written
/// the first time a second player is added.
/// </para>
/// </summary>
public sealed class BookingParticipant : ITenantScoped
{
    public const int MaxSeats = 4;
    public const int GuestNameMaxLength = 64;
    public const int SplitModeMaxLength = 16;

    /// <summary>SHA-256 hex of the invite token — 64 characters.</summary>
    public const int TokenHashLength = 64;

    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid BookingId { get; set; }

    /// <summary>1–4. Seats 1–2 are team A, 3–4 team B. Seat 1 is the organiser.</summary>
    public int Seat { get; set; }

    /// <summary>The member in the seat. Null for a guest, and for an open link seat nobody has claimed yet.</summary>
    public Guid? UserId { get; set; }

    /// <summary>A named guest — not a member, carries no share, never admitted by a board.</summary>
    public string? GuestName { get; set; }

    public ParticipantStatus Status { get; set; } = ParticipantStatus.Invited;

    /// <summary>What the organiser has asked this seat to pay, in whole minutes. Always 0 for a guest.</summary>
    public int ShareMinutes { get; set; }

    /// <summary>
    /// The most this partner has agreed to pay, in whole minutes — stamped by the partner's own accept.
    /// A share raised above it is not collected until they accept again; an admin's accept on
    /// their behalf leaves it at 0, which is why that never debits them.
    /// </summary>
    public int ConsentedMinutes { get; set; }

    /// <summary>
    /// What this partner could NOT pay of the share they were asked for, in whole minutes — set when
    /// they accepted paying only part of it ("pay what you can"). The organiser covers it until they
    /// re-split; any successful re-split clears it on every seat (the others have decided). Always
    /// 0 on the organiser's seat and a guest's.
    /// </summary>
    public int ShortfallMinutes { get; set; }

    /// <summary>The ratio weight this seat was split with. 1 under an equal split, 0 under an amount split.</summary>
    public int ShareWeight { get; set; }

    /// <summary>On seat 1 only: how the booking was last split — <c>equal</c>, <c>ratio</c> or <c>amount</c>.</summary>
    public string? SplitMode { get; set; }

    /// <summary>SHA-256 of this seat's invite link token. The token itself is shown once and never stored.</summary>
    public string? InviteTokenHash { get; set; }

    public Guid? InvitedByUserId { get; set; }
    public DateTimeOffset InvitedAt { get; set; }
    public DateTimeOffset? RespondedAt { get; set; }

    /// <summary>This player's own arrival at the court box — attendance per player, beside the booking's.</summary>
    public DateTimeOffset? CheckedInAt { get; set; }

    /// <summary>An admin recorded that this share was paid outside the app. Nothing is collected in-app after it.</summary>
    public DateTimeOffset? SettledOutsideAt { get; set; }

    /// <summary>When the share deadline passed with part of the share unpaid; the organiser covers the rest.</summary>
    public DateTimeOffset? LapsedAt { get; set; }

    /// <summary>
    /// Since when this seat's partner is due money BACK that the organiser's spendable minutes do
    /// not cover, so the return waits (D11, review round 2). Stamped when a reconcile first finds it
    /// uncovered — the moment both sides are told once — and cleared when it posts or is no longer
    /// due. The minute sweep selects on it (indexed), however old the booking, so a waiting
    /// return is never stranded; any money in to the organiser retries it at once.
    /// </summary>
    public DateTimeOffset? ReturnPendingSince { get; set; }

    public DateTimeOffset? LastNudgedAt { get; set; }
    public int NudgeCount { get; set; }
    public DateTimeOffset? LastReminderAt { get; set; }
    public int ReminderCount { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Optimistic concurrency token, bumped by <c>MainframeDbContext</c> on every modification.</summary>
    public int Version { get; set; }

    /// <summary>True for a seat that holds a place on the booking right now.</summary>
    public bool IsLive => Status is ParticipantStatus.Invited or ParticipantStatus.Accepted;

    /// <summary>True for a seat a member may be asked to pay for — not the organiser, not a guest.</summary>
    public bool IsPartner => Seat > 1 && GuestName is null;
}

/// <summary>
/// A member one person has starred as a partner. Private to its owner; the other member is never
/// told and it grants nothing — it only puts a face at the top of the owner's picker.
/// </summary>
public sealed class PartnerFavourite : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    public Guid PartnerUserId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// One line in a member's in-app inbox — the bell (D11 notifications).
///
/// <para>
/// <b>Written in the same save as the outbox row that mails it</b> (<c>MemberNotices.Stage</c>),
/// so the inbox and the mail can never disagree about whether something happened. The inbox
/// holds the headline and a link; the facts that make a mail are on the outbox row.
/// </para>
/// </summary>
public sealed class MemberNotification : ITenantScoped
{
    public const int KindMaxLength = 64;
    public const int HeadlineMaxLength = 255;
    public const int LinkMaxLength = 512;
    public const int DedupeKeyMaxLength = 200;

    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    public required string Kind { get; set; }
    public required string Headline { get; set; }
    public string? Link { get; set; }
    public Guid? BookingId { get; set; }

    /// <summary>Unique per club, like the outbox's — the same event staged twice is refused, not shown twice.</summary>
    public required string DedupeKey { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? ReadAt { get; set; }

    /// <summary>
    /// When the question this line asked was answered or replaced (review round 2, F2-5) — a
    /// result-to-confirm retired by a confirm, dispute, edit, withdraw, void or keep. Distinct from
    /// <see cref="ReadAt"/>: a line can be read and still open, and the inbox draws a resolved ask
    /// as settled rather than as something to act on. Null for every other kind.
    /// </summary>
    public DateTimeOffset? ResolvedAt { get; set; }
}
