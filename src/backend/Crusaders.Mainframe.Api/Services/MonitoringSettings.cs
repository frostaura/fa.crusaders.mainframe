namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The three bounds on the IoT error log, clamped on read for the reason
/// <see cref="DoorSettings"/> and <see cref="BoxSettings"/> are: the settings PUT is not the
/// only way a number reaches the column, and the sharpest of these names a cutoff a worker
/// DELETES rows against.
///
/// <para>
/// <b>Why any bound at all.</b> The error table is fed by anything holding the club's device
/// key, and an unbounded error table is a denial of service against the admin's own monitoring
/// screen — a club cannot tell a flood from a fault if the flood is what they are reading.
/// These are the inner, per-board walls; the route's existing 120-per-minute-per-tenant limiter
/// is the outer one.
/// </para>
/// </summary>
public static class MonitoringSettings
{
    /// <summary>
    /// Distinct OPEN rows one board may hold. Beyond it a new distinct fingerprint is folded
    /// into that board's single <c>error_log_overflow</c> row carrying <c>suppressed=n</c>,
    /// rather than inserted.
    ///
    /// <para>
    /// One row saying "and 412 more we stopped recording — this board is in trouble" is more
    /// useful to an admin than 412 rows, and it is the only shape under which a flood is still
    /// legible on the page it is flooding.
    /// </para>
    /// </summary>
    public const int DefaultMaxOpenRows = 200;

    public const int MinMaxOpenRows = 20;
    public const int MaxMaxOpenRows = 2000;

    /// <summary>Reports one board may have recorded per minute before the rest are counted into the overflow row.</summary>
    public const int DefaultIngestPerMinute = 60;

    public const int MinIngestPerMinute = 10;
    public const int MaxIngestPerMinute = 600;

    /// <summary>
    /// How long a club keeps its error rows, days.
    ///
    /// <para>
    /// The sweep is deliberately asymmetric: resolved rows past the cutoff are DELETED, and
    /// OPEN rows past it are AUTO-RESOLVED with a note rather than deleted. An "open errors"
    /// count that silently drops rows nobody looked at is a count that lies about the club's
    /// estate; ageing out keeps the number honest and keeps the history. It also frees the
    /// fingerprint, so a board that starts failing again in month four opens a fresh row with
    /// a truthful first-seen rather than resurrecting a stale one.
    /// </para>
    /// </summary>
    public const int DefaultRetentionDays = 90;

    public const int MinRetentionDays = 7;
    public const int MaxRetentionDays = 730;

    /// <summary>What the retention sweep writes on a row it ages out, so the page never shows a resolution nobody performed.</summary>
    public const string AgedOutNote = "aged out — no longer reported";

    public static int MaxOpenRows(TenantSettingsView s) =>
        Math.Clamp(s.DeviceErrorMaxOpenRows, MinMaxOpenRows, MaxMaxOpenRows);

    public static int IngestPerMinute(TenantSettingsView s) =>
        Math.Clamp(s.DeviceErrorIngestPerMinute, MinIngestPerMinute, MaxIngestPerMinute);

    public static int RetentionDays(TenantSettingsView s) =>
        Math.Clamp(s.DeviceErrorRetentionDays, MinRetentionDays, MaxRetentionDays);
}
