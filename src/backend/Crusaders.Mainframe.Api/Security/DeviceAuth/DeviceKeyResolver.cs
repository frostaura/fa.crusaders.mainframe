using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Security.DeviceAuth;

/// <summary>
/// Turns a bearer key into the club that owns it, and sets the tenant context.
///
/// <para>
/// <b>Setting the tenant is the load-bearing part</b>, not an afterthought. The device
/// endpoints sit on a path prefix the tenant middleware skips, so nothing else on that
/// path ever calls <c>Set</c>: without this line <c>TenantId</c> stays
/// <c>Guid.Empty</c>, every global query filter matches nothing, and any row a device
/// wrote would land orphaned at the empty tenant — invisible to every query and to the
/// balance sum. A device scheme that authenticated but left the tenant unset would
/// reproduce that bug exactly.
/// </para>
///
/// <para>
/// The match is a linear pass over the clubs that have a key, with a constant-time
/// comparison per row and no early exit on a hit, rather than a <c>WHERE
/// device_api_key = …</c> lookup. It costs one small query per device request — a box
/// calls once a minute — and it keeps the comparison in code where it can be seen to be
/// constant-time, instead of in an index whose timing is the database's business.
/// Nothing is cached: regenerating a key has to invalidate the old one <i>immediately</i>,
/// and a cache with any lifetime at all is a window in which a rotated-away key still works.
/// </para>
/// </summary>
public sealed class DeviceKeyResolver
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;

    public DeviceKeyResolver(MainframeDbContext db, ITenantContext tenant)
    {
        _db = db;
        _tenant = tenant;
    }

    /// <summary>
    /// The club whose device key this is, with the tenant context set to it — or null.
    /// The caller learns nothing about <i>why</i> a key failed; that is for the log.
    /// </summary>
    public async Task<Tenant?> ResolveAsync(string key, CancellationToken ct = default)
    {
        var candidates = await _db.Tenants
            .Where(t => t.DeviceApiKey != null)
            .OrderBy(t => t.Id)
            .ToListAsync(ct);

        Tenant? matched = null;
        foreach (var candidate in candidates)
        {
            // No `break`: a short-circuit here would make the number of comparisons — and
            // so the response time — depend on which club matched.
            if (DeviceApiKey.Matches(candidate.DeviceApiKey, key)) matched = candidate;
        }

        if (matched is null) return null;

        _tenant.Set(matched.Id, matched.Slug);
        return matched;
    }
}
