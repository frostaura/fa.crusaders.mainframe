namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The numbers the live streams run on — the keep-alive, the control board's self-healing
/// resync, the staleness multiplier, and the poll cadences a client falls back to when the
/// stream will not hold.
///
/// <para>
/// Three of these are read by the SERVER and four by the CLIENT, and all seven live here so a
/// club sets them in one place. The client's reach it on the control-board and wallet payloads
/// rather than on a settings call of their own: a page that has to make two requests to know how
/// often to make requests is a page that gets one of them wrong.
/// </para>
///
/// <para>
/// Clamped on read for the reason <see cref="DoorSettings"/> gives: the settings PUT is not the
/// only way a number reaches the column.
/// </para>
/// </summary>
public static class RealtimeSettings
{
    /// <summary>
    /// Seconds of quiet before a stream writes a <c>ping</c> frame. 25 s — what the wallet
    /// stream has shipped with, now a setting rather than a literal.
    /// </summary>
    public const int DefaultKeepaliveSeconds = 25;

    /// <summary>Below this the keep-alive is more traffic than the payload it protects.</summary>
    public const int MinKeepaliveSeconds = 5;

    /// <summary>
    /// The largest keep-alive that still sits under nginx's 60 s default idle timeout.
    ///
    /// <para>
    /// <b>The upper bound is 55 and it is not arbitrary.</b> nginx's <c>proxy_read_timeout</c>
    /// is not set in <c>nginx/nginx.conf</c>, so its 60-second default applies, and Cloudflare
    /// cuts an idle connection at 100 seconds on Free and Pro. A keep-alive at or above 60
    /// seconds means the proxy closes the stream before the server says anything on it, and the
    /// member's balance chip then sits on a number that stopped being true minutes ago — with
    /// nothing on either side reporting an error. The validator's refusal message says so,
    /// because "out of range" on its own invites an admin to wonder why they cannot have a
    /// minute.
    /// </para>
    /// </summary>
    public const int MaxKeepaliveSeconds = 55;

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

    /// <summary>Consecutive <c>EventSource</c> errors before the client gives up on the stream.</summary>
    public const int DefaultFallbackAfterFailures = 3;

    /// <summary>One failure is a reconnect, not a verdict.</summary>
    public const int MinFallbackAfterFailures = 1;

    /// <summary>Ten is already a minute of silence on a channel whose whole point is immediacy.</summary>
    public const int MaxFallbackAfterFailures = 10;

    /// <summary>How long a client stays on the poll fallback before trying the stream again.</summary>
    public const int DefaultFallbackWindowSeconds = 120;

    /// <summary>Shorter than this and a flapping tunnel becomes a reconnect storm.</summary>
    public const int MinFallbackWindowSeconds = 30;

    /// <summary>Longer than fifteen minutes and a recovered tunnel goes unnoticed for a session.</summary>
    public const int MaxFallbackWindowSeconds = 900;

    /// <summary>How often a degraded client re-reads its own wallet over plain HTTP.</summary>
    public const int DefaultPollSecondsWallet = 20;

    /// <summary>Faster than this and a phone on a club's wifi is polling for the sake of it.</summary>
    public const int MinPollSecondsWallet = 5;

    /// <summary>Slower than five minutes and "updating every N seconds" stops being a true sentence.</summary>
    public const int MaxPollSecondsWallet = 300;

    /// <summary>Seconds between control-board polls while degraded.</summary>
    public const int DefaultPollSecondsControlBoard = 10;

    public const int MinPollSecondsControlBoard = 5;
    public const int MaxPollSecondsControlBoard = 120;

    /// <summary>The keep-alive interval a stream will actually use.</summary>
    public static TimeSpan KeepAlive(TenantSettingsView s) =>
        TimeSpan.FromSeconds(Math.Clamp(s.SseKeepaliveSeconds, MinKeepaliveSeconds, MaxKeepaliveSeconds));

    /// <summary>How often an open control-board stream re-sends a full snapshot.</summary>
    public static int ResyncSeconds(TenantSettingsView s) =>
        Math.Clamp(s.ControlBoardResyncSeconds, MinResyncSeconds, MaxResyncSeconds);

    /// <summary>How many heartbeat intervals of silence make a light state stale.</summary>
    public static int StaleMultiplier(TenantSettingsView s) =>
        Math.Clamp(s.ControlBoardStaleMultiplier, MinStaleMultiplier, MaxStaleMultiplier);

    /// <summary>How many consecutive stream errors mean "stop trying and poll".</summary>
    public static int FallbackAfterFailures(TenantSettingsView s) =>
        Math.Clamp(s.RealtimeFallbackAfterFailures, MinFallbackAfterFailures, MaxFallbackAfterFailures);

    /// <summary>How long the client stays degraded before re-attempting the stream.</summary>
    public static int FallbackWindowSeconds(TenantSettingsView s) =>
        Math.Clamp(s.RealtimeFallbackWindowSeconds, MinFallbackWindowSeconds, MaxFallbackWindowSeconds);

    /// <summary>The wallet poll cadence a degraded client should use.</summary>
    public static int PollSecondsWallet(TenantSettingsView s) =>
        Math.Clamp(s.RealtimePollSecondsWallet, MinPollSecondsWallet, MaxPollSecondsWallet);

    /// <summary>The control-board poll cadence a degraded wall screen should use.</summary>
    public static int PollSecondsControlBoard(TenantSettingsView s) =>
        Math.Clamp(s.RealtimePollSecondsControlBoard, MinPollSecondsControlBoard, MaxPollSecondsControlBoard);
}
