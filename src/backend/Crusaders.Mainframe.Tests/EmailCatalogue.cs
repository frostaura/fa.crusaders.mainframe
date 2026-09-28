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

    /// <summary>
    /// A money symbol that cannot be confused with prose, for the catalogue-wide unit sweep.
    /// </summary>
    /// <remarks>
    /// <b>The default <c>R</c> is useless as a probe and that is the whole reason this exists.</b>
    /// "R" is a letter: it opens "Riverside", "Refunded" and "Reason", so a sweep looking for the
    /// club's symbol against the default cannot tell a money sign from the first letter of a
    /// word, and every assertion it makes is about the regex rather than about the mail. "CHF"
    /// appears in no sentence this product writes, so an occurrence of it is a symbol the
    /// renderer put there and nothing else.
    /// </remarks>
    internal const string ProbeSymbol = "CHF";

    /// <summary>
    /// Every message, named. The name is the template it came from, for a readable failure.
    /// </summary>
    /// <param name="symbol">
    /// The club's money symbol. It reaches the two top-up templates and nothing else, which is
    /// the invariant <see cref="EmailDesignTests"/> sweeps this catalogue to hold: credits are
    /// the unit of account and a credit figure wearing a money sign overstates a balance by the
    /// conversion rate. Defaults to the product's own default so every other rule in that file
    /// reads the mail a real club gets.
    /// </param>
    internal static IReadOnlyList<(string Name, EmailMessage Message)> All(
        ClubIdentity club, string symbol = Api.Services.CurrencySymbol.Default)
    {
        var to = "member@riverside.review.test";
        var booking = new BookingConfirmationDetails(
            CourtName: "Court 3", StartsAtLocal: "Tue 29 Sep, 18:00", Duration: "45 min",
            AmountCredits: 24m, BalanceAfterCredits: 136m,
            PenaltyWindowMinutes: 15, PenaltyPct: 30m);
        var peripheral = new PeripheralAlert("Court box 1-4", "box-2ad001", [1, 2], 12, ConsoleUrl);
        var gate = new GateAlert("Front door", "gate-44c101", "front-door", 12, ConsoleUrl);
        var adminGranted = new AdminRoleChange
        {
            SubjectName = "Thandi Mokoena",
            ActorName = "Jason Fourie",
            Granted = true,
            ConsoleUrl = ConsoleUrl,
        };
        var adminRevoked = new AdminRoleChange
        {
            SubjectName = "Thandi Mokoena",
            ActorName = "Jason Fourie",
            Granted = false,
            Reason = "Stepped down from the committee.",
            ConsoleUrl = ConsoleUrl,
        };

        return
        [
            ("VerifyEmail", EmailTemplates.VerifyEmail(club, to, LinkUrl)),
            ("MembershipApproved", EmailTemplates.MembershipApproved(club, to, LinkUrl)),
            ("MembershipRejected", EmailTemplates.MembershipRejected(club, to, "We could not match that membership number.")),
            ("MembershipSuspended", EmailTemplates.MembershipSuspended(club, to, "Thandi Mokoena", "Subscription unpaid since June.")),
            ("MembershipReactivated", EmailTemplates.MembershipReactivated(club, to, "Thandi Mokoena")),
            ("AdminNewRegistration", EmailTemplates.AdminNewRegistration(club, to, "Jason Fourie", "jason@riverside.review.test", "RR-0412", ConsoleUrl)),
            ("PasswordReset", EmailTemplates.PasswordReset(club, to, LinkUrl)),
            ("AdminPasswordReset", EmailTemplates.AdminPasswordReset(club, to, "Thandi Mokoena", "Qm7-42xw")),
            ("PasswordChanged", EmailTemplates.PasswordChanged(club, to)),
            ("BookingConfirmation", EmailTemplates.BookingConfirmation(club, to, booking)),
            ("BookingConfirmationWalkUp", EmailTemplates.BookingConfirmation(club, to, booking with { IsWalkUp = true })),
            ("BookingConfirmationOverdrawn", EmailTemplates.BookingConfirmation(club, to, booking with { BalanceAfterCredits = -40m })),
            ("WalkUpNotStarted", EmailTemplates.WalkUpNotStarted(club, to, "Court 2", 24m)),
            ("WalkUpNotStartedFreeCourt", EmailTemplates.WalkUpNotStarted(club, to, "Court 2", 0m)),
            ("BookingCancellation", EmailTemplates.BookingCancellation(club, to, "Court 3", 24m, 7.20m)),
            ("BookingCancellationByClub", EmailTemplates.BookingCancellation(club, to, "Court 3", 24m, null, new ClubCancellation("League night moved", true))),
            ("BookingNoShow", EmailTemplates.BookingNoShow(club, to, "Court 1", 24m, 7.20m)),
            ("BookingNoShowNoPenalty", EmailTemplates.BookingNoShow(club, to, "Court 1", 24m, 0m)),
            ("BookingDisplaced", EmailTemplates.BookingDisplaced(club, to, "Court 3", "Tue 29 Sep, 18:00")),
            ("BookingReinstated", EmailTemplates.BookingReinstated(club, to, "Court 3", "Tue 29 Sep, 18:00")),
            ("CancelledBookingLightsCharged", EmailTemplates.CancelledBookingLightsCharged(club, to, "Court 3", 40, 18m)),
            ("NoShowReversed", EmailTemplates.NoShowReversed(club, to, "Court 1", 24m, 7.20m)),
            ("TopUpConfirmation", EmailTemplates.TopUpConfirmation(club, to, new TopUpReceipt(100m, 160m, 1.6m, 296m, "pf-2026-09-22-0041", symbol))),
            ("TopUpNotCompleted", EmailTemplates.TopUpNotCompleted(club, to, 100m, "declined", "pf-2026-09-22-0042", symbol)),
            ("TopUpCancelled", EmailTemplates.TopUpNotCompleted(club, to, 100m, "cancelled", "pf-2026-09-22-0043", symbol)),
            ("TopUpMismatched", EmailTemplates.TopUpNotCompleted(club, to, 100m, "amount_mismatch", "pf-2026-09-22-0044", symbol)),
            ("CreditAdjustment", EmailTemplates.CreditAdjustment(club, to, 50m, 186m, "Refund for the lights on court 4")),
            ("CreditAdjustmentDeduction", EmailTemplates.CreditAdjustment(club, to, -50m, 86m, "Duplicate top-up reversed")),
            ("AdminPeripheralUnhealthy", EmailTemplates.AdminPeripheralUnhealthy(club, to, peripheral)),
            ("AdminPeripheralRecovered", EmailTemplates.AdminPeripheralRecovered(club, to, peripheral)),
            ("AdminGateUnhealthy", EmailTemplates.AdminGateUnhealthy(club, to, gate)),
            ("AdminGateRecovered", EmailTemplates.AdminGateRecovered(club, to, gate)),
            ("AdminGateUnhealthyUnnamed", EmailTemplates.AdminGateUnhealthy(club, to, gate with { GateKey = null })),
            ("BookingRefundedForOutage", EmailTemplates.BookingRefundedForOutage(club, to, "Court 2", 24m)),
            ("BookingRefundedForOutOfServiceBox", EmailTemplates.BookingRefundedForOutOfServiceBox(club, to, "Court 2", 24m)),
            ("AdminRoleGranted", EmailTemplates.AdminRoleGranted(club, to, adminGranted)),
            ("AdminRoleRevoked", EmailTemplates.AdminRoleRevoked(club, to, adminRevoked)),
            ("AdminRoleRevokedNoReason", EmailTemplates.AdminRoleRevoked(club, to, adminRevoked with { Reason = null })),
            ("AdminRoleChangedNotice", EmailTemplates.AdminRoleChangedNotice(club, to, adminGranted)),
            ("AdminRoleChangedNoticeRevoked", EmailTemplates.AdminRoleChangedNotice(club, to, adminRevoked)),

            // R23's admin notices — everything the notifier sends that nothing sent before it.
            ("AdminApplicationsWaiting", EmailTemplates.AdminApplicationsWaiting(club, to, new ApplicationsWaiting(3, "Jason Fourie", 31, ConsoleUrl))),
            ("AdminApplicationsWaitingOne", EmailTemplates.AdminApplicationsWaiting(club, to, new ApplicationsWaiting(1, "Jason Fourie", 26, ConsoleUrl))),
            ("AdminFaultSpike", EmailTemplates.AdminFaultSpike(club, to, new FaultSpike(6, 15, ["box-2ad001", "gate-44c101"], ConsoleUrl))),
            ("AdminDoorRefusalSpike", EmailTemplates.AdminDoorRefusalSpike(club, to, new DoorRefusalSpike("Front door", "gate-44c101", "front-door", 9, 20, ConsoleUrl))),
            ("AdminTopUpFailed", EmailTemplates.AdminTopUpFailed(club, to, new TopUpFailure("amount_mismatch", 100m, "Thandi Mokoena", "pf-2026-09-22-0045", symbol, ConsoleUrl))),
            ("AdminTopUpFailedUnsigned", EmailTemplates.AdminTopUpFailed(club, to, new TopUpFailure("signature_invalid", null, null, null, symbol, ConsoleUrl))),
            ("AdminWebhookDisabled", EmailTemplates.AdminWebhookDisabled(club, to, new WebhookDisabled("https://hooks.riverside.review.test", "Results board", 6, false, ConsoleUrl))),
            ("AdminWebhookDisabledBlocked", EmailTemplates.AdminWebhookDisabled(club, to, new WebhookDisabled("http://10.0.0.4", null, 1, true, ConsoleUrl))),
            ("AdminScheduleConflict", EmailTemplates.AdminScheduleConflict(club, to, new ScheduleConflictNotice("Tuesday league", "2026-10-06", 2, ["2026-10-06", "2026-10-13"], ConsoleUrl))),
            ("AdminOverdraftAuthorised", EmailTemplates.AdminOverdraftAuthorised(club, to, new OverdraftNotice("Jason Fourie", "Thandi Mokoena", false, "Court 3", "Tue 29 Sep, 18:00", 24m, -16m, ConsoleUrl))),
            ("AdminOverdraftAuthorisedSelf", EmailTemplates.AdminOverdraftAuthorised(club, to, new OverdraftNotice("Jason Fourie", "Jason Fourie", true, "Court 3", "Tue 29 Sep, 18:00", 24m, -16m, ConsoleUrl))),
            ("AdminCodeForgerySuspected", EmailTemplates.AdminCodeForgerySuspected(club, to, new ForgeryNotice("box-2ad001", "Thandi Mokoena", "offline half verified, online half did not", ConsoleUrl))),
            ("YouPaidForACourt", EmailTemplates.YouPaidForACourt(club, to, new PaidForCourt("Court 3", "Tue 29 Sep, 18:00", 24m, "Thandi Mokoena"))),
            ("YourCourtWasPaidFor", EmailTemplates.YourCourtWasPaidFor(club, to, new PaidForCourt("Court 3", "Tue 29 Sep, 18:00", 24m, "Jason Fourie"))),
            ("AdminBoardLostMemberCodes", EmailTemplates.AdminBoardLostMemberCodes(club, to, new BoardLostMemberCodes("Court box 1-4", "box-2ad001", "2.0.0", ConsoleUrl))),
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
