using Crusaders.Mainframe.Api.Domain;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Everything the target rule reads about one seat and its booking. No clock, no database.
/// <paramref name="Paid"/> is what the seat's partner has paid so far; <paramref name="Closed"/>
/// says the seat can no longer be collected from — it lapsed, or its share deadline passed — and
/// is false only for an admin's explicit collect.
/// </summary>
public sealed record ShareFacts(
    ParticipantStatus Status,
    bool IsPartner,
    bool SettledOutside,
    int ShareMinutes,
    int ConsentedMinutes,
    BookingStatus BookingStatus,
    bool BookingCheckedIn,
    bool Displaced,
    int Price,
    int Owed,
    int Paid = 0,
    bool Closed = false);

/// <summary>
/// What a partner should have paid the organiser for one booking, right now — the rule table
/// behind <see cref="ShareLedger"/> (D11). Pure, so every row of it is pinned by a unit test.
///
/// <para>
/// <b>A share is a fraction of what the organiser owes, never of the price.</b>
/// <c>Owed(b)</c> is the settlement model's own figure for the organiser (the payer), so every
/// path the settlement model already decides — a no-show's penalty, a reversal back to the full
/// price, a displacement to nothing, a cancelled court lit after all — moves the partners' shares
/// with it and needs no rule of its own here. The fraction is <c>ShareMinutes / P</c>, frozen at
/// the price the court was sold at.
/// </para>
///
/// <list type="table">
///   <item><term>not a partner (organiser, guest)</term><description>0 — they transfer nothing</description></item>
///   <item><term>not accepted (invited, declined, withdrawn, removed, lapsed)</term><description>0 — nobody pays for a seat they did not take</description></item>
///   <item><term>settled outside the app</term><description>0 — the club was told it was paid by hand</description></item>
///   <item><term>displaced</term><description>0 — <c>Owed = 0</c> (settlement model S8)</description></item>
///   <item><term>cancelled before anybody checked in</term><description>0 — the organiser cancelled, so any late-cancel penalty (and any lit time after it) is theirs alone</description></item>
///   <item><term>otherwise</term><description><c>min(consented, ⌊Owed × share / P⌋)</c> in whole minutes — a no-show's penalty is shared pro rata; a played or live court is shared in full</description></item>
///   <item><term>closed (lapsed, or past the share deadline)</term><description>the above, but never more than already paid — a return is still owed, a collection never is</description></item>
/// </list>
///
/// <para>
/// <b>Rounded DOWN to the whole minute</b>, so the partners' targets never sum past <c>Owed</c>,
/// a partner is never charged a part-minute more than their exact share, and the organiser keeps
/// the remainder (P13 §1.2). <b>Capped at the
/// consent</b>, so raising a share after somebody accepted collects nothing until they accept the
/// new figure — and lowering one refunds at the next reconcile.
/// </para>
/// </summary>
public static class ShareRules
{
    public static int TargetFor(ShareFacts f)
    {
        if (!f.IsPartner || f.Status != ParticipantStatus.Accepted || f.SettledOutside) return 0;
        if (f.Displaced || f.BookingStatus == BookingStatus.AdminBlock) return 0;
        if (f.BookingStatus == BookingStatus.Cancelled && !f.BookingCheckedIn) return 0;
        if (f.Price <= 0 || f.ShareMinutes <= 0) return 0;

        var owed = Math.Clamp(f.Owed, 0, f.Price);
        // ⌊owed × share ÷ price⌋ in whole minutes (§1.2): both factors are ≥ 0, so integer division
        // is the floor, and the organiser keeps whatever the partners' floors leave over.
        var fraction = (int)((long)owed * f.ShareMinutes / f.Price);
        var target = Math.Max(0, Math.Min(fraction, f.ConsentedMinutes));

        // No debts (D11): once the seat has closed the organiser's cover stands. What the partner
        // paid can still come back to them — a return follows the organiser's Owed down — but a
        // top-up after the deadline never turns an unpaid share into a collection.
        return f.Closed ? Math.Min(target, Math.Max(0, f.Paid)) : target;
    }
}
