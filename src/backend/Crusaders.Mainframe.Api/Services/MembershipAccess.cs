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
/// <b>A user with no membership row is not barred.</b> The test is "the club has recorded a
/// decision about this person, and it was not approval" — so a user who has never had a
/// membership row (an operator account created by provisioning rather than by registration)
/// keeps the access they have today. Widening this to "must hold an Active membership" would
/// be a different rule with a different blast radius, and it is not the one the console
/// promises.
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
        => await StatusIfBarredAsync(db, userId, ct) is not null;

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
}
