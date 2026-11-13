using System.Globalization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Which package-purchase failures the club's admins are told about, and the notice each raises
/// (R23; the kind keeps its <c>topup.failed</c> code, P13 §12.2).
///
/// <para>
/// <b>Only the ones the club has to act on.</b> A decline is the member's card; a cancellation is
/// the member's choice; both already mail the member, and an admin can do nothing about either.
/// What reaches the admins is the gateway disagreeing about an amount, the gateway failing in a
/// way nobody recognises, the club's own payment settings refusing to start a checkout, and a
/// notification the club cannot trust — no signature, or a payment with no reference to credit
/// it against.
/// </para>
///
/// <para>
/// <b>The ITN route is anonymous</b>, so the two notices raised from a request that changed
/// nothing are bounded by their dedupe keys rather than by anybody's good behaviour: a forged
/// notification raises at most one notice per club per UTC day, however many arrive. It was
/// one an hour, which let anybody who knew a club's slug put twenty-four mails a day in every
/// admin's inbox; one a day still tells the club the first time it happens, and a club whose
/// own passphrase is wrong hears it daily until it is fixed.
/// </para>
/// </summary>
public static class TopUpAlerts
{
    public const string SignatureInvalid = "signature_invalid";
    public const string PaymentIdMissing = "payment_id_missing";

    /// <summary>A signed ITN naming a merchant id that is not this club's. Daily, like a bad signature.</summary>
    public const string MerchantMismatch = "merchant_mismatch";

    /// <summary>An ITN from an address that is not PayFast's (the source check). Daily.</summary>
    public const string SourceUnrecognised = "source_unrecognised";

    /// <summary>PayFast's own validate call did not confirm a signed ITN: a leaked passphrase, or a forgery. Daily.</summary>
    public const string ValidationFailed = "validation_failed";

    /// <summary>A COMPLETE with no <c>amount_gross</c>: nothing to check the locked price against, so nothing is credited. Per purchase.</summary>
    public const string AmountMissing = "amount_missing";

    /// <summary>
    /// A second genuine payment for a checkout already credited (money lane BM-3). The member has
    /// paid twice; the second payment is NOT credited and must be refunded or credited at the desk.
    /// Keyed on the second payment's PayFast id, so its retries raise it once.
    /// </summary>
    public const string PaidTwice = "paid_twice";

    /// <summary>
    /// A genuine COMPLETE for a checkout the gateway had already closed (cancelled or failed).
    /// Money moved and nothing was credited; the desk settles it. Keyed on the PayFast id.
    /// </summary>
    public const string PaidAfterClose = "paid_after_close";

    /// <summary>The stored failure codes that are the club's to deal with. See the type's summary for why the others are not.</summary>
    private static readonly HashSet<string> ClubFacing = new(StringComparer.Ordinal)
    {
        "amount_mismatch", "gateway_error", "provider_register_failed",
    };

    /// <summary>Whether a failure code is one the admins are told about.</summary>
    public static bool IsClubFacing(string? reason) => reason is not null && ClubFacing.Contains(reason);

    /// <summary>
    /// Stages the notice for a top-up whose row is about to be saved as failed, into the same
    /// save. Keyed on the top-up, so a failure is raised once however often it is re-judged.
    /// </summary>
    public static async Task StageAsync(MainframeDbContext db, Guid tenantId, PendingTopup pending, CancellationToken ct)
    {
        if (!IsClubFacing(pending.FailureReason)) return;
        var reason = pending.FailureReason!;
        // P13 §5: the notice names the package and its minutes, from the purchase row.
        AdminNotices.Stage(db, tenantId, AdminNotices.TopUpFailed(
            reason, pending.Id.ToString("N"), await NameOfAsync(db, pending.UserId, ct), pending));
    }

    /// <summary>
    /// Raises a notice for a notification that changed nothing — a bad signature, a payment with
    /// no reference — on its own save. <paramref name="identity"/> decides how often it can fire.
    /// </summary>
    public static async Task RaiseAsync(
        MainframeDbContext db, Guid tenantId, string reason, string identity, PendingTopup? pending, CancellationToken ct)
    {
        var name = pending is null ? null : await NameOfAsync(db, pending.UserId, ct);
        var notice = AdminNotices.TopUpFailed(reason, identity, name, pending);
        await AdminNotices.RaiseAsync(db, tenantId, notice, DateTimeOffset.UtcNow, ct);
    }

    /// <summary>
    /// Raises the notice for a payment PayFast took that this club did not credit
    /// (<see cref="PaidTwice"/>, <see cref="PaidAfterClose"/>): the notice names THAT payment —
    /// its PayFast id and the rand it reports — not the purchase's first one, because it is the
    /// money the desk has to find. Once per payment id.
    /// </summary>
    public static async Task RaiseNotAddedAsync(
        MainframeDbContext db, Guid tenantId, NotAddedPayment payment, PendingTopup pending, CancellationToken ct)
    {
        var name = await NameOfAsync(db, pending.UserId, ct);
        var notice = AdminNotices.TopUpNotAdded(payment.Reason, payment.PaymentId, payment.AmountGross, name, pending);
        await AdminNotices.RaiseAsync(db, tenantId, notice, DateTimeOffset.UtcNow, ct);
    }

    /// <summary>The UTC day an instant falls in, as a dedupe identity: one notice per club per day.</summary>
    public static string DayOf(DateTimeOffset at) =>
        at.ToUniversalTime().ToString("yyyyMMdd", CultureInfo.InvariantCulture);

    private static async Task<string?> NameOfAsync(MainframeDbContext db, Guid userId, CancellationToken ct) =>
        await db.Memberships.AsNoTracking().Where(m => m.UserId == userId).Select(m => m.FullName).FirstOrDefaultAsync(ct);
}

/// <summary>A PayFast payment that was received and not added as minutes: why, its PayFast id, and the rand it reports.</summary>
public sealed record NotAddedPayment(string Reason, string PaymentId, decimal? AmountGross);
