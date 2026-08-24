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

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
