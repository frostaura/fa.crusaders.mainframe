using System.Collections.Concurrent;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Per-member directory search budget: <c>directory_searches_per_minute</c> in any rolling
/// minute (D13).
///
/// <para>
/// <b>Its own limiter rather than a route policy</b>, because the number is the club's (every
/// configurable number is a tenant setting) and ASP.NET's limiter policies are fixed at startup.
/// In process, like the access-token revocation cache: a second API instance would give a member
/// twice the budget, which bounds scraping just as well and is recorded rather than hidden.
/// </para>
/// </summary>
public sealed class DirectoryRateLimiter
{
    private readonly ConcurrentDictionary<(Guid Tenant, Guid User), Queue<DateTimeOffset>> _hits = new();

    /// <summary>Records a search and answers whether it is within budget; when not, how long until the oldest hit ages out.</summary>
    public (bool Allowed, TimeSpan RetryAfter) TryAcquire(Guid tenantId, Guid userId, int perMinute, DateTimeOffset now)
    {
        var queue = _hits.GetOrAdd((tenantId, userId), _ => new Queue<DateTimeOffset>());
        lock (queue)
        {
            while (queue.Count > 0 && queue.Peek() <= now.AddMinutes(-1)) queue.Dequeue();
            if (queue.Count >= perMinute) return (false, queue.Peek().AddMinutes(1) - now);
            queue.Enqueue(now);
            return (true, TimeSpan.Zero);
        }
    }
}
