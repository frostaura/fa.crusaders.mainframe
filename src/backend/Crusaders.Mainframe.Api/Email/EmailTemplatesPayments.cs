namespace Crusaders.Mainframe.Api.Email;

/// <summary>
/// A PayFast payment the club received and did NOT turn into minutes, for
/// <see cref="EmailTemplates.PaymentNotCredited"/>: a second payment for a checkout already
/// credited, or a payment for one the gateway had already closed.
/// </summary>
/// <param name="AmountZar">What PayFast reports for THIS payment; null when it reported none.</param>
/// <param name="Reference">THIS payment's PayFast id — what the member quotes to the club.</param>
public sealed record UncreditedPayment(
    string PackageName,
    decimal? AmountZar,
    string Reference,
    bool AlreadyCredited,
    string CurrencySymbol);

/// <summary>Rand the club gave back, for <see cref="EmailTemplates.PaymentReversed"/>.</summary>
/// <param name="MinutesRemoved">Whole minutes taken off with it; 0 when the member keeps them.</param>
/// <param name="Chargeback">A card chargeback rather than a refund the club chose to make.</param>
public sealed record ReversedPayment(
    string PurchaseLabel,
    decimal ZarReversed,
    int MinutesRemoved,
    int BalanceAfterMinutes,
    bool Chargeback,
    string CurrencySymbol);

/// <summary>
/// The two money-in messages beyond a receipt and a failure (money lane BM-3, BM-6). Every
/// player-affecting event sends an email, and a payment the club holds without having credited it,
/// or rand handed back, both change what the member is owed.
/// </summary>
public static partial class EmailTemplates
{
    /// <summary>To a member PayFast took a payment from that was not added as minutes.</summary>
    public static EmailMessage PaymentNotCredited(ClubIdentity club, string to, UncreditedPayment p) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: p.AlreadyCredited
                ? $"A second payment for {p.PackageName} was received"
                : $"A payment for {p.PackageName} arrived after the purchase closed",
            Preheader: "No minutes were added for it. The club has been told and will refund it or add it by hand.",
            Heading: p.AlreadyCredited ? "You paid twice for one purchase" : "A payment arrived after the purchase closed",
            Blocks:
            [
                new Paragraph(p.AlreadyCredited
                    ? $"PayFast reported a second payment for your {p.PackageName} purchase. Your first payment's minutes are already in your wallet; this one has not been added, so you are not charged twice for the same minutes."
                    : $"PayFast reported a payment for your {p.PackageName} purchase after it had been closed. No minutes were added for it."),
                new Facts(
                [
                    new FactRow("Package", p.PackageName),
                    new FactRow("Amount", p.AmountZar is { } zar ? Zar(zar, p.CurrencySymbol) : "Not reported by PayFast"),
                    new FactRow("Minutes added", Min(0)),
                    new FactRow("Reference", p.Reference),
                ]),
                new Callout(CalloutTone.Info, "The club's admins have been told. Quote the reference if you contact them."),
            ],
            WhyThis: WhyMoney));

    /// <summary>To a member the club refunded rand to, or whose card payment was charged back.</summary>
    public static EmailMessage PaymentReversed(ClubIdentity club, string to, ReversedPayment p) =>
        EmailChrome.Compose(club, to, new EmailContent(
            Subject: p.Chargeback
                ? $"Chargeback recorded — {Zar(p.ZarReversed, p.CurrencySymbol)}"
                : $"Refund of {Zar(p.ZarReversed, p.CurrencySymbol)}",
            Preheader: p.MinutesRemoved > 0
                ? $"{Min(p.MinutesRemoved)} came off your balance with it."
                : "Your minutes are unchanged.",
            Heading: p.Chargeback ? "A chargeback was recorded" : "The club refunded you",
            Blocks:
            [
                new Paragraph(p.Chargeback
                    ? $"Your bank reversed {Zar(p.ZarReversed, p.CurrencySymbol)} you paid for {p.PurchaseLabel}, and the club has recorded it."
                    : $"The club refunded {Zar(p.ZarReversed, p.CurrencySymbol)} of what you paid for {p.PurchaseLabel}."),
                new Facts(
                [
                    new FactRow("Purchase", p.PurchaseLabel),
                    new FactRow(p.Chargeback ? "Charged back" : "Refunded", Zar(p.ZarReversed, p.CurrencySymbol)),
                    new FactRow("Minutes removed", Min(p.MinutesRemoved)),
                    new FactRow("Balance now", Min(p.BalanceAfterMinutes)),
                ]),
            ],
            WhyThis: WhyMoney));
}
