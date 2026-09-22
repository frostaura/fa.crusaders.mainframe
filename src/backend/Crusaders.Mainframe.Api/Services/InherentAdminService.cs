using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Applies <see cref="InherentAdmins"/> to one account. The only thing in the application that
/// acts on <c>Admins:Emails</c>.
/// </summary>
/// <remarks>
/// <para>
/// <b>Where it is applied, and why not at boot.</b> A boot-time sweep can only reach accounts
/// that already exist, so an inherent administrator who registers next month would never get
/// the flag — and re-running the sweep on every boot means re-deciding, every restart, something
/// that has not changed. It is applied instead at the one moment the question is actually being
/// asked: a sign-in, by the account it concerns.
/// </para>
/// <para>
/// <b>It is called LAST in <c>AuthService.LoginAsync</c>, and that is a safety property rather
/// than a detail of ordering.</b> <c>IsAdmin</c> is already an exemption from the membership
/// gate in both <c>LoginAsync</c> and <c>RefreshAsync</c>, so granting it earlier in that method
/// would let a configured address in past a rejection, a suspension, or an application the club
/// has not approved. Called after every refusal has been evaluated, the list can only add the
/// admin flag to a sign-in that was going to succeed on its own merits. Consequently:
/// </para>
/// <list type="bullet">
/// <item><description>
/// <c>RegisterAsync</c> does not call this. A registering applicant is unverified and
/// unapproved; handing them <c>IsAdmin</c> at that moment would exempt them from both checks at
/// their first sign-in, turning a configuration key into an authentication bypass. They are
/// promoted at their first sign-in that passes everything — the earliest point at which the flag
/// changes nothing else.
/// </description></item>
/// <item><description>
/// <c>ConsumeMagicLinkAsync</c> does not call this either: that path performs no membership
/// check at all, so promoting there would reach an account the club has suspended.
/// </description></item>
/// </list>
/// <para>
/// <b>Tenancy: the rights are per club, and only where the person already is.</b> A <c>User</c>
/// row is per (tenant, person) by design — the same human at two clubs has two rows — so this
/// promotes the row in front of it and nothing else. It never creates a user, a membership or a
/// membership number in a club the person has not joined: that would put somebody who never
/// applied into a club's member list, in a product whose booking grid shows members to one
/// another. Someone with accounts at two clubs is promoted at each, independently, when they
/// sign in there.
/// </para>
/// </remarks>
public sealed class InherentAdminService
{
    /// <summary>
    /// The audit action. Its own verb rather than a reuse of an admin-granted one: nobody
    /// appointed this person, and a trail that says an admin did would be untrue.
    /// </summary>
    public const string PromotionAction = "user.admin_inherited";

    /// <summary>Where the rights came from, on the row itself, so the trail is self-describing.</summary>
    private const string PromotionDetails = "{\"source\":\"" + InherentAdmins.SectionKey + "\"}";

    private readonly MainframeDbContext _db;
    private readonly InherentAdmins _admins;
    private readonly ILogger<InherentAdminService> _logger;

    public InherentAdminService(MainframeDbContext db, InherentAdmins admins, ILogger<InherentAdminService> logger)
    {
        _db = db; _admins = admins; _logger = logger;
    }

    /// <summary>
    /// Brings <paramref name="user"/>'s admin flag into line with the configured list. Mutates
    /// the entity and stages the audit row; the caller's <c>SaveChangesAsync</c> commits both,
    /// so a promotion lands in the same unit of work as the sign-in that caused it.
    /// </summary>
    public async Task ApplyAsync(User user, CancellationToken ct)
    {
        // No list, no behaviour: an empty or absent Admins:Emails leaves every path exactly as
        // it was before this type existed, down to the queries it does not run.
        if (_admins.Emails.Count == 0) return;

        if (_admins.Includes(user.Email))
        {
            Promote(user);
            return;
        }

        if (user.IsAdmin) await WarnIfInheritedAsync(user, ct);
    }

    private void Promote(User user)
    {
        // Already true is not an event. Writing a row — or a log line — on every sign-in of a
        // configured address turns the audit trail into a heartbeat and buries the one entry
        // that matters, which is the moment the rights were actually conferred.
        if (user.IsAdmin) return;

        user.IsAdmin = true;
        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = user.TenantId,
            // Actor and subject are the same account because there is no third party: the
            // deployment's configuration conferred this, and it has no user row. Inventing a
            // sentinel actor would put a guid in the trail that resolves to nobody; the action
            // name is what carries the provenance, and no endpoint can write it.
            ActorUserId = user.Id,
            SubjectUserId = user.Id,
            Action = PromotionAction,
            DetailsJson = PromotionDetails,
        });

        _logger.LogInformation(
            "{Email} is an inherent administrator ({Section}) and has been given club-admin rights in " +
            "tenant {TenantId}.", user.Email, InherentAdmins.SectionKey, user.TenantId);
    }

    /// <summary>
    /// An address that WAS on the list and no longer is.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The flag is kept, deliberately.</b> Stripping it would turn a configuration edit — a
    /// rename, a typo, an <c>Admins__Emails__0</c> a redeploy dropped — into a lockout: if that
    /// account is the club's only administrator, there is no way back into the admin console
    /// that does not involve editing the database. It is the same call
    /// <c>ProductionBootstrap.EnsureAdminAsync</c> makes about an admin it did not create, for
    /// the same reason.
    /// </para>
    /// <para>
    /// <b>But it is not silent.</b> Left unsaid, a deployment would accumulate administrators
    /// whose rights have no configuration behind them and nothing anywhere would connect the two.
    /// The warning names the account and says where the flag is actually removed. Removal is a
    /// person's decision, taken in Admin → Members; this key is not a revocation mechanism and
    /// the message says so rather than implying it.
    /// </para>
    /// <para>
    /// The audit lookup is what keeps this honest: without it, every admin a club appointed
    /// itself would be reported on every sign-in, and an operator trained to ignore the message
    /// is the same as no message. It runs only for an admin who is not on a non-empty list,
    /// which is rare enough that its cost is a club-sized scan nobody will notice.
    /// </para>
    /// </remarks>
    private async Task WarnIfInheritedAsync(User user, CancellationToken ct)
    {
        var inherited = await _db.AuditLogs.IgnoreQueryFilters().AnyAsync(
            a => a.TenantId == user.TenantId && a.SubjectUserId == user.Id && a.Action == PromotionAction, ct);
        if (!inherited) return;

        _logger.LogWarning(
            "{Email} holds club-admin rights in tenant {TenantId} that were inherited from {Section}, and that " +
            "address is no longer configured there. The rights are being LEFT IN PLACE — removing them from a " +
            "config edit could lock a club out of its own admin console. Remove them from Admin → Members if " +
            "that is what was intended.", user.Email, user.TenantId, InherentAdmins.SectionKey);
    }
}
