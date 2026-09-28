namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// A user — a person within a tenant. The same human at two clubs has two User rows.
/// Platform admins have <see cref="IsPlatformAdmin"/> true and are not tenant-scoped.
/// </summary>
public sealed class User : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    public required string Email { get; set; }
    public string? PasswordHash { get; set; }
    public string? PinHash { get; set; }
    public bool EmailVerified { get; set; }

    /// <summary>
    /// True while the account's current password was issued by somebody other than its owner —
    /// today that means an admin-generated temporary password.
    ///
    /// <para>
    /// The spec calls the temporary password "single-use" and says it "forces a password reset on
    /// first use". Before this flag existed neither was true: the temporary password was simply the
    /// account's password, indefinitely, and it had been emailed in plaintext and shown on an
    /// admin's screen. Advice — the reset response literally returned <c>"They should change it on
    /// first login."</c> — is not enforcement.
    /// </para>
    ///
    /// <para>
    /// While this is set, <c>PasswordChangeGate</c> refuses every authenticated request except the
    /// handful needed to change the password, so the session is genuinely good for nothing else.
    /// <c>POST /api/v1/me/password</c> clears it, which is also the moment the temporary password
    /// stops working — it has been replaced.
    /// </para>
    /// </summary>
    public bool MustChangePassword { get; set; }

    public bool IsAdmin { get; set; }
    public bool IsPlatformAdmin { get; set; }
    public string Status { get; set; } = "active"; // active | suspended

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? LastLoginAt { get; set; }

    /// <summary>
    /// The account's session epoch (member-code §10, §13): every token carries the epoch it was
    /// minted under, and one below this is refused. Incremented — in SQL, atomically — by each
    /// rotation: an admin's code reset, a password change or reset, an admin temporary password,
    /// a suspension, sign out everywhere. So a lost phone's open session cannot simply re-enrol
    /// and fetch the new secret. See <see cref="Security.SessionEpochs"/>.
    /// </summary>
    public int SessionEpoch { get; set; }

    public Membership? Membership { get; set; }
}
