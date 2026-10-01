namespace Crusaders.Mainframe.Api.Email;

/// <summary>What both members are told when one pays for the other's court at the box (D10).</summary>
public sealed record PaidForCourt(string CourtName, string StartsAtLocal, int AmountMinutes, string OtherName);

/// <summary>
/// The two D10 messages (<c>docs/specs/member-code.md</c> §9): the payer's receipt and the
/// booker's refund. Every player-affecting event sends an email, and a court changing hands at
/// the box changes two members' balances.
/// </summary>
public static partial class EmailTemplates
{
    /// <summary>To the member who paid at the box.</summary>
    public static EmailMessage YouPaidForACourt(ClubIdentity club, string to, PaidForCourt p) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"You paid for {p.CourtName}",
            Preheader: $"{Cr(p.AmountMinutes)} for {p.OtherName}'s booking, paid at the court box.",
            Heading: "You paid for a court at the box",
            Blocks:
            [
                new Paragraph($"You paid for {p.OtherName}'s booking on {p.CourtName} at {p.StartsAtLocal}, at the court box with your member code."),
                new Facts(
                [
                    new FactRow("Court", p.CourtName),
                    new FactRow("Time", p.StartsAtLocal),
                    new FactRow("Charged", Cr(p.AmountMinutes)),
                ]),
                new Footnote($"{p.OtherName} has been refunded the same amount. If this was not you, tell the club — your code may have been used by somebody holding your phone."),
            ],
            WhyThis: WhyMoney));

    /// <summary>To the member whose booking was paid for.</summary>
    public static EmailMessage YourCourtWasPaidFor(ClubIdentity club, string to, PaidForCourt p) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: $"{p.OtherName} paid for your court",
            Preheader: $"{Cr(p.AmountMinutes)} is back in your wallet.",
            Heading: "Somebody paid for your court",
            Blocks:
            [
                new Paragraph($"{p.OtherName} paid for your booking on {p.CourtName} at {p.StartsAtLocal}, at the court box."),
                new Facts(
                [
                    new FactRow("Court", p.CourtName),
                    new FactRow("Time", p.StartsAtLocal),
                    new FactRow("Refunded to you", Cr(p.AmountMinutes)),
                ]),
                new Footnote("The refund is its own line in your wallet. Your booking is unchanged."),
            ],
            WhyThis: WhyMoney));
}
