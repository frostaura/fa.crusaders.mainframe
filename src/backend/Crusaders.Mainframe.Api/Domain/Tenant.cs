namespace Crusaders.Mainframe.Api.Domain;

/// <summary>
/// A tenant — a club using the platform. The first tenant is Crusaders Squash Club.
/// </summary>
public sealed class Tenant
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string Slug { get; set; }
    public required string DisplayName { get; set; }
    public string Status { get; set; } = "active"; // active | suspended | onboarding
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

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
