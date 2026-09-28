using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Workers;

/// <summary>
/// Drives <see cref="ShareSweep"/> for every club once a minute (D11): reconciles recent split
/// bookings, lapses shares past their deadline, sends reminders on the club's cadence.
///
/// <para>
/// <b>The safety net, not the mechanism.</b> Every participant action and every settlement path
/// already reconciles after its own commit; this catches the ones whose hook failed, the ones time
/// alone decides (a deadline passing), and a process that died in between. Thin for the reason
/// <see cref="AdminNotificationWorker"/> is: the pass is <see cref="TickAsync"/>, which tests call at
/// a stated instant, and a crashed <c>BackgroundService</c> is gone for the life of the process, so
/// every club's pass is caught and logged on its own.
/// </para>
/// </summary>
public sealed class ShareWorker : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<ShareWorker> _logger;

    public ShareWorker(IServiceScopeFactory scopes, ILogger<ShareWorker> logger)
    {
        _scopes = scopes; _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                await TickAsync(DateTimeOffset.UtcNow, stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Shutting down; the next process sweeps whatever is left.
        }
    }

    /// <summary>One pass over every club at <paramref name="now"/>.</summary>
    public async Task TickAsync(DateTimeOffset now, CancellationToken ct)
    {
        List<(Guid Id, string Slug)> tenants;
        using (var scope = _scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            tenants = (await db.Tenants.IgnoreQueryFilters().AsNoTracking().Select(t => new { t.Id, t.Slug }).ToListAsync(ct))
                .Select(t => (t.Id, t.Slug)).ToList();
        }

        foreach (var (id, slug) in tenants)
        {
            try
            {
                using var scope = _scopes.CreateScope();
                scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(id, slug);
                await scope.ServiceProvider.GetRequiredService<ShareSweep>().SweepAsync(now, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Share sweep failed for tenant {Tenant}", id);
            }
        }
    }
}
