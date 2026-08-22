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
/// Per-tenant configuration JSON: court_count, slice_minutes, slice_price_credits, penalty_pct,
/// grace_window_minutes, etc. See docs/specs/multi-tenancy.md.
/// </summary>
public sealed class TenantSettings : ITenantScoped
{
    public Guid TenantId { get; set; }
    public string SettingsJson { get; set; } = "{}";
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
