using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// What an admin did, as the caller knows it. The recorder resolves the rest — who they are,
/// which area the action belongs to, where the request came from.
/// </summary>
/// <param name="Action">One of <see cref="AdminChangeActions"/>. Not free text.</param>
/// <param name="SubjectKind">One of <see cref="AdminChangeSubjects"/>, or null.</param>
/// <param name="Before">Changed fields only, before. Serialised to jsonb. Never a whole document.</param>
/// <param name="After">Changed fields only, after.</param>
public readonly record struct AdminChange(
    string Action,
    Guid ActorUserId,
    string? SubjectKind = null,
    Guid? SubjectId = null,
    string? SubjectLabel = null,
    string? Reason = null,
    object? Before = null,
    object? After = null);

/// <summary>
/// Writes to the club's undeletable change record — the one service every admin mutation in
/// this product goes through, in any lane.
///
/// <para>
/// <b>Staging and recording are two methods on purpose.</b> <see cref="StageAsync"/> adds the
/// row to the caller's tracked context so it flushes with the change it describes: if the
/// change rolls back, so does the record of it, and a record of something that did not happen
/// is worse than no record. <see cref="RecordAsync"/> saves immediately and is for the case
/// where there is nothing else to save — a read that must be audited, such as the night trace.
/// </para>
///
/// <para>
/// <b>The actor's name is copied, not joined.</b> See <see cref="AdminChangeLog.ActorName"/>:
/// this table is exempt from retention and the members table is not, so a row that joined would
/// lose its actor's name two years later, in the one table that exists to still be readable
/// then. One read per row is acceptable here — an admin mutation is not a hot path, and the
/// alternative is a record that decays.
/// </para>
///
/// <para>
/// <b>This type has no delete, no update and no <c>Remove</c>.</b>
/// <c>AdminChangeLogPostureTests</c> greps the tree for one and fails on a hit, and the table's
/// own triggers raise on either. Both, because a posture test cannot see a hand-run statement
/// and a trigger cannot see a code review.
/// </para>
/// </summary>
public sealed class AdminChangeRecorder
{
    /// <summary>What a row records as the actor's name when the club has no membership row for them.</summary>
    public const string UnknownActorName = "Unknown";

    /// <summary>What a row records when the actor is the system rather than a person.</summary>
    public const string SystemActorName = "The club's automatic system";

    private const int MaxActorName = 255;
    private const int MaxActorEmail = 320;
    private const int MaxSubjectLabel = 255;
    private const int MaxReason = 512;
    private const int MaxRequestId = 64;
    private const int MaxIpAddress = 64;

    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly IHttpContextAccessor _http;

    public AdminChangeRecorder(MainframeDbContext db, ITenantContext tenant, IHttpContextAccessor http)
    { _db = db; _tenant = tenant; _http = http; }

    /// <summary>
    /// Stages the row on the caller's context. The caller's own <c>SaveChangesAsync</c> writes
    /// it, which is what ties the record to the change.
    /// </summary>
    public async Task<AdminChangeLog> StageAsync(AdminChange change, CancellationToken ct)
    {
        var area = AdminChangeActions.AreaOf(change.Action)
            ?? throw new ArgumentOutOfRangeException(
                nameof(change),
                $"'{change.Action}' is not an action AdminChangeActions knows. Add it to the " +
                "vocabulary in the same commit that writes it — a record nobody can read back " +
                "is not a record.");

        var (name, email) = await ActorAsync(change.ActorUserId, ct);

        var row = new AdminChangeLog
        {
            TenantId = _tenant.TenantId,
            OccurredAt = DateTimeOffset.UtcNow,
            ActorUserId = change.ActorUserId,
            ActorName = Bounded(name, MaxActorName) ?? UnknownActorName,
            ActorEmail = Bounded(email, MaxActorEmail),
            Area = area,
            Action = change.Action,
            SubjectKind = change.SubjectKind,
            SubjectId = change.SubjectId,
            SubjectLabel = Bounded(change.SubjectLabel, MaxSubjectLabel),
            Reason = Bounded(change.Reason, MaxReason),
            BeforeJson = Json(change.Before),
            AfterJson = Json(change.After),
            RequestId = Bounded(_http.HttpContext?.TraceIdentifier, MaxRequestId),
            IpAddress = Bounded(_http.HttpContext?.Connection.RemoteIpAddress?.ToString(), MaxIpAddress),
        };

        _db.AdminChangeLogs.Add(row);
        return row;
    }

    /// <summary>
    /// Stages and saves in one step, for a caller with nothing else to write — a read that has
    /// to be audited.
    /// </summary>
    public async Task<AdminChangeLog> RecordAsync(AdminChange change, CancellationToken ct)
    {
        var row = await StageAsync(change, ct);
        await _db.SaveChangesAsync(ct);
        return row;
    }

    /// <summary>
    /// The actor's name and address as the club holds them right now, copied onto the row.
    ///
    /// <para>
    /// <see cref="Guid.Empty"/> is the system, which every worker in this product writes as its
    /// actor — it is a real state, not a defensive one, and it must not render as an
    /// administrator. Block body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private async Task<(string? Name, string? Email)> ActorAsync(Guid actorUserId, CancellationToken ct)
    {
        if (actorUserId == Guid.Empty) return (SystemActorName, null);

        var name = await _db.Memberships.AsNoTracking()
            .Where(m => m.UserId == actorUserId)
            .Select(m => m.FullName)
            .FirstOrDefaultAsync(ct);

        var email = await _db.Users.AsNoTracking()
            .Where(u => u.Id == actorUserId)
            .Select(u => u.Email)
            .FirstOrDefaultAsync(ct);

        return (name, email);
    }

    private static string? Json(object? value)
        => value is null ? null : JsonSerializer.Serialize(value);

    private static string? Bounded(string? value, int max)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var trimmed = value.Trim();
        return trimmed.Length <= max ? trimmed : trimmed[..max];
    }
}
