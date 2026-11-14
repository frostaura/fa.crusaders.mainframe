using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Workers;

/// <summary>
/// Deletes photo files nobody references (BP-04, BM-15): on start, then every <see cref="Interval"/>.
///
/// <para>
/// The registration screen uploads the photo before it posts the application, every refused or
/// abandoned application left its file behind, and a replaced profile photo left the old one. The
/// upload is anonymous by necessity, so without a reaper the media volume — the disk Postgres
/// shares on a one-host stack — only ever grew. A file is removed once it is older than
/// <see cref="MemberPhotoFiles.OrphanAfter"/> and no membership in ANY club names its URL; the age
/// is what spares an upload whose registration is still on its way.
/// </para>
/// </summary>
public sealed class PhotoOrphanSweepWorker(
    IServiceScopeFactory scopes, MemberPhotoFiles photos, ILogger<PhotoOrphanSweepWorker> logger) : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromMinutes(15);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await SweepAsync(DateTimeOffset.UtcNow, stoppingToken);
            using var timer = new PeriodicTimer(Interval);
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                await SweepAsync(DateTimeOffset.UtcNow, stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Shutting down; the next process sweeps what is left.
        }
    }

    /// <summary>One pass at <paramref name="now"/>; a failure is logged, never thrown. Returns the files removed.</summary>
    public async Task<int> SweepAsync(DateTimeOffset now, CancellationToken ct)
    {
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var removed = 0;
            foreach (var (slug, names) in photos.StaleFiles(now - photos.OrphanAfter))
            {
                var prefix = MemberPhotoFiles.PrefixOf(slug);
                var referenced = (await db.Memberships.IgnoreQueryFilters().AsNoTracking()
                        .Where(m => m.PhotoUrl != null && m.PhotoUrl.StartsWith(prefix))
                        .Select(m => m.PhotoUrl!)
                        .ToListAsync(ct))
                    .ToHashSet(StringComparer.Ordinal);
                foreach (var name in names)
                {
                    var url = prefix + name;
                    if (!MemberPhotoFiles.IsIssued(slug, url) || referenced.Contains(url)) continue;
                    photos.TryDelete(slug, url);
                    removed++;
                }
            }

            if (removed > 0) logger.LogInformation("Removed {Count} photo file(s) no membership references", removed);
            return removed;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "Photo orphan sweep failed");
            return 0;
        }
    }
}
