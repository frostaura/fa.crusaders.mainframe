using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Workers;

/// <summary>
/// Drives <see cref="PlaySweep"/> for every club once a minute (D14, <c>docs/specs/play.md</c> §7.3):
/// auto-confirms results whose deadline passed, drains the recompute markers, and catches up
/// members whose badges were never evaluated against the current catalogue.
///
/// <para>
/// <b>An in-process worker, not a CI or cron schedule</b> — the standing rule. The mechanism is the
/// marker each change's own save staged; this is the safety net that reaches it, as
/// <see cref="ShareWorker"/> is for shares. The pass is <see cref="TickAsync"/>, which tests call at
/// a stated instant, and every club's every step is caught and logged on its own: a crashed
/// <c>BackgroundService</c> is gone for the life of the process.
/// </para>
/// </summary>
public sealed class PlayWorker : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<PlayWorker> _logger;

    public PlayWorker(IServiceScopeFactory scopes, ILogger<PlayWorker> logger)
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
            // Shutting down; the markers wait for the next process.
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
            await RunForClubAsync(new Club(id, slug), "auto-confirm", (sweep, token) => sweep.AutoConfirmAsync(now, token), ct);
            await RunForClubAsync(new Club(id, slug), "recompute", (sweep, token) => sweep.DrainAsync(now, token), ct);
            await RunForClubAsync(new Club(id, slug), "catch-up", (sweep, token) => sweep.CatchUpAsync(now, token), ct);
        }
    }

    private sealed record Club(Guid Id, string Slug);

    /// <summary>One step for one club, in its own scope; a failure is logged, never thrown.</summary>
    private async Task RunForClubAsync(Club club, string step, Func<PlaySweep, CancellationToken, Task<int>> work, CancellationToken ct)
    {
        try
        {
            using var scope = _scopes.CreateScope();
            scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(club.Id, club.Slug);
            await work(scope.ServiceProvider.GetRequiredService<PlaySweep>(), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Play {Step} failed for tenant {Tenant}", step, club.Id);
        }
    }
}
