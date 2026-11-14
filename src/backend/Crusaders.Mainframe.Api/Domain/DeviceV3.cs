namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// A club device key that is no longer the current one but may still be accepted
/// (device-api.md §6). A rotation moves the current key here and mints a new one; every row
/// with no <see cref="RetiredAt"/> still authenticates a board, which is what lets a board that
/// has not yet heard <c>key_next</c> keep calling in. Retiring stamps <see cref="RetiredAt"/>;
/// the row is kept so the console can say which key a board is still holding.
/// </summary>
/// <remarks>
/// The key is stored as the bearer token itself, exactly as <see cref="Tenant.DeviceApiKey"/>
/// is: a board presents it on every request in plain HTTP on the club LAN and the server has to
/// compare it in constant time. v3 changes how a key is replaced, not the threat model.
/// </remarks>
public sealed class DevicePreviousKey : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    /// <summary>The key's id number: this row is <c>k&lt;KeyId&gt;</c>.</summary>
    public int KeyId { get; set; }

    /// <summary>The bearer key.</summary>
    public required string Key { get; set; }

    /// <summary>When it stopped being the current key.</summary>
    public DateTimeOffset SupersededAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>When it stopped authenticating anything; null while it still does.</summary>
    public DateTimeOffset? RetiredAt { get; set; }

    /// <summary>Who retired it; <see cref="Guid.Empty"/> for the automatic retirement after the grace window.</summary>
    public Guid? RetiredByUserId { get; set; }
}

/// <summary>
/// The club's device network (device-api.md §8): up to two WiFi profiles and the server base URL
/// every board dials, versioned so a board can say which one it applied. One row per club.
/// </summary>
/// <remarks>
/// Passwords are write-only: stored encrypted (<see cref="Services.DeviceNetworkCipher"/>),
/// never returned by a read, never logged. They leave the server only inside the heartbeat's
/// <c>net</c> object, to an authenticated board of the same club, which is the one party that
/// needs them in the clear.
/// </remarks>
public sealed class DeviceNetwork : ITenantScoped
{
    public Guid TenantId { get; set; }

    /// <summary>Increments on every save; 0 is never a saved version (it is a board's compiled defaults).</summary>
    public int Version { get; set; }

    /// <summary><c>http://host[:port]</c>, or null to leave every board's base URL as it is.</summary>
    public string? BaseUrl { get; set; }

    public string? Wifi0Ssid { get; set; }
    public string? Wifi0PskCipher { get; set; }
    public string? Wifi1Ssid { get; set; }
    public string? Wifi1PskCipher { get; set; }

    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public Guid? UpdatedByUserId { get; set; }
}
