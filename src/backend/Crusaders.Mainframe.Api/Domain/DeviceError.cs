namespace Crusaders.Mainframe.Api.Domain;

/// <summary>Who noticed the fault: the board itself, or this server.</summary>
public enum DeviceErrorSource
{
    /// <summary>The board reported it, as an aggregated <c>fault</c> event on the events queue.</summary>
    Device = 0,

    /// <summary>The server detected it at the site that already made the decision — an auth failure, a clamped clock, a refused event.</summary>
    Server = 1,
}

/// <summary>
/// How bad it is. <b>Assigned server-side from the code, never taken from the board.</b>
///
/// <para>
/// A board cannot be trusted to grade its own faults, and a single table where half the
/// severities are the firmware's opinion and half are the server's is not sortable — which
/// makes the monitoring page's most useful column its least trustworthy one.
/// </para>
/// </summary>
public enum DeviceErrorSeverity
{
    Info = 0,
    Warning = 1,
    Error = 2,
    Critical = 3,
}

/// <summary>
/// One distinct thing going wrong on the club's estate, with a count rather than a row per
/// occurrence — GOAL item 7's store.
///
/// <para>
/// <b>Aggregated by construction.</b> The boards already aggregate on their side (a fault is
/// counted, not queued, and emitted at most once per code per window), and this table
/// aggregates again on <see cref="Fingerprint"/>. A link producing four hundred CRC errors a
/// minute is <b>one row whose count climbs</b>, not four hundred rows an admin has to scroll
/// past. Item 7 asks for a monitoring surface, and a list is not a health state.
/// </para>
///
/// <para>
/// <b>De-duplication is a uniqueness rule about the present, not a read-then-write.</b> The
/// filtered unique index on <c>(TenantId, Fingerprint) WHERE "ResolvedAt" IS NULL</c> is
/// exactly the <see cref="DeviceOutage"/> pattern and is chosen for the same stated reason:
/// a bound enforced by a <c>COUNT</c> before an <c>INSERT</c> is not a bound at all under
/// concurrency, which is how the sixteen-board cap became reachable by thirty-two simultaneous
/// heartbeats. Resolved rows fall out of the index, so history accumulates freely and a board
/// that starts failing again in month four opens a fresh row with a truthful
/// <see cref="FirstSeenAt"/> rather than resurrecting a stale one.
/// </para>
/// </summary>
public sealed class DeviceError : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>
    /// The board, when one resolved. <b>Null is a real case</b>: an authentication failure has
    /// no device row by definition, and an unregistered MAC has not got one yet.
    /// </summary>
    public Guid? DeviceId { get; set; }

    /// <summary>What the caller said its device code was, when there was no row to confirm it.</summary>
    public string? ClaimedDeviceCode { get; set; }

    /// <summary>What the caller said its MAC was, normalised if it normalises and null if it does not.</summary>
    public string? ClaimedMac { get; set; }

    public DeviceErrorSource Source { get; set; }

    /// <summary>One of <c>DeviceErrorCodes</c>. A code this server has never heard of is stored as <c>unknown</c> with the raw string in <see cref="Detail"/>, never dropped.</summary>
    public required string Code { get; set; }

    public DeviceErrorSeverity Severity { get; set; }

    /// <summary>Free text, bounded on ingest AND on read. Stored verbatim so an admin can read the real number the fingerprint collapsed.</summary>
    public string? Detail { get; set; }

    /// <summary>The relay index the board attributed the fault to, when it attributed it to one.</summary>
    public int? Court { get; set; }

    public DateTimeOffset FirstSeenAt { get; set; }
    public DateTimeOffset LastSeenAt { get; set; }

    /// <summary>How many occurrences this row stands for. At least one, enforced by a CHECK.</summary>
    public int Count { get; set; } = 1;

    /// <summary>
    /// What makes two reports the same fault. See <c>DeviceErrorFingerprint</c> for the
    /// composition and for why the detail's digits are collapsed before hashing.
    /// </summary>
    public required string Fingerprint { get; set; }

    public DateTimeOffset? ResolvedAt { get; set; }
    public Guid? ResolvedByUserId { get; set; }
    public string? ResolutionNote { get; set; }

    /// <summary>Longest <see cref="Code"/> this table stores — the device wire caps a fault code at 32, and the server's own codes are shorter.</summary>
    public const int MaxCodeLength = 48;

    /// <summary>Longest <see cref="Detail"/> and <see cref="ResolutionNote"/>. Truncated on ingest rather than refused: a fault report that bounces is a fault nobody hears about.</summary>
    public const int MaxDetailLength = 512;

    /// <summary>Longest <see cref="Fingerprint"/>. The composer emits 32 hex characters; the column is wider so a future composition is not a migration.</summary>
    public const int MaxFingerprintLength = 64;

    /// <summary>Longest <see cref="ClaimedDeviceCode"/>.</summary>
    public const int MaxClaimedDeviceCodeLength = 64;

    /// <summary>Longest <see cref="ClaimedMac"/> — twelve normalised hex characters.</summary>
    public const int MaxClaimedMacLength = 12;

    /// <summary>Whether this row is still open — i.e. still in the filtered unique index.</summary>
    public bool IsOpen => ResolvedAt is null;
}
