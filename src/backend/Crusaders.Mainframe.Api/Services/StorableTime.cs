namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Clock readings cut down to the resolution the database can actually keep.
/// </summary>
/// <remarks>
/// <para>
/// <b>The two clocks in this system do not agree, and only one of them is authoritative.</b>
/// <see cref="DateTimeOffset"/> counts 100-nanosecond ticks. Postgres <c>timestamptz</c> stores
/// microseconds — ten ticks to one. Handing the column a finer value does not fail and does not
/// warn: it silently drops the last digit. So an instant that is stamped, returned to a caller
/// in the same request, and read back afterwards is two different numbers, and the one the
/// caller was told is the one that does not exist.
/// </para>
/// <para>
/// <b>Found through a door that reported being shut at an instant it was not.</b> Shutting a
/// door stamps <c>out_of_service_since</c> and answers with it; the console shows "shut at".
/// Refreshing re-read the stored value and got something a fraction earlier, so the timestamp
/// moved on its own — which is precisely what
/// <c>A_repeated_shut_does_not_move_the_instant_or_the_name</c> exists to forbid, arriving by a
/// route that test could not see, because it compared one response against another response
/// rather than a response against the database.
/// </para>
/// <para>
/// <b>It hid because the defect is per-platform.</b> The granularity of <c>UtcNow</c> differs
/// between hosts: on the development Macs the reading frequently lands on a microsecond
/// boundary and survives the round trip by luck, while the Linux CI runner's finer clock does
/// not. A suite that is green on every developer's machine and red on the runner is the worst
/// shape a failure can take, and the cause was never in the test.
/// </para>
/// <para>
/// Truncating, never rounding to nearest: half the readings would otherwise be moved FORWARD,
/// and an event must never be recorded as having happened in the future, however slightly. A
/// value already on a boundary is returned unchanged.
/// </para>
/// </remarks>
public static class StorableTime
{
    /// <summary>Ticks per microsecond — the resolution of a Postgres <c>timestamptz</c>.</summary>
    private const long TicksPerMicrosecond = 10L;

    /// <summary>The reading, truncated to something the column can hold exactly.</summary>
    public static DateTimeOffset Storable(this DateTimeOffset value)
        => new(value.UtcTicks - (value.UtcTicks % TicksPerMicrosecond), TimeSpan.Zero);

    /// <summary>Now, at a precision that survives being written down.</summary>
    public static DateTimeOffset UtcNow => DateTimeOffset.UtcNow.Storable();
}
