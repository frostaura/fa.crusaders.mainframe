using Microsoft.Extensions.Caching.Memory;

namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// The in-flight passkey ceremonies' challenge state, in a cache of its OWN with a hard size limit
/// (BP-10).
///
/// <para>
/// The flows used to share the application's <see cref="IMemoryCache"/>, which has no size limit —
/// and can never be given one, because every other entry in it would then have to declare a size.
/// <c>POST /auth/webauthn/login/options</c> is anonymous, and each call parked a five-minute entry,
/// so a flood grew the process's memory without bound. Here a full store refuses the new ceremony
/// (the caller answers 503 <c>service_busy</c>) instead of growing; the route is also under the
/// sign-in rate limit now, so reaching the ceiling takes many addresses at once.
/// </para>
/// </summary>
public sealed class WebAuthnFlows : IDisposable
{
    /// <summary>How long a ceremony may take between its options and its answer.</summary>
    public static readonly TimeSpan FlowTtl = TimeSpan.FromMinutes(5);

    /// <summary>Ceremonies in flight at once, deployment-wide. A club has hundreds of members, not thousands of phones mid-sign-in.</summary>
    public const int Capacity = 5_000;

    private readonly MemoryCache _cache;

    public WebAuthnFlows() : this(Capacity) { }

    /// <summary>A store of another size — for a test that fills one.</summary>
    internal WebAuthnFlows(int capacity) => _cache = new MemoryCache(new MemoryCacheOptions
    {
        SizeLimit = capacity,
        // A full store refuses the NEW ceremony; it never evicts one somebody is in the middle of
        // (MemoryCache's default compacts 5% of live entries whenever the limit is hit). Expired
        // entries still go, on the scan.
        CompactionPercentage = 0,
        ExpirationScanFrequency = TimeSpan.FromSeconds(30),
    });

    /// <summary>Parks a ceremony's state; false when the store is full and it was NOT parked.</summary>
    public bool TryStore(string key, string json)
    {
        _cache.Set(key, json, new MemoryCacheEntryOptions { Size = 1, AbsoluteExpirationRelativeToNow = FlowTtl });
        return _cache.TryGetValue(key, out _);
    }

    /// <summary>Takes a ceremony's state out — once. Null when unknown or expired.</summary>
    public string? Take(string key)
    {
        if (!_cache.TryGetValue<string>(key, out var json) || json is null) return null;
        _cache.Remove(key);
        return json;
    }

    public void Dispose() => _cache.Dispose();
}
