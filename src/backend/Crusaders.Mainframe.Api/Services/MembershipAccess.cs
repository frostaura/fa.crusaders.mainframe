using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Whether the club will let this member through a door — the one rule, in one place.
///
/// <para>
/// <b>Only <see cref="MembershipStatus.Active"/> may open a court or buy court time.</b> The
/// rule had been written four times and enforced on three of them: the app's booking route
/// (<c>member_suspended</c>), the activation candidate set and the cached roster all carried
/// it, while <c>POST /api/v1/device/walkup</c> — the touchpad at the court, which creates its
/// own booking and so never meets a candidate set — carried none of it. A member suspended
/// at the desk walked up, was sold fifty credits of court time and had the lights switched
/// on for them; the suspension modal on the console promises, in those words, that they
/// cannot "open a court at the box". This type is what makes that sentence true, and having
/// exactly one home for it is what stops the fifth door being written without it.
/// </para>
///
/// <para>
/// <b>Not-Active rather than Suspended.</b> The three existing filters tested for
/// <c>Suspended</c> alone, which left <c>PendingApproval</c> and <c>Rejected</c> through — a
/// gap that is unreachable today only because neither can sign in to fetch a code, and that
/// an admin booking on behalf of an unapproved applicant re-opens without touching this
/// file. A club that has not said yes, or has said no, has not said yes.
/// </para>
///
/// <para>
/// <b>A user with NO membership row is barred too, and that is a deliberate reversal.</b> This
/// type used to read "the club has recorded a decision about this person, and it was not
/// approval" — and about such a user it has recorded none, so it let them through. The member
/// lane found what that means at a door: a real, live ident code for a user with no membership
/// row <b>opened the building</b> under the default <c>active_member</c> policy. "Active member"
/// cannot mean "anybody the club has not said no to". The refusal carries its own reason,
/// <c>no_membership</c>, because the desk's next action is different — there is nothing to
/// un-suspend, the person needs enrolling.
/// </para>
///
/// <para>
/// <b>What this widening reaches.</b> Every caller of these two methods: the door, the walk-up
/// pad, the activation paths, the cached roster, and the code-minting route — so a user with no
/// membership row is also issued no door-capable ident code in the first place. No path in this
/// product creates a user without a membership row (not registration, not admin promotion, not
/// the seeder), so the blast radius in a real club is rows that should not exist. That is exactly
/// why the old reading was safe-looking and was not safe.
/// </para>
///
/// <para>
/// <b>This is not a staff carve-out and must not be read as one.</b> It used to be described
/// as covering "operator accounts created by provisioning rather than by registration", and
/// there is no such thing in this product: there is no operator role, and no path — not
/// registration, not admin promotion, not the seeder — creates a user without a membership
/// row. Anything that needs staff to get through a door has to say <c>IsAdmin</c> and mean it;
/// <see cref="GateAccess"/> records what keying it on this instead cost.
/// </para>
/// </summary>
public static class MembershipAccess
{
    /// <summary>
    /// True when the club has taken this member's court access away — suspended, rejected,
    /// or still waiting on approval.
    ///
    /// <para>
    /// The query-side twin of this test is written inline as
    /// <c>!db.Memberships.Any(m =&gt; m.UserId == b.UserId &amp;&amp; m.Status != MembershipStatus.Active)</c>
    /// in <see cref="CourtActivationService"/> and
    /// <c>DeviceRosterBuilder</c>, because a captured expression does not translate inside a
    /// subquery. The two must move together; this summary is where the reason lives.
    /// </para>
    /// </summary>
    public static async Task<bool> IsBarredFromCourtsAsync(
        MainframeDbContext db, Guid userId, CancellationToken ct)
        => await RefusalReasonAsync(db, userId, ct) is not null;

    /// <summary>
    /// The recorded status when the club has taken this member's court access away, or null
    /// when it has not — the same test as <see cref="IsBarredFromCourtsAsync"/>, keeping the
    /// reason so a caller can say WHICH refusal this is.
    ///
    /// <para>
    /// The booking routes need that and the device routes do not. A box says "SEE THE DESK"
    /// either way; a screen has to distinguish "your membership is suspended, speak to the
    /// club" from "this applicant has not been approved yet", because those are two different
    /// things for the desk to do next and the second is one click away.
    /// </para>
    /// </summary>
    public static async Task<MembershipStatus?> StatusIfBarredAsync(
        MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        var status = await db.Memberships
            .Where(m => m.UserId == userId)
            .Select(m => (MembershipStatus?)m.Status)
            .FirstOrDefaultAsync(ct);
        return status == MembershipStatus.Active ? null : status;
    }

    /// <summary>
    /// Why the club will not let this person through, or null when it will.
    ///
    /// <para>
    /// Three answers rather than two, because <see cref="StatusIfBarredAsync"/> cannot express
    /// the third: it returns <c>null</c> both for "approved" and for "no row at all", which is
    /// precisely the conflation that opened a door for a user the club had never admitted.
    /// Callers that only need a yes/no use <see cref="IsBarredFromCourtsAsync"/>; callers that
    /// have a screen to write a sentence on use this.
    /// </para>
    /// </summary>
    public static async Task<string?> RefusalReasonAsync(
        MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        var status = await db.Memberships
            .Where(m => m.UserId == userId)
            .Select(m => (MembershipStatus?)m.Status)
            .FirstOrDefaultAsync(ct);

        return status switch
        {
            null => NoMembership,
            MembershipStatus.Active => null,
            MembershipStatus.Suspended => MemberSuspended,
            _ => MemberNotActive,
        };
    }

    /// <summary>The club has no record of this person at all. Ruling 15.</summary>
    public const string NoMembership = "no_membership";

    /// <summary>The club took this member's access away.</summary>
    public const string MemberSuspended = "member_suspended";

    /// <summary>The club has not granted access — pending approval, or rejected.</summary>
    public const string MemberNotActive = "member_not_active";
}
