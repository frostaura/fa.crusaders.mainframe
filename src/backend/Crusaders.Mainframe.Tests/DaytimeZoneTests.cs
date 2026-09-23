namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The fixture's own day, pinned at every hour instead of at the one the suite happens to run.
/// </summary>
/// <remarks>
/// <para>
/// <b>This exists because a green suite at 23:42 and a red one at 00:02 were the same commit.</b>
/// <c>AdminDoorsOverviewHttpTests</c> writes door rows at <c>now.AddMinutes(-5)</c> and asserts
/// they count toward TODAY. Against a UTC club that is false for the first five minutes of
/// every day — 00:02 minus five minutes is yesterday, the row falls outside the day window the
/// endpoint correctly computes, and two tests fail in code nobody touched. The product was
/// right; the fixture was asserting something true for 99.7% of the day.
/// </para>
/// <para>
/// <c>DoorClub.DaytimeSettings()</c> answers it by seeding a club in a zone where the current
/// instant reads as mid-afternoon, so "a few minutes ago" is safely inside that club's day
/// whatever the UTC hour. That only works if the zone list actually covers every hour, which
/// is arithmetic nobody should take on trust — hence this.
/// </para>
/// <para>
/// Note what is NOT done here: the clock is not frozen and the tests are not skipped near
/// midnight. A skipped test reports as green while covering nothing, which is the trap
/// <c>memory/gotchas-ci-jobs.md</c> records for the booking caps.
/// </para>
/// </remarks>
public sealed class DaytimeZoneTests
{
    /// <summary>Every hour of the day has a zone where it is the afternoon.</summary>
    [Fact]
    public void A_daytime_zone_exists_for_every_hour_of_the_day()
    {
        // A date with no DST transition anywhere in the list, walked minute by minute would be
        // slow and prove no more: the choice only depends on the hour and the zone offsets.
        var day = new DateTimeOffset(2026, 9, 23, 0, 0, 0, TimeSpan.Zero);

        for (var hour = 0; hour < 24; hour++)
        {
            var instant = day.AddHours(hour);
            var zone = DoorClub.DaytimeZone(instant);
            var local = TimeZoneInfo.ConvertTime(instant, TimeZoneInfo.FindSystemTimeZoneById(zone));

            Assert.True(
                local.Hour is >= 12 and < 20,
                $"at {instant:HH:mm} UTC the chosen zone {zone} reads {local:HH:mm} local, " +
                "which is not an afternoon — a club seeded there can still cross its own midnight");
        }
    }

    /// <summary>
    /// And the margin is real: five minutes either side of the instant stays on the same date.
    /// </summary>
    /// <remarks>
    /// The zone existing is not quite the property the fixtures need. What they need is that
    /// the rows they write — up to five minutes back — and the read that follows both land on
    /// one calendar day in the club's own zone. Noon-to-eight leaves hours of margin at both
    /// ends; this asserts it rather than assuming it.
    /// </remarks>
    [Fact]
    public void The_chosen_zone_leaves_a_margin_on_both_sides_of_the_instant()
    {
        var day = new DateTimeOffset(2026, 9, 23, 0, 0, 0, TimeSpan.Zero);

        for (var hour = 0; hour < 24; hour++)
        {
            var instant = day.AddHours(hour);
            var tz = TimeZoneInfo.FindSystemTimeZoneById(DoorClub.DaytimeZone(instant));

            var before = TimeZoneInfo.ConvertTime(instant.AddMinutes(-5), tz);
            var after = TimeZoneInfo.ConvertTime(instant.AddMinutes(5), tz);

            Assert.Equal(before.Date, after.Date);
        }
    }
}
