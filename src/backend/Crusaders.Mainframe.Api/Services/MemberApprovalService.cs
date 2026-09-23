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
///
/// <para>
/// <b>The transition is the status change. Mail and the webhook are consequences of it, and
/// neither may undo it.</b> Approve and reject used to await the mail bare, after
/// <c>SaveChangesAsync</c> had already committed — so with SMTP refusing connections
/// <c>POST /admin/members/{id}/approve</c> committed the approval and then threw
/// <c>SmtpException</c> out of this file, the caller got HTTP 500, and the console said
/// "Approval failed." about a member who was already Active. An admin who believes that
/// sentence presses Approve again on an approved member; the second press answers 404,
/// which reads as a broken console. Suspend, reactivate and the registration announcement
/// were already guarded — the two transitions a club uses most were not. Both now report
/// whether the member was actually told, rather than choosing between lying and 500ing:
/// see <see cref="TransitionReport"/>.
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

    private readonly ClubIdentityResolver _club;

    /// <summary>
    /// Everything it takes to tell somebody. Bundled rather than passed one by one because the
    /// club became a seventh collaborator and the complexity gate caps a signature at six —
    /// which is the right pressure: what these three do together is one job, and the four
    /// arguments left are the four this class reasons about.
    /// </summary>
    public sealed record MemberNotifier(
        IEmailService Email, ILogger<MemberApprovalService> Logger, ClubIdentityResolver Club);

    public MemberApprovalService(
        MainframeDbContext db, ITenantContext tenant, IConfiguration config,
        IEventBus bus, MemberNotifier notifier)
    {
        _db = db; _tenant = tenant; _config = config; _bus = bus;
        _email = notifier.Email; _logger = notifier.Logger; _club = notifier.Club;
    }

    public async Task<TransitionReport> ApproveAsync(Guid memberId, Guid actorId, CancellationToken ct)
    {
        var membership = await _db.Memberships.FirstOrDefaultAsync(m => m.Id == memberId, ct);
        if (membership is null || membership.Status != MembershipStatus.PendingApproval)
            return TransitionReport.Refused(MembershipTransition.NotFound);

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

        var club = await _club.GetAsync(ct);
        var url = $"{_config["App:PublicBaseUrl"] ?? "http://localhost:8088"}/welcome/{magicLinkPlain}";
        var notified = await SendOrLogAsync(
            EmailTemplates.MembershipApproved(club, user.Email, url), $"approval notice for {user.Email}", ct);
        await EmitAsync("member.approved", membership, actorId, null, ct);
        return new TransitionReport(MembershipTransition.Ok, notified);
    }

    public async Task<TransitionReport> RejectAsync(Guid memberId, Guid actorId, string reason, CancellationToken ct)
    {
        var membership = await _db.Memberships.FirstOrDefaultAsync(m => m.Id == memberId, ct);
        if (membership is null || membership.Status != MembershipStatus.PendingApproval)
            return TransitionReport.Refused(MembershipTransition.NotFound);

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

        var notified = await SendOrLogAsync(
            EmailTemplates.MembershipRejected(await _club.GetAsync(ct), user.Email, reason), $"rejection notice for {user.Email}", ct);
        await EmitAsync("member.rejected", membership, actorId, reason, ct);
        return new TransitionReport(MembershipTransition.Ok, notified);
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
    public async Task<TransitionReport> SuspendAsync(Guid memberId, Guid actorId, string reason, CancellationToken ct)
    {
        var membership = await _db.Memberships.FirstOrDefaultAsync(m => m.Id == memberId, ct);
        if (membership is null) return TransitionReport.Refused(MembershipTransition.NotFound);
        if (membership.Status == MembershipStatus.Suspended) return TransitionReport.Refused(MembershipTransition.AlreadyInState);
        if (membership.Status != MembershipStatus.Active) return TransitionReport.Refused(MembershipTransition.WrongStatus);

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

        var notified = await SendOrLogAsync(
            EmailTemplates.MembershipSuspended(await _club.GetAsync(ct), user.Email, membership.FullName, reason),
            $"suspension notice for {user.Email}", ct);
        await EmitAsync("member.suspended", membership, actorId, reason, ct);
        return new TransitionReport(MembershipTransition.Ok, notified);
    }

    /// <summary>
    /// Lifts a suspension. Only ever from <see cref="MembershipStatus.Suspended"/> — a
    /// rejected application is a different decision with a different remedy, and turning
    /// one into an active member from this route would skip the approval the club owes it.
    /// </summary>
    public async Task<TransitionReport> ReactivateAsync(Guid memberId, Guid actorId, CancellationToken ct)
    {
        var membership = await _db.Memberships.FirstOrDefaultAsync(m => m.Id == memberId, ct);
        if (membership is null) return TransitionReport.Refused(MembershipTransition.NotFound);
        if (membership.Status == MembershipStatus.Active) return TransitionReport.Refused(MembershipTransition.AlreadyInState);
        if (membership.Status != MembershipStatus.Suspended) return TransitionReport.Refused(MembershipTransition.WrongStatus);

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

        var notified = await SendOrLogAsync(
            EmailTemplates.MembershipReactivated(await _club.GetAsync(ct), user.Email, membership.FullName),
            $"reactivation notice for {user.Email}", ct);
        await EmitAsync("member.reactivated", membership, actorId, null, ct);
        return new TransitionReport(MembershipTransition.Ok, notified);
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

        var club = await _club.GetAsync(ct);
        var consoleUrl = $"{_config["App:PublicBaseUrl"] ?? "http://localhost:8088"}/admin/members";

        // Admin users of this tenant only. Query filters already scope to the tenant; the
        // IsAdmin flag is what makes this the club's desk rather than every member.
        var adminEmails = await _db.Users.AsNoTracking()
            .Where(u => u.IsAdmin)
            .Select(u => u.Email)
            .ToListAsync(ct);

        // DISPATCHED, not awaited — the one call site in this class that must not block.
        //
        // The four notices above are raised by an admin acting at the desk, and each USES the
        // returned bool to tell that admin whether the member was actually reached; waiting is
        // correct there. This one is different in both respects: it is raised by a member's own
        // registration request, and its result is discarded. Awaiting it put SMTP on the
        // applicant's critical path — once per admin, in a loop — so a club with three admins
        // and a slow mail server spent three SMTP round trips before the browser heard
        // anything. The browser gives up at twenty seconds, on an account that was committed
        // before the first send, and the retry then tells the applicant their membership number
        // belongs to somebody else.
        //
        // The comment above this method already promised a dead SMTP host "must not turn a
        // successful registration into a 500". A slow one turned it into a timeout, which from
        // the applicant's side is the same thing.
        foreach (var to in adminEmails)
        {
            EmailDispatch.InBackground(
                _email, _logger,
                EmailTemplates.AdminNewRegistration(club, to, membership.FullName, user.Email, membership.MembershipNumber, consoleUrl),
                $"new-registration notice to {to}");
        }

        await EmitAsync("member.registered", membership, actorId: userId, reason: null, ct);
    }

    /// <summary>
    /// Sends, and answers whether it went. The bool is not decoration: the caller is a
    /// transition that has already committed, and the only two honest things it can do with
    /// a dead mail server are carry on and say so. Swallowing the failure silently would put
    /// a club in the position of believing a member was told when nobody was.
    /// </summary>
    private async Task<bool> SendOrLogAsync(EmailMessage message, string what, CancellationToken ct)
    {
        try { await _email.SendAsync(message, ct); return true; }
        catch (Exception ex) { _logger.LogWarning(ex, "Email failed: {What}", what); return false; }
    }

    /// <summary>
    /// One shape for every <c>member.*</c> event, so a template written against one works
    /// against the others. Block body for lizard's benefit — see memory/gotchas.md.
    ///
    /// <para>
    /// Guarded on the same terms as the mail. The in-process bus is an unbounded channel and
    /// does not throw today, but this runs on the far side of <c>SaveChangesAsync</c> exactly
    /// as the mail does, and it is that SHAPE — a post-commit side effect allowed to unwind
    /// its own caller — that turned a committed approval into an HTTP 500. The guard lives
    /// inside this method rather than in a differently-named wrapper on purpose:
    /// <c>RepositoryPostureTests.EmittedEventTypes</c> reads the event catalogue by scanning
    /// for <c>EmitAsync(</c> call sites, so renaming them hides the whole member lifecycle
    /// from the picker- and blueprint-agreement tests. That is not a hypothetical; it is what
    /// the first draft of this fix did, and those two tests caught it.
    /// </para>
    /// </summary>
    private async Task EmitAsync(string type, Membership membership, Guid actorId, string? reason, CancellationToken ct)
    {
        try
        {
            // D2: the member's active groups replace their class. `groups` is an array, so a URL
            // template cannot name it — a body consumer reads it; `member_class` is derived from the
            // league group and kept for ONE release so an existing template does not start failing
            // as a missing variable (a config error, never retried) the day this deploys. Read
            // inside the guard: it runs after the commit, like everything else here.
            var groups = await MemberTariffs.GroupsOfAsync(_db, membership.UserId, ct);
            var data = new Dictionary<string, object?>
            {
                ["membership_id"] = membership.Id,
                ["user_id"] = membership.UserId,
                ["full_name"] = membership.FullName,
                ["membership_number"] = membership.MembershipNumber,
                ["status"] = membership.Status.ToString(),
                ["groups"] = groups.Select(g => new Dictionary<string, object?>
                {
                    ["id"] = g.Id,
                    ["name"] = g.Name,
                    ["system_key"] = g.SystemKey,
                }).ToList(),
                ["member_class"] = MemberTariff.LegacyClassOf(groups),
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
        catch (Exception ex) { _logger.LogWarning(ex, "Event emit failed: {Type}", type); }
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

/// <summary>
/// What a lifecycle transition did, and whether the member was actually told about it.
///
/// <para>
/// Two facts rather than one, because they can genuinely differ and the console has to be
/// able to say so. A transition that succeeded with the mail server down is <b>not</b> a
/// failure — the row is committed, the audit line is written and the member's status has
/// really changed — but it is also not the same event as one the member received an email
/// about, and an admin who is told only "approved" will not think to pick up the phone.
/// </para>
/// </summary>
/// <param name="Result">Whether the status changed, and if not, why not.</param>
/// <param name="MemberNotified">Whether the notification email left the building.</param>
public readonly record struct TransitionReport(MembershipTransition Result, bool MemberNotified)
{
    /// <summary>A transition that never happened, so there was nothing to notify anyone about.</summary>
    public static TransitionReport Refused(MembershipTransition result) => new(result, false);

    public bool Ok => Result == MembershipTransition.Ok;
}
