using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// R19 E19-1: which boot a court box's heartbeat belongs to, and the restored count it carries — what
/// lets the power-dip restore be served, and confirmed, once per boot.
///
/// <para>
/// <b>The boot is the server's clock less the board's uptime.</b> Two heartbeats of one boot agree on
/// it to within their network delays; a reboot moves it by at least the uptime the board had when it
/// was last heard, which is seconds at the very least (the board joins Wi-Fi before its first beat).
/// <see cref="SameBootSlack"/> sits between the two. An uptime that is absent, negative or beyond
/// <see cref="MaxUptimeMs"/> gives no boot, and an unknown boot is read as the same one — the
/// behaviour every board had before boots were told apart.
/// </para>
///
/// <para>
/// <b>A count no board can send settles nothing.</b> The firmware's <c>restored_relays</c> is one byte
/// and is omitted at zero, so absent reads 0 and anything outside <c>[0, 255]</c> is a broken counter,
/// not evidence the box acted: <see cref="Restored"/> is null, the expectation waits for a readable
/// count, and the heartbeat is answered as always. Not a 400 — a diagnostic counter must never take a
/// box's roster down with it (<see cref="HeartbeatRequest.RestoredRelays"/>) — and not a clamp, because
/// a clamped 9e18 would still "confirm" a restore nobody reported.
/// </para>
/// </summary>
/// <param name="BootedAt">When the board booted, by the server's clock; null when its uptime was unreadable.</param>
/// <param name="Restored">The board's <c>restored_relays</c>: 0 when absent, null when no board could send it.</param>
internal readonly record struct RestoreBoot(DateTimeOffset? BootedAt, int? Restored)
{
    /// <summary>Ten years of uptime: past this the board's clock has gone wrong, not stayed up.</summary>
    public const long MaxUptimeMs = 10L * 366 * 24 * 60 * 60 * 1000;

    /// <summary>How far two estimates of one boot may disagree: the spread of two heartbeats' network delays.</summary>
    public static readonly TimeSpan SameBootSlack = TimeSpan.FromSeconds(3);

    /// <summary>The most relays a board's one-byte count can say it restored.</summary>
    public const int MaxRestored = byte.MaxValue;

    /// <summary>This heartbeat's boot and count.</summary>
    public static RestoreBoot Of(HeartbeatRequest req, DateTimeOffset now)
    {
        DateTimeOffset? booted = req.UptimeMs is { } up && up is >= 0 and <= MaxUptimeMs
            ? now - TimeSpan.FromMilliseconds(up)
            : null;
        int? restored = req.RestoredRelays switch
        {
            null => 0,
            { } n when n is >= 0 and <= MaxRestored => (int)n,
            _ => null,
        };
        return new RestoreBoot(booted, restored);
    }

    /// <summary>Whether the board's outstanding restore was served to THIS boot. An unknown boot on either side reads as the same.</summary>
    public bool IsBootServed(Device device)
    {
        return BootedAt is not { } now || device.RestoreServedBootAt is not { } served || Same(now, served);
    }

    /// <summary>
    /// Whether this boot has had its restore: it was served one, or it says it restored relays (a box
    /// only counts what it was served, so a positive count is a boot that has already acted).
    /// </summary>
    public bool AlreadyServed(Device device)
    {
        if (Restored is > 0) return true;
        return BootedAt is { } now && device.RestoreServedBootAt is { } served && Same(now, served);
    }

    private static bool Same(DateTimeOffset a, DateTimeOffset b) => (a - b).Duration() <= SameBootSlack;
}
