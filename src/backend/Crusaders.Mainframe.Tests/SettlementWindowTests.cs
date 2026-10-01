using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The lit window, on exact clocks — settlement model I6.
///
/// <para>
/// The HTTP tests around this arithmetic all anchor one end of the window to a booking row
/// written a second or two before the upload, so their minute counts carry a sub-second
/// residue that <c>ceil</c> turns into a whole minute. That is fine for asserting the money
/// end to end and useless for asserting <i>which bound did the work</i>, which is the thing
/// that was wrong: every bound here was missing, each in its own way, and each is worth a
/// case where it alone is binding.
/// </para>
///
/// <para>
/// All times are whole minutes off one fixed instant, so every expectation below is exact.
/// </para>
/// </summary>
public class SettlementWindowTests
{
    private static readonly DateTimeOffset T = new(2026, 9, 5, 18, 0, 0, TimeSpan.Zero);

    /// <summary>A booking of <paramref name="soldMinutes"/> starting at <see cref="T"/>.</summary>
    private static Booking Sold(int soldMinutes, int sliceMinutes = 15) => new()
    {
        StartsAt = T,
        EndsAt = T.AddMinutes(soldMinutes),
        SliceMinutes = sliceMinutes,
        SliceCount = soldMinutes / sliceMinutes,
        AmountChargedMinutes = soldMinutes,
    };

    private static long Minutes(int m) => m * 60_000L;

    /// <summary>The ordinary case: a scan inside the slot and a grant that ends inside it.</summary>
    [Fact]
    public void A_grant_that_ends_inside_the_slot_is_the_window()
    {
        var w = DeviceEventEndpoints.LitWindowOf(Sold(60), T.AddMinutes(10), Minutes(20), heldMs: null);

        Assert.Equal(T.AddMinutes(10), w.Start);
        Assert.Equal(T.AddMinutes(30), w.End);
        Assert.Equal(20, w.Minutes);
    }

    /// <summary>
    /// The lower bound. The roster's window opens a cue window <b>before</b> the slot, so the
    /// grant a box hands out to an early scanner runs from before the member bought anything.
    /// Those minutes are not court time and are not billed: the window starts at
    /// <c>StartsAt</c>.
    /// </summary>
    [Fact]
    public void A_scan_inside_the_cue_window_is_billed_from_the_slot_start()
    {
        var w = DeviceEventEndpoints.LitWindowOf(Sold(60), T.AddMinutes(-10), Minutes(40), heldMs: null);

        Assert.Equal(T, w.Start);                       // not the scan
        Assert.Equal(T.AddMinutes(30), w.End);          // scan + 40, which is inside the slot
        Assert.Equal(30, w.Minutes);                    // not the 40 the relay was given
    }

    /// <summary>
    /// The upper bound. A grant longer than what is left of the slot cannot bill past the end
    /// of what was sold, however long the relay was told to run.
    /// </summary>
    [Fact]
    public void A_grant_running_past_the_sold_end_is_cut_at_it()
    {
        var w = DeviceEventEndpoints.LitWindowOf(Sold(60), T.AddMinutes(10), Minutes(60), heldMs: null);

        Assert.Equal(T.AddMinutes(10), w.Start);
        Assert.Equal(T.AddMinutes(60), w.End);          // the sold end, not scan + 60
        Assert.Equal(50, w.Minutes);
    }

    /// <summary>
    /// The measurement. Once the box's own <c>release</c> has landed, <c>heldMs</c> is what
    /// the relay actually did and the grant is only an upper bound on it.
    /// </summary>
    [Fact]
    public void A_release_narrows_the_window_to_what_the_relay_measured()
    {
        var w = DeviceEventEndpoints.LitWindowOf(Sold(60), T, Minutes(60), heldMs: Minutes(20));

        Assert.Equal(T.AddMinutes(20), w.End);
        Assert.Equal(20, w.Minutes);
    }

    /// <summary>A release claiming more than the grant does not widen it — the grant is a ceiling.</summary>
    [Fact]
    public void A_release_longer_than_the_grant_does_not_widen_the_window()
    {
        var w = DeviceEventEndpoints.LitWindowOf(Sold(60), T, Minutes(20), heldMs: Minutes(45));

        Assert.Equal(T.AddMinutes(20), w.End);
        Assert.Equal(20, w.Minutes);
    }

    /// <summary>
    /// The relay bank opens after ninety minutes whatever it is told, so no honest charge can
    /// exceed it — the one bound that still bites once the other two have applied.
    /// </summary>
    [Fact]
    public void The_relay_hard_cap_bounds_a_slot_longer_than_the_relay_will_run()
    {
        var w = DeviceEventEndpoints.LitWindowOf(Sold(120), T, Minutes(120), heldMs: null);

        Assert.Equal(T.AddMinutes(120), w.End);
        Assert.Equal(90, w.Minutes);
    }

    /// <summary>
    /// A grant of zero — the event carried none — falls back to the sold window rather than
    /// to nothing. The lights demonstrably ran; how long is what the release will say.
    /// </summary>
    [Fact]
    public void A_missing_grant_falls_back_to_the_sold_window()
    {
        var w = DeviceEventEndpoints.LitWindowOf(Sold(45), T, grantMs: 0, heldMs: null);

        Assert.Equal(T.AddMinutes(45), w.End);
        Assert.Equal(45, w.Minutes);
    }

    /// <summary>
    /// A scan after the slot has already ended lights nothing anybody bought. Zero minutes,
    /// which the caller turns into "nothing to charge" rather than the one-minute floor the
    /// old arithmetic applied unconditionally.
    /// </summary>
    [Fact]
    public void A_scan_after_the_sold_window_has_ended_bills_nothing()
    {
        var w = DeviceEventEndpoints.LitWindowOf(Sold(45), T.AddMinutes(50), Minutes(30), heldMs: null);

        Assert.Equal(0, w.Minutes);
    }

    /// <summary>
    /// A part-minute is two numbers. The court WAS lit into its second minute, so the board and
    /// the audit say 2; but the charge keeps the remainder with whoever pays (contract §1.2,
    /// §12.6), so the money path bills 1.
    /// </summary>
    [Fact]
    public void A_part_minute_is_shown_rounded_up_and_charged_rounded_down()
    {
        var w = DeviceEventEndpoints.LitWindowOf(Sold(60), T, 90_000L, heldMs: null);

        Assert.Equal(2, w.Minutes);
        Assert.Equal(1, w.ChargeMinutes);
    }

    /// <summary>
    /// A measured release of 44 min 59 s on a 45-minute court charges 44, never 45 — and a
    /// release just under one minute charges nothing at all.
    /// </summary>
    [Theory]
    [InlineData(44 * 60_000L + 59_000L, 45, 44)]
    [InlineData(59_000L, 1, 0)]
    [InlineData(20 * 60_000L, 20, 20)]
    public void The_charge_rounds_a_measured_release_down(long heldMs, int shown, int charged)
    {
        var w = DeviceEventEndpoints.LitWindowOf(Sold(45), T, Minutes(45), heldMs);

        Assert.Equal(shown, w.Minutes);
        Assert.Equal(charged, w.ChargeMinutes);
    }
}
