namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Turns what a member presented at a court into a user, when there is no booking to
/// narrow the search down.
///
/// <para>
/// <b>This is deliberately not the same question the courtside match endpoints ask.</b>
/// Those resolve an identification <i>against a candidate set</i> — the handful of members
/// with a booking on that court in the grace window — which is what makes a four-digit PIN
/// usable at all. Here there is no booking yet, because the member is buying court time
/// they have not reserved.
/// </para>
///
/// <para>
/// So the methods that work here are the ones that identify a member <b>globally</b>, and
/// PIN is not one of them. A PIN checked against every member in the club is a 10,000-space
/// oracle over the whole roll, not over four people — and the club has far fewer than 10,000
/// members, so a random four digits would frequently match <i>somebody</i>. Refusing is the
/// only correct answer, and it is refused with a reason rather than silently returning null.
/// </para>
///
/// <para>
/// What a QR carries is an <see cref="Domain.AccessCode"/>, never a JWT. There used to be a
/// JWT path here, and it could not work: the court box's scanner pipeline carries at most
/// 24 bytes and a signed token is hundreds (review H2). A sixty-bit random code that names
/// a row is what the hardware can actually scan, and the row is what makes it real.
/// </para>
/// </summary>
public sealed class IdentificationResolver
{
    private readonly AccessCodeService _codes;

    public IdentificationResolver(AccessCodeService codes) => _codes = codes;

    /// <summary>
    /// Methods that can identify a member without a booking to check against. <c>qr</c>
    /// is a code read by a camera or scanner; <c>code</c> is the same code typed in.
    /// </summary>
    public static bool CanIdentifyGlobally(string? method)
        => string.Equals(method, "qr", StringComparison.OrdinalIgnoreCase)
           || string.Equals(method, "code", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// The user this code identifies, or null. Null covers every failure — expired,
    /// unknown, another club's, unsupported method — on purpose: telling them apart at a
    /// court box turns it into an oracle for which codes are real.
    ///
    /// <para>
    /// Either purpose identifies: a booking-activation code names its member as surely as
    /// a member-ident one does, and a member with a booking on court 2 buying a walk-up on
    /// court 3 should not have to fetch a second code.
    /// </para>
    /// </summary>
    public async Task<Guid?> ResolveAsync(string? method, string? token, CancellationToken ct)
    {
        if (!CanIdentifyGlobally(method) || string.IsNullOrWhiteSpace(token))
        {
            return null;
        }

        var resolved = await _codes.ResolveAsync(token, ct);
        return resolved?.UserId;
    }
}
