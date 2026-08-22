using System.Net;

namespace Crusaders.Mainframe.Api.Security.Discovery;

/// <summary>Where the listener got to. Reported verbatim by the discovery-status endpoint.</summary>
public enum DiscoveryListenerState
{
    /// <summary>The hosted service has not run. Normal under the test host, which strips hosted services.</summary>
    NotStarted = 0,

    /// <summary>Turned off by configuration.</summary>
    Disabled = 1,

    /// <summary>Socket bound; packets, if any exist, will arrive.</summary>
    Listening = 2,

    /// <summary>The bind failed. The port is taken, or the container has no permission to hold it.</summary>
    Failed = 3,
}

/// <summary>
/// One board heard on the LAN.
///
/// <para>
/// Everything except <see cref="SignatureVerified"/> and <see cref="OwnerTenantId"/> is
/// self-asserted by whoever sent the packet, including the MAC. It is treated as a
/// display hint and never as an authorisation input — the only field that can move a
/// key is the claim commitment, and that is bound to a code the board shows on its own
/// LCD.
/// </para>
/// </summary>
public sealed record DiscoveredBoard
{
    public required string Mac { get; init; }
    public required string Address { get; init; }
    public required string Nonce { get; init; }

    public string? Hardware { get; init; }
    public string? Firmware { get; init; }
    public string? MegaVersion { get; init; }

    /// <summary>Present only while the board is unclaimed. Its absence is what makes a claim impossible.</summary>
    public string? Commitment { get; init; }

    public bool Claimed { get; init; }

    /// <summary>The device id the board claims to be. Self-asserted until the signature verifies.</summary>
    public Guid? DeviceId { get; init; }

    public string? TenantSlug { get; init; }
    public long UptimeSeconds { get; init; }

    /// <summary>
    /// Null when there was nothing to verify — an unclaimed board has no key. False means
    /// a board asserted an identity and could not prove it, which is a state an admin has
    /// to be shown rather than one to filter away: a key rotated out from under a board
    /// looks exactly like this, and so does a spoof.
    /// </summary>
    public bool? SignatureVerified { get; init; }

    /// <summary>Set only when the signature verified against a real device row. The isolation boundary for the list.</summary>
    public Guid? OwnerTenantId { get; init; }

    public DateTimeOffset FirstSeenAt { get; init; }
    public DateTimeOffset LastSeenAt { get; init; }
}

/// <summary>A point-in-time snapshot of the listener, for the diagnostic endpoint.</summary>
public sealed record DiscoveryStatus(
    DiscoveryListenerState State,
    string? BoundEndpoint,
    string? Detail,
    long PacketsReceived,
    long PacketsAccepted,
    long PacketsRejected,
    DateTimeOffset? LastPacketAt,
    DateTimeOffset? StartedAt,
    int AnnouncerCount,
    bool CapacityReached);

/// <summary>
/// The bounded, in-memory set of boards heard on the LAN, plus the listener's own health.
///
/// <para>
/// In memory and not in the database on purpose. This is ephemeral LAN observation with
/// a five-minute half-life, it is fed by an <b>unauthenticated UDP socket</b>, and it is
/// not tenant-scoped — an unclaimed board belongs to no tenant. Persisting it would put
/// attacker-controlled rows into a tenant-scoped schema and hand a broadcast flood a
/// write path to Postgres.
/// </para>
///
/// <para>
/// Every mutation is under one lock. The traffic is a few packets per second from a
/// handful of boards; a lock-free structure here would be complexity bought with no
/// measurable return, and correctness under a flood is the property that matters.
/// </para>
/// </summary>
public sealed class DiscoveryStore
{
    private readonly object _gate = new();
    private readonly Dictionary<string, DiscoveredBoard> _boards = new(StringComparer.Ordinal);
    private readonly Dictionary<IPAddress, SourceWindow> _sources = new();
    private readonly DiscoveryOptions _options;
    private readonly TimeProvider _clock;

    private DiscoveryListenerState _state = DiscoveryListenerState.NotStarted;
    private string? _boundEndpoint;
    private string? _detail;
    private DateTimeOffset? _startedAt;
    private DateTimeOffset? _lastPacketAt;
    private long _received;
    private long _accepted;
    private long _rejected;
    private bool _capacityReached;

    public DiscoveryStore(DiscoveryOptions options, TimeProvider? clock = null)
    {
        _options = options;
        _clock = clock ?? TimeProvider.System;
    }

    public void RecordListening(EndPoint endpoint)
    {
        lock (_gate)
        {
            _state = DiscoveryListenerState.Listening;
            _boundEndpoint = endpoint.ToString();
            _startedAt = _clock.GetUtcNow();
            _detail = null;
        }
    }

    public void RecordDisabled()
    {
        lock (_gate)
        {
            _state = DiscoveryListenerState.Disabled;
            _detail = "Discovery:Enabled is false.";
        }
    }

    public void RecordBindFailure(string detail)
    {
        lock (_gate)
        {
            _state = DiscoveryListenerState.Failed;
            _detail = detail;
        }
    }

    /// <summary>
    /// Counts a datagram and decides whether it may be processed.
    ///
    /// <para>
    /// A fixed window per source address, and the source table is capped as hard as the
    /// board table: UDP source addresses are trivially forged, so a per-source limiter
    /// with an unbounded key set is a memory-exhaustion primitive wearing the costume of
    /// a defence. Once the table is full, unknown sources are refused rather than
    /// evicting a source already in it.
    /// </para>
    /// </summary>
    public bool TryAdmit(IPAddress source)
    {
        var now = _clock.GetUtcNow();

        lock (_gate)
        {
            _received++;
            _lastPacketAt = now;

            if (!Admit(source, now))
            {
                _rejected++;
                return false;
            }

            return true;
        }
    }

    /// <summary>Counts a packet that decoded and was stored. Called after <see cref="TryAdmit"/> has already counted it.</summary>
    public void RecordAccepted()
    {
        lock (_gate) _accepted++;
    }

    public void RecordRejected()
    {
        lock (_gate) _rejected++;
    }

    /// <summary>
    /// Records a board, keyed by MAC so a board that moves address updates in place rather
    /// than doubling.
    ///
    /// <para>
    /// At capacity a <b>new</b> MAC is dropped and the flag is raised for the status
    /// endpoint. The alternative — evicting the least-recently-seen entry — was rejected
    /// because it is strictly worse under the attack it exists to survive: a flooder can
    /// keep its own forged entries fresh and would push the real board out of the list,
    /// silently. Refusing the new entry turns the same attack into a visible
    /// "capacity_reached" an admin can act on.
    /// </para>
    /// </summary>
    public void Upsert(DiscoveredBoard board)
    {
        var now = _clock.GetUtcNow();

        lock (_gate)
        {
            PruneExpired(now);

            if (_boards.TryGetValue(board.Mac, out var existing))
            {
                _boards[board.Mac] = board with { FirstSeenAt = existing.FirstSeenAt, LastSeenAt = now };
                return;
            }

            if (_boards.Count >= _options.MaxAnnouncers)
            {
                _capacityReached = true;
                _rejected++;
                return;
            }

            _boards[board.Mac] = board with { FirstSeenAt = now, LastSeenAt = now };
        }
    }

    /// <summary>
    /// Records that a board has been claimed, without waiting for its next announce.
    ///
    /// <para>
    /// Without this the entry stays <c>unclaimed</c> for up to a minute after the key is
    /// issued, and a second claim with the same code but a different device code would
    /// register the same physical board twice. The commitment is deliberately <b>kept</b>
    /// rather than cleared: keeping it means the second attempt matches and is refused as
    /// "already claimed", which is the message an admin can act on, where clearing it would
    /// produce a bare "no match" for a board sitting in front of them.
    /// </para>
    /// </summary>
    public void MarkClaimed(string mac, Guid deviceId, Guid tenantId)
    {
        lock (_gate)
        {
            if (!_boards.TryGetValue(mac, out var board)) return;
            _boards[mac] = board with { Claimed = true, DeviceId = deviceId, OwnerTenantId = tenantId };
        }
    }

    /// <summary>Live announcers, freshest first. Expired entries are pruned on the way out.</summary>
    public IReadOnlyList<DiscoveredBoard> Snapshot()
    {
        var now = _clock.GetUtcNow();

        lock (_gate)
        {
            PruneExpired(now);
            return _boards.Values.OrderByDescending(b => b.LastSeenAt).ToList();
        }
    }

    public DiscoveryStatus Status()
    {
        var now = _clock.GetUtcNow();

        lock (_gate)
        {
            PruneExpired(now);
            return new DiscoveryStatus(
                _state, _boundEndpoint, _detail, _received, _accepted, _rejected,
                _lastPacketAt, _startedAt, _boards.Count, _capacityReached);
        }
    }

    /// <summary>Test seam. Never called by the application — the TTL is the only production eviction path.</summary>
    internal void Clear()
    {
        lock (_gate)
        {
            _boards.Clear();
            _sources.Clear();
            _received = _accepted = _rejected = 0;
            _capacityReached = false;
            _lastPacketAt = null;
        }
    }

    private bool Admit(IPAddress source, DateTimeOffset now)
    {
        if (_sources.TryGetValue(source, out var window))
        {
            if (now - window.Start >= TimeSpan.FromMinutes(1))
            {
                _sources[source] = new SourceWindow(now, 1);
                return true;
            }

            if (window.Count >= _options.MaxPacketsPerSourcePerMinute) return false;

            _sources[source] = window with { Count = window.Count + 1 };
            return true;
        }

        PruneSources(now);
        if (_sources.Count >= _options.MaxRateLimitedSources) return false;

        _sources[source] = new SourceWindow(now, 1);
        return true;
    }

    private void PruneSources(DateTimeOffset now)
    {
        var stale = _sources
            .Where(kv => now - kv.Value.Start >= TimeSpan.FromMinutes(1))
            .Select(kv => kv.Key)
            .ToList();

        foreach (var key in stale) _sources.Remove(key);
    }

    private void PruneExpired(DateTimeOffset now)
    {
        var ttl = _options.AnnouncerTtl;
        var stale = _boards.Where(kv => now - kv.Value.LastSeenAt > ttl).Select(kv => kv.Key).ToList();

        foreach (var key in stale) _boards.Remove(key);
        if (stale.Count > 0 && _boards.Count < _options.MaxAnnouncers) _capacityReached = false;
    }

    private readonly record struct SourceWindow(DateTimeOffset Start, int Count);
}
