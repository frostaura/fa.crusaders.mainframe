using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The heartbeat interval an admin may set, and the offline threshold derived from it.
///
/// <para>
/// Round-3 finding 22, escalated from lead L9: the API accepted 10–3600, the Settings page
/// said 3600 was fine, <c>bridgelogic::Cadence</c> clamped whatever arrived into [15, 300],
/// and the Devices page called a box offline after a fixed 180 s against a stale "every
/// 30 s" comment. So an admin who set 300 to reduce chatter saw every box read WifiOff for
/// forty per cent of every interval and went power-cycling healthy hardware; one who set
/// 600 had a fleet running at 300 with the page reporting 600 and nothing anywhere saying
/// so. The API accepts only what the boxes honour, and the threshold follows the interval.
/// </para>
/// </summary>
public sealed class HeartbeatCadenceTests
{
    /// <summary>
    /// These are the firmware's own bounds, transcribed. A change to
    /// <c>bridgelogic::kMinHeartbeatMs</c> / <c>kMaxHeartbeatMs</c> that does not land here
    /// puts the API back to accepting settings the fleet silently ignores.
    /// </summary>
    [Fact]
    public void The_bounds_are_the_firmwares_own()
    {
        Assert.Equal(15, HeartbeatCadence.MinSeconds);      // bridgelogic::kMinHeartbeatMs / 1000
        Assert.Equal(300, HeartbeatCadence.MaxSeconds);     // bridgelogic::kMaxHeartbeatMs / 1000
    }

    [Theory]
    [InlineData(5, 15)]
    [InlineData(15, 15)]
    [InlineData(60, 60)]
    [InlineData(300, 300)]
    [InlineData(600, 300)]
    [InlineData(3600, 300)]
    public void The_effective_interval_is_what_the_box_will_run_at(int configured, int expected)
        => Assert.Equal(expected, HeartbeatCadence.Effective(configured));

    /// <summary>
    /// Three missed beats, floored at the old fixed 180 s. The floor is what stops a club on
    /// the 15-second minimum being called offline after 45 seconds of ordinary jitter; above
    /// 60 the threshold moves with the interval, which is the collision this closes.
    /// </summary>
    [Theory]
    [InlineData(15, 180)]
    [InlineData(60, 180)]      // the default: unchanged from the page's old hardcoded value
    [InlineData(120, 360)]
    [InlineData(300, 900)]
    [InlineData(3600, 900)]    // clamped first, then tripled — never derived from a number no box runs
    public void The_offline_threshold_follows_the_effective_interval(int configured, int expected)
        => Assert.Equal(expected, HeartbeatCadence.OfflineAfterSeconds(configured));

    /// <summary>
    /// A box is never called offline before it was due to call at all — the property that
    /// makes the threshold usable, stated rather than inferred from the table above.
    /// </summary>
    [Theory]
    [InlineData(15)]
    [InlineData(60)]
    [InlineData(300)]
    [InlineData(600)]
    public void The_threshold_always_allows_at_least_one_missed_beat(int configured)
        => Assert.True(HeartbeatCadence.OfflineAfterSeconds(configured) > HeartbeatCadence.Effective(configured));

    /// <summary>The default a club starts on is inside the range the API will accept.</summary>
    [Fact]
    public void The_default_setting_is_within_the_accepted_range()
    {
        Assert.InRange(
            TenantSettingsView.DefaultHeartbeatSeconds,
            HeartbeatCadence.MinSeconds,
            HeartbeatCadence.MaxSeconds);
    }
}
