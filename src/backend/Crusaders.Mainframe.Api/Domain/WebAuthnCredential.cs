namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// A WebAuthn (passkey) credential bound to a user. Each user may have many — one per
/// device/authenticator. The CredentialId is the opaque identifier returned by the
/// authenticator and used both as the lookup key and to populate allowCredentials lists
/// (we use discoverable credentials so allowCredentials is generally empty).
/// </summary>
public sealed class WebAuthnCredential : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }

    /// <summary>Opaque credential id from the authenticator.</summary>
    public required byte[] CredentialId { get; set; }

    /// <summary>COSE-encoded public key bytes returned during registration.</summary>
    public required byte[] PublicKey { get; set; }

    /// <summary>Random user handle bound to this credential — needed for discoverable credentials.</summary>
    public required byte[] UserHandle { get; set; }

    /// <summary>Monotonic counter — bumped on each assertion. Replay protection. Stored as bigint so
    /// PostgreSQL is happy; the WebAuthn spec defines this as uint32.</summary>
    public long SignCount { get; set; }

    /// <summary>Authenticator AAGUID — useful for surfacing the device kind.</summary>
    public Guid AaGuid { get; set; }

    /// <summary>CSV of transports advertised by the authenticator (usb,nfc,ble,internal,hybrid).</summary>
    public string? Transports { get; set; }

    /// <summary>User-visible label so they can tell their devices apart in settings.</summary>
    public string Label { get; set; } = "Passkey";

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? LastUsedAt { get; set; }
}
