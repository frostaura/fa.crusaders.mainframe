namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Instant arithmetic on a number a board sent — review round 16, D16-1.
///
/// <para>
/// <b>Why.</b> <c>DateTimeOffset.AddMilliseconds</c> throws when its answer falls outside year 1 to
/// 9999, and a board's uptimes and durations are 64-bit values nothing bounds: an event whose uptime
/// was 2^53 ms behind its batch's answered the whole <c>/events</c> upload 500, which the firmware
/// reads as "retry the head event for ever". The arithmetic now saturates instead: an instant past
/// the calendar is the calendar's edge, which every caller already treats as out of range — an
/// upload's claimed time is clamped (<c>clock_clamped</c>, the event kept), a release's implied end
/// does not pair, and a lit window is bounded by its booking.
/// </para>
/// </summary>
public static class DeviceTime
{
    /// <summary>
    /// <paramref name="at"/> plus <paramref name="milliseconds"/> (which may be negative), saturated at
    /// <see cref="DateTimeOffset.MinValue"/> / <see cref="DateTimeOffset.MaxValue"/> (UTC) rather than
    /// thrown. Exact for any value whose answer is representable.
    /// </summary>
    public static DateTimeOffset Add(DateTimeOffset at, decimal milliseconds)
    {
        var ticks = (decimal)at.UtcTicks + (milliseconds * TimeSpan.TicksPerMillisecond);
        if (ticks <= DateTimeOffset.MinValue.UtcTicks) return DateTimeOffset.MinValue;
        if (ticks >= DateTimeOffset.MaxValue.UtcTicks) return DateTimeOffset.MaxValue;
        return new DateTimeOffset((long)ticks, TimeSpan.Zero);
    }

    /// <summary>How long before the batch an event happened, in milliseconds — exact, never overflowing <c>long</c>.</summary>
    public static decimal Ago(long batchUptimeMs, long eventUptimeMs) => (decimal)batchUptimeMs - eventUptimeMs;
}
