using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Persistence;

namespace Crusaders.Mainframe.Api.Workers;

/// <summary>
/// Closes package checkouts PayFast never reported on (M4-1): on start, then every
/// <see cref="Interval"/>. See <see cref="TopUpEndpoints.ExpireStaleAsync"/>.
///
/// <para>
/// Safe to run any number of times: it only touches rows still <c>Pending</c> past the lifetime,
/// mails nobody, and leaves each one reopenable, so a COMPLETE that arrives later still posts the
/// locked minutes. The shelf already stops listing those rows as open checkouts, and there is no
/// cap for them to hold (P13), so this is housekeeping for the status page and the desk.
/// </para>
/// </summary>
public sealed class TopUpExpiryWorker(IServiceScopeFactory scopes, ILogger<TopUpExpiryWorker> logger) : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromMinutes(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await TickAsync(DateTimeOffset.UtcNow, stoppingToken);
            using var timer = new PeriodicTimer(Interval);
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                await TickAsync(DateTimeOffset.UtcNow, stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Shutting down; the next process closes whatever is left.
        }
    }

    /// <summary>One pass at <paramref name="now"/>; a failure is logged, never thrown. Returns the rows closed.</summary>
    public async Task<int> TickAsync(DateTimeOffset now, CancellationToken ct)
    {
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
            var closed = await TopUpEndpoints.ExpireStaleAsync(db, now, ct);
            if (closed > 0) logger.LogInformation("Closed {Count} abandoned top-up checkout(s) as expired", closed);
            return closed;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "Top-up expiry pass failed");
            return 0;
        }
    }
}
