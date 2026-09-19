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

    /// <summary>The outcome of one action, in the product's words.</summary>
    public static string? OutcomeOf(string action)
    {
        if (DoorTrail.OutcomeOf(action) is not { } outcome) return null;
        return outcome == DoorTrail.Released ? Released : Refused;
    }

    /// <summary>
    /// One reason code in the product's words.
    ///
    /// <para>
    /// The set is <see cref="GateAccess.Reasons"/> plus the offline path's <c>ok</c>, and an
    /// unrecognised code is returned AS ITSELF rather than mapped to a guess: a board or a
    /// server ahead of this one can write a reason this list has not met, and printing the
    /// code is honest where inventing a sentence for it is not. Block body for the lizard
    /// reason in <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    public static string ReasonOf(string? reason)
    {
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
            _ => reason,
        };
    }
}
