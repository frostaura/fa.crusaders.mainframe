using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Workers;

/// <summary>
/// Keeps every club's repeating schedules written out to its own horizon.
///
/// <para>
/// <b>The horizon has to be topped up by something, and it cannot be the request that created
/// the schedule.</b> A league night created in October with a sixty-day horizon has rows to
/// mid-December; by November those rows are the past and the series needs January. Nobody
/// clicks anything in between. The create and edit paths also materialise SYNCHRONOUSLY, so an
/// admin sees the result of their own click rather than a calendar that fills in up to fifteen
/// minutes later — this worker is what keeps it true afterwards.
/// </para>
///
/// <para>
/// <b>Per tenant, with the context's tenant explicitly set</b> — the
/// <c>PeripheralHealthWorker</c> idiom, and not <c>LightsCueWorker</c>'s single global
/// <c>IgnoreQueryFilters</c> sweep. A worker that writes rows must have a tenant resolved, or
/// every row it writes carries whichever tenant happened to be set last.
/// </para>
///
/// <para>
/// <b>A fresh scope per tenant, and the change tracker is asserted empty between them.</b> One
/// scope across the loop leaves each tenant's entities tracked while the next tenant's save
/// runs, which is how a sweep writes one club's rows into another's. <c>RetentionWorker</c>
/// documents that hazard; this worker is tested against it rather than trusting the comment.
/// </para>
/// </summary>
public sealed class ScheduleMaterialisationWorker : BackgroundService
{
    /// <summary>
    /// How long the worker waits before its first sweep.
    ///
    /// <para>
    /// Two minutes, staggered like <c>RetentionWorker</c>'s five: a boot that immediately
    /// expanded every schedule for every club would put its heaviest write of the hour into the
    /// same seconds as the migration, the device reconnects and the first admin login.
    /// </para>
    /// </summary>
    public static readonly TimeSpan StartupDelay = TimeSpan.FromMinutes(2);

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<ScheduleMaterialisationWorker> _logger;

    public ScheduleMaterialisationWorker(
        IServiceScopeFactory scopes, ILogger<ScheduleMaterialisationWorker> logger)
    { _scopes = scopes; _logger = logger; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(StartupDelay, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            var interval = ScheduleSettings.DefaultWorkerInterval;

            try
            {
                interval = await SweepAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // One club's broken schedule must not stop every other club's horizon from
                // being topped up, and a worker that dies silently is a horizon that stalls
                // with nothing saying so.
                _logger.LogError(ex, "Schedule materialisation sweep failed");
            }

            try
            {
                await Task.Delay(interval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    /// <summary>
    /// One pass over every club. Returns the interval the LAST club asked for, which is what
    /// the loop waits by — a single-club deployment therefore honours its own setting exactly.
    /// </summary>
    public async Task<TimeSpan> SweepAsync(CancellationToken ct)
    {
        List<Tenant> tenants;
        using (var scope = _scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            tenants = await db.Tenants.IgnoreQueryFilters().AsNoTracking().ToListAsync(ct);
        }

        var interval = ScheduleSettings.DefaultWorkerInterval;

        foreach (var tenant in tenants)
        {
            // A scope PER TENANT. See the type's own summary: a shared scope carries one club's
            // tracked entities into the next club's SaveChanges.
            using var scope = _scopes.CreateScope();
            scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(tenant.Id, tenant.Slug);

            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var settings = scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>();
            var schedules = scope.ServiceProvider.GetRequiredService<BookingScheduleService>();

            interval = ScheduleSettings.WorkerInterval(await settings.GetAsync(ct));

            var active = await db.BookingSchedules
                .Where(s => s.Status == ScheduleStatus.Active)
                .ToListAsync(ct);

            foreach (var schedule in active)
            {
                var outcome = await schedules.MaterialiseAsync(schedule, ct);
                if (outcome.RowsWritten > 0 || outcome.Collisions > 0)
                {
                    _logger.LogInformation(
                        "Schedule {Name} for {Slug}: wrote {Rows} occurrence rows, {Collisions} court-times already held",
                        schedule.Name, tenant.Slug, outcome.RowsWritten, outcome.Collisions);
                }
            }
        }

        return interval;
    }
}
