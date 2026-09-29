using Crusaders.Mainframe.Api.Multitenancy;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Immediacy for a member's own taps (<c>docs/specs/play.md</c> §7.4): after the commit of a result
/// record, edit, confirm, dispute, withdraw, void or uphold, and after <c>PUT /me/play/settings</c>,
/// the affected members are evaluated at once — so the winner of a confirmed match has their
/// "First win" by the time the confirmer's sheet closes.
///
/// <para>
/// <b>A fresh scope per member, on <see cref="CancellationToken.None"/>, and it never throws</b>
/// (the <c>ShareHook</c> pattern). It is not the guarantee: the change's own save staged the
/// booking's recompute marker, so <c>PlayWorker</c> evaluates anybody this misses. A check-in is not
/// hooked — the member is on court, and the minute worker is soon enough.
/// </para>
/// </summary>
public sealed class PlayHook
{
    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<PlayHook> _logger;

    public PlayHook(IServiceScopeFactory scopes, ILogger<PlayHook> logger)
    {
        _scopes = scopes; _logger = logger;
    }

    public async Task AfterAsync(Guid tenantId, string? tenantSlug, IEnumerable<Guid> userIds)
    {
        foreach (var userId in userIds.Distinct())
        {
            try
            {
                using var scope = _scopes.CreateScope();
                scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(tenantId, tenantSlug ?? "");
                await scope.ServiceProvider.GetRequiredService<PlayEvaluator>().EvaluateAsync(userId, DateTimeOffset.UtcNow, CancellationToken.None);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Play evaluation after a member's action failed for {User}; the worker will retry", userId);
            }
        }
    }
}

/// <summary>The request-side spelling of the hook: the club is the request's own.</summary>
public static class PlayHookHttp
{
    public static Task AfterPlayAsync(this HttpContext ctx, IEnumerable<Guid> userIds)
    {
        var tenant = ctx.RequestServices.GetRequiredService<ITenantContext>();
        return ctx.RequestServices.GetRequiredService<PlayHook>().AfterAsync(tenant.TenantId, tenant.TenantSlug, userIds);
    }
}
