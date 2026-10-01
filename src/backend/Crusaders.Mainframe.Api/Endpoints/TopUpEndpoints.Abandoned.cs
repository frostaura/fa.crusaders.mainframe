using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// A purchase the gateway never reports on (review round 4, M4-1).
///
/// <para>
/// <b>PayFast sends no ITN when a member cancels on its page or simply closes it</b>, so the row
/// stayed <c>Pending</c> for ever. Under the old R1000 cap that locked a member out for good; the
/// cap is gone (P13, Dean 2026-10-01), and what the closings protect now is the member's own
/// screen — "a payment you started" listed until it is settled one way or the other.
/// </para>
///
/// <para>
/// Two things close it, and <b>neither can lose money</b>: a member coming back through the cancel
/// URL says so (<c>POST /api/v1/minutes/purchase/{id}/cancel</c>), and
/// <see cref="ExpireStaleAsync"/> closes a row left <c>Pending</c> past <see cref="PendingLifetime"/>
/// (on start and every few minutes). Both are <see cref="IsReopenable">reopenable</see>: a signed
/// COMPLETE arriving later still credits the member, because it means the money moved — only the
/// gateway's own word is terminal (D2-B04).
/// </para>
/// </summary>
public static partial class TopUpEndpoints
{
    /// <summary>
    /// How long a registered checkout stays open before it is listed no longer and the sweep
    /// closes it.
    ///
    /// <para>
    /// <b>Not a tenant setting, on purpose.</b> It is a property of the gateway's hosted checkout,
    /// not a club policy — no club can change how long PayFast's page stays open — and being wrong
    /// costs nothing: a payment finished after it is still credited by its ITN. An hour is
    /// several times any card or instant-EFT session.
    /// </para>
    /// </summary>
    internal static readonly TimeSpan PendingLifetime = TimeSpan.FromMinutes(60);

    /// <summary>
    /// A row closed on OUR word rather than the gateway's — the member's cancel return, or the
    /// expiry. A later signed notification may still settle it; a gateway cancel or failure may not.
    /// </summary>
    internal static bool IsReopenable(PendingTopup p)
        => p.Status == TopUpStatus.Cancelled
           && p.FailureReason is FailureCodes.CancelledAtReturn or FailureCodes.Expired;

    /// <summary>The instant before which a still-Pending row is no longer an open checkout.</summary>
    internal static DateTimeOffset PendingCutoff(DateTimeOffset now) => now - PendingLifetime;

    /// <summary>
    /// <c>POST /api/v1/minutes/purchase/{id}/cancel</c> — the member landed on the cancel URL.
    ///
    /// <para>
    /// Own row only (anyone else's reads 404, like the status read). Idempotent, and a
    /// conditional update rather than read-then-write, so it can never overwrite a completion
    /// that landed first: a row that is no longer <c>Pending</c> is answered as it stands. No mail
    /// — the member is looking at the screen that says it.
    /// </para>
    /// </summary>
    internal static void MapCancelReturn(RouteGroupBuilder g)
    {
        g.MapPost("/purchase/{purchaseId:guid}/cancel", async (Guid purchaseId, HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var now = DateTimeOffset.UtcNow;
            await db.PendingTopups
                .Where(p => p.Id == purchaseId && p.UserId == userId && p.Status == TopUpStatus.Pending)
                .ExecuteUpdateAsync(u => u
                    .SetProperty(p => p.Status, TopUpStatus.Cancelled)
                    .SetProperty(p => p.FailureReason, FailureCodes.CancelledAtReturn)
                    .SetProperty(p => p.CompletedAt, now), ct);

            var row = await db.PendingTopups.AsNoTracking().FirstOrDefaultAsync(x => x.Id == purchaseId && x.UserId == userId, ct);
            return row is null ? Results.NotFound() : Results.Ok(StatusWire(row));
        });
    }

    /// <summary>The purchase status shape (P13 §3.4), shared by the read and the cancel return.</summary>
    internal static object StatusWire(PendingTopup p)
    {
        return new
        {
            id = p.Id,
            status = p.Status.ToString(),
            package_id = p.PackageId,
            package_name = p.PackageName,
            minutes = p.Minutes,
            list_price_zar = p.ListPriceZar,
            discount_bps = p.DiscountBps,
            amount_zar = p.AmountZar,
            // A stable code the client maps to a sentence, never an internal string.
            failure_code = p.FailureReason,
            // M5-2: "a payment you started at 14:05", and when it stops being an open checkout.
            created_at = p.CreatedAt,
            expires_at = p.CreatedAt + PendingLifetime,
        };
    }

    /// <summary>
    /// The member's checkouts still waiting on PayFast — <c>Pending</c> and fresh — newest first
    /// (review round 5, M5-2).
    ///
    /// <para>
    /// <b>Why the screen lists them.</b> Back from PayFast without paying, a member has no other way
    /// to see that a checkout is still open, nor to close it: the cancel return only fires when
    /// PayFast's own Cancel is pressed. Each row carries its own Cancel
    /// (<c>POST /api/v1/minutes/purchase/{id}/cancel</c>), which a signed COMPLETE reopens if the
    /// money did move.
    /// </para>
    /// </summary>
    internal static async Task<List<PendingTopup>> OpenCheckoutsAsync(MainframeDbContext db, Guid userId, CancellationToken ct)
    {
        var cutoff = PendingCutoff(DateTimeOffset.UtcNow);
        return await db.PendingTopups.AsNoTracking()
            .Where(p => p.UserId == userId && p.Status == TopUpStatus.Pending && p.CreatedAt >= cutoff)
            .OrderByDescending(p => p.CreatedAt)
            .ToListAsync(ct);
    }

    /// <summary>One open checkout on the shelf read (P13 §3.4): <c>expires_at</c> replaced <c>counts_until</c>.</summary>
    internal static object OpenWire(PendingTopup p)
    {
        return new
        {
            id = p.Id,
            package_name = p.PackageName,
            minutes = p.Minutes,
            amount_zar = p.AmountZar,
            created_at = p.CreatedAt,
            expires_at = p.CreatedAt + PendingLifetime,
        };
    }

    /// <summary>
    /// Closes every club's checkouts left <c>Pending</c> past <see cref="PendingLifetime"/> as
    /// <c>Cancelled</c> / <c>expired</c>. One statement across tenants; idempotent; mails nobody
    /// (the one-off run over production's history must not mail a year of abandoned checkouts).
    /// Returns how many rows it closed.
    /// </summary>
    public static Task<int> ExpireStaleAsync(MainframeDbContext db, DateTimeOffset now, CancellationToken ct)
    {
        var cutoff = PendingCutoff(now);
        return db.PendingTopups.IgnoreQueryFilters()
            .Where(p => p.Status == TopUpStatus.Pending && p.CreatedAt < cutoff)
            .ExecuteUpdateAsync(u => u
                .SetProperty(p => p.Status, TopUpStatus.Cancelled)
                .SetProperty(p => p.FailureReason, FailureCodes.Expired)
                .SetProperty(p => p.CompletedAt, now), ct);
    }
}
