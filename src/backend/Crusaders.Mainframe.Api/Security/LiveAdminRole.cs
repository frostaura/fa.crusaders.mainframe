using System.Security.Claims;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// Makes the <c>admin</c> role on a bearer token mean "is an admin NOW", not "was an admin when
/// this token was minted".
///
/// <para>
/// <b>Why a token is not enough.</b> An access token lives fifteen minutes and carries its roles
/// inside it. Before this existed, demoting an admin changed <c>users.IsAdmin</c> and nothing
/// else: the token they already held went on opening every admin route — members, money,
/// devices, the change record — until it expired, and the refresh endpoint would have been the
/// first thing to notice. For a club removing somebody's rights because something has gone
/// wrong, a quarter of an hour of continued access is the whole incident.
/// </para>
///
/// <para>
/// <b>What it costs, and who pays.</b> Only a token that CLAIMS the admin role is checked, so a
/// member's request — the overwhelming majority — never touches the database here. An admin's
/// is answered from an in-process cache for <see cref="CacheFor"/>; the endpoint that changes
/// the role evicts the entry in the same process, so on the single backend container the
/// deployment runs a demotion bites on the very next request, and on any other topology within
/// the cache window.
/// </para>
///
/// <para>
/// <b>It only ever REMOVES the role.</b> A token that does not claim admin is never promoted by
/// a database read — a newly appointed admin gets the role from a refresh, which re-reads
/// <c>IsAdmin</c> (<see cref="Services.AuthService.RefreshAsync"/>). Granting authority on a
/// cache lookup would make this a second place roles come from; removing it only narrows what
/// the signed token already said.
/// </para>
/// </summary>
public sealed class LiveAdminRole
{
    /// <summary>The role this guards. The string every <c>RequireRole</c> in the API names.</summary>
    public const string AdminRole = "admin";

    /// <summary>
    /// How long one answer is trusted. Short enough that a demotion made on another instance —
    /// or by hand in the database — bites within seconds; long enough that an admin clicking
    /// through the console costs one read per quarter-minute rather than one per request.
    /// </summary>
    public static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(15);

    private readonly IMemoryCache _cache;

    public LiveAdminRole(IMemoryCache cache)
    {
        _cache = cache;
    }

    /// <summary>
    /// Strips the admin role from <paramref name="principal"/> unless the account still holds it.
    /// A no-op, with no database read, for a principal that never claimed it.
    /// </summary>
    public async Task EnforceAsync(ClaimsPrincipal principal, IServiceProvider services, CancellationToken ct)
    {
        if (!principal.IsInRole(AdminRole)) return;

        var userId = principal.Id();
        var tenantClaim = principal.FindFirst("tenant_id")?.Value;
        var holds = userId is { } id
            && Guid.TryParse(tenantClaim, out var tenantId)
            && await HoldsAsync(tenantId, id, services, ct);

        if (!holds) Strip(principal);
    }

    /// <summary>
    /// Forgets the cached answer for one account, so the next request re-reads it. Called by
    /// whatever changes <c>IsAdmin</c>, after its transaction has committed — evicting before the
    /// commit would let a request in between cache the OLD answer for another fifteen seconds.
    /// </summary>
    public void Invalidate(Guid tenantId, Guid userId)
    {
        _cache.Remove(Key(tenantId, userId));
    }

    /// <summary>
    /// Whether the account is an active admin in the club its token names. Tenant filters are
    /// off because this runs before tenant resolution, so the tenant is matched explicitly: a
    /// user id is only an admin in the club the token was minted for.
    /// </summary>
    private async Task<bool> HoldsAsync(Guid tenantId, Guid userId, IServiceProvider services, CancellationToken ct)
    {
        var key = Key(tenantId, userId);
        if (_cache.TryGetValue(key, out bool cached)) return cached;

        var db = services.GetRequiredService<MainframeDbContext>();
        var holds = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .AnyAsync(u => u.Id == userId && u.TenantId == tenantId && u.IsAdmin && u.Status == "active", ct);

        _cache.Set(key, holds, CacheFor);
        return holds;
    }

    /// <summary>
    /// Removes every admin role claim, under whichever claim type carried it. The bearer handler
    /// maps <c>role</c> to <see cref="ClaimTypes.Role"/> today; checking both means a change to
    /// that mapping cannot silently leave the claim in place.
    /// </summary>
    private static void Strip(ClaimsPrincipal principal)
    {
        foreach (var identity in principal.Identities)
        {
            var roleClaims = identity.Claims
                .Where(c => c.Value == AdminRole
                            && (c.Type == identity.RoleClaimType || c.Type == ClaimTypes.Role || c.Type == "role"))
                .ToList();
            foreach (var claim in roleClaims) identity.TryRemoveClaim(claim);
        }
    }

    private static string Key(Guid tenantId, Guid userId)
    {
        return "live-admin:" + tenantId.ToString("N") + ":" + userId.ToString("N");
    }
}
