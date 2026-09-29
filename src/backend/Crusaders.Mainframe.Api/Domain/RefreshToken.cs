namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// One link in a rotating refresh-token chain (review round 1, B1): the long-lived half of a
/// session, held by the browser in the httpOnly <c>crusaders_rt</c> cookie and exchanged at
/// <c>POST /api/v1/auth/refresh</c> for a fresh fifteen-minute access token and its own successor.
///
/// <para>
/// <b>Stored hashed</b> (<see cref="TokenHash"/>, SHA-256 hex): a database read leaks nothing a
/// browser can present. <b>Single use</b>: a link is spent (<see cref="UsedAt"/>) the moment it is
/// exchanged, and a spent link presented again is a replay — the whole <see cref="FamilyId"/> is
/// revoked. <b>Bound to the session epoch it was issued under</b>: a rotation (password change,
/// reset, suspension, sign out everywhere, the desk's code reset) raises
/// <see cref="User.SessionEpoch"/>, and a link below the account's epoch mints nothing.
/// </para>
/// </summary>
public sealed class RefreshToken : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }

    /// <summary>Every link descended from one sign-in shares this. Reuse or sign-out revokes the family.</summary>
    public Guid FamilyId { get; set; }

    public required string TokenHash { get; set; }

    /// <summary>The account's <see cref="User.SessionEpoch"/> when this link was issued.</summary>
    public int SessionEpoch { get; set; }

    public DateTimeOffset IssuedAt { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }

    /// <summary>When this link was exchanged for its successor. Presenting it again is a replay.</summary>
    public DateTimeOffset? UsedAt { get; set; }

    /// <summary>When this link was revoked — sign-out, a replay in its family, or an epoch raise.</summary>
    public DateTimeOffset? RevokedAt { get; set; }

    public const int TokenHashMaxLength = 128;
}
