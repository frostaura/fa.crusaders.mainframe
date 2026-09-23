using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The mail an admin-rights change sends: the affected person, and every OTHER active admin.
///
/// <para>
/// <b>Dispatched in the background, like the registration notice</b> (see
/// <see cref="MemberApprovalService.AnnounceRegistrationAsync"/>): the change is committed before
/// the first send, the recipient list is a loop over the club's admins, and an admin waiting on
/// the console must not wait on SMTP once per colleague. A dead mail server is logged, never
/// thrown — the rights have already changed and the change record already says so.
/// </para>
///
/// <para>
/// <b>The actor is not sent a notice about their own action</b>; they are looking at the result.
/// On a self-removal the actor IS the subject and gets the subject's mail, which is the one that
/// carries the reason.
/// </para>
/// </summary>
public sealed class AdminRoleNotifier
{
    private readonly MainframeDbContext _db;
    private readonly IEmailService _email;
    private readonly ILogger<AdminRoleNotifier> _logger;
    private readonly ClubIdentityResolver _club;
    private readonly IConfiguration _config;

    public AdminRoleNotifier(
        MainframeDbContext db, IEmailService email, ILogger<AdminRoleNotifier> logger,
        ClubIdentityResolver club, IConfiguration config)
    {
        _db = db; _email = email; _logger = logger; _club = club; _config = config;
    }

    public async Task NotifyAsync(User target, AdminRoleRequest request, CancellationToken ct)
    {
        var club = await _club.GetAsync(ct);
        var baseUrl = _config["App:PublicBaseUrl"] ?? "http://localhost:8088";
        var change = new AdminRoleChange
        {
            SubjectName = await NameOfAsync(target.Id, target.Email, ct),
            ActorName = await NameOfAsync(request.ActorUserId, null, ct),
            Granted = request.Grant,
            Reason = request.Grant ? null : request.Reason?.Trim(),
            ConsoleUrl = $"{baseUrl}/admin/members",
        };

        var toSubject = request.Grant
            ? EmailTemplates.AdminRoleGranted(club, target.Email, change)
            : EmailTemplates.AdminRoleRevoked(club, target.Email, change);
        EmailDispatch.InBackground(_email, _logger, toSubject, $"admin-role notice to {target.Email}");

        // Read AFTER the commit, so a newly appointed admin is excluded by id rather than by
        // luck of timing, and a just-removed one is simply no longer in the set.
        var others = await _db.Users.AsNoTracking()
            .Where(u => u.IsAdmin && u.Status == "active" && u.Id != target.Id && u.Id != request.ActorUserId)
            .Select(u => u.Email)
            .ToListAsync(ct);

        var notice = change with { ConsoleUrl = $"{baseUrl}/admin/monitoring/changes" };
        foreach (var to in others)
        {
            EmailDispatch.InBackground(
                _email, _logger, EmailTemplates.AdminRoleChangedNotice(club, to, notice), $"admin-role notice to admin {to}");
        }
    }

    /// <summary>The club's name for a person, or their address when they have no membership row.</summary>
    private async Task<string> NameOfAsync(Guid userId, string? fallback, CancellationToken ct)
    {
        var name = await _db.Memberships.AsNoTracking()
            .Where(m => m.UserId == userId).Select(m => m.FullName).FirstOrDefaultAsync(ct);
        if (!string.IsNullOrWhiteSpace(name)) return name;

        return fallback
            ?? await _db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.Email).FirstOrDefaultAsync(ct)
            ?? "An administrator";
    }
}
