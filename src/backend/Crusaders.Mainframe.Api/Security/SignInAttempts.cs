using System.Threading.RateLimiting;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// The per-ACCOUNT half of sign-in limiting (review round 1, B14): <c>RateLimits:AuthPerMinute</c>
/// (10) attempts a minute per (club, address typed), whoever sends them.
///
/// <para>
/// <b>Why not per address alone.</b> Every member at the club is behind the club's one public
/// address, so ten sign-ins a minute per address locked the whole club out on a busy evening,
/// while a guesser on their own line got the same ten. Guessing is against an ACCOUNT, so that is
/// what the tight limit keys on; the per-address bucket (<see cref="RateLimitPolicies.SignIn"/>)
/// stays as a ceiling against one address spraying many accounts. The key is the address as
/// typed (trimmed, lower-cased) — an unknown address is limited like a known one, so the limiter
/// is no account oracle.
/// </para>
/// </summary>
public sealed class SignInAttempts : IDisposable
{
    private readonly PartitionedRateLimiter<string> _limiter;

    public SignInAttempts(IConfiguration config)
    {
        var limit = config.GetValue("RateLimits:AuthPerMinute", 10);
        _limiter = PartitionedRateLimiter.Create<string, string>(key =>
            RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = limit,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            }));
    }

    /// <summary>
    /// True when one more attempt against this account may go ahead. <paramref name="purpose"/>
    /// keeps sign-in and reset requests in separate buckets: a member who signed in may still ask
    /// for a reset link.
    /// </summary>
    public bool TryAcquire(string purpose, Guid tenantId, string? email)
    {
        var key = purpose + "|" + tenantId.ToString("N") + "|" + (email ?? "").Trim().ToLowerInvariant();
        using var lease = _limiter.AttemptAcquire(key);
        return lease.IsAcquired;
    }

    /// <summary>The same refusal the middleware limiter answers with.</summary>
    public static IResult Refused(HttpContext ctx)
    {
        ctx.Response.Headers.RetryAfter = "60";
        return Results.Json(
            new { error = "rate_limited", message = "Too many requests. Try again shortly." },
            statusCode: StatusCodes.Status429TooManyRequests);
    }

    public void Dispose() => _limiter.Dispose();
}
