using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The one line both booking routes need: refuse a member the club will not let onto a court.
///
/// <para>
/// Its own file rather than a private helper on <see cref="BookingEndpoints"/> for the
/// ordinary reason — that file is at the 200-line gate, and extracting a component into the
/// same file does not move lizard's number, only moving it out does (<c>memory/gotchas.md</c>).
/// It reads better here anyway: the rule belongs to neither route in particular, and the next
/// route that charges a member is meant to find it.
/// </para>
/// </summary>
internal static class BookingMembershipGate
{
    /// <summary>
    /// The 403 for a barred member, or null to carry on.
    ///
    /// <para>
    /// Two codes, because one sentence cannot serve both. <c>member_suspended</c> already has
    /// copy the member reads — "speak to the club to have it restored" — and that is wrong for
    /// an applicant nobody has approved yet, where the desk's next action is one click on the
    /// Members page rather than a conversation. The status travels alongside so a screen can
    /// name it without mapping the code back.
    /// </para>
    ///
    /// <para>
    /// Callers pass the PAYER, not the actor. The desk booking on behalf is authorized; the
    /// question this answers is whether the person being CHARGED can use what is being bought.
    /// </para>
    /// </summary>
    public static async Task<IResult?> RefuseIfBarredAsync(
        MainframeDbContext db, Guid payerUserId, CancellationToken ct)
    {
        var status = await MembershipAccess.StatusIfBarredAsync(db, payerUserId, ct);
        if (status is null) return null;

        return Results.Json(
            new
            {
                error = status == MembershipStatus.Suspended ? "member_suspended" : "member_not_active",
                status = status.Value.ToString(),
            },
            statusCode: 403);
    }
}
