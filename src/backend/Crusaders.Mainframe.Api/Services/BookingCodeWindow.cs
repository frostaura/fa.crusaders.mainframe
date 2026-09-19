namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// How long a booking's own activation code is good for — the one window, shared by the
/// screen that shows it and the door that accepts it.
///
/// <para>
/// <b>A booking code is not a standing building key.</b> It is minted with the booking, lives
/// until the slot ends plus the grace window, and is a stable token for that whole time —
/// which is exactly what makes it dangerous at a door. Left unbounded, a code the member's
/// phone happened to show at 17:00 opened every door in the club at 03:00 the same night, and
/// a captured roster bought a building key rather than an entry to one booking. The bound is
/// the booking's own window, under every policy.
/// </para>
///
/// <para>
/// <b>The point of this type is that there is one copy of the arithmetic.</b>
/// <c>QrEndpoints</c> decides whether the member's phone will show a booking's code at all,
/// and <see cref="GateAccess"/> decides whether the door will accept it; under the default
/// policy those are the SAME predicate, and they were two independent rearrangements of it in
/// two files. Two copies of "is this booking in reach" is how a member ends up holding a code
/// their own club's door refuses — or, worse, holding one it accepts eight hours early.
/// </para>
/// </summary>
public static class BookingCodeWindow
{
    /// <summary>
    /// How far ahead of a booking the member's phone will show that booking's own code:
    /// <c>roster_window_minutes + activation_cue_window_minutes</c>.
    ///
    /// <para>
    /// This is <c>QrEndpoints</c>' <c>?kind=auto</c> rule, stated once. A booking is "in reach"
    /// when its activation window — from the cue before it starts until it ends — overlaps the
    /// next roster window, which is the same horizon a court box's cached roster looks ahead.
    /// </para>
    /// </summary>
    public static int DisplayHorizonMinutes(TenantSettingsView settings)
    {
        return settings.RosterWindowMinutes + settings.ActivationCueWindowMinutes;
    }

    /// <summary>
    /// How far ahead of a booking a door will accept that booking's own code, under the club's
    /// current <c>gate_access_policy</c>.
    ///
    /// <para>
    /// Under <see cref="GateAccessPolicies.BookingWindow"/> it is
    /// <c>gate_early_entry_minutes</c> and nothing else: that policy's whole claim is that a
    /// member may be in the building because they are due on a court, and the entry window is
    /// when they are due.
    /// </para>
    ///
    /// <para>
    /// Under <see cref="GateAccessPolicies.ActiveMember"/> it is the wider of the entry window
    /// and <see cref="DisplayHorizonMinutes"/> — which is to say, the door accepts exactly as
    /// long as the member's own phone would have shown them the code. Narrower than that would
    /// refuse a code the product itself put on their screen; wider would be the standing key
    /// again.
    /// </para>
    ///
    /// <para>
    /// <b>The <c>max</c> is what keeps online at least as permissive as offline</b>, and that
    /// is not decoration. The cached roster admits a booking from
    /// <c>StartsAt − gate_early_entry_minutes</c>, so a door that accepted a narrower window
    /// while it could reach the server would refuse, online, a member it would have let in
    /// during an outage — and no club is going to be told that its doors work better when the
    /// network is down.
    /// </para>
    /// </summary>
    public static int DoorHorizonMinutes(TenantSettingsView settings)
    {
        return settings.GateAccessPolicy == GateAccessPolicies.BookingWindow
            ? settings.GateEarlyEntryMinutes
            : Math.Max(settings.GateEarlyEntryMinutes, DisplayHorizonMinutes(settings));
    }

    /// <summary>
    /// The latest <c>StartsAt</c> a booking may carry and still be inside
    /// <paramref name="horizonMinutes"/> of <paramref name="now"/>.
    ///
    /// <para>
    /// <c>StartsAt − horizon ≤ now</c> rearranged to <c>StartsAt ≤ now + horizon</c>: a
    /// comparison against a constant, which is what the provider can translate, and the same
    /// rearrangement <c>DeviceRosterBuilder</c> and <c>DeviceGateRosterBuilder</c> use. Shared
    /// rather than rewritten at each call site because the rearrangement is the half that gets
    /// copied wrong.
    /// </para>
    /// </summary>
    public static DateTimeOffset LatestStart(DateTimeOffset now, int horizonMinutes)
    {
        return now.AddMinutes(horizonMinutes);
    }
}
