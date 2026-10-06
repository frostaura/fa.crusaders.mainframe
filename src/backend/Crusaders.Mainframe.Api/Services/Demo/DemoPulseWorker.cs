using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services.Demo;

/// <summary>
/// Keeps a demo club's made-up boards looking alive. No board ever talks to a demo club (it has no
/// device key, and the key resolver refuses one anyway), so without this every box on the demo's
/// Monitoring page would go grey a few minutes after the data was drawn and the outage sweep would
/// start raising notices about hardware that does not exist. Once a minute, every enabled board
/// of every demo club is marked heard-from — demo clubs only, by their flag on the club row.
/// </summary>
public sealed class DemoPulseWorker : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<DemoPulseWorker> _logger;

    public DemoPulseWorker(IServiceScopeFactory scopes, ILogger<DemoPulseWorker> logger)
    {
        _scopes = scopes;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);
        do
        {
            try
            {
                await PulseAsync(DateTimeOffset.UtcNow, stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "Demo board pulse failed; trying again in a minute");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    /// <summary>One pulse: every enabled demo board heard from at <paramref name="now"/>. Answers how many.</summary>
    public async Task<int> PulseAsync(DateTimeOffset now, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var demos = await db.Tenants.AsNoTracking().Where(t => t.DemoOfTenantId != null).Select(t => t.Id).ToListAsync(ct);
        if (demos.Count == 0) return 0;
        var at = now.Storable();
        return await db.Devices.IgnoreQueryFilters()
            .Where(d => demos.Contains(d.TenantId) && d.Enabled)
            .ExecuteUpdateAsync(u => u.SetProperty(d => d.LastSeenAt, at), ct);
    }
}
