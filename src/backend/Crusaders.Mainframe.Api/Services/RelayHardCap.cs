namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The longest the relay bank will hold a court's lights on from one grant.
///
/// <para>
/// This is a property of the hardware, not a policy. The Mega's own auto-off timer clamps
/// every <c>!ON</c> at this many minutes whatever the ESP asked for, and it cannot be
/// changed over the air — the ATmega is USB-flashed, and its ESP sits on Serial3 rather
/// than the bootloader port. So a grant past it is not "a long session": it is minutes
/// the member pays for that the lights cannot deliver, with no refund path and their own
/// booking blocking a re-purchase (review M1).
/// </para>
///
/// <para>
/// One constant, read by everything that can produce a grant — the button map's
/// per-button limit, the walk-up minutes bound, and the activation endpoint's
/// <c>granted_seconds</c> clamp — and pinned to <c>relay_hard_cap_minutes</c> in the
/// shared corpus at <c>src/contracts/device-protocol/buttonmap/cases.json</c>, which the
/// firmware reads too. A change here that the corpus does not carry goes red on both
/// sides; a change on one side only goes red on the other.
/// </para>
/// </summary>
public static class RelayHardCap
{
    public const int Minutes = 90;

    public const int Seconds = Minutes * 60;
}
