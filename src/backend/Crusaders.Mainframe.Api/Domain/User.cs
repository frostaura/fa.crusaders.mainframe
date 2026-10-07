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
    public string Status { get; set; } = "active"; // active | suspended | deleted — see Services.UserStatuses

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

    /// <summary>
    /// Set on a demo club's MIRROR admin only: the real admin, in the real club, this account
    /// stands in for. The mirror has no password, a non-routable address and no passkey — it is
    /// reachable only through the mode switch, and switching back hands a session to exactly this
    /// user and nobody else (<see cref="Services.Demo.DemoModeService"/>).
    /// </summary>
    public Guid? DemoSourceUserId { get; set; }

    /// <summary>
    /// The real admin's <see cref="SessionEpoch"/> when they last entered the demo. Switching back
    /// is refused once the real account's epoch has moved past it — a "sign out everywhere", a
    /// password change or a suspension in the real club also ends the way back from the demo.
    /// </summary>
    public int? DemoSourceEpoch { get; set; }

    /// <summary>
    /// Set on a demo club's <b>member-view persona</b>: the second account each real admin has in
    /// the demo, a plain member (never an admin) the admin can flip to so they test what a member
    /// sees. It names the same real admin as the mirror admin does (<see cref="DemoSourceUserId"/>),
    /// so the way back is the same and the one-of-each-per-admin index is on the pair.
    /// </summary>
    public bool DemoMemberView { get; set; }

    public Membership? Membership { get; set; }
}
