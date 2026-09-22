using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// Which club the request is acting for, in the form an email needs it.
/// </summary>
/// <remarks>
/// <para>
/// <b>One place, because there were three and they disagreed.</b> The club's name reached a
/// template from <c>MemberApprovalService</c>'s own private query, from
/// <c>PeripheralHealthWorker</c>'s <c>health.Tenant.DisplayName</c>, from a
/// <c>tenant?.DisplayName ?? "Crusaders Mainframe"</c> fallback inside
/// <c>BookingService</c> — and, on the eleven templates that took no club at all, from a
/// literal baked into the markup. A club's own name is not the kind of fact that should have
/// four sources.
/// </para>
/// <para>
/// The contact pair comes from <c>tenant_settings</c>, so a club that has set neither gets an
/// identity with neither and a footer that says nothing about how to reach them — rather than
/// an invented number, which is the rule the settings record states about these two fields and
/// the sign-in screen already keeps.
/// </para>
/// <para>
/// Scoped and memoised per scope. Every email path already holds a scope, and a background
/// worker opens one per tenant it sweeps, so the lookup happens once per club per pass rather
/// than once per message — which matters on the sweep that mails every admin in the club.
/// </para>
/// </remarks>
public sealed class ClubIdentityResolver
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly TenantSettingsAccessor _settings;
    private ClubIdentity? _cached;

    public ClubIdentityResolver(MainframeDbContext db, ITenantContext tenant, TenantSettingsAccessor settings)
    {
        _db = db;
        _tenant = tenant;
        _settings = settings;
    }

    /// <summary>
    /// The current tenant's identity.
    /// </summary>
    /// <remarks>
    /// <c>IgnoreQueryFilters</c> on the tenant row itself, matching the lookup this replaced:
    /// <c>Tenants</c> is the table the filter is derived from, so reading it through the filter
    /// is circular.
    /// </remarks>
    public async Task<ClubIdentity> GetAsync(CancellationToken ct)
    {
        if (_cached is not null) return _cached;

        var name = await _db.Tenants.IgnoreQueryFilters()
            .Where(t => t.Id == _tenant.TenantId)
            .Select(t => t.DisplayName)
            .FirstOrDefaultAsync(ct);

        var settings = await _settings.GetAsync(ct);
        _cached = Build(name, settings);
        return _cached;
    }

    /// <summary>
    /// The identity for a tenant already in hand — the shape the sweeps need, which walk every
    /// tenant in one pass and have the row before they have a scope.
    /// </summary>
    public static ClubIdentity For(Domain.Tenant tenant, TenantSettingsView settings) =>
        Build(tenant.DisplayName, settings);

    /// <summary>
    /// <b>The name is never invented.</b> A tenant row with no display name is a broken row,
    /// and the honest rendering of one is the word "the club" — which is what the product's own
    /// copy calls the institution when it has no name to use. The alternative, and what this
    /// replaced, was a hardcoded "Crusaders Mainframe" that told every other club it was
    /// Crusaders.
    /// </summary>
    private static ClubIdentity Build(string? displayName, TenantSettingsView settings)
    {
        var name = string.IsNullOrWhiteSpace(displayName) ? "the club" : displayName.Trim();
        return new ClubIdentity(name, settings.ClubContactPhone.Trim(), settings.ClubContactEmail.Trim());
    }
}
