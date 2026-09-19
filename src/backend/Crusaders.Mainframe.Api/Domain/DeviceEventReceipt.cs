namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// Proof that a court box's event has already been recorded.
///
/// <para>
/// A box may upload an event, lose the link before reading the response, and upload it
/// again — that is the normal shape of an unreliable network rather than an error. So the
/// question "have I seen this before?" is asked on every event, and the answer has to be
/// cheap and it has to be <b>right under concurrency</b>.
/// </para>
///
/// <para>
/// Hence a table with a unique index rather than a scan over the audit log. An
/// <c>AuditLogs.Any(a =&gt; a.DetailsJson.Contains(reference))</c> is an unindexed substring
/// scan that grows with the club's whole history, and — worse — it is a check-then-insert:
/// two retries arriving together both find nothing and both write. The unique index is what
/// makes a duplicate impossible rather than unlikely, exactly as the filtered index on
/// <see cref="LedgerEntry.ExternalReference"/> does for payments.
/// </para>
///
/// <para>
/// This row is a receipt, not the record. What actually happened is written to the audit log
/// beside it; this exists only to answer the duplicate question.
/// </para>
/// </summary>
public sealed class DeviceEventReceipt : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    public Guid DeviceId { get; set; }

    /// <summary>The box's own monotonic sequence number. Never reused by a given device —
    /// that is what <c>eventq</c>'s persisted high-water mark exists to guarantee.</summary>
    public long Seq { get; set; }

    /// <summary>What kind of event it was, for diagnostics on the receipt alone.</summary>
    public required string Kind { get; set; }

    /// <summary>When the box says it happened, derived from its uptime against the server clock.</summary>
    public DateTimeOffset OccurredAt { get; set; }

    /// <summary>
    /// The RELAY INDEX the event was about (0-3), or null when it was about no court.
    /// Mirrors <c>eventq::Event::court</c>, not a court number.
    /// </summary>
    public int? Court { get; set; }

    /// <summary>
    /// The booking an <c>activation</c> event resolved to, or null.
    ///
    /// <para>
    /// This is what makes a <c>release</c> settleable at all. A release names no member and
    /// no booking — it carries a relay index and how long the relay was closed — so the only
    /// way back to the money is the activation that lit the same relay on the same box just
    /// before it. Recording the booking on the activation's own receipt turns that from a
    /// scan of the audit log's JSON into an indexed read. See
    /// <c>docs/specs/settlement-model.md</c> §4.
    /// </para>
    /// </summary>
    public Guid? BookingId { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
