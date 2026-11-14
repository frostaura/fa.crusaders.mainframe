namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The interval a court box will actually run at, and how long a box may be silent before
/// the admin UI calls it offline.
///
/// <para>
/// Like <see cref="RelayHardCap"/> this is a property of the firmware rather than a policy.
/// <c>bridgelogic::Cadence</c> adopts <c>heartbeat_seconds</c> from the heartbeat response
/// and CLAMPS it into [15 s, 300 s] — below the floor a fleet hammers the API and its own
/// UART with four-second blocking calls, above the ceiling the roster ages and a new key or
/// network takes minutes to reach a box. The API used to accept 10–3600 and the Settings page said
/// so, so an admin could set 600, see 600 on the page, and have every box in the club run
/// at 300 with nothing anywhere saying otherwise (round-3 finding 22, escalated from lead
/// L9). Accepting only what the boxes will honour is the only version of this that cannot
/// lie to an admin.
/// </para>
/// </summary>
public static class HeartbeatCadence
{
    /// <summary>Matches <c>bridgelogic::kMinHeartbeatMs</c>.</summary>
    public const int MinSeconds = 15;

    /// <summary>Matches <c>bridgelogic::kMaxHeartbeatMs</c>.</summary>
    public const int MaxSeconds = 300;

    /// <summary>
    /// Missed heartbeats before a box is shown as offline. Three, so a single dropped call
    /// — a WiFi retry, a long blocking activation — is not an outage on the glass.
    /// </summary>
    public const int MissedBeatsBeforeOffline = 3;

    /// <summary>
    /// The floor under <see cref="OfflineAfterSeconds"/>, in seconds.
    ///
    /// <para>
    /// The admin page hardcoded 180 000 ms against a fixed "every 30 s" comment while the
    /// interval was editable up to 3600, so an admin who raised it to reduce chatter saw
    /// WifiOff and "last seen 4m ago" for 40% of every interval and went power-cycling
    /// healthy boxes. The threshold is derived from the tenant's own interval now; this
    /// constant only stops a club on the 15-second floor from being called offline after
    /// 45 seconds of ordinary jitter.
    /// </para>
    /// </summary>
    public const int MinOfflineAfterSeconds = 180;

    /// <summary>The interval a box will run at, given what the tenant asked for.</summary>
    public static int Effective(int configuredSeconds)
        => Math.Clamp(configuredSeconds, MinSeconds, MaxSeconds);

    /// <summary>
    /// How long a box may be silent before it is offline, given what the tenant asked for.
    /// Derived from the EFFECTIVE interval, not the configured one: a threshold computed
    /// from a number the boxes ignore is the collision this replaces.
    /// </summary>
    public static int OfflineAfterSeconds(int configuredSeconds)
        => Math.Max(MinOfflineAfterSeconds, Effective(configuredSeconds) * MissedBeatsBeforeOffline);
}
