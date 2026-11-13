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

    /// <summary>
    /// Which BOOT of that box the sequence number belongs to, or 0 for a board that does not
    /// send one.
    ///
    /// <para>
    /// <b>It is here because <c>(device, seq)</c> was not an idempotency key.</b> The box's
    /// ring is RAM-only, so no event survives a reboot, and <c>seq</c> resumes from a single
    /// checkpoint record in the board's flash written in blocks of 64. Erase or tear that
    /// record — a reflash, a wiped NVS partition, a torn write — and the board renumbers from
    /// 1, against the PERMANENT unique index below: every event of the next evening is then
    /// silently receipted as a duplicate and discarded, <i>including</i> the <c>boot</c> event
    /// the firmware queues so that an operator can see the board restarted. Two boards
    /// accidentally sharing a MAC dedup each other the same way.
    /// </para>
    ///
    /// <para>
    /// <b>0 means "no boot identity", which is exactly the old behaviour.</b> A court box,
    /// whose renderer omits the field, and every gate image flashed before this change share
    /// one boot identity and dedup against themselves as before — and legacy rows are
    /// backfilled to 0 by the migration, so they keep deduplicating against the boards that
    /// wrote them.
    /// </para>
    /// </summary>
    public long BootId { get; set; }

    /// <summary>The box's own monotonic sequence number. Never reused WITHIN A BOOT — and a
    /// reboot is made distinguishable by <see cref="BootId"/> rather than made impossible,
    /// because <c>eventq</c>'s checkpointed high-water mark is best-effort by design.</summary>
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

    /// <summary>
    /// What the server made of the event — the activation or release outcome code
    /// (<c>ok</c>, <c>wrong_court</c>, <c>unpaired</c>, …), or null for an event with no outcome
    /// and for every receipt written before the column existed.
    ///
    /// <para>
    /// <b>Why the receipt carries it (review round 7, E7-1).</b> The night trace reads relay
    /// receipts as "the lights came on", and a REFUSED upload — a box that lit a relay wired to
    /// another court — still names the booking it was refused for. Without the verdict beside
    /// it the member's night invented a lit court out of the very event the server turned down,
    /// and counted its minutes as time on court. Null is read as the old behaviour: shown.
    /// </para>
    /// </summary>
    public string? Outcome { get; set; }

    /// <summary>
    /// Why a <c>release</c> opened the relay (device-api.md §9): <c>member</c> (the OFF button),
    /// <c>autooff</c>, <c>cap</c>, <c>mega_reset</c>, <c>reconcile</c> — or whatever a later image
    /// sends, stored as given and never a 400. Null on every other kind, and on a release from a
    /// 2.x box, which means <c>member</c>. Only a member's release takes a booking out of the
    /// heartbeat snapshot (§3): v2 treated a Mega watchdog reset as the member leaving (BD-2).
    /// </summary>
    public string? Cause { get; set; }

    /// <summary>The widest <see cref="Cause"/> kept; a longer one is cut to this, never refused.</summary>
    public const int CauseMaxLength = 32;

    /// <summary>
    /// <see cref="Outcome"/>s that are NOT evidence of the receipt's booking's court being lit or
    /// measured: a relay wired to another court, a booking whose court is gone, a release the server
    /// could not pair. The member's night leaves them out (E7-1), and a release never pairs with one
    /// (review round 8, D8-4) — a refused receipt keeps its booking on the row (the legacy path), and
    /// paired it settled that booking's court from a relay this box never lit for it.
    /// </summary>
    public static readonly string[] RefusedOutcomes = ["wrong_court", "unresolved", "unpaired", "implausible"];

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
