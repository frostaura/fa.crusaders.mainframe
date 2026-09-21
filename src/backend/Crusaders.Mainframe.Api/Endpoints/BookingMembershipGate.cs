using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The one line the booking routes and the member's court-code route need: refuse a member
/// the club will not let onto a court.
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
    ///
    /// <para>
    /// <c>POST /me/qr/generate</c> asks it too, about the signed-in member. Nothing is charged
    /// there — the code it would mint is already inert at every box — but the screen showing
    /// it promises a walk-up, and a promise nothing keeps is the defect. Same gate, so the
    /// screen and the box refuse for the same stated reason.
    /// </para>
    /// </summary>
    public static async Task<IResult?> RefuseIfBarredAsync(
        MainframeDbContext db, Guid payerUserId, CancellationToken ct)
    {
        // THREE codes now, not two. Ruling 15 added the third: a user with no membership row at
        // all, which this gate used to let straight through — and which, at a door, opened the
        // building. It carries no `status`, because there is no status to name; a screen that
        // printed one would be inventing a decision the club never took.
        var reason = await MembershipAccess.RefusalReasonAsync(db, payerUserId, ct);
        if (reason is null) return null;

        var status = await MembershipAccess.StatusIfBarredAsync(db, payerUserId, ct);

        return Results.Json(
            new
            {
                error = reason,
                status = status?.ToString(),
            },
            statusCode: 403);
    }
}
