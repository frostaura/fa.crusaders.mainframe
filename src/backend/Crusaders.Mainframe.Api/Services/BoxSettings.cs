namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The numbers the court box's screen and scanner run on, clamped on the way out to the board.
///
/// <para>
/// <b>The rule these obey, which this codebase already follows: the server may narrow, the box
/// clamps, and an absent key changes nothing.</b> Every value below starts at the firmware's
/// own compile-time fallback and is replaced only by an accepted heartbeat, so a box that has
/// never had one behaves exactly as a hand-built box did. That is the same contract the button
/// map has carried since it shipped, applied to nine more numbers.
/// </para>
///
/// <para>
/// <b>Why the clamp is here and not only on the settings PUT.</b> The PUT is not the only way a
/// number reaches the settings column — a hand-edited document, a restored backup or a data
/// migration all bypass it — and the reader's contract is "what a board may act on", which is a
/// different question from "what the column says" with a different answer. That is the
/// <c>DoorSettings</c> split, and it exists because a bound enforced only at the PUT is a bound
/// on the form rather than on the setting.
/// </para>
///
/// <para>
/// <b>Three numbers are deliberately NOT here, and must never be added.</b> The relay hard cap,
/// the minimum relay dwell and the screen's geometry are SAFETY, and a database row is not a
/// safe place for safety. <c>RelayHardCap</c> already argues this for the ninety-minute ceiling
/// and the argument transfers unchanged: a club that can set its own relay cap can leave a bank
/// of lights on all night by typing a number into a form.
/// </para>
/// </summary>
public static class BoxSettings
{
    // ---- How long a decided scan's result stays on the glass (GOAL items 1 and 18) ----

    /// <summary>
    /// Default seconds a decided scan's result holds before the screen reverts to the landing
    /// page — GOAL item 1's "configurable timeout for reverting to the LED landing page,
    /// 10 sec by default".
    ///
    /// <para>
    /// <b>It is also GOAL item 18's rapid-scan window, and there is deliberately only one
    /// number.</b> Item 18 asks that the next person be able to scan within about ten seconds
    /// and that the screen show the time left. That countdown IS this hold, surfaced: a scan
    /// pre-empts the hold immediately and never waits it out, so the count is information
    /// rather than a gate. A second "cooldown" setting would be a second timer describing the
    /// same interval, and a second state that can get stuck — which is the whole class of
    /// defect item 11 is about.
    /// </para>
    /// </summary>
    public const int DefaultLcdRevertSeconds = 10;

    /// <summary>Shortest revert a club may set. Below three seconds a member cannot read the result of their own scan.</summary>
    public const int MinLcdRevertSeconds = 3;

    /// <summary>Longest revert a club may set. Past a minute the box is a screen showing one member's business to the next.</summary>
    public const int MaxLcdRevertSeconds = 60;

    /// <summary>Default seconds the court/time selection screens hold before giving up and reverting.</summary>
    public const int DefaultLcdChoiceSeconds = 20;

    public const int MinLcdChoiceSeconds = 5;
    public const int MaxLcdChoiceSeconds = 60;

    /// <summary>Default seconds the member's name card shows after a recognised scan.</summary>
    public const int DefaultLcdCardSeconds = 2;

    public const int MinLcdCardSeconds = 1;
    public const int MaxLcdCardSeconds = 10;

    /// <summary>Default seconds a one-off hint occupies the bottom row.</summary>
    public const int DefaultLcdHintSeconds = 3;

    public const int MinLcdHintSeconds = 1;
    public const int MaxLcdHintSeconds = 10;

    /// <summary>
    /// Default seconds the box remembers who scanned, so the buttons mean something when they
    /// are pressed.
    ///
    /// <para>
    /// <b>It must never be shorter than <see cref="DefaultLcdChoiceSeconds"/>,</b> or a member
    /// who scans, walks to the court door and comes back finds the pad still holding their
    /// selection while the bridge has forgotten who they are — a selection that then belongs
    /// to nobody. Today the pair holds by accident; <see cref="ScanMemorySeconds"/> makes it
    /// hold by construction.
    /// </para>
    /// </summary>
    public const int DefaultScanMemorySeconds = 30;

    public const int MaxScanMemorySeconds = 300;

    /// <summary>Default minutes the box trusts its adopted clock before it stops printing a time at all.</summary>
    public const int DefaultClockTrustMinutes = 90;

    public const int MinClockTrustMinutes = 5;
    public const int MaxClockTrustMinutes = 1440;

    /// <summary>Whether a box may re-energise relays from the heartbeat's restore answer after a power dip (GOAL item 17).</summary>
    public const bool DefaultRelayRestoreEnabled = true;

    /// <summary>Whether boards should report faults at all (GOAL item 7's device half).</summary>
    public const bool DefaultDeviceFaultReporting = true;

    /// <summary>
    /// Default distinct fault reports one board may emit per hour. The board turns this into a
    /// per-code window of <c>3600 / n</c> seconds, so the default of twenty is one report per
    /// code every three minutes — a link producing four hundred CRC errors a minute costs one
    /// event carrying the number 1200, not four hundred events.
    /// </summary>
    public const int DefaultDeviceFaultMaxPerHour = 20;

    public const int MinDeviceFaultMaxPerHour = 1;
    public const int MaxDeviceFaultMaxPerHour = 120;

    public static int LcdRevertSeconds(TenantSettingsView s) =>
        Math.Clamp(s.LcdRevertSeconds, MinLcdRevertSeconds, MaxLcdRevertSeconds);

    public static int LcdChoiceSeconds(TenantSettingsView s) =>
        Math.Clamp(s.LcdChoiceSeconds, MinLcdChoiceSeconds, MaxLcdChoiceSeconds);

    public static int LcdCardSeconds(TenantSettingsView s) =>
        Math.Clamp(s.LcdCardSeconds, MinLcdCardSeconds, MaxLcdCardSeconds);

    public static int LcdHintSeconds(TenantSettingsView s) =>
        Math.Clamp(s.LcdHintSeconds, MinLcdHintSeconds, MaxLcdHintSeconds);

    /// <summary>
    /// How long the box remembers a scan, clamped — and never below the choice hold.
    ///
    /// <para>
    /// The lower bound is <see cref="LcdChoiceSeconds"/> rather than a constant, which is the
    /// invariant made mechanical: whatever a club sets the selection hold to, the box is
    /// guaranteed to still know who is standing there for at least that long. A club that
    /// lowers the memory below the hold gets the hold, silently and correctly, rather than a
    /// pad holding a choice for a member the bridge has forgotten.
    /// </para>
    /// </summary>
    public static int ScanMemorySeconds(TenantSettingsView s) =>
        Math.Clamp(s.ScanMemorySeconds, LcdChoiceSeconds(s), MaxScanMemorySeconds);

    public static int ClockTrustMinutes(TenantSettingsView s) =>
        Math.Clamp(s.ClockTrustMinutes, MinClockTrustMinutes, MaxClockTrustMinutes);

    public static bool RelayRestoreEnabled(TenantSettingsView s) => s.RelayRestoreEnabled;

    public static bool DeviceFaultReporting(TenantSettingsView s) => s.DeviceFaultReporting;

    public static int DeviceFaultMaxPerHour(TenantSettingsView s) =>
        Math.Clamp(s.DeviceFaultMaxPerHour, MinDeviceFaultMaxPerHour, MaxDeviceFaultMaxPerHour);
}
