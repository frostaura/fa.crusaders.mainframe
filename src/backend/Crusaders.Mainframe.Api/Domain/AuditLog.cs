namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// Append-only audit log. Every admin action — approve, reject, book-on-behalf,
/// adjust-minutes, impersonate — writes a row here. Members have a right to see who
/// has touched their data (out of scope for v1 UI but the data is captured).
/// </summary>
public sealed class AuditLog : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    public Guid ActorUserId { get; set; }
    public Guid? SubjectUserId { get; set; }
    public required string Action { get; set; }   // e.g. "member.approved", "booking.created_on_behalf"
    public string? DetailsJson { get; set; }
    public string? IpAddress { get; set; }
    public string? UserAgent { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>
    /// The instant this row is DISPLAYED at, and therefore the instant it is ordered by. Equal
    /// to <see cref="CreatedAt"/> on every row except an offline door scan, where it is the
    /// instant somebody actually stood at the door.
    ///
    /// <para>
    /// <b>"Newest first" was not true, and the trail is the only record a door leaves (R3-17).</b>
    /// A board that loses the network decides scans from its cache and uploads them when it
    /// comes back, so the row is CREATED at the upload while the scan's own instant sits in its
    /// details — and every door surface has rendered the scan's instant since W1.2 said to. The
    /// list, however, was ordered by <see cref="CreatedAt"/>. A batch delivered at 21:10
    /// carrying scans from 18:40 therefore appeared at the TOP of a list labelled "newest first"
    /// showing times two and a half hours older than the rows beneath it. An admin reading down
    /// that list is reading an order the page asserts and does not have.
    /// </para>
    ///
    /// <para>
    /// <b>A stored column rather than an expression over the jsonb, for three reasons.</b> It is
    /// indexable, where <c>COALESCE((details-&gt;&gt;'occurred_at')::timestamptz, created_at)</c>
    /// is not — the cast is not immutable, so Postgres will not build a generated column or an
    /// expression index on it. It is translatable by the EF in-memory provider, which is what
    /// nearly every test in this suite runs on. And it is what lets the keyset CURSOR order by
    /// the same value the page sorts by: a cursor over one column while the list is ordered by
    /// another silently skips and repeats rows at every page boundary.
    /// </para>
    ///
    /// <para>
    /// <b>Derived centrally in <c>MainframeDbContext.SaveChangesAsync</c>, not at each writer.</b>
    /// Four paths write door rows and a fifth will; a writer that forgot this column would put
    /// its rows in the wrong place in a list with nothing anywhere saying so. See
    /// <c>DoorTrail.ScanAtOf</c> for the one rule, and note the consequence: a caller that sets
    /// it explicitly is believed, which is what lets a test place a row in the past.
    /// </para>
    ///
    /// <para>
    /// <b>NOT NULL, and that is the point.</b> A nullable column would mean every reader sorting
    /// by <c>COALESCE(scan_at, created_at)</c>, which no index can serve — so a club's ninety
    /// days would be sorted in memory on every page load. Left unset it is <c>default</c>, which
    /// the context fills in; a row that somehow reached the database with it still unset sorts
    /// to the very end of the list, which is visible, rather than to a plausible-looking place,
    /// which is not.
    /// </para>
    /// </summary>
    public DateTimeOffset ScanAt { get; set; }
}
