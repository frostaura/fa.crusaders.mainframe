using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>Why an admin-rights change did or did not happen. Each refusal is its own 4xx.</summary>
public enum AdminRoleOutcome
{
    Changed,
    Unchanged,
    NotFound,
    NotActiveMember,
    LastAdmin,
    ConfirmSelfRequired,
    InheritedFromConfig,
    ActorNotAdmin,
}

/// <summary>What the admin asked for. <see cref="Reason"/> is required on a revoke and ignored on a grant.</summary>
public sealed class AdminRoleRequest
{
    public required Guid ActorUserId { get; init; }
    public required Guid TargetUserId { get; init; }
    public required bool Grant { get; init; }
    public string? Reason { get; init; }
    public bool ConfirmSelf { get; init; }
}

/// <summary>What happened, and the account's admin state afterwards.</summary>
public sealed class AdminRoleResult
{
    public required AdminRoleOutcome Outcome { get; init; }
    public bool IsAdmin { get; init; }
    public string? AdminSource { get; init; }

    public static AdminRoleResult Refused(AdminRoleOutcome outcome)
    {
        return new AdminRoleResult { Outcome = outcome };
    }
}

/// <summary>
/// Where an account's admin rights come from, as the members list shows it.
/// </summary>
public static class AdminSource
{
    /// <summary>The address is in <c>Admins:Emails</c>; only an operator can remove it.</summary>
    public const string Config = "config";

    /// <summary>Appointed by the club — the bootstrap admin, or anyone granted from Admin → Members.</summary>
    public const string Granted = "granted";

    /// <summary><c>config</c>, <c>granted</c>, or null for a non-admin.</summary>
    public static string? Of(bool isAdmin, string email, InherentAdmins inherent)
    {
        if (!isAdmin) return null;
        return inherent.Includes(email) ? Config : Granted;
    }
}

/// <summary>
/// Makes a member an administrator, or stops them being one (R20). The only writer of
/// <see cref="User.IsAdmin"/> apart from the two configuration paths — the production bootstrap
/// and <see cref="InherentAdminService"/>.
/// </summary>
/// <remarks>
/// <para>
/// <b>The last-admin guard runs under a lock, and it has to.</b> "Is there another active admin?"
/// followed by "remove this one" is a read-then-write, and the realistic race is exactly the one
/// that matters: two admins, each removing the other, at the same moment. Each reads one other
/// admin, both proceed, and the club has none — with no way back into the console that does not
/// involve editing the database. A transaction-scoped advisory lock keyed on (club, "admins")
/// serialises every admin-rights change in one club, so the second reads the first's commit and
/// is refused. Clubs never queue behind each other, and the lock dies with the transaction however
/// it ends, as <see cref="PayerLock"/>'s does.
/// </para>
/// <para>
/// <b>Everything is re-read inside the lock.</b> The target's current flag, the count of the
/// others, and whether the ACTOR is still an admin — the actor may have been removed by the very
/// request that held the lock before them.
/// </para>
/// <para>
/// <b>Config admins cannot be removed here.</b> <c>Admins:Emails</c> would hand the rights straight
/// back at their next sign-in (<see cref="InherentAdminService"/>), so a revoke would appear to work
/// and quietly undo itself. It is refused, and the list shows <c>admin_source: "config"</c> so the
/// console can say why before anyone presses the button.
/// </para>
/// </remarks>
public sealed class AdminRoleService
{
    /// <summary>The <c>audit_log</c> verb for a grant.</summary>
    public const string GrantedAction = "user.admin_granted";

    /// <summary>The <c>audit_log</c> verb for a revoke.</summary>
    public const string RevokedAction = "user.admin_revoked";

    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly AdminChangeRecorder _recorder;
    private readonly InherentAdmins _inherent;
    private readonly LiveAdminRole _liveRole;
    private readonly AdminRoleNotifier _notifier;

    public AdminRoleService(
        MainframeDbContext db, ITenantContext tenant, AdminChangeRecorder recorder,
        InherentAdmins inherent, LiveAdminRole liveRole, AdminRoleNotifier notifier)
    {
        _db = db; _tenant = tenant; _recorder = recorder;
        _inherent = inherent; _liveRole = liveRole; _notifier = notifier;
    }

    public async Task<AdminRoleResult> ChangeAsync(AdminRoleRequest request, CancellationToken ct)
    {
        var email = await _db.Users.AsNoTracking()
            .Where(u => u.Id == request.TargetUserId).Select(u => u.Email).FirstOrDefaultAsync(ct);
        if (email is null) return AdminRoleResult.Refused(AdminRoleOutcome.NotFound);
        if (!request.Grant && _inherent.Includes(email)) return AdminRoleResult.Refused(AdminRoleOutcome.InheritedFromConfig);

        await using var tx = await LockAdminsAsync(ct);

        var target = await _db.Users.FirstAsync(u => u.Id == request.TargetUserId, ct);
        if (target.IsAdmin == request.Grant)
        {
            return new AdminRoleResult
            {
                Outcome = AdminRoleOutcome.Unchanged,
                IsAdmin = target.IsAdmin,
                AdminSource = AdminSource.Of(target.IsAdmin, target.Email, _inherent),
            };
        }

        var refusal = request.Grant ? await RefuseGrantAsync(target, ct) : await RefuseRevokeAsync(target, request, ct);
        refusal ??= await RefuseActorAsync(request.ActorUserId, ct);
        if (refusal is { } outcome) return AdminRoleResult.Refused(outcome);

        target.IsAdmin = request.Grant;
        await StageRecordsAsync(target, request, ct);
        await _db.SaveChangesAsync(ct);
        if (tx is not null) await tx.CommitAsync(ct);

        // After the commit, never before: evicting first would let a request in between cache
        // the old answer for another full window.
        _liveRole.Invalidate(target.TenantId, target.Id);
        await _notifier.NotifyAsync(target, request, ct);

        return new AdminRoleResult
        {
            Outcome = AdminRoleOutcome.Changed,
            IsAdmin = target.IsAdmin,
            AdminSource = AdminSource.Of(target.IsAdmin, target.Email, _inherent),
        };
    }

    /// <summary>
    /// Opens the transaction and takes the club's admin lock inside it. Null on a provider with
    /// no transactions — the in-memory one the unit suites run on — where the guard cannot be
    /// exercised and is proved by the Postgres suite instead.
    /// </summary>
    private async Task<IDbContextTransaction?> LockAdminsAsync(CancellationToken ct)
    {
        if (!_db.Database.IsNpgsql()) return null;

        var tx = await _db.Database.BeginTransactionAsync(ct);
        await _db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock({0})", [LockKey(_tenant.TenantId)], ct);
        return tx;
    }

    /// <summary>Only an active member with an active account can be appointed.</summary>
    private async Task<AdminRoleOutcome?> RefuseGrantAsync(User target, CancellationToken ct)
    {
        var membership = await _db.Memberships.AsNoTracking()
            .Where(m => m.UserId == target.Id).Select(m => (MembershipStatus?)m.Status).FirstOrDefaultAsync(ct);
        var active = membership == MembershipStatus.Active && target.Status == "active";
        return active ? null : AdminRoleOutcome.NotActiveMember;
    }

    /// <summary>
    /// Never the last active admin — including oneself — and oneself only when the caller has
    /// confirmed it. The last-admin check comes first so a lone admin is told the thing that
    /// cannot be fixed, rather than asked to confirm something that will then be refused.
    /// </summary>
    private async Task<AdminRoleOutcome?> RefuseRevokeAsync(User target, AdminRoleRequest request, CancellationToken ct)
    {
        var others = await _db.Users.AsNoTracking()
            .CountAsync(u => u.IsAdmin && u.Status == "active" && u.Id != target.Id, ct);
        if (others == 0) return AdminRoleOutcome.LastAdmin;
        if (target.Id == request.ActorUserId && !request.ConfirmSelf) return AdminRoleOutcome.ConfirmSelfRequired;
        return null;
    }

    /// <summary>
    /// The actor may have lost the rights while waiting on the lock. Their token was checked at
    /// the door; this is checked after the queue.
    /// </summary>
    private async Task<AdminRoleOutcome?> RefuseActorAsync(Guid actorUserId, CancellationToken ct)
    {
        var stillAdmin = await _db.Users.AsNoTracking()
            .AnyAsync(u => u.Id == actorUserId && u.IsAdmin && u.Status == "active", ct);
        return stillAdmin ? null : AdminRoleOutcome.ActorNotAdmin;
    }

    /// <summary>
    /// Both records, staged on the change's own unit of work so they commit or vanish with it:
    /// <c>audit_log</c> for the member's trail, and the undeletable <c>admin_change_log</c>
    /// because who administers the club is the change that can hide every other one.
    /// </summary>
    private async Task StageRecordsAsync(User target, AdminRoleRequest request, CancellationToken ct)
    {
        var reason = request.Grant ? null : request.Reason?.Trim();
        var self = target.Id == request.ActorUserId;

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = target.TenantId,
            ActorUserId = request.ActorUserId,
            SubjectUserId = target.Id,
            Action = request.Grant ? GrantedAction : RevokedAction,
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new { reason, self }),
        });

        var label = await _db.Memberships.AsNoTracking()
            .Where(m => m.UserId == target.Id).Select(m => m.FullName).FirstOrDefaultAsync(ct);
        await _recorder.StageAsync(new AdminChange(
            Action: request.Grant ? AdminChangeActions.MemberAdminGranted : AdminChangeActions.MemberAdminRevoked,
            ActorUserId: request.ActorUserId,
            SubjectKind: AdminChangeSubjects.User,
            SubjectId: target.Id,
            SubjectLabel: label ?? target.Email,
            Reason: reason,
            Before: new { is_admin = !request.Grant },
            After: new { is_admin = request.Grant }), ct);
    }

    /// <summary>
    /// A stable 64-bit key for one club's admin set. FNV-1a over the tenant and a fixed label,
    /// for <see cref="PayerLock"/>'s reason: <c>GetHashCode</c> is randomised per process, so two
    /// API instances would never contend. The label keeps the key out of the payer locks' space.
    /// </summary>
    internal static long LockKey(Guid tenantId)
    {
        const ulong offsetBasis = 14695981039346656037UL;
        const ulong prime = 1099511628211UL;

        var hash = offsetBasis;
        Span<byte> bytes = stackalloc byte[16 + 6];
        tenantId.TryWriteBytes(bytes[..16]);
        "admins"u8.CopyTo(bytes[16..]);

        foreach (var b in bytes)
        {
            hash ^= b;
            hash *= prime;
        }

        return unchecked((long)hash);
    }
}
