namespace Crusaders.Mainframe.Api.Email;

/// <summary>A game somebody has been asked to join, and what their share of it would be.</summary>
public sealed record PlayerInviteNotice(
    string OrganiserName, string CourtName, string StartsAtLocal, decimal ShareCredits, string AcceptUrl);

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
public sealed record ShareMovement(
    ShareDirection Direction, string OtherName, string CourtName, string StartsAtLocal, decimal AmountCredits, string BookingUrl);

/// <summary>A share still waiting — a reminder from the club, or a nudge from the organiser.</summary>
public sealed record ShareReminderNotice(
    string OrganiserName, string CourtName, string StartsAtLocal, decimal ShareCredits, string DeadlineLocal,
    bool FromOrganiser, string AcceptUrl);

/// <summary>A share whose deadline passed. <see cref="ToOrganiser"/> decides who is reading.</summary>
public sealed record ShareLapsedNotice(
    string OtherName, string CourtName, string StartsAtLocal, decimal UnpaidCredits, bool ToOrganiser, string BookingUrl);

/// <summary>A change to a game the reader is in — they were taken off it, or their share moved.</summary>
public sealed record PlayersChange(
    string OrganiserName, string CourtName, string StartsAtLocal, bool Removed, decimal? NewShareCredits, bool NeedsConsent,
    string BookingUrl);

/// <summary>
/// The messages a game with more than one player sends (D11): the invite, the receipt for every
/// share that moves, the reminder, the lapse, a cancellation and a change.
/// </summary>
/// <remarks>
/// <para>
/// A partial of <see cref="EmailTemplates"/> for the length reason the admin-role partial gives.
/// Every figure is CREDITS — a share is a slice of a court price, and a credit figure wearing a
/// money sign would overstate it by the conversion rate.
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
            Preheader: n.ShareCredits > 0
                ? $"{n.StartsAtLocal}. Your share would be {Cr(n.ShareCredits)}."
                : $"{n.StartsAtLocal}. {n.OrganiserName} is covering the court.",
            Heading: "You've been invited to a game",
            Blocks:
            [
                new Paragraph($"{n.OrganiserName} has booked {n.CourtName} at {club.Name} and would like you to play."),
                new Facts(
                [
                    new FactRow("Court", n.CourtName),
                    new FactRow("When", n.StartsAtLocal),
                    new FactRow("Your share", n.ShareCredits > 0 ? Cr(n.ShareCredits) : "Nothing — covered"),
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
            Heading: ShareHeading(m.Direction),
            Blocks:
            [
                new Paragraph(ShareSentence(m)),
                new Facts(
                [
                    new FactRow("Court", m.CourtName),
                    new FactRow("When", m.StartsAtLocal),
                    new FactRow(m.Direction is ShareDirection.Paid or ShareDirection.Returned ? "Taken from your balance" : "Added to your balance", Cr(m.AmountCredits)),
                ]),
                new CallToAction("Open the booking", m.BookingUrl),
                new Footnote("Shares move between players only. The club's price for the court is unchanged."),
            ],
            WhyThis: WhyMoney));

    /// <summary>A share still waiting: the club's reminder, or the organiser's nudge.</summary>
    public static EmailMessage ShareReminder(ClubIdentity club, string to, ShareReminderNotice n) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: n.FromOrganiser ? $"{n.OrganiserName} is waiting for your answer — {n.CourtName}" : $"Your invite is still open — {n.CourtName}",
            Preheader: $"Your share is {Cr(n.ShareCredits)}. It can be paid until {n.DeadlineLocal}.",
            Heading: "Your share is still open",
            Blocks:
            [
                new Paragraph(n.FromOrganiser
                    ? $"{n.OrganiserName} would like to know if you are playing on {n.CourtName} at {n.StartsAtLocal}."
                    : $"You have an open invite from {n.OrganiserName} for {n.CourtName} at {n.StartsAtLocal}."),
                new Facts(
                [
                    new FactRow("Your share", Cr(n.ShareCredits)),
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
                    ? $"{n.OtherName} did not pay {Cr(n.UnpaidCredits)} of their share for {n.CourtName} at {n.StartsAtLocal} before it closed. Your booking already covered the court, so nothing else moves."
                    : $"Your share for {n.CourtName} at {n.StartsAtLocal} closed before it was paid. {n.OtherName}'s booking covers it and nothing is owed."),
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
            new Paragraph(c.Removed
                ? $"{c.OrganiserName} has taken you off the booking for {c.CourtName} at {c.StartsAtLocal}. Any share you paid comes back to you."
                : $"{c.OrganiserName} has changed how {c.CourtName} at {c.StartsAtLocal} is split."),
        };
        if (!c.Removed && c.NewShareCredits is { } share) blocks.Add(new Facts([new FactRow("Your share now", Cr(share))]));
        if (c.NeedsConsent) blocks.Add(new Callout(CalloutTone.Warning, "Your share went up. Nothing more is taken until you accept the new figure."));
        blocks.Add(new CallToAction("Open the booking", c.BookingUrl));
        return blocks;
    }

    private static string ShareSubject(ShareMovement m)
    {
        switch (m.Direction)
        {
            case ShareDirection.Paid: return $"Share paid — {m.CourtName}";
            case ShareDirection.Received: return $"{m.OtherName} paid their share — {m.CourtName}";
            case ShareDirection.Refunded: return $"Share refunded — {m.CourtName}";
            default: return $"Share returned to {m.OtherName} — {m.CourtName}";
        }
    }

    private static string ShareHeading(ShareDirection d)
    {
        switch (d)
        {
            case ShareDirection.Paid: return "You paid your share";
            case ShareDirection.Received: return "A share has come in";
            case ShareDirection.Refunded: return "Your share came back";
            default: return "A share went back";
        }
    }

    private static string ShareSentence(ShareMovement m)
    {
        switch (m.Direction)
        {
            case ShareDirection.Paid: return $"You paid {Cr(m.AmountCredits)} to {m.OtherName} for your share of the court.";
            case ShareDirection.Received: return $"{m.OtherName} paid you {Cr(m.AmountCredits)} for their share of your booking.";
            case ShareDirection.Refunded: return $"{Cr(m.AmountCredits)} of your share came back from {m.OtherName}.";
            default: return $"{Cr(m.AmountCredits)} of {m.OtherName}'s share went back to them from your balance.";
        }
    }
}
