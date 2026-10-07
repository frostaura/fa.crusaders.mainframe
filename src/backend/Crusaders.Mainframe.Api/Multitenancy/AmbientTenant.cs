namespace Crusaders.Mainframe.Api.Multitenancy;

/// <summary>
/// The club the running flow acts for, readable from singletons that hold no tenant.
///
/// <para>
/// Raised by <see cref="TenantContext.Set"/>, so it flows with the execution context exactly as
/// <see cref="Services.Demo.DemoTenants.Active"/> does. The email outbox records it so a mail that
/// finally fails can tell the right club's administrators; nothing may use it to decide access.
/// </para>
/// </summary>
public static class AmbientTenant
{
    private static readonly AsyncLocal<Guid> Current = new();

    /// <summary>The club the flow last chose, or null when none has been.</summary>
    public static Guid? Id => Current.Value == Guid.Empty ? null : Current.Value;

    public static void Enter(Guid tenantId) => Current.Value = tenantId;
}
