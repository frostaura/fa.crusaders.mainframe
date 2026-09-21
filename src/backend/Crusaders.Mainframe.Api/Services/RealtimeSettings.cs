namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The numbers the live streams run on — the keep-alive, the control board's self-healing
/// resync, the staleness multiplier, and the poll intervals a client falls back to when the
/// stream will not hold.
///
/// <para>
/// Three of these are read by the SERVER and three by the CLIENT, and all six live here so a
/// club sets them in one place. The client's three reach it on the control-board and wallet
/// payloads rather than on a settings call of their own: a page that has to make two requests
/// to know how often to make requests is a page that gets one of them wrong.
/// </para>
/// </summary>
public static class RealtimeSettings
{
    /// <summary>
    /// Seconds of quiet before a stream writes a <c>ping</c> frame.
    ///
    /// <para>
    /// <b>The upper bound is 55 and it is not arbitrary.</b> nginx's <c>proxy_read_timeout</c>
    /// is not set in this deployment's config, so its 60-second default applies — a keep-alive
    /// interval at or above that is a stream the gateway cuts before the keep-alive that would
    /// have saved it. Cloudflare's own idle cut-off on the plans this club runs is 100 seconds,
    /// so 60 is the binding constraint. The validator's refusal message says so, because a
    /// number whose bound is explained only in a source comment is a number somebody raises.
    /// </para>
    /// </summary>
    public const int DefaultKeepAliveSeconds = 25;

    public const int MinKeepAliveSeconds = 5;
    public const int MaxKeepAliveSeconds = 55;

    /// <summary>
    /// Seconds between full control-board snapshots on an open stream.
    ///
    /// <para>
    /// <b>This is how a client that missed a delta heals itself.</b> Deltas alone are a state
    /// machine the browser has to get right for hours on an unattended wall screen; a periodic
    /// resync makes a missed frame cost at most five minutes of staleness rather than a
    /// permanently wrong court. The snapshot carries its own <c>generated_at</c> so the screen
    /// can say when it was last right.
    /// </para>
    /// </summary>
    public const int DefaultResyncSeconds = 300;

    public const int MinResyncSeconds = 30;
    public const int MaxResyncSeconds = 3600;

    /// <summary>
    /// How many effective heartbeat intervals of silence make a light state STALE.
    ///
    /// <para>
    /// Two by default: one missed beat is a lost packet, two is a board that has stopped. Past
    /// it the server must not silently assert a relay is on — the tile says "ON, but the box
    /// has not reported for six minutes", which is both halves of a conditional the club needs.
    /// An unqualified "ON" on a wall screen is how a club leaves a court lit all night
    /// believing the software knows.
    /// </para>
    /// </summary>
    public const int DefaultStaleMultiplier = 2;

    public const int MinStaleMultiplier = 1;
    public const int MaxStaleMultiplier = 10;

    /// <summary>Consecutive stream failures after which a client should fall back to polling.</summary>
    public const int DefaultFallbackAfterFailures = 3;

    public const int MinFallbackAfterFailures = 1;
    public const int MaxFallbackAfterFailures = 10;

    /// <summary>Seconds a client stays in polling mode before trying the stream again.</summary>
    public const int DefaultFallbackWindowSeconds = 120;

    public const int MinFallbackWindowSeconds = 30;
    public const int MaxFallbackWindowSeconds = 900;

    /// <summary>Seconds between wallet polls while degraded.</summary>
    public const int DefaultPollSecondsWallet = 20;

    public const int MinPollSecondsWallet = 5;
    public const int MaxPollSecondsWallet = 300;

    /// <summary>Seconds between control-board polls while degraded.</summary>
    public const int DefaultPollSecondsControlBoard = 10;

    public const int MinPollSecondsControlBoard = 5;
    public const int MaxPollSecondsControlBoard = 120;

    public static TimeSpan KeepAlive(TenantSettingsView s) =>
        TimeSpan.FromSeconds(Math.Clamp(s.SseKeepAliveSeconds, MinKeepAliveSeconds, MaxKeepAliveSeconds));

    public static int ResyncSeconds(TenantSettingsView s) =>
        Math.Clamp(s.ControlBoardResyncSeconds, MinResyncSeconds, MaxResyncSeconds);

    public static int StaleMultiplier(TenantSettingsView s) =>
        Math.Clamp(s.ControlBoardStaleMultiplier, MinStaleMultiplier, MaxStaleMultiplier);

    public static int FallbackAfterFailures(TenantSettingsView s) =>
        Math.Clamp(s.RealtimeFallbackAfterFailures, MinFallbackAfterFailures, MaxFallbackAfterFailures);

    public static int FallbackWindowSeconds(TenantSettingsView s) =>
        Math.Clamp(s.RealtimeFallbackWindowSeconds, MinFallbackWindowSeconds, MaxFallbackWindowSeconds);

    public static int PollSecondsWallet(TenantSettingsView s) =>
        Math.Clamp(s.RealtimePollSecondsWallet, MinPollSecondsWallet, MaxPollSecondsWallet);

    public static int PollSecondsControlBoard(TenantSettingsView s) =>
        Math.Clamp(s.RealtimePollSecondsControlBoard, MinPollSecondsControlBoard, MaxPollSecondsControlBoard);
}
