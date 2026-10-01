namespace Crusaders.Mainframe.Api.Email;

// P13-B4: positional forms of two templates lane B2 already calls, kept only until B2 passes the
// records instead (the complexity gate caps a signature at six parameters). Internal, so the
// template catalogue does not count them. Delete this file once nothing calls it.

public static partial class EmailTemplates
{
    /// <summary>Forwards to <see cref="PurchaseNotCompleted(ClubIdentity, string, PackagePurchaseAttempt)"/>.</summary>
    internal static EmailMessage PurchaseNotCompleted(
        ClubIdentity club, string to, string packageName, int minutes, decimal amountZar, string? failureReason,
        string reference, string currencySymbol) =>
        PurchaseNotCompleted(club, to, new PackagePurchaseAttempt(packageName, minutes, amountZar, failureReason, reference, currencySymbol));

    /// <summary>Forwards to <see cref="PackageSoldAtDesk(ClubIdentity, string, DeskPackageSale)"/>.</summary>
    internal static EmailMessage PackageSoldAtDesk(
        ClubIdentity club, string to, string packageName, int minutes, decimal zarReceived, int balanceAfterMinutes,
        string currencySymbol) =>
        PackageSoldAtDesk(club, to, new DeskPackageSale(packageName, minutes, zarReceived, balanceAfterMinutes, currencySymbol));
}
