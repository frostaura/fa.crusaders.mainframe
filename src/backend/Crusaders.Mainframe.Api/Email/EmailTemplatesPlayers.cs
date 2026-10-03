namespace Crusaders.Mainframe.Api.Email;

/// <summary>A game somebody has been asked to join, and what their share of it would be.</summary>
public sealed record PlayerInviteNotice(
    string OrganiserName, string CourtName, string StartsAtLocal, int ShareMinutes, string AcceptUrl);

/// <summary>Which way a share moved, from the reader's side of it.</summary>
public enum ShareDirection
{
    /// <summary>The reader paid their share to the organiser.</summary>
    Paid,

    /// <summary>The reader (the organiser) received a partner's share.</summary>
    Received,

    /// <summary>The reader's share came back to them.</summary>
    Refunded,

    /// <summary>The reader (the organiser) handed a partner's share back.</summary>
    Returned,
}

/// <summary>One share movement, as the person on one side of it reads it.</summary>
/// <param name="HeldUntilLocal">
/// A share an organiser RECEIVES is held until the booking's share deadline (D11) — "added to your
/// balance" alone read as money they could spend now (review round 1, B12).
/// </param>
/// <param name="ByClub">The club collected it (an admin's collect), not the partner (B8).</param>
/// <param name="BalanceAfterMinutes">The partner's balance after a club collect — said when it is below zero (B8).</param>
public sealed record ShareMovement(
    ShareDirection Direction, string OtherName, string CourtName, string StartsAtLocal, int AmountMinutes, string BookingUrl,
    string? HeldUntilLocal = null, bool ByClub = false, int? BalanceAfterMinutes = null)
{
    /// <summary>The club took the partner off the game and this is the share going back (review round 2, B-8).</summary>
    public bool ClubRemoved { get; init; }

    /// <summary>The reason the admin recorded for a club collect or removal — the adjust mail always carried one (B-8).</summary>
    public string? ClubReason { get; init; }

    /// <summary>
    /// The share was taken again because the booking's refund was reversed — the court's late
    /// check-in showed the session was attended (review round 9, E9-2). A plain "You paid your
    /// share" told the partner nothing about why minutes left their balance for a refunded game.
    /// </summary>
    public bool AfterAttendance { get; init; }

    /// <summary>
    /// Review round 10, E10-7: the share went back because the CLUB refunded the session — one of
    /// <see cref="ShareRefundCauses"/> — not because the organiser returned it. Null otherwise.
    /// </summary>
    public string? ClubRefund { get; init; }

    /// <summary>
    /// Review round 11, E11-2: on a no-show return, the partner's part of the no-show penalty — the
    /// minutes of their share that did NOT come back. Null when nothing was kept. "The club refunded
    /// the session" alone left a partner who paid 15 and got 11 back with 4 unexplained.
    /// </summary>
    public int? KeptMinutes { get; init; }

    /// <summary>A no-show return that kept part of the share (E11-2).</summary>
    public bool KeptForNoShow => ClubRefund == ShareRefundCauses.NoShow && KeptMinutes is > 0;
}

/// <summary>Why the club refunded a split session, so a returned share can say so (E10-7).</summary>
public static class ShareRefundCauses
{
    /// <summary>The sweep refunded it in full: the court's box was offline.</summary>
    public const string Outage = "outage";

    /// <summary>The sweep settled it as a no-show: nobody checked in.</summary>
    public const string NoShow = "no_show";

    /// <summary>It was displaced: the court was already in use by an earlier booking.</summary>
    public const string Displaced = "displaced";

    /// <summary>The cause in words, after "because"; null for a value this build does not know.</summary>
    public static string? Because(string? cause)
    {
        return cause switch
        {
            Outage => "the court's box was offline",
            NoShow => "nobody checked in",
            Displaced => "the court was already in use by an earlier booking",
            _ => null,
        };
    }
}

/// <summary>
/// The club put the reader on a game (an admin's add) or accepted one for them — review round 1,
/// B8: neither was told to the member at all. <paramref name="Accepted"/>: they are in, and nothing
/// is taken for their share until they accept it themselves (an admin's acceptance records no consent).
/// </summary>
public sealed record ClubSeatNotice(
    string OrganiserName, string CourtName, string StartsAtLocal, int ShareMinutes, bool Accepted, string Url);

/// <summary>A share still waiting — a reminder from the club, or a nudge from the organiser.</summary>
public sealed record ShareReminderNotice(
    string OrganiserName, string CourtName, string StartsAtLocal, int ShareMinutes, string DeadlineLocal,
    bool FromOrganiser, string AcceptUrl);

/// <summary>A share whose deadline passed. <see cref="ToOrganiser"/> decides who is reading.</summary>
public sealed record ShareLapsedNotice(
    string OtherName, string CourtName, string StartsAtLocal, int UnpaidMinutes, bool ToOrganiser, string BookingUrl);

/// <summary>A paid share on its way back to a partner, waiting until the organiser's minutes cover it.</summary>
public sealed record ShareReturnWaitingNotice(
    string OtherName, string CourtName, string StartsAtLocal, int AmountMinutes, bool ToOrganiser, string BookingUrl);

/// <summary>A change to a game the reader is in — they were taken off it, or their share moved.</summary>
public sealed record PlayersChange(
    string OrganiserName, string CourtName, string StartsAtLocal, bool Removed, int? NewShareMinutes, bool NeedsConsent,
    string BookingUrl)
{
    /// <summary>The club, not the organiser, took the reader off (review round 2, B-8).</summary>
    public bool ByClub { get; init; }
}

/// <summary>
/// The messages a game with more than one player sends (D11): the invite, the receipt for every
/// share that moves, the reminder, the lapse, a cancellation and a change.
/// </summary>
/// <remarks>
/// <para>
/// A partial of <see cref="EmailTemplates"/> for the length reason the admin-role partial gives.
/// Every figure is MINUTES — a share is a slice of a booking's minutes, and a minutes figure
/// never wears a money sign.
/// </para>
/// <para>
/// <b>No mail here ever says the reader owes anything.</b> A partner who does not pay is not in
/// debt: after the deadline the organiser's cover stands and the matter is closed. The wording is
/// held to that, because Playtomic's worst habit is a ledger of debts between friends.
/// </para>
/// </remarks>
public static partial class EmailTemplates
{
    private const string WhyGame =
        "You're getting this because a member of the club added you to a court booking.";

    /// <summary>A member has been asked to play, with their share and a link that opens the invite.</summary>
    public static EmailMessage PlayerInvite(ClubIdentity club, string to, PlayerInviteNotice n) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"{n.OrganiserName} invited you to play — {n.CourtName}",
            Preheader: n.ShareMinutes > 0
                ? $"{n.StartsAtLocal}. Your share would be {Min(n.ShareMinutes)}."
                : $"{n.StartsAtLocal}. {n.OrganiserName} is covering the court.",
            Heading: "You've been invited to a game",
            Blocks:
            [
                new Paragraph($"{n.OrganiserName} has booked {n.CourtName} at {club.Name} and would like you to play."),
                new Facts(
                [
                    new FactRow("Court", n.CourtName),
                    new FactRow("When", n.StartsAtLocal),
                    new FactRow("Your share", n.ShareMinutes > 0 ? Min(n.ShareMinutes) : "Nothing — covered"),
                ]),
                new CallToAction("See the invite", n.AcceptUrl),
                new Footnote("Nothing is taken until you accept. If you would rather not play, decline and the seat goes back to the organiser."),
            ],
            WhyThis: WhyGame));

    /// <summary>The receipt for a share moving, on whichever side of it the reader is.</summary>
    public static EmailMessage ShareMoved(ClubIdentity club, string to, ShareMovement m) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: ShareSubject(m),
            Preheader: $"{m.CourtName}, {m.StartsAtLocal}.",
            Heading: ShareHeading(m),
            Blocks: ShareBlocks(m),
            WhyThis: WhyMoney));

    private static List<EmailBlock> ShareBlocks(ShareMovement m)
    {
        var facts = new List<FactRow>
        {
            new("Court", m.CourtName),
            new("When", m.StartsAtLocal),
            new(m.Direction is ShareDirection.Paid or ShareDirection.Returned ? "Taken from your balance" : "Added to your balance", Min(m.AmountMinutes)),
        };
        if (m.HeldUntilLocal is { } held) facts.Add(new("Held until", held));
        var blocks = new List<EmailBlock> { new Paragraph(ShareSentence(m)) };
        if (m.ClubReason is { Length: > 0 } reason) blocks.Add(new Callout(CalloutTone.Info, $"Reason given by the club: {reason}"));
        blocks.Add(new Facts(facts));

        // B12: received shares are held to the deadline in case one has to go back (D11) — say so,
        // or "added to your balance" reads as money to spend tonight.
        if (m.HeldUntilLocal is { } until)
        {
            blocks.Add(new Callout(CalloutTone.Info,
                $"It is held until {until} in case a share has to go back to a player, and you can spend it after that."));
        }

        // B8: a club collect may take a partner below zero, by name — tell them where they stand.
        if (m.ByClub && m.BalanceAfterMinutes is { } after && after < 0)
        {
            blocks.Add(new Callout(CalloutTone.Warning,
                $"Your balance is now {Min(after)}, below zero. Buy minutes before you book again."));
        }
        blocks.Add(new CallToAction("Open the booking", m.BookingUrl));
        blocks.Add(new Footnote("Shares move between players only. The club's price for the court is unchanged."));
        return blocks;
    }

    /// <summary>The club added the reader to a game, or accepted one for them (B8).</summary>
    public static EmailMessage ClubSeat(ClubIdentity club, string to, ClubSeatNotice n) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: n.Accepted ? $"The club put you in {n.OrganiserName}'s game — {n.CourtName}" : $"The club added you to {n.OrganiserName}'s game — {n.CourtName}",
            Preheader: $"{n.StartsAtLocal}.",
            Heading: n.Accepted ? "You're in a game" : "You've been added to a game",
            Blocks: ClubSeatBlocks(n),
            WhyThis: WhyGame));

    private static List<EmailBlock> ClubSeatBlocks(ClubSeatNotice n)
    {
        var blocks = new List<EmailBlock>
        {
            new Paragraph(n.Accepted
                ? $"The club has put you in the game {n.OrganiserName} booked for {n.CourtName} at {n.StartsAtLocal}."
                : $"The club has added you to the game {n.OrganiserName} booked for {n.CourtName} at {n.StartsAtLocal}, and it is waiting for your answer."),
            new Facts(
            [
                new FactRow("Court", n.CourtName),
                new FactRow("When", n.StartsAtLocal),
                new FactRow("Your share", n.ShareMinutes > 0 ? Min(n.ShareMinutes) : "Nothing — covered"),
            ]),
        };
        if (n.ShareMinutes > 0)
        {
            blocks.Add(new Callout(CalloutTone.Info, n.Accepted
                ? "Nothing is taken from your balance for your share until you accept it yourself in the app."
                : "Nothing is taken until you accept. If you would rather not play, decline and the seat goes back to the organiser."));
        }
        blocks.Add(new CallToAction(n.Accepted ? "Open the booking" : "See the invite", n.Url));
        return blocks;
    }

    /// <summary>A share still waiting: the club's reminder, or the organiser's nudge.</summary>
    public static EmailMessage ShareReminder(ClubIdentity club, string to, ShareReminderNotice n) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: n.FromOrganiser ? $"{n.OrganiserName} is waiting for your answer — {n.CourtName}" : $"Your invite is still open — {n.CourtName}",
            Preheader: $"Your share is {Min(n.ShareMinutes)}. It can be paid until {n.DeadlineLocal}.",
            Heading: "Your share is still open",
            Blocks:
            [
                new Paragraph(n.FromOrganiser
                    ? $"{n.OrganiserName} would like to know if you are playing on {n.CourtName} at {n.StartsAtLocal}."
                    : $"You have an open invite from {n.OrganiserName} for {n.CourtName} at {n.StartsAtLocal}."),
                new Facts(
                [
                    new FactRow("Your share", Min(n.ShareMinutes)),
                    new FactRow("Open until", n.DeadlineLocal),
                ]),
                new CallToAction("Answer the invite", n.AcceptUrl),
                new Footnote("If you do nothing, the invite simply closes and the organiser covers the seat. You will not owe anything."),
            ],
            WhyThis: WhyGame));

    /// <summary>A share whose deadline passed with part of it unpaid.</summary>
    public static EmailMessage ShareLapsed(ClubIdentity club, string to, ShareLapsedNotice n) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: n.ToOrganiser ? $"{n.OtherName}'s share has closed — {n.CourtName}" : $"Your invite has closed — {n.CourtName}",
            Preheader: n.ToOrganiser ? "Your booking covers the seat, as it did from the start." : "Nothing is owed.",
            Heading: "A share has closed",
            Blocks:
            [
                new Paragraph(n.ToOrganiser
                    ? $"{n.OtherName} did not pay {Min(n.UnpaidMinutes)} of their share for {n.CourtName} at {n.StartsAtLocal} before it closed. Your booking already covered the court, so nothing else moves."
                    : $"Your share for {n.CourtName} at {n.StartsAtLocal} closed before it was paid. {n.OtherName}'s booking covers it and nothing is owed."),
                new CallToAction("Open the booking", n.BookingUrl),
            ],
            WhyThis: WhyGame));

    /// <summary>
    /// A return of a paid share is waiting: the organiser's minutes do not cover it yet. Told once
    /// to each side. It moves on its own the moment they do — buying a package is enough — and the
    /// wording says so, and no more: nobody here is in anybody's debt.
    /// </summary>
    public static EmailMessage ShareReturnWaiting(ClubIdentity club, string to, ShareReturnWaitingNotice n) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: n.ToOrganiser ? $"{Min(n.AmountMinutes)} for {n.OtherName} is waiting — {n.CourtName}" : $"{Min(n.AmountMinutes)} is on its way back — {n.CourtName}",
            Preheader: n.ToOrganiser ? "It goes back as soon as your balance covers it." : "It reaches you as soon as it can be sent.",
            Heading: "A share is on its way back",
            Blocks:
            [
                new Paragraph(n.ToOrganiser
                    ? $"{Min(n.AmountMinutes)} of {n.OtherName}'s share for {n.CourtName} at {n.StartsAtLocal} is due back to them. Your balance doesn't cover it right now, so it will go back automatically the next time it does."
                    : $"{Min(n.AmountMinutes)} of your share for {n.CourtName} at {n.StartsAtLocal} is due back to you from {n.OtherName}. It will reach your balance automatically as soon as it can be sent."),
                new CallToAction("Open the booking", n.BookingUrl),
            ],
            WhyThis: WhyGame));

    /// <summary>A game the reader was in has been cancelled.</summary>
    public static EmailMessage PlayersBookingCancelled(
        ClubIdentity club, string to, string organiserName, string courtName, string startsAtLocal) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"Game cancelled — {courtName}",
            Preheader: $"{startsAtLocal}. Any share you paid comes back to you.",
            Heading: "This game has been cancelled",
            Blocks:
            [
                new Paragraph($"The booking {organiserName} made for {courtName} at {startsAtLocal} has been cancelled."),
                new Callout(CalloutTone.Info, "If you had paid a share, it comes back to your balance — you will get a separate receipt for it."),
            ],
            WhyThis: WhyGame));

    /// <summary>The reader was taken off a game, or their share of it changed.</summary>
    public static EmailMessage PlayersChanged(ClubIdentity club, string to, PlayersChange c) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: c.Removed ? $"You've been taken off a game — {c.CourtName}" : $"Your share has changed — {c.CourtName}",
            Preheader: c.StartsAtLocal,
            Heading: c.Removed ? "You're no longer in this game" : "Your share has changed",
            Blocks: ChangeBlocks(c),
            WhyThis: WhyGame));

    private static List<EmailBlock> ChangeBlocks(PlayersChange c)
    {
        var blocks = new List<EmailBlock>
        {
            new Paragraph(ChangeSentence(c)),
        };
        if (!c.Removed && c.NewShareMinutes is { } share) blocks.Add(new Facts([new FactRow("Your share now", Min(share))]));
        if (c.NeedsConsent) blocks.Add(new Callout(CalloutTone.Warning, "Your share went up. Nothing more is taken until you accept the new figure."));
        blocks.Add(new CallToAction("Open the booking", c.BookingUrl));
        return blocks;
    }

    private static string ChangeSentence(PlayersChange c)
    {
        if (c.Removed && c.ByClub)
        {
            return $"The club has taken you off the booking {c.OrganiserName} made for {c.CourtName} at {c.StartsAtLocal}. Any share you paid comes back to you.";
        }
        return c.Removed
            ? $"{c.OrganiserName} has taken you off the booking for {c.CourtName} at {c.StartsAtLocal}. Any share you paid comes back to you."
            : $"{c.OrganiserName} has changed how {c.CourtName} at {c.StartsAtLocal} is split.";
    }

    private static string ShareSubject(ShareMovement m)
    {
        if (m.AfterAttendance && m.Direction == ShareDirection.Paid) return $"Share taken again — {m.CourtName}";
        if (m.AfterAttendance && m.Direction == ShareDirection.Received) return $"{m.OtherName}'s share came back to you — {m.CourtName}";
        if (RefundSubject(m) is { } refund) return refund;
        if (m.ByClub && m.Direction == ShareDirection.Paid) return $"The club collected your share — {m.CourtName}";
        if (m.ClubRemoved && m.Direction == ShareDirection.Refunded) return $"The club took you off the game — {m.CourtName}";
        if (m.ClubRemoved) return $"The club took {m.OtherName} off your game — {m.CourtName}";
        switch (m.Direction)
        {
            case ShareDirection.Paid: return $"Share paid — {m.CourtName}";
            case ShareDirection.Received: return $"{m.OtherName} paid their share — {m.CourtName}";
            case ShareDirection.Refunded: return $"Share refunded — {m.CourtName}";
            default: return $"Share returned to {m.OtherName} — {m.CourtName}";
        }
    }

    /// <summary>A club refund's subject (E10-7), or a no-show's that kept part of the share (E11-2); null otherwise.</summary>
    private static string? RefundSubject(ShareMovement m)
    {
        var mine = m.Direction == ShareDirection.Refunded;
        if (m.KeptForNoShow)
        {
            return mine
                ? $"No-show: part of your share came back — {m.CourtName}"
                : $"No-show: part of {m.OtherName}'s share went back — {m.CourtName}";
        }
        if (ShareRefundCauses.Because(m.ClubRefund) is null) return null;
        return mine
            ? $"The club refunded your share — {m.CourtName}"
            : $"The club refunded {m.OtherName}'s share — {m.CourtName}";
    }

    private static string ShareHeading(ShareMovement m)
    {
        if (m.AfterAttendance && m.Direction == ShareDirection.Paid) return "Your share was taken again";
        if (m.ByClub && m.Direction == ShareDirection.Paid) return "The club collected your share";
        if (m.ClubRemoved) return "Taken off by the club";
        switch (m.Direction)
        {
            case ShareDirection.Paid: return "You paid your share";
            case ShareDirection.Received: return "A share has come in";
            case ShareDirection.Refunded: return "Your share came back";
            default: return "A share went back";
        }
    }

    private static string ShareSentence(ShareMovement m)
    {
        if (m.ByClub) return ClubShareSentence(m);
        if (m.AfterAttendance) return AttendedSentence(m);
        if (m.ClubRemoved) return ClubRemovedSentence(m);
        if (m.KeptForNoShow) return NoShowSentence(m);
        if (ShareRefundCauses.Because(m.ClubRefund) is { } because) return ClubRefundSentence(m, because);
        switch (m.Direction)
        {
            case ShareDirection.Paid: return $"You paid {Min(m.AmountMinutes)} to {m.OtherName} for your share of the court.";
            case ShareDirection.Received: return $"{m.OtherName} paid you {Min(m.AmountMinutes)} for their share of your booking.";
            case ShareDirection.Refunded: return $"{Min(m.AmountMinutes)} of your share came back from {m.OtherName}.";
            default: return $"{Min(m.AmountMinutes)} of {m.OtherName}'s share went back to them from your balance.";
        }
    }

    /// <summary>
    /// Review round 2, B-8: the club REMOVED the partner, and their share went back. "X of your share
    /// came back from Sam" told the partner the organiser had done it; the club did.
    /// </summary>
    private static string ClubRemovedSentence(ShareMovement m)
    {
        return m.Direction == ShareDirection.Refunded
            ? $"The club took you off the game {m.OtherName} booked, and {Min(m.AmountMinutes)} of your share came back to your balance."
            : $"The club took {m.OtherName} off your game, and {Min(m.AmountMinutes)} of their share went back to them from your balance.";
    }

    /// <summary>
    /// Review round 10, E10-7: the CLUB refunded the session (an outage, a no-show sweep, a
    /// displacement), and the share followed. "came back from Olive" told the partner the organiser
    /// had returned it.
    /// </summary>
    private static string ClubRefundSentence(ShareMovement m, string because)
    {
        return m.Direction == ShareDirection.Refunded
            ? $"The club refunded the session because {because}, so {Min(m.AmountMinutes)} of your share came back to your balance."
            : $"The club refunded the session because {because}, so {Min(m.AmountMinutes)} of {m.OtherName}'s share went back to them from your balance.";
    }

    /// <summary>
    /// Review round 11, E11-2: a no-show settlement keeps a penalty, and a split session's partner
    /// carries their part of it — the mail names that part and what came back.
    /// </summary>
    private static string NoShowSentence(ShareMovement m)
    {
        var kept = Min(m.KeptMinutes ?? 0);
        var paid = Min(m.AmountMinutes + (m.KeptMinutes ?? 0));
        return m.Direction == ShareDirection.Refunded
            ? $"Nobody checked in, so the club settled the session as a no-show: it refunded the court less its no-show penalty. Your part of that penalty is {kept}, so {Min(m.AmountMinutes)} of the {paid} you paid came back to your balance."
            : $"Nobody checked in, so the club settled the session as a no-show: it refunded the court less its no-show penalty. {m.OtherName}'s part of that penalty is {kept}, so {Min(m.AmountMinutes)} of the {paid} they paid went back to them from your balance.";
    }

    /// <summary>Review round 9, E9-2: the refund was reversed because the session was attended, so the share follows the court again.</summary>
    private static string AttendedSentence(ShareMovement m)
    {
        return m.Direction == ShareDirection.Paid
            ? $"Your share came back to you when the club refunded the booking, but the court's check-in has since come through — the session was attended, so {Min(m.AmountMinutes)} was taken from your balance again and paid to {m.OtherName}."
            : $"The court's check-in has since come through and the session was attended, so {m.OtherName}'s share of {Min(m.AmountMinutes)} was taken again and paid to you.";
    }

    /// <summary>B8: a share the CLUB collected — "You paid your share…" told the partner they had done something they had not.</summary>
    private static string ClubShareSentence(ShareMovement m)
    {
        return m.Direction == ShareDirection.Paid
            ? $"The club collected {Min(m.AmountMinutes)} from your balance for your share of the court {m.OtherName} booked."
            : $"The club collected {Min(m.AmountMinutes)} from {m.OtherName} for their share of your booking.";
    }
}
