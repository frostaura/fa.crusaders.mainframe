namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The words a door's outcome and reason are said in — for the ONE surface the server writes
/// prose to, which is the CSV export.
///
/// <para>
/// <b>Copy belongs on the console and this is the exception that proves it.</b> Every other
/// door surface answers codes and the page says them in the club's language; a spreadsheet has
/// no page. The export shipped with <c>released</c>, <c>device.unknown_scan</c> and
/// <c>member_not_active</c> in its cells, so a committee reading a printed log met the
/// database's vocabulary and not the product's (B4). The machine value is kept beside the
/// words in <c>reason_code</c>, because a club filtering a spreadsheet wants the stable one and
/// a club reading it wants the sentence.
/// </para>
///
/// <para>
/// <b>"Lock released", never "Opened".</b> P2 and A1.2: the board energised a lock and this
/// product has no sensor that could say the door moved or who walked through it. The export is
/// the copy most likely to be printed, forwarded and quoted, so it is the last place that
/// sentence may slip.
/// </para>
/// </summary>
public static class DoorWords
{
    /// <summary>What a released scan is called. A1.2.</summary>
    public const string Released = "Lock released";

    /// <summary>What a refused scan is called. A refusal is never anything softer.</summary>
    public const string Refused = "Refused";

    /// <summary>
    /// What a row with no reason on it says. An explicit sentence rather than an empty cell,
    /// because A2's rule is that a row always carries a reason line or says there is none —
    /// and an empty cell in a spreadsheet reads as "nothing happened", not "not recorded".
    /// </summary>
    public const string NoReason = "No reason recorded";

    /// <summary>
    /// Why a board turned somebody away while the link was down: the code they held was not in
    /// the roster it had cached.
    ///
    /// <para>
    /// <b>It is the one refusal with no reason code, and printing "No reason recorded" for it
    /// was wrong twice over (E-L2).</b> The reason IS recorded — it is the action itself,
    /// <c>device.unknown_scan</c> — and a club reading "Refused / No reason recorded" in an
    /// export concludes the system lost the answer rather than that the board had one. A board
    /// deciding alone has exactly one way to refuse: the code was not on the list it last
    /// downloaded. That also explains, on the same row, why some offline rows name a member and
    /// others cannot: a code on the saved list names its holder and an unknown one names nobody
    /// (A3).
    /// </para>
    /// </summary>
    public const string NotOnTheSavedList = "Code not on the door's saved list";

    /// <summary>
    /// R11 D11-2: a member's genuine code the door turned away while it was offline. Neutral —
    /// the board's own reason is not uploaded — and in the "Code already used" family of short
    /// sentences.
    /// </summary>
    public const string RefusedOffline = "Refused offline";

    /// <summary>MCV1-10: the door refused a code it had just opened for — a replayed or photographed code.</summary>
    public const string Replayed = "Code used again (refused as a replay)";

    /// <summary>The outcome of one action, in the product's words.</summary>
    public static string? OutcomeOf(string action)
    {
        if (DoorTrail.OutcomeOf(action) is not { } outcome) return null;
        return outcome == DoorTrail.Released ? Released : Refused;
    }

    /// <summary>
    /// One reason code in the product's words, read together with the ACTION that carried it.
    ///
    /// <para>
    /// The set is <see cref="GateAccess.Reasons"/> plus the offline path's <c>ok</c>, and an
    /// unrecognised code is returned AS ITSELF rather than mapped to a guess: a board or a
    /// server ahead of this one can write a reason this list has not met, and printing the
    /// code is honest where inventing a sentence for it is not. The action is needed for the
    /// one row whose reason lives in the action — see <see cref="NotOnTheSavedList"/>. Block
    /// body for the lizard reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    public static string ReasonOf(string action, string? reason)
    {
        // The ACTION wins here, and it has to now that DoorActivityView names this row's reason
        // `not_recognised` so the filter and the count can reach it (R3-16). The code is the
        // right machine value — it is the same refusal the online path decides — and "Code not
        // recognised" would be the wrong SENTENCE for it, because it drops the one fact that
        // explains why some offline rows name a member and this one cannot: the board was
        // deciding from a saved list. Checked before the reason rather than after, so the
        // sentence cannot drift when the code changes.
        if (reason == DoorTrail.RefusedOffline) return RefusedOffline;
        if (reason == DoorTrail.Replayed) return Replayed;
        if (action == DoorTrail.OfflineUnknownScanAction) return NotOnTheSavedList;

        if (string.IsNullOrWhiteSpace(reason)) return NoReason;

        return reason switch
        {
            GateAccess.Ok => "Recognised and allowed",
            GateAccess.NotRecognised => "Code not recognised",
            GateAccess.MemberNotActive => "Membership not active",
            GateAccess.NoBooking => "No booking in the entry window",
            GateAccess.TooEarly => "Too early for the booking",
            GateAccess.MethodNotSupported => "Scan method not supported at a door",
            GateAccess.NotAGate => "Not a door controller",
            // E10-4: the Night's "code already used" family, not the raw token.
            GateAccess.CodeUsed => "Code already used",
            _ => reason,
        };
    }
}
