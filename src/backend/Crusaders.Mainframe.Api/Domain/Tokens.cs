namespace Crusaders.Mainframe.Api.Domain;

public enum TokenKind
{
    EmailVerification = 0,
    MagicLink = 1,
    PasswordReset = 2,
    AdminTempPassword = 3,

    /// <summary>
    /// A signed-out access token, held by its <c>jti</c> until its own expiry passes.
    ///
    /// <para>
    /// The durable half of <c>AccessTokenRevocationList</c>: without it a restart inside a
    /// token's fifteen-minute lifetime would resurrect every credential a member had signed
    /// out. Unlike the other kinds this row is never redeemed — <c>UsedAt</c> stays null and
    /// the row is simply spent when <c>ExpiresAt</c> passes.
    /// </para>
    /// </summary>
    RevokedAccess = 4,
}

/// <summary>
/// One-time / short-lived token. Stored hashed; the plaintext value is sent in the email
/// and never persisted. Used for email-verification, magic-link sign-in, and password reset.
/// </summary>
public sealed class AuthToken : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }

    public TokenKind Kind { get; set; }
    public required string TokenHash { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? UsedAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
