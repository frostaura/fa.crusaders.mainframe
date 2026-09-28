using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>Everything the target rule reads about one seat and its booking. No clock, no database.</summary>
public sealed record ShareFacts(
    ParticipantStatus Status,
    bool IsPartner,
    bool SettledOutside,
    decimal ShareCredits,
    decimal ConsentedCredits,
    BookingStatus BookingStatus,
    bool BookingCheckedIn,
    bool Displaced,
    decimal Price,
    decimal Owed);

/// <summary>
/// What a partner should have paid the organiser for one booking, right now — the rule table
/// behind <see cref="ShareLedger"/> (D11). Pure, so every row of it is pinned by a unit test.
///
/// <para>
/// <b>A share is a fraction of what the organiser owes, never of the price.</b>
/// <c>Owed(b)</c> is the settlement model's own figure for the organiser (the payer), so every
/// path the settlement model already decides — a no-show's penalty, a reversal back to the full
/// price, a displacement to nothing, a cancelled court lit after all — moves the partners' shares
/// with it and needs no rule of its own here. The fraction is <c>ShareCredits / P</c>, frozen at
/// the price the court was sold at.
/// </para>
///
/// <list type="table">
///   <item><term>not a partner (organiser, guest)</term><description>0 — they transfer nothing</description></item>
///   <item><term>not accepted (invited, declined, withdrawn, removed, lapsed)</term><description>0 — nobody pays for a seat they did not take</description></item>
///   <item><term>settled outside the app</term><description>0 — the club was told it was paid by hand</description></item>
///   <item><term>displaced</term><description>0 — <c>Owed = 0</c> (settlement model S8)</description></item>
///   <item><term>cancelled before anybody checked in</term><description>0 — the organiser cancelled, so any late-cancel penalty (and any lit time after it) is theirs alone</description></item>
///   <item><term>otherwise</term><description><c>min(consented, ⌊Owed × share / P⌋₂)</c> — a no-show's penalty is shared pro rata; a played or live court is shared in full</description></item>
/// </list>
///
/// <para>
/// <b>Rounded DOWN to the cent</b>, so the partners' targets never sum past <c>Owed</c> and a
/// partner is never charged a fraction of a credit more than their exact share. <b>Capped at the
/// consent</b>, so raising a share after somebody accepted collects nothing until they accept the
/// new figure — and lowering one refunds at the next reconcile.
/// </para>
/// </summary>
public static class ShareRules
{
    public static decimal TargetFor(ShareFacts f)
    {
        if (!f.IsPartner || f.Status != ParticipantStatus.Accepted || f.SettledOutside) return 0m;
        if (f.Displaced || f.BookingStatus == BookingStatus.AdminBlock) return 0m;
        if (f.BookingStatus == BookingStatus.Cancelled && !f.BookingCheckedIn) return 0m;
        if (f.Price <= 0m || f.ShareCredits <= 0m) return 0m;

        var owed = Math.Clamp(f.Owed, 0m, f.Price);
        var fraction = Math.Round(owed * f.ShareCredits / f.Price, 2, MidpointRounding.ToZero);
        return Math.Max(0m, Math.Min(fraction, f.ConsentedCredits));
    }
}
