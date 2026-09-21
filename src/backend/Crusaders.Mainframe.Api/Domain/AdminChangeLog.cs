namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// The club's record of what its own administrators did — append-only, and undeletable by
/// anything the application can reach.
///
/// <para>
/// <b>Why this is not <c>audit_log</c>.</b> Two reasons, neither of them style. First,
/// <c>audit_log</c> has a delete path: <c>RetentionWorker.PurgeDoorTrailAsync</c>
/// <c>RemoveRange</c>s door rows on a cutoff an admin controls through
/// <c>door_log_retention_days</c> — so a record that "no role can delete" cannot live in a
/// table a worker deletes from on an admin-editable schedule. Second, the two requirements
/// conflict at the database: making <c>audit_log</c> undeletable means revoking <c>DELETE</c>
/// on it, and the retention sweep needs <c>DELETE</c> on it. One table cannot be both.
/// </para>
///
/// <para>
/// <b>The relationship to <c>audit_log</c> is intent versus effect.</b> A bulk cancellation
/// writes ONE row here — the admin's decision, in their own words — and <c>CancelAsync</c>
/// writes the per-booking <c>audit_log</c> rows exactly as it always did. The night trace reads
/// the effects; this table answers "who decided, and why".
/// </para>
///
/// <para>
/// <b>There is no delete endpoint, no <c>Remove</c> call, and a trigger that raises.</b> The
/// four layers, and the one honest residual — a database owner can still
/// <c>ALTER TABLE … DISABLE TRIGGER</c> — are set out on <c>ProtectAdminChangeLog</c> and in
/// <c>MEMORY.md</c>. The claim this design supports is "no role in the application can delete
/// these rows, and no admin has a way to", not "tamper-proof". Overstating it would be worse
/// than having no record, because the club would rely on it.
/// </para>
/// </summary>
public sealed class AdminChangeLog : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public DateTimeOffset OccurredAt { get; set; } = DateTimeOffset.UtcNow;

    public Guid ActorUserId { get; set; }

    /// <summary>
    /// The actor's name AS IT WAS, copied rather than joined.
    ///
    /// <para>
    /// <b>Denormalised on purpose.</b> A renamed, anonymised or removed member must not change
    /// what the history says happened. <c>RetentionWorker</c> nulls <c>audit_log.SubjectUserId</c>
    /// at two years; this table is exempt from retention entirely, so it must not depend on a
    /// row that is not.
    /// </para>
    /// </summary>
    public required string ActorName { get; set; }

    /// <summary>The actor's address as it was, for the same reason. Null when the club held none.</summary>
    public string? ActorEmail { get; set; }

    /// <summary>One of <see cref="Services.AdminChangeAreas"/>. A closed set, pinned by a test.</summary>
    public required string Area { get; set; }

    /// <summary>One of <see cref="Services.AdminChangeActions"/>. A closed set, pinned by a test.</summary>
    public required string Action { get; set; }

    /// <summary>What kind of thing was acted on — see <see cref="Services.AdminChangeSubjects"/>.</summary>
    public string? SubjectKind { get; set; }

    /// <summary>The id of that thing, when it has one.</summary>
    public Guid? SubjectId { get; set; }

    /// <summary>
    /// What to call it on screen — "Tuesday league", "Priya Naidoo". Denormalised for the
    /// reason <see cref="ActorName"/> is: the row has to read correctly after the thing it
    /// names has been renamed or removed.
    /// </summary>
    public string? SubjectLabel { get; set; }

    /// <summary>The admin's own words. Required by the endpoint for every destructive action.</summary>
    public string? Reason { get; set; }

    /// <summary>The changed fields before, as jsonb. Changed keys only — never a whole document.</summary>
    public string? BeforeJson { get; set; }

    /// <summary>The changed fields after, as jsonb. Changed keys only.</summary>
    public string? AfterJson { get; set; }

    public string? RequestId { get; set; }
    public string? IpAddress { get; set; }
}
