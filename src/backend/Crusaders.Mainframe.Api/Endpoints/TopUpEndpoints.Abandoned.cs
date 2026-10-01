using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// A top-up the gateway never reports on (review round 4, M4-1).
///
/// <para>
/// <b>PayFast sends no ITN when a member cancels on its page or simply closes it</b>, so the row
/// stayed <c>Pending</c> for ever — and the per-member ceiling counts <c>Pending</c> (D2-B05), so
/// every abandoned R1000 checkout used up a member's R1000 for good. Live in production: one
/// cancelled checkout and the member could never top up again.
/// </para>
///
/// <para>
/// Three things close it, and <b>none of them can lose money</b>: a member coming back through the
/// cancel URL says so (<c>POST /topup/{id}/cancel</c>); a <c>Pending</c> row older than
/// <see cref="PendingLifetime"/> stops counting against the ceiling at once; and
/// <see cref="ExpireStaleAsync"/> closes those rows (on start and every few minutes, which is also
/// the one-off fix for the rows already stuck in production). Both closings are
/// <see cref="IsReopenable">reopenable</see>: a signed COMPLETE arriving later still credits the
/// member, because it means the money moved — only the gateway's own word is terminal (D2-B04).
/// </para>
/// </summary>
public static partial class TopUpEndpoints
{
    /// <summary>
    /// How long a registered checkout may stay unanswered before it stops counting against the
    /// member's ceiling.
    ///
    /// <para>
    /// <b>Not a tenant setting, on purpose.</b> It is a property of the gateway's hosted checkout,
    /// not a club policy — no club can change how long PayFast's page stays open — and being wrong
    /// costs only the ceiling: a payment finished after it is still credited by its ITN. An hour is
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

    /// <summary>The instant before which a still-Pending row no longer counts.</summary>
    internal static DateTimeOffset PendingCutoff(DateTimeOffset now) => now - PendingLifetime;

    /// <summary>
    /// <c>POST /api/v1/credit/topup/{id}/cancel</c> — the member landed on the cancel URL.
    ///
    /// <para>
    /// Own row only (anyone else's reads 404, like the status read). Idempotent, and a
    /// conditional update rather than read-then-write, so it can never overwrite a completion
    /// that landed first: a row that is no longer <c>Pending</c> is answered as it stands. No mail
    /// — the member is looking at the screen that says it.
    /// </para>
    /// </summary>
    private static void MapCancelReturn(RouteGroupBuilder g)
    {
        g.MapPost("/topup/{topupId:guid}/cancel", async (Guid topupId, HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var now = DateTimeOffset.UtcNow;
            await db.PendingTopups
                .Where(p => p.Id == topupId && p.UserId == userId && p.Status == TopUpStatus.Pending)
                .ExecuteUpdateAsync(u => u
                    .SetProperty(p => p.Status, TopUpStatus.Cancelled)
                    .SetProperty(p => p.FailureReason, FailureCodes.CancelledAtReturn)
                    .SetProperty(p => p.CompletedAt, now), ct);

            var row = await db.PendingTopups.AsNoTracking().FirstOrDefaultAsync(x => x.Id == topupId && x.UserId == userId, ct);
            return row is null ? Results.NotFound() : Results.Ok(StatusWire(row));
        });
    }

    /// <summary>The status read's shape, shared by the read and the cancel return.</summary>
    private static object StatusWire(PendingTopup p)
    {
        return new
        {
            id = p.Id,
            status = p.Status.ToString(),
            amount_zar = p.AmountZar,
            // P13-B2: the §3.4 purchase shape (package_id, package_name, minutes, list_price_zar,
            // discount_bps, expires_at) replaces conversion_rate and counts_until.
            minutes = p.Minutes,
            // A stable code the client maps to a sentence, never an internal string.
            failure_code = p.FailureReason,
            // M5-2: "a payment you started at 14:05", and until when it holds the member's limit.
            created_at = p.CreatedAt,
            counts_until = p.CreatedAt + PendingLifetime,
        };
    }

    /// <summary>
    /// The member's checkouts still waiting on PayFast — <c>Pending</c> and fresh, so exactly the
    /// rows the ceiling counts as in flight — newest first (review round 5, M5-2).
    ///
    /// <para>
    /// <b>Why the screen lists them.</b> Back from PayFast twice (R200, R800) and the member read
    /// "You've topped up R1000.00, the most the club takes" with R0 paid, for up to an hour, with no
    /// way to free it: the cancel return only fires when PayFast's own Cancel is pressed. Each row
    /// carries its own Cancel (<c>POST /topup/{id}/cancel</c>, which frees the limit at once and,
    /// like the return, is reopened by a signed COMPLETE if the money did move).
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

    /// <summary>One open checkout on the options read.</summary>
    private static object OpenWire(PendingTopup p)
    {
        return new
        {
            id = p.Id,
            amount_zar = p.AmountZar,
            created_at = p.CreatedAt,
            counts_until = p.CreatedAt + PendingLifetime,
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
