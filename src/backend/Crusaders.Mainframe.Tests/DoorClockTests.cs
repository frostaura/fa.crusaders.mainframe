using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A4 — when a club's day begins, on the two days a year the question is hard.
///
/// <para>
/// <b>The club's day was built with the wrong offset and no test in this repository could see
/// it.</b> <c>DoorDay</c> converted <c>now</c> into the club's zone and then constructed midnight
/// with <c>local.Offset</c> — the offset in force at <i>now</i>, not at midnight. Those are the
/// same number on every day of the year in UTC, which is what every fixture club here runs, and
/// in Africa/Johannesburg, which is what the first real one runs; they differ by an hour on the
/// two days a DST zone changes, and on those days every count taken against the boundary belonged
/// to a different day. This is the <c>memory/gotchas.md</c> shape exactly: a green suite that
/// cannot fail because the fixture has no DST in it.
/// </para>
///
/// <para>
/// <b>These are pure functions taking <c>now</c>, deliberately.</b> A DST transition cannot be
/// waited for and must not be simulated by moving the test host's zone — which
/// <c>memory/gotchas.md</c> records as manufacturing false failures across every fixture pinning
/// <c>"timezone":"UTC"</c>. Passing the instant in is what makes both boundaries testable at all.
/// </para>
/// </summary>
public sealed class DoorClockTests
{
    /// <summary>
    /// A zone with DST that Windows, macOS and Linux all carry, and whose transition is at 02:00
    /// local — so midnight itself is neither invalid nor ambiguous and the ONLY thing under test
    /// is which offset the boundary was built with.
    /// </summary>
    private static TimeZoneInfo Amsterdam() => TimeZoneInfo.FindSystemTimeZoneById("Europe/Amsterdam");

    /// <summary>
    /// The morning after the clocks go forward: the day began at +01:00 and it is now +02:00.
    ///
    /// <para>
    /// The old arithmetic answered <c>00:00+02:00</c>, which is 22:00 UTC the night before — an
    /// hour of the previous day counted into this one, and an hour of this one dropped.
    /// </para>
    /// </summary>
    [Fact]
    public void A_day_that_springs_forward_starts_at_the_offset_that_was_in_force_at_midnight()
    {
        var zone = Amsterdam();

        // 2026-03-29 is the last Sunday in March: Amsterdam goes +01:00 → +02:00 at 02:00 local.
        var noon = new DateTimeOffset(2026, 3, 29, 12, 0, 0, TimeSpan.FromHours(2));
        Assert.Equal(TimeSpan.FromHours(2), zone.GetUtcOffset(noon));

        var start = DoorClock.StartOfLocalDay(zone, DoorClock.LocalDateOf(zone, noon));

        Assert.Equal(TimeSpan.FromHours(1), start.Offset);
        Assert.Equal(new DateTimeOffset(2026, 3, 28, 23, 0, 0, TimeSpan.Zero), start.ToUniversalTime());

        // Eleven hours have elapsed since the club's day began, though the wall clock reads
        // noon: the hour between 02:00 and 03:00 never happened. The old arithmetic answered
        // twelve, which is the wall clock and not the day.
        Assert.Equal(11, (noon - start).TotalHours, 3);
    }

    /// <summary>
    /// And the morning after they go back: the day began at +02:00 and it is now +01:00, so the
    /// day is twenty-five hours long. The mirror of the case above, and it fails on the mirror of
    /// the same bug.
    /// </summary>
    [Fact]
    public void A_day_that_falls_back_starts_at_the_offset_that_was_in_force_at_midnight()
    {
        var zone = Amsterdam();

        // 2026-10-25 is the last Sunday in October: +02:00 → +01:00 at 03:00 local.
        var noon = new DateTimeOffset(2026, 10, 25, 12, 0, 0, TimeSpan.FromHours(1));
        Assert.Equal(TimeSpan.FromHours(1), zone.GetUtcOffset(noon));

        var start = DoorClock.StartOfLocalDay(zone, DoorClock.LocalDateOf(zone, noon));

        Assert.Equal(TimeSpan.FromHours(2), start.Offset);
        Assert.Equal(new DateTimeOffset(2026, 10, 24, 22, 0, 0, TimeSpan.Zero), start.ToUniversalTime());
        Assert.Equal(25, (DoorClock.StartOfLocalDay(zone, DoorClock.LocalDateOf(zone, noon).AddDays(1)) - start).TotalHours, 3);
    }

    /// <summary>
    /// Consecutive club days tile the timeline exactly: each one starts where the last ended,
    /// with no hour counted twice and none lost, across both transitions.
    /// </summary>
    [Fact]
    public void Club_days_tile_the_year_with_no_gap_and_no_overlap_across_both_transitions()
    {
        var zone = Amsterdam();
        var day = new DateOnly(2026, 3, 26);

        var previous = DoorClock.StartOfLocalDay(zone, day);
        for (var i = 1; i <= 5; i++)
        {
            var next = DoorClock.StartOfLocalDay(zone, day.AddDays(i));
            var hours = (next - previous).TotalHours;
            Assert.InRange(hours, 23, 25);
            Assert.True(next > previous, $"{day.AddDays(i)} did not start after {day.AddDays(i - 1)}");
            previous = next;
        }

        var october = new DateOnly(2026, 10, 23);
        previous = DoorClock.StartOfLocalDay(zone, october);
        for (var i = 1; i <= 5; i++)
        {
            var next = DoorClock.StartOfLocalDay(zone, october.AddDays(i));
            Assert.InRange((next - previous).TotalHours, 23, 25);
            previous = next;
        }
    }

    /// <summary>
    /// A day whose midnight does not exist starts when the clocks jumped, rather than at an
    /// instant that is not on that date at all.
    ///
    /// <para>
    /// Skipped where the platform's tzdb has no such zone — the rule is still right, and a test
    /// that invents a fake zone to assert it would be asserting against its own invention.
    /// </para>
    /// </summary>
    [Fact]
    public void A_day_with_no_midnight_starts_when_the_clocks_jumped()
    {
        // Asia/Beirut springs forward at 00:00, so 2026-03-29T00:00 local never happens there.
        if (!TimeZoneInfo.TryFindSystemTimeZoneById("Asia/Beirut", out var zone)) return;

        var day = new DateOnly(2026, 3, 29);
        if (!zone.IsInvalidTime(day.ToDateTime(TimeOnly.MinValue))) return;

        var start = DoorClock.StartOfLocalDay(zone, day);

        // On that date, and the first instant of it that exists.
        Assert.Equal(day, DoorClock.LocalDateOf(zone, start));
        Assert.True(start.TimeOfDay > TimeSpan.Zero, $"expected a jumped start, got {start:O}");
        Assert.True(DoorClock.IsStartOfLocalDay(zone, start));
    }

    /// <summary>
    /// <c>yesterday</c> is a closed club day and <c>last_24h</c> is a rolling window — the
    /// distinction A4 is about, stated where it is decided rather than only where it is rendered.
    /// </summary>
    [Fact]
    public void Yesterday_is_a_whole_club_day_and_last_24h_is_a_rolling_window()
    {
        var zone = Amsterdam();
        var now = new DateTimeOffset(2026, 6, 15, 9, 50, 0, TimeSpan.FromHours(2));

        var yesterday = DoorPeriod.Resolve(DoorPeriod.Yesterday, zone, now)!.Value;
        Assert.True(DoorClock.IsStartOfLocalDay(zone, yesterday.From));
        Assert.True(DoorClock.IsStartOfLocalDay(zone, yesterday.To));
        Assert.Equal(24, (yesterday.To - yesterday.From).TotalHours);

        var rolling = DoorPeriod.Resolve(DoorPeriod.Last24h, zone, now)!.Value;
        Assert.Equal(now, rolling.To);
        Assert.Equal(now.AddHours(-24), rolling.From);
        Assert.False(DoorClock.IsStartOfLocalDay(zone, rolling.From));
    }

    /// <summary>
    /// The whole-day periods count back in CALENDAR days, so a week containing a transition is
    /// still seven club days and not seven times twenty-four hours.
    /// </summary>
    [Fact]
    public void Last_7d_is_seven_club_days_even_when_one_of_them_is_not_24_hours_long()
    {
        var zone = Amsterdam();
        var now = new DateTimeOffset(2026, 3, 31, 9, 50, 0, TimeSpan.FromHours(2));

        var week = DoorPeriod.Resolve(DoorPeriod.Last7d, zone, now)!.Value;

        Assert.Equal(new DateOnly(2026, 3, 25), DoorClock.LocalDateOf(zone, week.From));
        Assert.True(DoorClock.IsStartOfLocalDay(zone, week.From));

        // Six club days and part of a seventh — and one of those days was twenty-three hours
        // long, so the elapsed time is an hour SHORT of 6 × 24 + 9h50m. Counting back in hours
        // instead of in dates would have started the week an hour into the 25th.
        Assert.Equal((6 * 24) + 9.8333 - 1, (now - week.From).TotalHours, 2);
    }

    /// <summary>A period or a day this server does not know is null, for its caller to refuse by name.</summary>
    [Fact]
    public void A_period_or_a_day_the_server_cannot_read_is_null_rather_than_a_guess()
    {
        var zone = Amsterdam();

        Assert.Null(DoorPeriod.Resolve("last_week", zone, DateTimeOffset.UtcNow));
        Assert.Null(DoorPeriod.Resolve("", zone, DateTimeOffset.UtcNow));
        var now = DateTimeOffset.UtcNow;
        Assert.Null(DoorPeriod.Day("2026-13-40", zone, now));
        Assert.Null(DoorPeriod.Day("yesterday", zone, now));
        Assert.Null(DoorPeriod.Day("2026-9-1", zone, now));
    }
}
