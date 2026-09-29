using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Claims;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// Makes a rotation end every session the member had open when it happened
/// (<c>docs/specs/member-code.md</c> §10, §13), by a per-account integer EPOCH.
///
/// <para>
/// <b>Why a rotation has to reach the sessions.</b> Rotating the member code retires every code
/// the old phone can compute — but a lost phone still holds a signed-in PWA, and that session
/// could simply call <c>/me/code/enrol</c> again and be handed the NEW generation's secret. So
/// every rotation — an admin's code reset, a password change or reset, a suspension, sign out
/// everywhere — increments <see cref="Domain.User.SessionEpoch"/>, every token carries the epoch
/// it was minted under (<see cref="EpochClaim"/>), and a token whose epoch is below the account's
/// is refused on every route, the way a revoked <c>jti</c> is.
/// </para>
///
/// <para>
/// <b>Why an epoch and not a time.</b> The first version stamped a cut-off INSTANT and refused
/// tokens minted before it. A refresh landing between the stamp and the rotation's commit read
/// no cut-off at all and minted a token dated AFTER the stamp — which then survived it, and could
/// enrol for the new secret (refuted 2026-09-28). An epoch has no such window: the rotation
/// increments it in one SQL statement that commits at once, and refresh mints with the value it
/// read only after checking the presented token's epoch against it — whichever side of the
/// increment the refresh lands on, the token it mints carries an epoch that dies with it or was
/// never old.
/// </para>
///
/// <para>
/// <b>The cost is <see cref="LiveAdminRole"/>'s, and so is the shape.</b> The account's epoch is
/// cached per <see cref="CacheFor"/> and evicted once the increment has committed, so on the
/// single backend container a rotation bites on the next request, and on any other topology
/// within the cache window. The routes that must not trust the cache — refresh, which mints a
/// token that would pass every later check, and enrolment, which hands out the secret — read
/// the row (<see cref="CurrentAsync"/>, and enrolment under a row lock).
/// A token with no epoch claim (minted before this existed) is epoch 0.
/// </para>
///
/// <para>
/// <b>A token whose subject has no account in its club is refused, not read as epoch 0.</b> The
/// lookup is by user AND tenant, and it used to fall back to 0 when it found nothing — so after
/// the local database was wiped, a browser's old token passed here and every route answered as
/// if the account existed: <c>/me/profile</c> 404, <c>/me/door</c> and the notification count 200
/// (headed walk, 2026-09-29). The same fallback admitted a real user id under ANOTHER club's
/// tenant. No account, or an account in a different club, is the most stale a session can be;
/// the answer is cached like any other (<see cref="CacheFor"/>). Nothing in the application
/// deletes a user row or re-creates one under an old id (ids are fresh GUIDs), so there is no
/// write to evict on: a row that reappears — a backup restored under a live token — is admitted
/// once the entry expires. A token with no subject or tenant is refused for the same reason.
/// </para>
/// </summary>
public sealed class SessionEpochs
{
    /// <summary>The claim carrying the epoch a token was minted under.</summary>
    public const string EpochClaim = "sep";

    /// <summary>How long one account's epoch is trusted from the cache — <see cref="LiveAdminRole.CacheFor"/>.</summary>
    public static readonly TimeSpan CacheFor = LiveAdminRole.CacheFor;

    private readonly IMemoryCache _cache;
    private readonly ConcurrentDictionary<string, long> _generations = new();

    public SessionEpochs(IMemoryCache cache)
    {
        _cache = cache;
    }

    /// <summary>The epoch the token behind <paramref name="principal"/> was minted under; 0 when it names none.</summary>
    public static int EpochOf(ClaimsPrincipal principal)
    {
        return int.TryParse(principal.FindFirst(EpochClaim)?.Value, NumberStyles.None, CultureInfo.InvariantCulture, out var epoch)
            ? epoch
            : 0;
    }

    /// <summary>The claim value for a token minted under <paramref name="epoch"/>.</summary>
    public static string Format(int epoch)
    {
        return epoch.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// True when the principal's token predates its account's epoch, or names no account in its
    /// club — the request must be refused. Cached per <see cref="CacheFor"/>; see the class remarks.
    /// </summary>
    public async Task<bool> IsStaleAsync(ClaimsPrincipal principal, IServiceProvider services, CancellationToken ct)
    {
        if (principal.Id() is not { } userId) return true;
        if (!Guid.TryParse(principal.FindFirst("tenant_id")?.Value, out var tenantId)) return true;

        // No account in the club the token names: refused, never "epoch 0" — see the class remarks.
        return await CachedAsync(tenantId, userId, services, ct) is not { } epoch || EpochOf(principal) < epoch;
    }

    /// <summary>
    /// Whether a connection that outlives its request — an SSE stream — may go on: the same
    /// question as <see cref="IsStaleAsync"/>, answered in a scope of its own.
    /// </summary>
    public async Task<bool> StillCurrentAsync(ClaimsPrincipal principal, IServiceProvider services, CancellationToken ct)
    {
        using var scope = services.GetRequiredService<IServiceScopeFactory>().CreateScope();
        return !await IsStaleAsync(principal, scope.ServiceProvider, ct);
    }

    /// <summary>The account's epoch from the row, never the cache. Null for an unknown account.</summary>
    public static async Task<int?> CurrentAsync(MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        return await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => (int?)u.SessionEpoch)
            .FirstOrDefaultAsync(ct);
    }

    /// <summary>
    /// Forgets the cached epoch for one account, so the next request re-reads it. Called once the
    /// increment has committed — see <see cref="LiveAdminRole.Invalidate"/> for why before is wrong.
    /// </summary>
    public void Invalidate(Guid tenantId, Guid userId)
    {
        var key = Key(tenantId, userId);
        _generations.AddOrUpdate(key, 1, (_, n) => n + 1);
        _cache.Remove(key);
    }

    /// <summary>The account's epoch in that club, or null when the club has no such account.</summary>
    private async Task<int?> CachedAsync(Guid tenantId, Guid userId, IServiceProvider services, CancellationToken ct)
    {
        var key = Key(tenantId, userId);
        if (_cache.TryGetValue(key, out Entry? cached) && cached is not null) return cached.Epoch;

        var generation = _generations.GetValueOrDefault(key);
        var db = services.GetRequiredService<MainframeDbContext>();
        var epoch = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => u.Id == userId && u.TenantId == tenantId)
            .Select(u => (int?)u.SessionEpoch)
            .FirstOrDefaultAsync(ct);

        if (_generations.GetValueOrDefault(key) == generation)
        {
            _cache.Set(key, new Entry(epoch), CacheFor);
            if (_generations.GetValueOrDefault(key) != generation) _cache.Remove(key);
        }
        return epoch;
    }

    /// <summary>One cached answer — boxed so "no such account" (null) is a value the cache can hold.</summary>
    private sealed record Entry(int? Epoch);

    private static string Key(Guid tenantId, Guid userId)
    {
        return "session-epoch:" + tenantId.ToString("N") + ":" + userId.ToString("N");
    }
}
