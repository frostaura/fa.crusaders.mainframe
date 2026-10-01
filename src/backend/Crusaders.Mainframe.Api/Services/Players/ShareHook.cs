using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Multitenancy;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The one line each existing settlement path gained for D11: "this booking's money just moved —
/// let the shares follow". Cancellation, the no-show sweep, a reversal and the bookings it
/// displaced, a cancelled court lit after all, a release — every one calls this AFTER its own
/// commit, and the settlement code itself is untouched.
///
/// <para>
/// <b>A fresh scope, and it never throws.</b> The caller's context may hold tracked rows of its
/// own, and a reconcile saves; running it on the caller's context would flush somebody else's
/// pending work inside a share transfer. And the settlement it follows has already committed and
/// been answered for — a reconcile that fails here is logged and left to <c>ShareWorker</c>'s
/// next pass, never surfaced as a failed cancellation.
/// </para>
///
/// <para>
/// <b>It runs to completion whatever the caller's token says</b> (review round 8). The money has
/// moved; the admin closing the tab or the request aborting must not abort the follow-up, so every
/// entry point ignores the token it is handed and works on <see cref="CancellationToken.None"/>.
/// And it is not the only line of defence: the settlement's own transaction staged the "reconcile
/// due" marker beside the money (<c>MainframeDbContext.ShareStaging</c>), so a hook that never
/// runs at all — a restart in between — is made good by the next minute sweep.
/// </para>
/// </summary>
public sealed class ShareHook
{
    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<ShareHook> _logger;

    public ShareHook(IServiceScopeFactory scopes, ILogger<ShareHook> logger)
    {
        _scopes = scopes; _logger = logger;
    }

    /// <summary>
    /// After a member RECEIVED minutes (a purchase, a desk sale or adjustment, a refund): reconcile every
    /// booking they pay for on which a return is waiting on them (<c>ReturnPendingSince</c>), so
    /// the partner is paid back the moment the organiser can cover it (review round 2, M1). One
    /// indexed read when nothing waits, which is almost always. Never throws.
    /// </summary>
    public async Task AfterCreditAsync(Guid tenantId, string? tenantSlug, IReadOnlyCollection<Guid> userIds, CancellationToken requestAborted)
    {
        var ct = FollowUp(requestAborted);
        List<Guid> waiting;
        try
        {
            using var scope = _scopes.CreateScope();
            scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(tenantId, tenantSlug ?? "");
            var db = scope.ServiceProvider.GetRequiredService<Persistence.MainframeDbContext>();
            // Oldest waiting return first (stamp, then participant id): first come, first served.
            waiting = (await db.BookingParticipants.AsNoTracking()
                .Where(p => p.ReturnPendingSince != null)
                .Join(db.Bookings.AsNoTracking(), p => p.BookingId, b => b.Id,
                    (p, b) => new { b.Id, Payer = b.PaidByUserId ?? b.UserId, p.ReturnPendingSince, Seat = p.Id })
                .Where(x => x.Payer != null && userIds.Contains(x.Payer.Value))
                .OrderBy(x => x.ReturnPendingSince).ThenBy(x => x.Seat)
                .Select(x => x.Id).ToListAsync(ct)).Distinct().ToList();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Finding waiting share returns after minutes arrived failed; the sweep will retry");
            return;
        }

        // One booking at a time, as the settlement hook does (review round 7): one that throws is
        // logged and marked due for the sweep, and the returns behind it are still retried.
        foreach (var id in waiting) await SettleOneAsync(tenantId, tenantSlug, id, "after minutes arrived", ct);
    }

    /// <summary>Reconciles one booking in its own scope; a failure is logged and marks it due. Never throws.</summary>
    private async Task SettleOneAsync(Guid tenantId, string? tenantSlug, Guid bookingId, string after, CancellationToken ct, Guid? ownActionBy = null)
    {
        try
        {
            using var scope = _scopes.CreateScope();
            scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(tenantId, tenantSlug ?? "");
            await scope.ServiceProvider.GetRequiredService<ShareSweep>().SettleBookingAsync(bookingId, ct, ownActionBy);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Share reconcile {After} failed for {Booking}; marked for the sweep", after, bookingId);
            await MarkDueAsync(tenantId, tenantSlug, bookingId, ct);
        }
    }

    /// <param name="ownActionBy">
    /// The member whose own request settled it (review round 4, I4-5): an organiser's cancellation
    /// tells them "25.00 went back to Bongani" born read. Null from the workers.
    /// </param>
    public async Task AfterSettlementAsync(
        Guid tenantId, string? tenantSlug, IEnumerable<Guid?> bookingIds, CancellationToken requestAborted, Guid? ownActionBy = null)
    {
        var ct = FollowUp(requestAborted);
        var ids = bookingIds.Where(i => i is not null).Select(i => i!.Value).Distinct().ToList();
        if (ids.Count == 0) return;

        // One booking at a time, each in its own scope: a failure is logged and leaves that booking
        // marked due (review round 5), so the next minute sweep makes it good however old the
        // booking is — the catch-up at start does not reach every kind of game, and a swallowed
        // failure used to be forgotten.
        foreach (var id in ids) await SettleOneAsync(tenantId, tenantSlug, id, "after settlement", ct, ownActionBy);
    }

    /// <summary>
    /// The token the follow-up runs on: never the caller's. A cancelled request (or a worker
    /// stopping) must not abandon money that has already moved half-way (review round 8).
    /// </summary>
    private static CancellationToken FollowUp(CancellationToken requestAborted)
    {
        _ = requestAborted;
        return CancellationToken.None;
    }

    /// <summary>Leaves the durable "reconcile due" marker in a fresh scope. Best effort: logged if even that fails.</summary>
    private async Task MarkDueAsync(Guid tenantId, string? tenantSlug, Guid bookingId, CancellationToken ct)
    {
        try
        {
            using var scope = _scopes.CreateScope();
            scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(tenantId, tenantSlug ?? "");
            await ShareSweep.MarkReconcileDueAsync(scope.ServiceProvider.GetRequiredService<Persistence.MainframeDbContext>(), bookingId, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Could not mark booking {Booking} for the share sweep", bookingId);
        }
    }
}

/// <summary>
/// The request-side spelling of the hook: the club is the request's own, and so is the action —
/// the signed-in member's own receipts are born read (I4-5). An admin acting on somebody else's
/// game is not a party to it, so this marks nothing of theirs.
/// </summary>
public static class ShareHookHttp
{
    public static Task AfterSettlementAsync(this HttpContext ctx, IEnumerable<Guid?> bookingIds, CancellationToken ct)
    {
        var tenant = ctx.RequestServices.GetRequiredService<ITenantContext>();
        return ctx.RequestServices.GetRequiredService<ShareHook>()
            .AfterSettlementAsync(tenant.TenantId, tenant.TenantSlug, bookingIds, ct, ctx.User.Id());
    }
}
