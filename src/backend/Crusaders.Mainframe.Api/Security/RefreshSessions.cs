using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// The long-lived half of a session (review round 1, B1): an opaque, rotating, single-use
/// refresh token carried in the httpOnly <see cref="CookieName"/> cookie.
///
/// <para>
/// <b>Why it exists.</b> The access token lives fifteen minutes and refresh used to need a
/// still-valid one, so a phone left idle for a quarter of an hour — at the door, typically — was
/// signed out. The cookie outlives the access token (sliding <see cref="Lifetime"/>) and is
/// exchanged at <c>POST /api/v1/auth/refresh</c> for a new access token and a new cookie.
/// </para>
///
/// <para>
/// <b>What keeps it safe.</b>
/// <list type="bullet">
/// <item>Stored as SHA-256 only (<see cref="RefreshToken.TokenHash"/>); 256 random bits each.</item>
/// <item>Single use: the exchange claims the row with a conditional UPDATE (<c>UsedAt IS NULL AND
/// RevokedAt IS NULL</c>), so two presentations of one link cannot both mint.</item>
/// <item>Replay detection: a SPENT link presented again revokes its whole family — whoever holds
/// the stolen copy and whoever holds the real one both have to sign in again. One exception, and it
/// mints nothing: a spent link presented within <see cref="ReuseGrace"/> of being spent is refused
/// WITHOUT revoking (two tabs of one PWA waking together must not sign the member out).</item>
/// <item>Epoch-bound: each link records the <see cref="User.SessionEpoch"/> it was issued under and
/// the exchange refuses one below the account's (password change or reset, suspension, sign out
/// everywhere, the desk's code reset). <see cref="RevokeUserAsync"/> also stamps every live link
/// revoked when the epoch is raised, so the table says what happened.</item>
/// <item>Tenant-scoped: a link is accepted only in the club that issued it.</item>
/// <item>Cookie: <c>HttpOnly</c>, <c>SameSite=Strict</c>, <c>Secure</c> outside Development, and
/// <c>Path=/api/v1/auth</c> so it travels on nothing but the auth routes.</item>
/// </list>
/// </para>
///
/// <para>
/// <b>CSRF.</b> The cookie is read on exactly two routes. <c>POST /auth/refresh</c> changes no
/// state a forger benefits from: it mints an access token into the RESPONSE BODY, which a
/// cross-site page cannot read (no CORS grant for a foreign origin, and SameSite=Strict keeps the
/// cookie off a cross-site request in the first place). <c>POST /auth/logout</c> can only end the
/// session — a forced sign-out is the worst a forger gets, and SameSite=Strict blocks that too. No
/// other route reads it; every other route authenticates by bearer only.
/// </para>
/// </summary>
public sealed class RefreshSessions
{
    public const string CookieName = "crusaders_rt";

    /// <summary>
    /// The access-token claim naming the refresh family the token was minted from (review round 2,
    /// C1). <b>Why:</b> a sign-out in one tab revoked the family, and a second tab still holding a
    /// live bearer refreshed with it — the bearer path minted, found no cookie, and STARTED A NEW
    /// FAMILY, resurrecting the session the member had just ended. A bearer whose family is ended
    /// is now refused at refresh (<c>401 session_ended</c>).
    /// </summary>
    public const string FamilyClaim = "rfid";
    public const string CookiePath = "/api/v1/auth";

    /// <summary>How long a spent link is refused quietly (no family revocation) — a concurrent tab, not a thief.</summary>
    public static readonly TimeSpan ReuseGrace = TimeSpan.FromSeconds(10);

    private readonly MainframeDbContext _db;
    private readonly TimeProvider _clock;
    private readonly IHostEnvironment _env;

    public RefreshSessions(MainframeDbContext db, TimeProvider clock, IConfiguration config, IHostEnvironment env)
    {
        _db = db;
        _clock = clock;
        _env = env;
        Lifetime = TimeSpan.FromDays(Math.Clamp(config.GetValue("Jwt:RefreshTokenLifetimeDays", 30), 1, 90));
    }

    /// <summary>Sliding lifetime of one link (<c>Jwt:RefreshTokenLifetimeDays</c>, 30, 1–90).</summary>
    public TimeSpan Lifetime { get; }

    /// <summary>Issues a new link — a new family when <paramref name="familyId"/> is null — and saves it.</summary>
    public async Task<IssuedRefresh> IssueAsync(Guid tenantId, Guid userId, int sessionEpoch, Guid? familyId, CancellationToken ct)
    {
        var plaintext = TokenHashing.Generate();
        var now = _clock.GetUtcNow();
        var row = new RefreshToken
        {
            TenantId = tenantId,
            UserId = userId,
            FamilyId = familyId ?? Guid.NewGuid(),
            TokenHash = TokenHashing.Hash(plaintext),
            SessionEpoch = sessionEpoch,
            IssuedAt = now,
            ExpiresAt = now.Add(Lifetime),
        };
        _db.RefreshTokens.Add(row);
        await _db.SaveChangesAsync(ct);
        return new IssuedRefresh(plaintext, row.ExpiresAt, row.FamilyId);
    }

    /// <summary>
    /// Spends the presented link, or says why not. Only <see cref="RefreshClaim.Claimed"/> may mint.
    /// A replay revokes the family before this returns.
    /// </summary>
    public async Task<RefreshClaim> ClaimAsync(string? plaintext, Guid tenantId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(plaintext) || plaintext.Length > 256) return new RefreshClaim.Unknown();

        var hash = TokenHashing.Hash(plaintext);
        var row = await _db.RefreshTokens.IgnoreQueryFilters().AsNoTracking()
            .FirstOrDefaultAsync(t => t.TokenHash == hash, ct);

        // Another club's link is not this club's business: unknown here, and its family untouched.
        if (row is null || row.TenantId != tenantId) return new RefreshClaim.Unknown();

        var now = _clock.GetUtcNow();
        if (row.RevokedAt is not null) return new RefreshClaim.Revoked();
        if (row.UsedAt is { } usedAt) return await ReplayAsync(row, usedAt, now, ct);
        if (row.ExpiresAt <= now) return new RefreshClaim.Expired();

        if (!await TrySpendAsync(row.Id, now, ct))
        {
            // Lost a race to another presentation of the same link inside this instant: the
            // winner minted; this one is a concurrent tab, not a thief.
            return new RefreshClaim.Superseded();
        }
        return new RefreshClaim.Claimed(row);
    }

    private async Task<RefreshClaim> ReplayAsync(RefreshToken row, DateTimeOffset usedAt, DateTimeOffset now, CancellationToken ct)
    {
        if (now - usedAt <= ReuseGrace) return new RefreshClaim.Superseded();
        await RevokeFamilyAsync(row.TenantId, row.FamilyId, ct);
        return new RefreshClaim.Replayed();
    }

    private async Task<bool> TrySpendAsync(Guid id, DateTimeOffset now, CancellationToken ct)
    {
        if (_db.Database.IsRelational())
        {
            var spent = await _db.RefreshTokens.IgnoreQueryFilters()
                .Where(t => t.Id == id && t.UsedAt == null && t.RevokedAt == null)
                .ExecuteUpdateAsync(s => s.SetProperty(t => t.UsedAt, now), ct);
            return spent == 1;
        }

        var tracked = await _db.RefreshTokens.IgnoreQueryFilters().FirstAsync(t => t.Id == id, ct);
        if (tracked.UsedAt is not null || tracked.RevokedAt is not null) return false;
        tracked.UsedAt = now;
        await _db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>Revokes every live link of one family — sign-out, or a replay in it.</summary>
    public async Task RevokeFamilyAsync(Guid tenantId, Guid familyId, CancellationToken ct)
    {
        var now = _clock.GetUtcNow();
        await RevokeWhereAsync(_db.RefreshTokens.IgnoreQueryFilters()
            .Where(t => t.TenantId == tenantId && t.FamilyId == familyId && t.RevokedAt == null), now, ct);
    }

    /// <summary>Revokes every live link the account holds — called on every session-epoch raise.</summary>
    public async Task RevokeUserAsync(Guid tenantId, Guid userId, CancellationToken ct)
    {
        var now = _clock.GetUtcNow();
        await RevokeWhereAsync(_db.RefreshTokens.IgnoreQueryFilters()
            .Where(t => t.TenantId == tenantId && t.UserId == userId && t.RevokedAt == null), now, ct);
    }

    /// <summary>The refresh family the bearer behind <paramref name="principal"/> was minted from; null for a token that names none.</summary>
    public static Guid? FamilyOf(System.Security.Claims.ClaimsPrincipal principal)
    {
        return Guid.TryParse(principal.FindFirst(FamilyClaim)?.Value, out var family) ? family : null;
    }

    /// <summary>
    /// Whether a family may still mint in this club: it exists here, no link of it was revoked
    /// (sign-out, a replay, an epoch raise and a refused exchange all stamp EVERY link), and one of
    /// its links is unexpired. Keyed on revocation rather than on "an unspent link exists", because
    /// a rotation spends the old link a moment before its successor is written and a bearer refresh
    /// landing between the two must not read the family as ended.
    /// </summary>
    public async Task<bool> IsFamilyLiveAsync(Guid tenantId, Guid familyId, CancellationToken ct)
    {
        var now = _clock.GetUtcNow();
        var links = _db.RefreshTokens.IgnoreQueryFilters().AsNoTracking().Where(t => t.TenantId == tenantId && t.FamilyId == familyId);
        return !await links.AnyAsync(t => t.RevokedAt != null, ct) && await links.AnyAsync(t => t.ExpiresAt > now, ct);
    }

    /// <summary>The family a presented link belongs to, in this club — for sign-out. Null when unknown.</summary>
    public async Task<Guid?> FamilyOfAsync(string? plaintext, Guid tenantId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(plaintext) || plaintext.Length > 256) return null;
        var hash = TokenHashing.Hash(plaintext);
        return await _db.RefreshTokens.IgnoreQueryFilters().AsNoTracking()
            .Where(t => t.TokenHash == hash && t.TenantId == tenantId)
            .Select(t => (Guid?)t.FamilyId)
            .FirstOrDefaultAsync(ct);
    }

    private async Task RevokeWhereAsync(IQueryable<RefreshToken> rows, DateTimeOffset now, CancellationToken ct)
    {
        if (_db.Database.IsRelational())
        {
            await rows.ExecuteUpdateAsync(s => s.SetProperty(t => t.RevokedAt, now), ct);
            return;
        }
        foreach (var row in await rows.ToListAsync(ct)) row.RevokedAt = now;
        await _db.SaveChangesAsync(ct);
    }

    // ---- The cookie ------------------------------------------------------------------------

    /// <summary>Sets the cookie carrying <paramref name="issued"/>.</summary>
    public void WriteCookie(HttpResponse response, IssuedRefresh issued)
    {
        response.Cookies.Append(CookieName, issued.Token, Options(issued.ExpiresAt));
    }

    /// <summary>Clears the cookie (an expired copy with the same attributes).</summary>
    public void ClearCookie(HttpResponse response)
    {
        response.Cookies.Delete(CookieName, Options(null));
    }

    /// <summary>The cookie the request carried, or null.</summary>
    public static string? CookieOf(HttpRequest request)
    {
        return request.Cookies.TryGetValue(CookieName, out var value) && !string.IsNullOrWhiteSpace(value) ? value : null;
    }

    private CookieOptions Options(DateTimeOffset? expires)
    {
        var options = new CookieOptions
        {
            HttpOnly = true,
            Secure = !_env.IsDevelopment(),
            SameSite = SameSiteMode.Strict,
            Path = CookiePath,
            IsEssential = true,
        };
        if (expires is { } at)
        {
            options.Expires = at;
            options.MaxAge = at - _clock.GetUtcNow();
        }
        return options;
    }
}

/// <summary>A newly issued link: the plaintext for the cookie (never stored), its expiry and its family.</summary>
public sealed record IssuedRefresh(string Token, DateTimeOffset ExpiresAt, Guid FamilyId);

/// <summary>What presenting a refresh link came to.</summary>
public abstract record RefreshClaim
{
    /// <summary>Spent now, by this request: it may mint.</summary>
    public sealed record Claimed(RefreshToken Row) : RefreshClaim;

    /// <summary>No such link in this club.</summary>
    public sealed record Unknown : RefreshClaim;

    public sealed record Expired : RefreshClaim;
    public sealed record Revoked : RefreshClaim;

    /// <summary>Spent before, outside the grace: the family has been revoked.</summary>
    public sealed record Replayed : RefreshClaim;

    /// <summary>Spent a moment ago by a concurrent request: refused, family untouched.</summary>
    public sealed record Superseded : RefreshClaim;
}
