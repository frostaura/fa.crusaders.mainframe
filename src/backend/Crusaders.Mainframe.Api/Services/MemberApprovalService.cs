using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

public sealed class MemberApprovalService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly IEmailService _email;
    private readonly IConfiguration _config;

    public MemberApprovalService(MainframeDbContext db, ITenantContext tenant, IEmailService email, IConfiguration config)
    { _db = db; _tenant = tenant; _email = email; _config = config; }

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

        var clubName = await _db.Tenants.IgnoreQueryFilters().Where(t => t.Id == _tenant.TenantId).Select(t => t.DisplayName).FirstAsync(ct);
        var url = $"{_config["App:PublicBaseUrl"] ?? "http://localhost:8088"}/welcome/{magicLinkPlain}";
        await _email.SendAsync(EmailTemplates.MembershipApproved(user.Email, url, clubName), ct);
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

        var clubName = await _db.Tenants.IgnoreQueryFilters().Where(t => t.Id == _tenant.TenantId).Select(t => t.DisplayName).FirstAsync(ct);
        await _email.SendAsync(EmailTemplates.MembershipRejected(user.Email, reason, clubName), ct);
        return true;
    }
}
