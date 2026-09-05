using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The member lifecycle an admin drives: approve, reject, suspend, reactivate.
///
/// <para>
/// Every transition writes an audit row, sends the member an email, and emits the matching
/// <c>member.*</c> webhook event. The three used to come apart — the audit rows existed,
/// the emails existed, and <b>no member lifecycle event was ever emitted at all</b>, so the
/// programmatic mirror CLAUDE.md promises had nothing to mirror for the half of the system
/// a club actually operates by hand.
/// </para>
/// </summary>
public sealed class MemberApprovalService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly IEmailService _email;
    private readonly IConfiguration _config;
    private readonly IEventBus _bus;
    private readonly ILogger<MemberApprovalService> _logger;

    public MemberApprovalService(
        MainframeDbContext db, ITenantContext tenant, IEmailService email, IConfiguration config,
        IEventBus bus, ILogger<MemberApprovalService> logger)
    { _db = db; _tenant = tenant; _email = email; _config = config; _bus = bus; _logger = logger; }

    public async Task<bool> ApproveAsync(Guid memberId, Guid actorId, CancellationToken ct)
    {
        var membership = await _db.Memberships.FirstOrDefaultAsync(m => m.Id == memberId, ct);
        if (membership is null || membership.Status != MembershipStatus.PendingApproval) return false;

        var user = await _db.Users.FirstAsync(u => u.Id == membership.UserId, ct);
        membership.Status = MembershipStatus.Active;
        membership.ReviewedAt = DateTimeOffset.UtcNow;
        membership.ReviewedByUserId = actorId;

        var magicLinkPlain = TokenHashing.Generate();
        _db.AuthTokens.Add(new AuthToken
        {
            TenantId = _tenant.TenantId,
            UserId = user.Id,
            Kind = TokenKind.MagicLink,
            TokenHash = TokenHashing.Hash(magicLinkPlain),
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(15),
        });
        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorId,
            SubjectUserId = user.Id,
            Action = "member.approved",
        });

        await _db.SaveChangesAsync(ct);

        var clubName = await ClubNameAsync(ct);
        var url = $"{_config["App:PublicBaseUrl"] ?? "http://localhost:8088"}/welcome/{magicLinkPlain}";
        await _email.SendAsync(EmailTemplates.MembershipApproved(user.Email, url, clubName), ct);
        await EmitAsync("member.approved", membership, actorId, null, ct);
        return true;
    }

    public async Task<bool> RejectAsync(Guid memberId, Guid actorId, string reason, CancellationToken ct)
    {
        var membership = await _db.Memberships.FirstOrDefaultAsync(m => m.Id == memberId, ct);
        if (membership is null || membership.Status != MembershipStatus.PendingApproval) return false;

        var user = await _db.Users.FirstAsync(u => u.Id == membership.UserId, ct);
        membership.Status = MembershipStatus.Rejected;
        membership.RejectionReason = reason;
        membership.ReviewedAt = DateTimeOffset.UtcNow;
        membership.ReviewedByUserId = actorId;

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorId,
            SubjectUserId = user.Id,
            Action = "member.rejected",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new { reason }),
        });

        await _db.SaveChangesAsync(ct);

        var clubName = await ClubNameAsync(ct);
        await _email.SendAsync(EmailTemplates.MembershipRejected(user.Email, reason, clubName), ct);
        await EmitAsync("member.rejected", membership, actorId, reason, ct);
        return true;
    }

    /// <summary>
    /// Suspends an active member — the status a club reaches for when dues lapse.
    ///
    /// <para>
    /// The enum value and the console's "Suspended" filter both shipped; the operation did
    /// not, so the filter was permanently empty and spec §8's "approve / reject / suspend"
    /// was two thirds true. A suspension is <b>not</b> a rejection and not a deletion: the
    /// row, the ledger and the member's bookings all stand, and reactivating puts them back
    /// exactly where they were. What it takes away is access — sign-in
    /// (<see cref="AuthService"/>), booking, and identification at the court box.
    /// </para>
    ///
    /// <para>
    /// A reason is required for the same rationale rejection requires one: the member is
    /// emailed it, and a club that cannot say why it locked somebody out will be asked.
    /// </para>
    /// </summary>
    public async Task<MembershipTransition> SuspendAsync(Guid memberId, Guid actorId, string reason, CancellationToken ct)
    {
        var membership = await _db.Memberships.FirstOrDefaultAsync(m => m.Id == memberId, ct);
        if (membership is null) return MembershipTransition.NotFound;
        if (membership.Status == MembershipStatus.Suspended) return MembershipTransition.AlreadyInState;
        if (membership.Status != MembershipStatus.Active) return MembershipTransition.WrongStatus;

        var user = await _db.Users.FirstAsync(u => u.Id == membership.UserId, ct);
        membership.Status = MembershipStatus.Suspended;
        membership.ReviewedAt = DateTimeOffset.UtcNow;
        membership.ReviewedByUserId = actorId;

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorId,
            SubjectUserId = user.Id,
            Action = "member.suspended",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new { reason }),
        });
        await _db.SaveChangesAsync(ct);

        var clubName = await ClubNameAsync(ct);
        await SendOrLogAsync(EmailTemplates.MembershipSuspended(user.Email, membership.FullName, reason, clubName), $"suspension notice for {user.Email}", ct);
        await EmitAsync("member.suspended", membership, actorId, reason, ct);
        return MembershipTransition.Ok;
    }

    /// <summary>
    /// Lifts a suspension. Only ever from <see cref="MembershipStatus.Suspended"/> — a
    /// rejected application is a different decision with a different remedy, and turning
    /// one into an active member from this route would skip the approval the club owes it.
    /// </summary>
    public async Task<MembershipTransition> ReactivateAsync(Guid memberId, Guid actorId, CancellationToken ct)
    {
        var membership = await _db.Memberships.FirstOrDefaultAsync(m => m.Id == memberId, ct);
        if (membership is null) return MembershipTransition.NotFound;
        if (membership.Status == MembershipStatus.Active) return MembershipTransition.AlreadyInState;
        if (membership.Status != MembershipStatus.Suspended) return MembershipTransition.WrongStatus;

        var user = await _db.Users.FirstAsync(u => u.Id == membership.UserId, ct);
        membership.Status = MembershipStatus.Active;
        membership.ReviewedAt = DateTimeOffset.UtcNow;
        membership.ReviewedByUserId = actorId;

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = actorId,
            SubjectUserId = user.Id,
            Action = "member.reactivated",
        });
        await _db.SaveChangesAsync(ct);

        var clubName = await ClubNameAsync(ct);
        await SendOrLogAsync(EmailTemplates.MembershipReactivated(user.Email, membership.FullName, clubName), $"reactivation notice for {user.Email}", ct);
        await EmitAsync("member.reactivated", membership, actorId, null, ct);
        return MembershipTransition.Ok;
    }

    /// <summary>
    /// The club's admins, told a new application is waiting, plus the
    /// <c>member.registered</c> webhook (spec §2.3 / §9).
    ///
    /// <para>
    /// It lives here rather than in <see cref="AuthService"/> because it is a membership
    /// lifecycle notification like the four above it, and because the registration path owns
    /// exactly one line of it: the call. Mail failures are logged, never thrown — the account
    /// is already committed by the time this runs, and an unreachable SMTP host must not turn
    /// a successful registration into a 500 the applicant can never retry past.
    /// </para>
    /// </summary>
    public async Task AnnounceRegistrationAsync(Guid userId, CancellationToken ct)
    {
        var membership = await _db.Memberships.FirstOrDefaultAsync(m => m.UserId == userId, ct);
        if (membership is null) return;
        var user = await _db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null) return;

        var clubName = await ClubNameAsync(ct);
        var consoleUrl = $"{_config["App:PublicBaseUrl"] ?? "http://localhost:8088"}/admin/members";

        // Admin users of this tenant only. Query filters already scope to the tenant; the
        // IsAdmin flag is what makes this the club's desk rather than every member.
        var adminEmails = await _db.Users.AsNoTracking()
            .Where(u => u.IsAdmin)
            .Select(u => u.Email)
            .ToListAsync(ct);

        foreach (var to in adminEmails)
        {
            await SendOrLogAsync(
                EmailTemplates.AdminNewRegistration(to, membership.FullName, user.Email, membership.MembershipNumber, clubName, consoleUrl),
                $"new-registration notice to {to}", ct);
        }

        await EmitAsync("member.registered", membership, actorId: userId, reason: null, ct);
    }

    private Task<string> ClubNameAsync(CancellationToken ct) =>
        _db.Tenants.IgnoreQueryFilters().Where(t => t.Id == _tenant.TenantId).Select(t => t.DisplayName).FirstAsync(ct);

    private async Task SendOrLogAsync(EmailMessage message, string what, CancellationToken ct)
    {
        try { await _email.SendAsync(message, ct); }
        catch (Exception ex) { _logger.LogWarning(ex, "Email failed: {What}", what); }
    }

    /// <summary>
    /// One shape for every <c>member.*</c> event, so a template written against one works
    /// against the others. Block body for lizard's benefit — see memory/gotchas.md.
    /// </summary>
    private async Task EmitAsync(string type, Membership membership, Guid actorId, string? reason, CancellationToken ct)
    {
        var data = new Dictionary<string, object?>
        {
            ["membership_id"] = membership.Id,
            ["user_id"] = membership.UserId,
            ["full_name"] = membership.FullName,
            ["membership_number"] = membership.MembershipNumber,
            ["status"] = membership.Status.ToString(),
            ["member_class"] = membership.MemberClass.ToString(),
        };
        if (reason is not null) data["reason"] = reason;

        await _bus.EmitAsync(new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: type,
            TenantId: _tenant.TenantId,
            TenantSlug: _tenant.TenantSlug,
            OccurredAt: DateTimeOffset.UtcNow,
            ActorUserId: actorId == Guid.Empty ? null : actorId,
            ActorIsAdmin: actorId != membership.UserId,
            SubjectUserId: membership.UserId,
            Data: data), ct);
    }
}

/// <summary>
/// Why a lifecycle transition did or did not happen. A bool could not tell "no such member"
/// from "already suspended", and the console needs to say different things for each.
/// </summary>
public enum MembershipTransition
{
    Ok,
    NotFound,
    AlreadyInState,
    WrongStatus,
}
