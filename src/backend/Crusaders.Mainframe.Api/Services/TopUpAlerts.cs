using System.Globalization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Which top-up failures the club's admins are told about, and the notice each raises (R23).
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
        AdminNotices.Stage(db, tenantId, AdminNotices.TopUpFailed(
            reason, pending.Id.ToString("N"), pending.AmountZar, await NameOfAsync(db, pending.UserId, ct),
            pending.ExternalReference ?? pending.IdempotencyKey));
    }

    /// <summary>
    /// Raises a notice for a notification that changed nothing — a bad signature, a payment with
    /// no reference — on its own save. <paramref name="identity"/> decides how often it can fire.
    /// </summary>
    public static async Task RaiseAsync(
        MainframeDbContext db, Guid tenantId, string reason, string identity, PendingTopup? pending, CancellationToken ct)
    {
        var name = pending is null ? null : await NameOfAsync(db, pending.UserId, ct);
        var notice = AdminNotices.TopUpFailed(
            reason, identity, pending?.AmountZar, name, pending is null ? null : pending.ExternalReference ?? pending.IdempotencyKey);
        await AdminNotices.RaiseAsync(db, tenantId, notice, DateTimeOffset.UtcNow, ct);
    }

    /// <summary>The UTC day an instant falls in, as a dedupe identity: one notice per club per day.</summary>
    public static string DayOf(DateTimeOffset at) =>
        at.ToUniversalTime().ToString("yyyyMMdd", CultureInfo.InvariantCulture);

    private static async Task<string?> NameOfAsync(MainframeDbContext db, Guid userId, CancellationToken ct) =>
        await db.Memberships.AsNoTracking().Where(m => m.UserId == userId).Select(m => m.FullName).FirstOrDefaultAsync(ct);
}
