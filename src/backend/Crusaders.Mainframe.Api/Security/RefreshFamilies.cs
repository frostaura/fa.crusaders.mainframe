using System.Collections.Concurrent;
using System.Security.Claims;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// Refuses, on EVERY route, a bearer whose refresh family has been ended (review round 2, C1
/// tightened): sign-out, a replay, a refused exchange, sign out everywhere — the way
/// <see cref="SessionEpochs"/> refuses a token below the account's epoch.
///
/// <para>
/// <b>Why every route and not only refresh.</b> Refusing the refresh stopped a signed-out
/// session being resurrected, but a bearer from the ended family — another tab's, or the one a
/// refresh racing the sign-out minted a moment after it — still opened the wallet and the code for
/// up to fifteen minutes. Sign-out must end the session within seconds everywhere.
/// </para>
///
/// <para>
/// <b>The cost is <see cref="SessionEpochs"/>'s, and so is the shape</b>: one answer per family
/// cached for <see cref="SessionEpochs.CacheFor"/> and evicted by the revoke itself
/// (<see cref="RefreshSessions"/>), with a generation counter so a read racing the eviction cannot
/// re-cache the old answer. A token naming no family (minted before C1) is never refused here.
/// Ended = any link of the family revoked (every revocation stamps every live link), or no such
/// family in the token's club.
/// </para>
/// </summary>
public sealed class RefreshFamilies
{
    private readonly IMemoryCache _cache;
    private readonly ConcurrentDictionary<string, long> _generations = new();

    public RefreshFamilies(IMemoryCache cache)
    {
        _cache = cache;
    }

    /// <summary>True when the principal's token names a family that has been ended — the request must be refused.</summary>
    public async Task<bool> IsEndedAsync(ClaimsPrincipal principal, IServiceProvider services, CancellationToken ct)
    {
        if (RefreshSessions.FamilyOf(principal) is not { } family) return false;
        if (!Guid.TryParse(principal.FindFirst("tenant_id")?.Value, out var tenantId)) return true;

        var key = Key(tenantId, family);
        if (_cache.TryGetValue(key, out bool ended)) return ended;

        var generation = _generations.GetValueOrDefault(key);
        var db = services.GetRequiredService<MainframeDbContext>();
        var links = db.RefreshTokens.IgnoreQueryFilters().AsNoTracking().Where(t => t.TenantId == tenantId && t.FamilyId == family);
        ended = !await links.AnyAsync(ct) || await links.AnyAsync(t => t.RevokedAt != null, ct);

        if (_generations.GetValueOrDefault(key) == generation)
        {
            _cache.Set(key, ended, SessionEpochs.CacheFor);
            if (_generations.GetValueOrDefault(key) != generation) _cache.Remove(key);
        }
        return ended;
    }

    /// <summary>Forgets one family's answer, so its next request re-reads it. Called once the revoke has committed.</summary>
    public void Invalidate(Guid tenantId, Guid familyId)
    {
        var key = Key(tenantId, familyId);
        _generations.AddOrUpdate(key, 1, (_, n) => n + 1);
        _cache.Remove(key);
    }

    private static string Key(Guid tenantId, Guid familyId)
    {
        return "refresh-family:" + tenantId.ToString("N") + ":" + familyId.ToString("N");
    }
}
