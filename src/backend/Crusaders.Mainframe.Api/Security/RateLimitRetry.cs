using System.Threading.RateLimiting;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// How long a refused request should wait, from the limiter that refused it (review round 5, P5-2).
///
/// <para>
/// Every 429 said <c>Retry-After: 60</c> / <c>retry_after_seconds: 60</c>, while the writes bucket
/// refills a token a second — a member who pressed once too often was told to wait a minute for a
/// press that would have gone through a second later, and the console's countdown said so. The
/// refused lease carries the limiter's own answer (<see cref="MetadataName.RetryAfter"/>: the token
/// bucket's next refill, the fixed window's reset); it is rounded UP to whole seconds, never below
/// one. A lease without it (the global chain can refuse without one) keeps the old minute.
/// </para>
/// </summary>
public static class RateLimitRetry
{
    /// <summary>The wait when the refusing limiter did not say: the longest window any policy here uses.</summary>
    public const int FallbackSeconds = 60;

    public static int Seconds(RateLimitLease lease)
    {
        if (!lease.TryGetMetadata(MetadataName.RetryAfter, out var wait)) return FallbackSeconds;
        return Math.Max(1, (int)Math.Ceiling(wait.TotalSeconds));
    }
}
