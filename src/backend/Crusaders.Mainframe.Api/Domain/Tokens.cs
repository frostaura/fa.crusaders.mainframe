namespace Crusaders.Mainframe.Api.Domain;

public enum TokenKind
{
    EmailVerification = 0,
    MagicLink = 1,
    PasswordReset = 2,
    AdminTempPassword = 3,
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
