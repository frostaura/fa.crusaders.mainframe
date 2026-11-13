using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Member notices held for an address that is not confirmed yet (browser lane BM-01).
/// </summary>
/// <remarks>
/// <para>
/// <b>Why held, not dropped.</b> A club may approve a member before they click the verify link, and
/// "every player-affecting event sends an email": an invite, a share, a shortfall, a cancellation.
/// The dispatcher used to finish such a row <c>sent</c> with nobody mailed, so the invite was lost
/// even when the member verified a minute later, and the organiser had no signal. The row now stays
/// Pending; confirming the address releases it at once (<see cref="ReleaseAsync"/>, called by every
/// path that sets <c>EmailVerified</c>), and the dispatcher's own release judgement (C8) still drops
/// whatever is no longer true by then.
/// </para>
/// <para>
/// <b>The two durations are delivery mechanics, not club policy</b>, so they are constants rather
/// than tenant settings: the recheck only bounds how long a missed release can go unnoticed, and
/// the cap only stops a row for an address that is never confirmed from being looked at for ever.
/// </para>
/// </remarks>
public static class MemberNoticeHold
{
    /// <summary>How long a held row waits before the dispatcher looks at it again, absent a release.</summary>
    public static readonly TimeSpan Recheck = TimeSpan.FromHours(6);

    /// <summary>How long a row is held at most before it is suppressed as undeliverable.</summary>
    public static readonly TimeSpan MaxHold = TimeSpan.FromDays(14);

    /// <summary><c>LastError</c> of a row waiting for its recipient's address.</summary>
    public const string AwaitingAddress = "awaiting_verified_address";

    /// <summary>Why a held row was given up on.</summary>
    public const string RecipientUnverified = "recipient_unverified";

    /// <summary>Why a row for a suspended, deleted or unknown account was not sent.</summary>
    public const string RecipientInactive = "recipient_inactive";

    /// <summary>
    /// Makes every notice held for <paramref name="userId"/>'s address due now. Tracks the rows on
    /// <paramref name="db"/> and does not save: the caller's save — the one that confirms the
    /// address — commits the release with it.
    /// </summary>
    public static async Task ReleaseAsync(MainframeDbContext db, Guid userId, DateTimeOffset now, CancellationToken ct)
    {
        var held = await db.AdminNotifications
            .Where(n => n.RecipientUserId == userId && n.State == AdminNotificationState.Pending && n.LastError == AwaitingAddress)
            .ToListAsync(ct);
        foreach (var row in held)
        {
            row.DueAt = now.Storable();
            row.LastError = null;
        }
    }
}
