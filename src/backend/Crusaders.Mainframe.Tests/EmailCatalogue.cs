using System.Reflection;
using Crusaders.Mainframe.Api.Email;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Every message the product can send, rendered for one named club.
///
/// <para>
/// <b>It exists because the failure being guarded against is a partial redesign.</b> A club
/// whose booking confirmation carries its name and crest while its password reset is still a
/// bare <c>div</c> headed "Crusaders Mainframe" looks less trustworthy than one where both are
/// plain, because the inconsistency is the thing a reader notices. Asserting the house rules
/// one template at a time is how three get missed; this list is what lets
/// <see cref="EmailDesignTests"/> assert them across the whole set at once, and
/// <c>Every_template_the_product_can_send_is_in_the_catalogue</c> is what stops the list going
/// stale the first time somebody adds a template.
/// </para>
///
/// <para>
/// <b>The club is a parameter, and it is deliberately not Crusaders.</b> Crusaders Squash Club
/// is the first tenant and its name is the one a hard-coded literal would be, so a catalogue
/// rendered as Crusaders cannot tell a template that resolved the club from one that guessed
/// it. Every message here is a fictional second club's, which is the only way the assertion
/// "the club's own name appears, and no other club's does" means anything.
/// </para>
/// </summary>
internal static class EmailCatalogue
{
    /// <summary>The club everything is rendered for unless a test says otherwise.</summary>
    internal static readonly ClubIdentity Riverside =
        new("Riverside Racquet Club", "+27 31 555 0188", "desk@riverside.review.test");

    /// <summary>A second club, for the cross-tenant pass. Shares no word with the first.</summary>
    internal static readonly ClubIdentity Kestrel =
        new("Kestrel Lawn Tennis", "+27 21 555 0142", "office@kestrel.review.test");

    /// <summary>A club that has set neither a phone number nor an address — the default state.</summary>
    internal static readonly ClubIdentity Silent = new("Silent Valley Squash", "", "");

    private const string ConsoleUrl = "https://riverside.review.test/admin/devices";
    private const string LinkUrl = "https://riverside.review.test/verify-email/T0k3n-abc_123";

    /// <summary>Every message, named. The name is the template it came from, for a readable failure.</summary>
    internal static IReadOnlyList<(string Name, EmailMessage Message)> All(ClubIdentity club)
    {
        var to = "member@riverside.review.test";
        var booking = new BookingConfirmationDetails(
            CourtName: "Court 3", StartsAtLocal: "Tue 29 Sep, 18:00", Duration: "45 min",
            AmountCredits: 24m, BalanceAfterCredits: 136m,
            PenaltyWindowMinutes: 15, PenaltyPct: 30m);
        var peripheral = new PeripheralAlert("Court box 1-4", "box-2ad001", [1, 2], 12, club.Name, ConsoleUrl);
        var gate = new GateAlert("Front door", "gate-44c101", "front-door", 12, club.Name, ConsoleUrl);

        return
        [
            ("VerifyEmail", EmailTemplates.VerifyEmail(to, LinkUrl)),
            ("MembershipPending", EmailTemplates.MembershipPending(to)),
            ("MembershipApproved", EmailTemplates.MembershipApproved(to, LinkUrl, club.Name)),
            ("MembershipRejected", EmailTemplates.MembershipRejected(to, "We could not match that membership number.", club.Name)),
            ("MembershipSuspended", EmailTemplates.MembershipSuspended(to, "Thandi Mokoena", "Subscription unpaid since June.", club.Name)),
            ("MembershipReactivated", EmailTemplates.MembershipReactivated(to, "Thandi Mokoena", club.Name)),
            ("AdminNewRegistration", EmailTemplates.AdminNewRegistration(to, "Jason Fourie", "jason@riverside.review.test", "RR-0412", club.Name, ConsoleUrl)),
            ("PasswordReset", EmailTemplates.PasswordReset(to, LinkUrl)),
            ("AdminPasswordReset", EmailTemplates.AdminPasswordReset(to, "Thandi Mokoena", "Qm7-42xw")),
            ("PasswordChanged", EmailTemplates.PasswordChanged(to)),
            ("BookingConfirmation", EmailTemplates.BookingConfirmation(to, booking)),
            ("BookingConfirmationWalkUp", EmailTemplates.BookingConfirmation(to, booking with { IsWalkUp = true })),
            ("BookingConfirmationOverdrawn", EmailTemplates.BookingConfirmation(to, booking with { BalanceAfterCredits = -40m })),
            ("WalkUpNotStarted", EmailTemplates.WalkUpNotStarted(to, "Court 2", 24m)),
            ("BookingCancellation", EmailTemplates.BookingCancellation(to, "Court 3", 24m, 7.20m)),
            ("BookingCancellationByClub", EmailTemplates.BookingCancellation(to, "Court 3", 24m, null, new ClubCancellation("League night moved", true))),
            ("BookingNoShow", EmailTemplates.BookingNoShow(to, "Court 1", 24m, 7.20m)),
            ("TopUpConfirmation", EmailTemplates.TopUpConfirmation(to, 100m, 160m, 1.6m, 296m, "pf-2026-09-22-0041")),
            ("TopUpNotCompleted", EmailTemplates.TopUpNotCompleted(to, 100m, "declined", "pf-2026-09-22-0042")),
            ("TopUpCancelled", EmailTemplates.TopUpNotCompleted(to, 100m, "cancelled", "pf-2026-09-22-0043")),
            ("CreditAdjustment", EmailTemplates.CreditAdjustment(to, 50m, 186m, "Refund for the lights on court 4")),
            ("CreditAdjustmentDeduction", EmailTemplates.CreditAdjustment(to, -50m, 86m, "Duplicate top-up reversed")),
            ("AdminPeripheralUnhealthy", EmailTemplates.AdminPeripheralUnhealthy(to, peripheral)),
            ("AdminPeripheralRecovered", EmailTemplates.AdminPeripheralRecovered(to, peripheral)),
            ("AdminGateUnhealthy", EmailTemplates.AdminGateUnhealthy(to, gate)),
            ("AdminGateRecovered", EmailTemplates.AdminGateRecovered(to, gate)),
            ("AdminGateUnhealthyUnnamed", EmailTemplates.AdminGateUnhealthy(to, gate with { GateKey = null })),
            ("BookingRefundedForOutage", EmailTemplates.BookingRefundedForOutage(to, "Court 2", 24m, club.Name)),
            ("BookingRefundedForOutOfServiceBox", EmailTemplates.BookingRefundedForOutOfServiceBox(to, "Court 2", 24m, club.Name)),
        ];
    }

    /// <summary>
    /// The names of every public template on <see cref="EmailTemplates"/>, found by reflection.
    /// </summary>
    /// <remarks>
    /// The anti-drift half. A template added without a catalogue entry is a template nothing in
    /// this file has ever rendered, which is exactly the state twenty-three of them were in.
    /// </remarks>
    internal static IReadOnlyList<string> DeclaredTemplateNames() =>
        typeof(EmailTemplates)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.ReturnType == typeof(EmailMessage))
            .Select(m => m.Name)
            .Distinct()
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
}
