namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The numbers that govern the live channels — the SSE keep-alive, and the poll cadences the
/// client falls back to when the stream cannot be held open.
///
/// <para>
/// <b>The keep-alive's upper bound is load-bearing and is not a round number.</b> nginx's
/// <c>proxy_read_timeout</c> is not set in <c>nginx/nginx.conf</c>, so its 60-second default
/// applies, and Cloudflare cuts an idle connection at 100 seconds on Free and Pro. A keep-alive
/// at or above 60 seconds means the proxy closes the stream before the server says anything on
/// it, and the member's balance chip then sits on a number that stopped being true minutes
/// ago — with nothing on either side reporting an error. 55 is the largest value that still
/// leaves the proxy a margin; the validator's message says so, because "out of range" on its
/// own invites an admin to wonder why they cannot have a minute.
/// </para>
///
/// <para>
/// Clamped on read for the reason <see cref="DoorSettings"/> gives: the settings PUT is not the
/// only way a number reaches the column.
/// </para>
/// </summary>
public static class RealtimeSettings
{
    /// <summary>25 s — what the wallet stream has shipped with, now a setting rather than a literal.</summary>
    public const int DefaultKeepaliveSeconds = 25;

    /// <summary>Below this the keep-alive is more traffic than the payload it protects.</summary>
    public const int MinKeepaliveSeconds = 5;

    /// <summary>The largest keep-alive that still sits under nginx's 60 s default idle timeout.</summary>
    public const int MaxKeepaliveSeconds = 55;

    /// <summary>How often a degraded client re-reads its own wallet over plain HTTP.</summary>
    public const int DefaultPollSecondsWallet = 20;

    /// <summary>Faster than this and a phone on a club's wifi is polling for the sake of it.</summary>
    public const int MinPollSecondsWallet = 5;

    /// <summary>Slower than five minutes and "updating every N seconds" stops being a true sentence.</summary>
    public const int MaxPollSecondsWallet = 300;

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

    /// <summary>The keep-alive interval a stream will actually use.</summary>
    public static TimeSpan KeepAlive(TenantSettingsView settings)
        => TimeSpan.FromSeconds(
            Math.Clamp(settings.SseKeepaliveSeconds, MinKeepaliveSeconds, MaxKeepaliveSeconds));

    /// <summary>The wallet poll cadence a degraded client should use.</summary>
    public static int PollSecondsWallet(TenantSettingsView settings)
        => Math.Clamp(settings.RealtimePollSecondsWallet, MinPollSecondsWallet, MaxPollSecondsWallet);

    /// <summary>How many consecutive stream errors mean "stop trying and poll".</summary>
    public static int FallbackAfterFailures(TenantSettingsView settings)
        => Math.Clamp(settings.RealtimeFallbackAfterFailures, MinFallbackAfterFailures, MaxFallbackAfterFailures);

    /// <summary>How long the client stays degraded before re-attempting the stream.</summary>
    public static int FallbackWindowSeconds(TenantSettingsView settings)
        => Math.Clamp(settings.RealtimeFallbackWindowSeconds, MinFallbackWindowSeconds, MaxFallbackWindowSeconds);
}
