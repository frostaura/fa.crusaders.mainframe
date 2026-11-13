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
    private readonly AdminChangeRecorder _changes;

    /// <summary>
    /// Everything it takes to tell somebody. Bundled rather than passed one by one because the
    /// club became a seventh collaborator and the complexity gate caps a signature at six —
    /// which is the right pressure: what these three do together is one job, and the four
    /// arguments left are the four this class reasons about.
    /// </summary>
    /// <para>
    /// <see cref="Changes"/> joined it in review round 1 (B5): the club's own change record is one
    /// more audience a decision about a membership is told to, in the decision's own save.
    /// </para>
    public sealed record MemberNotifier(
        IEmailService Email, ILogger<MemberApprovalService> Logger, ClubIdentityResolver Club, AdminChangeRecorder Changes);

    private readonly MemberCodeService _memberCodes;

    public MemberApprovalService(
        MainframeDbContext db, ITenantContext tenant, IConfiguration config,
        IEventBus bus, MemberNotifier notifier, MemberCodeService memberCodes)
    {
        _memberCodes = memberCodes;
        _db = db; _tenant = tenant; _config = config; _bus = bus;
        _email = notifier.Email; _logger = notifier.Logger; _club = notifier.Club; _changes = notifier.Changes;
    }

    public async Task<TransitionReport> ApproveAsync(Guid memberId, Guid actorId, CancellationToken ct)
    {
        var membership = await _db.Memberships.FirstOrDefaultAsync(m => m.Id == memberId, ct);
        // A rejection can be reversed (review round 3, A-2): the console offers "Approve
        // application" on a rejected applicant, and a club that turned somebody down by mistake
        // approves them exactly as it would have the first time — audited, on the change record
        // FROM "rejected", welcomed by the same email. Nothing else is approvable.
        if (membership is null
            || membership.Status is not (MembershipStatus.PendingApproval or MembershipStatus.Rejected))
            return TransitionReport.Refused(MembershipTransition.NotFound);

        var from = membership.Status == MembershipStatus.Rejected ? "rejected" : "pending_approval";
        var user = await _db.Users.FirstAsync(u => u.Id == membership.UserId, ct);

        // BP-02: an applicant whose address is unconfirmed cannot be approved. Whoever typed an
        // address into the form chose the password with it, and the welcome link below is mailed
        // to that ADDRESS: approving first let a stranger register somebody else's email, wait for
        // the club to approve "them", and keep a working password once the real owner clicked the
        // welcome mail. Confirming first means the password and the mailbox belong to the same
        // person before the club lets either in. The console offers "Resend verification" on
        // exactly these rows.
        if (!user.EmailVerified) return TransitionReport.Refused(MembershipTransition.EmailNotVerified);
        membership.Status = MembershipStatus.Active;
        membership.RejectionReason = null;
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
        await StageChangeAsync(AdminChangeActions.MemberApproved, membership, actorId, null, (from, "active"), ct);

        await _db.SaveChangesAsync(ct);

        var club = await _club.GetAsync(ct);
        var url = $"{await TenantLinks.ForTenantAsync(_db, _config, _tenant.TenantId, ct)}/welcome/{magicLinkPlain}";
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
        await StageChangeAsync(AdminChangeActions.MemberRejected, membership, actorId, reason, ("pending_approval", "rejected"), ct);

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

        // A suspension retires the member's code (member-code §10), so a reactivation does not
        // quietly hand back a code the phone kept through the suspension.
        await _memberCodes.StageRotationAsync(user.Id, actorId, "suspended", ct);
        await StageChangeAsync(AdminChangeActions.MemberSuspended, membership, actorId, reason, ("active", "suspended"), ct);
        await _db.SaveChangesAsync(ct);
        await _memberCodes.CompleteRotationsAsync(ct);

        var notified = await SendOrLogAsync(
            EmailTemplates.MembershipSuspended(await _club.GetAsync(ct), user.Email, membership.FullName, reason),
            $"suspension notice for {user.Email}", ct);
        await EmitAsync("member.suspended", membership, actorId, reason, ct);
        return new TransitionReport(MembershipTransition.Ok, notified);
    }

    /// <summary>
    /// The club's own change record for a membership decision (review round 1, B5), staged on the
    /// decision's unit of work so the two commit or vanish together. The actions were in the
    /// vocabulary from the start and nothing wrote them, so the Change record page never showed
    /// who approved, rejected, suspended or reactivated anybody.
    /// </summary>
    private Task StageChangeAsync(
        string action, Membership membership, Guid actorId, string? reason, (string From, string To) status, CancellationToken ct)
    {
        // Block body: lizard mis-scopes an expression body containing braces (memory/gotchas-gates.md).
        return _changes.StageAsync(new AdminChange(
            Action: action,
            ActorUserId: actorId,
            SubjectKind: AdminChangeSubjects.User,
            SubjectId: membership.UserId,
            SubjectLabel: membership.FullName,
            Reason: reason,
            Before: new { status = status.From },
            After: new { status = status.To }), ct);
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
        await StageChangeAsync(AdminChangeActions.MemberReactivated, membership, actorId, null, ("suspended", "active"), ct);
        await _db.SaveChangesAsync(ct);

        var notified = await SendOrLogAsync(
            EmailTemplates.MembershipReactivated(await _club.GetAsync(ct), user.Email, membership.FullName),
            $"reactivation notice for {user.Email}", ct);
        await EmitAsync("member.reactivated", membership, actorId, null, ct);
        return new TransitionReport(MembershipTransition.Ok, notified);
    }

    /// <summary>
    /// The <c>member.registered</c> webhook (spec §2.3 / §9) for an application that has just
    /// been committed.
    ///
    /// <para>
    /// <b>The admins' email is no longer sent from here.</b> It used to be a loop of background
    /// sends to every admin, dispatched after the registration had committed — so a crash in
    /// between, or a mail server that refused one address, lost the desk's only cue. It is now an
    /// admin notice staged in the registration's own save (<see cref="AdminNotices.MemberRegistered"/>,
    /// in <see cref="AuthService.RegisterAsync"/>), delivered by the outbox to every active,
    /// confirmed admin who has not opted out, with the same wording. This method keeps its name
    /// and its one call site so the webhook still fires exactly once per application.
    /// </para>
    /// </summary>
    public async Task AnnounceRegistrationAsync(Guid userId, CancellationToken ct)
    {
        var membership = await _db.Memberships.FirstOrDefaultAsync(m => m.UserId == userId, ct);
        if (membership is null) return;

        await EmitAsync("member.registered", membership, actorId: userId, reason: null, ct);
    }

    /// <summary>
    /// Queues the mail, and answers whether it was queued. The bool is not decoration: the caller
    /// is a transition that has already committed, and the only honest things it can do with a
    /// mail that could not even be queued are carry on and say so. Delivery is the email outbox's —
    /// retried with backoff, and announced to the club's admins if it finally cannot go — so a dead
    /// mail server no longer holds this request, and "queued" is all this can truthfully claim.
    /// </summary>
    private async Task<bool> SendOrLogAsync(EmailMessage message, string what, CancellationToken ct)
    {
        try { await _email.SendAsync(message, ct); return true; }  // queues; see above
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

    /// <summary>The applicant has not confirmed their address yet (BP-02): approval waits for it.</summary>
    EmailNotVerified,
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
/// <param name="EmailQueued">Whether the notification email was queued for sending. Not whether it has arrived: delivery belongs to the email outbox.</param>
public readonly record struct TransitionReport(MembershipTransition Result, bool EmailQueued)
{
    /// <summary>A transition that never happened, so there was nothing to notify anyone about.</summary>
    public static TransitionReport Refused(MembershipTransition result) => new(result, false);

    public bool Ok => Result == MembershipTransition.Ok;
}
