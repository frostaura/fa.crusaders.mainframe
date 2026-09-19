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
    ///
    /// <para>
    /// <b>Both terms are clamped on read, like every other window in this type.</b> This one
    /// was left raw when <see cref="DoorHorizonMinutes"/> gained its clamps, which made the
    /// two disagree about the same settings document — the door bounded and the phone not —
    /// and the phone is what the door's horizon is defined as being equal to. A hand-edited
    /// <c>roster_window_minutes: -600</c> stopped the member's screen offering a booking code
    /// at all, silently, while the door went on accepting one; the reverse of the drift the
    /// sharing of this arithmetic exists to prevent.
    /// </para>
    /// </summary>
    public static int DisplayHorizonMinutes(TenantSettingsView settings)
    {
        return RosterReachMinutes(settings) + CueMinutes(settings);
    }

    /// <summary>
    /// <c>roster_window_minutes</c>, clamped to the range the settings PUT declares. The one
    /// place that number is read — by this type, by both roster builders and by the phone —
    /// so a hand-edited column cannot mean three different things.
    /// </summary>
    public static int RosterReachMinutes(TenantSettingsView settings)
    {
        return Math.Clamp(
            settings.RosterWindowMinutes,
            TenantSettingsView.MinRosterWindowMinutes,
            TenantSettingsView.MaxRosterWindowMinutes);
    }

    /// <summary>
    /// <c>activation_cue_window_minutes</c>, clamped to the range the settings PUT declares.
    /// </summary>
    public static int CueMinutes(TenantSettingsView settings)
    {
        return Math.Clamp(
            settings.ActivationCueWindowMinutes, 0, TenantSettingsView.MaxActivationCueWindowMinutes);
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
    ///
    /// <para>
    /// <b>And there is a CEILING on the whole thing, which there was not.</b>
    /// <see cref="GateAccess.MaxEarlyEntryMinutes"/> is four hours and its own comment says
    /// so in those words, but it bounded <c>gate_early_entry_minutes</c> alone. The other
    /// term is two settings the PUT bounds at a day each and cross-checks only against each
    /// other, so a club could set both to their legal maxima and give every booking code in
    /// the building a forty-eight-hour door window — with the spec still saying four hours,
    /// the console still saying four hours, and nothing red. The <c>min</c> against the
    /// ceiling is what makes the sentence true.
    /// </para>
    ///
    /// <para>
    /// <b>All three numbers are clamped HERE, on read, rather than trusted from the column.</b>
    /// <c>TenantSettingsAccessor</c> reads this document with no bounds at all, so the PUT is
    /// not the only way a value reaches it — a hand-edited row is, exactly as it is for
    /// <c>gate_unlock_seconds</c>, which has been clamped on the way out since it shipped for
    /// this reason. A door is where that argument is strongest and it was the one door number
    /// without it.
    /// </para>
    ///
    /// <para>
    /// The phone is deliberately NOT narrowed to match (<see cref="DisplayHorizonMinutes"/>
    /// is untouched). Where the club's horizon exceeds the ceiling a member holds a code the
    /// door will not yet accept, and the door answers <see cref="GateAccess.TooEarly"/> —
    /// honest, actionable, and the refusal a person outside a building can do something
    /// about. Narrowing the screen instead would hide a booking's code from the member who
    /// owns it.
    /// </para>
    /// </summary>
    public static int DoorHorizonMinutes(TenantSettingsView settings)
    {
        var early = EntryWindowMinutes(settings);
        if (settings.GateAccessPolicy == GateAccessPolicies.BookingWindow) return early;

        return Math.Max(
            early, Math.Min(DisplayHorizonMinutes(settings), GateAccess.MaxEarlyEntryMinutes));
    }

    /// <summary>
    /// How long before a booking its holder may come into the building —
    /// <c>gate_early_entry_minutes</c>, clamped to the range the settings PUT declares.
    ///
    /// <para>
    /// The one place that number is read, so the three windows built from it — the cached
    /// roster's, the <c>booking_window</c> policy's, and the floor under
    /// <see cref="DoorHorizonMinutes"/> — cannot end up with three different answers about
    /// what a hand-edited column means. Leaving the roster unclamped would be the worse
    /// half of that: a door admitting more from its cache than it does online is the exact
    /// asymmetry the <c>max</c> above exists to prevent.
    /// </para>
    /// </summary>
    public static int EntryWindowMinutes(TenantSettingsView settings)
    {
        return Math.Clamp(settings.GateEarlyEntryMinutes, 0, GateAccess.MaxEarlyEntryMinutes);
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
