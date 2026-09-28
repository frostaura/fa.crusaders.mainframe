using System.Collections.Concurrent;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// Makes a rotation end every session the member had open when it happened
/// (<c>docs/specs/member-code.md</c> §10, §13).
///
/// <para>
/// <b>Why a rotation has to reach the sessions.</b> Rotating the member code retires every code
/// the old phone can compute — but a lost phone still holds a signed-in PWA, and that session
/// could simply call <c>/me/code/enrol</c> again and be handed the NEW generation's secret. The
/// desk's "I lost my phone" button then changed nothing. So every rotation — an admin's code
/// reset, a password change or reset, a suspension, sign-out-everywhere — stamps
/// <see cref="Domain.User.SessionsValidAfter"/>, and a token issued before that instant is
/// refused here, on every route, the way a revoked <c>jti</c> is.
/// </para>
///
/// <para>
/// <b>The cost is <see cref="LiveAdminRole"/>'s, and so is the shape.</b> The instant is read
/// once per account per <see cref="CacheFor"/> from an in-process cache; the rotation evicts the
/// entry after its transaction commits, so on the single backend container the deployment runs a
/// rotation bites on the very next request, and on any other topology within the cache window.
/// The generation counter closes the same read-in-flight race <see cref="LiveAdminRole"/>
/// documents. <b>The two routes that can outlive the window uncached — refresh, which re-mints a
/// token that would pass forever, and enrolment, which hands out the secret — read the column
/// directly</b> (<see cref="IsCutOffNowAsync"/>).
/// </para>
///
/// <para>
/// <b>Issued-at is milliseconds.</b> JWT's <c>iat</c>/<c>nbf</c> are whole seconds, and a
/// password change re-issues the caller's own token in the same second it stamps the cut-off:
/// judged in seconds the fresh token would be refused. Every token this server mints carries
/// <see cref="IssuedAtMsClaim"/>; one without it (minted before this existed) is judged by its
/// <c>nbf</c>, which can only make it look OLDER — the safe direction.
/// </para>
/// </summary>
public sealed class SessionCutoff
{
    /// <summary>The claim carrying the instant a token was minted, Unix milliseconds.</summary>
    public const string IssuedAtMsClaim = "iat_ms";

    /// <summary>How long one account's cut-off is trusted from the cache — <see cref="LiveAdminRole.CacheFor"/>.</summary>
    public static readonly TimeSpan CacheFor = LiveAdminRole.CacheFor;

    private readonly IMemoryCache _cache;
    private readonly ConcurrentDictionary<string, long> _generations = new();

    public SessionCutoff(IMemoryCache cache)
    {
        _cache = cache;
    }

    /// <summary>
    /// The cut-off instant to stamp for a rotation happening now: whole milliseconds, because that
    /// is what <see cref="IssuedAtMsClaim"/> can say, so a token minted after the stamp can never
    /// read as minted before it.
    /// </summary>
    public static DateTimeOffset StampNow() =>
        DateTimeOffset.FromUnixTimeMilliseconds(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    /// <summary>When the token behind <paramref name="principal"/> was minted, or null when it says nothing usable.</summary>
    public static DateTimeOffset? IssuedAt(ClaimsPrincipal principal)
    {
        if (long.TryParse(principal.FindFirst(IssuedAtMsClaim)?.Value, out var ms)) return DateTimeOffset.FromUnixTimeMilliseconds(ms);
        var nbf = principal.FindFirst(JwtRegisteredClaimNames.Nbf)?.Value ?? principal.FindFirst("nbf")?.Value;
        if (long.TryParse(nbf, out var seconds)) return DateTimeOffset.FromUnixTimeSeconds(seconds);
        var iat = principal.FindFirst(JwtRegisteredClaimNames.Iat)?.Value;
        return long.TryParse(iat, out var iatSeconds) ? DateTimeOffset.FromUnixTimeSeconds(iatSeconds) : null;
    }

    /// <summary>Whether a token minted at <paramref name="issuedAt"/> predates <paramref name="validAfter"/>. A token that cannot say when it was minted predates any cut-off.</summary>
    public static bool Predates(DateTimeOffset? issuedAt, DateTimeOffset? validAfter) =>
        validAfter is { } cut && (issuedAt is not { } at || at < cut);

    /// <summary>
    /// True when the principal's token was minted before its account's cut-off — the request must
    /// be refused. Cached per <see cref="CacheFor"/>; see the class remarks.
    /// </summary>
    public async Task<bool> IsCutOffAsync(ClaimsPrincipal principal, IServiceProvider services, CancellationToken ct)
    {
        if (principal.Id() is not { } userId) return false;
        if (!Guid.TryParse(principal.FindFirst("tenant_id")?.Value, out var tenantId)) return false;

        var validAfter = await ValidAfterAsync(tenantId, userId, services, ct);
        return Predates(IssuedAt(principal), validAfter);
    }

    /// <summary>The same question answered from the database, never the cache — for refresh and enrolment.</summary>
    public static async Task<bool> IsCutOffNowAsync(MainframeDbContext db, ClaimsPrincipal principal, CancellationToken ct)
    {
        if (principal.Id() is not { } userId) return false;
        var validAfter = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => u.SessionsValidAfter)
            .FirstOrDefaultAsync(ct);
        return Predates(IssuedAt(principal), validAfter);
    }

    /// <summary>
    /// Forgets the cached instant for one account, so the next request re-reads it. Call AFTER the
    /// rotation commits — see <see cref="LiveAdminRole.Invalidate"/> for why before is wrong.
    /// </summary>
    public void Invalidate(Guid tenantId, Guid userId)
    {
        var key = Key(tenantId, userId);
        _generations.AddOrUpdate(key, 1, (_, n) => n + 1);
        _cache.Remove(key);
    }

    private async Task<DateTimeOffset?> ValidAfterAsync(Guid tenantId, Guid userId, IServiceProvider services, CancellationToken ct)
    {
        var key = Key(tenantId, userId);
        if (_cache.TryGetValue(key, out DateTimeOffset? cached)) return cached;

        var generation = _generations.GetValueOrDefault(key);
        var db = services.GetRequiredService<MainframeDbContext>();
        var validAfter = await db.Users.IgnoreQueryFilters().AsNoTracking()
            .Where(u => u.Id == userId && u.TenantId == tenantId)
            .Select(u => u.SessionsValidAfter)
            .FirstOrDefaultAsync(ct);

        if (_generations.GetValueOrDefault(key) == generation)
        {
            _cache.Set(key, validAfter, CacheFor);
            if (_generations.GetValueOrDefault(key) != generation) _cache.Remove(key);
        }
        return validAfter;
    }

    private static string Key(Guid tenantId, Guid userId) =>
        "session-cutoff:" + tenantId.ToString("N") + ":" + userId.ToString("N");
}
