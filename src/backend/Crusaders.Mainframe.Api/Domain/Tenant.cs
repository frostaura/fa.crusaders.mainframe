namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// A tenant — a club using the platform. The first tenant is Crusaders Squash Club.
/// </summary>
public sealed class Tenant
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string Slug { get; set; }
    public required string DisplayName { get; set; }
    /// <summary>
    /// <see cref="TenantStatus.Active"/>, <see cref="TenantStatus.Onboarding"/> or
    /// <see cref="TenantStatus.Suspended"/>. Read by <c>TenantResolutionMiddleware</c>: a
    /// suspended club answers <c>403 club_suspended</c> to every tenant-scoped request, and any
    /// value this build does not know is treated as suspended (fail closed). Changed by the
    /// operator CLI (<c>tenant suspend</c> / <c>tenant activate</c>), never by a club admin.
    /// </summary>
    public string Status { get; set; } = TenantStatus.Active;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>
    /// The address this club's members use — <c>https://kestrel.frostaura.net</c> — when it is
    /// not the one derived from <c>App:PublicBaseUrl</c> (BP-03). Null for almost every club:
    /// <see cref="Services.TenantLinks"/> derives the address by putting the club's slug in the
    /// first label of the deployment's own host, which is exactly the rule
    /// <c>TenantResolutionMiddleware</c> reads a request's club by. Every verify, reset, welcome,
    /// admin-notice and PayFast-return link is built from it, so a second club's links land on
    /// the second club rather than on the first, where its one-time tokens do not exist.
    /// </summary>
    public string? PublicBaseUrl { get; set; }

    /// <summary>
    /// The single API key every court box at this club carries, as
    /// <c>Authorization: Bearer &lt;key&gt;</c>. Null until an admin generates one.
    ///
    /// <para>
    /// One key per club rather than one per device, and stored in plaintext rather than
    /// hashed, because it is a value an admin has to be able to <i>read back</i> and type
    /// into a <c>secrets.h</c> — a hashed credential can only ever be shown once, and the
    /// scheme it replaced (a per-device HMAC key derived from a master KEK, shown once at
    /// provisioning) is exactly what made a reflashed board unrecoverable without a
    /// discovery protocol, a claim code and an LCD ceremony. The club LAN, one box and a
    /// key the founder can re-read is the whole threat model; see
    /// <c>docs/specs/deployment.md</c>.
    /// </para>
    ///
    /// <para>
    /// A column rather than a key inside <c>tenant_settings.settings_json</c> for two
    /// reasons: the device scheme has to resolve key → tenant <i>before</i> a tenant is
    /// known, which wants an index rather than a scan-and-parse of every club's settings
    /// document; and the settings document is replaced wholesale by the admin settings PUT,
    /// which would silently take the key with it.
    /// </para>
    /// </summary>
    public string? DeviceApiKey { get; set; }

    /// <summary>When the key was last generated. Shown on the Devices page so an admin can
    /// tell "the box has never been flashed" from "the key was rotated this morning".</summary>
    public DateTimeOffset? DeviceApiKeyRegeneratedAt { get; set; }

    /// <summary>
    /// The id number of <see cref="DeviceApiKey"/> (device-api.md §6): the current key is
    /// <c>k&lt;DeviceApiKeyId&gt;</c>. 1 for every club that existed before key rotation; every
    /// rotation and every restore moves it on by one. <c>k0</c> is what a BOARD calls the key
    /// compiled into it and is never a server id.
    /// </summary>
    public int DeviceApiKeyId { get; set; } = 1;

    /// <summary>
    /// When the rotation now in progress started — null when the current key is the only valid
    /// one. Every key in <see cref="DevicePreviousKey"/> that is not retired is still accepted.
    /// </summary>
    public DateTimeOffset? DeviceKeyRotationStartedAt { get; set; }

    /// <summary>
    /// Set on a DEMO club only: the real club it is the demo of (one per club). A demo club is a
    /// second tenant full of made-up members that an admin switches into from the account menu
    /// (<see cref="Services.Demo.DemoModeService"/>). Null on every real club.
    ///
    /// <para>
    /// <b>Why a second tenant rather than a flag on rows.</b> Every tenant-scoped table already
    /// carries a global query filter on <c>TenantId</c>, so a session minted in the demo tenant
    /// cannot read a single real row — the isolation is the one the product already proves for two
    /// clubs, not a new one that every query would have to remember. A demo club never gets a
    /// <see cref="DeviceApiKey"/>, and the device key resolver refuses one anyway, so no box can
    /// ever talk to it.
    /// </para>
    /// </summary>
    public Guid? DemoOfTenantId { get; set; }

    /// <summary>When the demo club's made-up data was last generated, relative to which every
    /// date in it was drawn. Older than a day and the next entry regenerates it, so "today"
    /// always has a realistic past and future. Null on a real club.</summary>
    public DateTimeOffset? DemoGeneratedAt { get; set; }

    /// <summary>True for a demo club (<see cref="DemoOfTenantId"/> set).</summary>
    public bool IsDemo => DemoOfTenantId is not null;
}

/// <summary>The closed vocabulary of <see cref="Tenant.Status"/>.</summary>
public static class TenantStatus
{
    public const string Active = "active";

    /// <summary>Set up but not yet launched to members. Served exactly like an active club.</summary>
    public const string Onboarding = "onboarding";

    /// <summary>Every tenant-scoped request answers 403 <c>club_suspended</c>.</summary>
    public const string Suspended = "suspended";

    /// <summary>Whether the club's members and admins may use it. Unknown values are closed.</summary>
    public static bool IsOpen(string? status) => status is Active or Onboarding;
}

/// <summary>
/// Marker interface — entities that live "inside" a single tenant. Used by the EF query-filter wiring
/// to enforce tenant isolation.
/// </summary>
public interface ITenantScoped
{
    Guid TenantId { get; }
}

/// <summary>
/// Per-tenant configuration JSON: court_count, slice_minutes, penalty_pct,
/// grace_window_minutes, etc. See docs/specs/multi-tenancy.md.
/// </summary>
public sealed class TenantSettings : ITenantScoped
{
    public Guid TenantId { get; set; }
    public string SettingsJson { get; set; } = "{}";
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
