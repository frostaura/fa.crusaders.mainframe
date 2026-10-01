namespace Crusaders.Mainframe.Api.Email;

// P13-B4: a compile bridge for lane B2's call sites while they move to PurchaseConfirmation,
// PurchaseNotCompleted, MinutesAdjusted and PackageSoldAtDesk (contract §6). It renders the NEW
// templates, so nothing a member receives says "credit". Delete this file once nothing calls it.

/// <summary>The pre-P13 receipt shape, kept only so lane B2's call site compiles until it moves.</summary>
internal sealed record TopUpReceipt(
    decimal AmountZar,
    int MinutesAdded,
    decimal ConversionRate,
    int BalanceAfterMinutes,
    string Reference,
    string CurrencySymbol);

public static partial class EmailTemplates
{
    /// <summary>Forwards to <see cref="PurchaseConfirmation"/>; the package name is not known here.</summary>
    internal static EmailMessage TopUpConfirmation(ClubIdentity club, string to, TopUpReceipt r) =>
        PurchaseConfirmation(club, to, new PackagePurchaseReceipt(
            "Minutes", r.MinutesAdded, r.AmountZar, 0, null, r.AmountZar, r.BalanceAfterMinutes, r.Reference, r.CurrencySymbol));

    /// <summary>Forwards to <see cref="PurchaseNotCompleted"/>.</summary>
    internal static EmailMessage TopUpNotCompleted(
        ClubIdentity club, string to, decimal amountZar, string? failureReason, string reference, string currencySymbol) =>
        PurchaseNotCompleted(club, to, "Minutes", 0, amountZar, failureReason, reference, currencySymbol);

    /// <summary>The old name of <see cref="Min"/>, for lane B2's ledger reason until it calls <c>MoneyFormat.Minutes</c>.</summary>
    internal static string Cr(int value) => Min(value);

    /// <summary>Forwards to <see cref="MinutesAdjusted"/>.</summary>
    internal static EmailMessage CreditAdjustment(
        ClubIdentity club, string to, int amountMinutes, int balanceAfterMinutes, string reason) =>
        MinutesAdjusted(club, to, amountMinutes, balanceAfterMinutes, reason);
}
