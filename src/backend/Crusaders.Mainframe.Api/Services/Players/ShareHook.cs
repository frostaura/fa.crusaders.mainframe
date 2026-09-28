using Crusaders.Mainframe.Api.Multitenancy;

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
/// </summary>
public sealed class ShareHook
{
    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<ShareHook> _logger;

    public ShareHook(IServiceScopeFactory scopes, ILogger<ShareHook> logger)
    {
        _scopes = scopes; _logger = logger;
    }

    public async Task AfterSettlementAsync(Guid tenantId, string? tenantSlug, IEnumerable<Guid?> bookingIds, CancellationToken ct)
    {
        var ids = bookingIds.Where(i => i is not null).Select(i => i!.Value).Distinct().ToList();
        if (ids.Count == 0) return;

        try
        {
            using var scope = _scopes.CreateScope();
            scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(tenantId, tenantSlug ?? "");
            var sweep = scope.ServiceProvider.GetRequiredService<ShareSweep>();
            foreach (var id in ids) await sweep.SettleBookingAsync(id, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Share reconcile after settlement failed for {Bookings}; the worker will retry", string.Join(",", ids));
        }
    }
}

/// <summary>The request-side spelling of the hook: the club is the request's own.</summary>
public static class ShareHookHttp
{
    public static Task AfterSettlementAsync(this HttpContext ctx, IEnumerable<Guid?> bookingIds, CancellationToken ct)
    {
        var tenant = ctx.RequestServices.GetRequiredService<ITenantContext>();
        return ctx.RequestServices.GetRequiredService<ShareHook>()
            .AfterSettlementAsync(tenant.TenantId, tenant.TenantSlug, bookingIds, ct);
    }
}
