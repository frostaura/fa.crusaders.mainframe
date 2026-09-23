using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Workers;

/// <summary>
/// Drives the admin notice outbox (R23): delivers what is due every
/// <see cref="DeliveryInterval"/>, and runs the observation sweep every
/// <see cref="SweepEvery"/>th pass.
///
/// <para>
/// <b>Deliberately thin.</b> Everything it does is <see cref="AdminNotificationDispatcher"/> and
/// <see cref="AdminNotificationSweep"/>, which tests drive directly at a stated instant; this is
/// the timer and the exception boundary and nothing else. A crashed <c>BackgroundService</c> is
/// silently gone for the life of the process, so every pass is caught and logged rather than
/// allowed to end the loop.
/// </para>
/// </summary>
public sealed class AdminNotificationWorker : BackgroundService
{
    /// <summary>
    /// How often due notices are delivered. Fifteen seconds: an admin who has just been told on
    /// screen that a member applied should not wait longer than that for the mail that says so.
    /// </summary>
    public static readonly TimeSpan DeliveryInterval = TimeSpan.FromSeconds(15);

    /// <summary>The sweep runs every fourth pass — once a minute, which is finer than any window it judges.</summary>
    public const int SweepEvery = 4;

    private readonly AdminNotificationDispatcher _dispatcher;
    private readonly AdminNotificationSweep _sweep;
    private readonly ILogger<AdminNotificationWorker> _logger;

    public AdminNotificationWorker(
        AdminNotificationDispatcher dispatcher, AdminNotificationSweep sweep, ILogger<AdminNotificationWorker> logger)
    {
        _dispatcher = dispatcher; _sweep = sweep; _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(DeliveryInterval);
        var pass = 0;

        while (await WaitAsync(timer, stoppingToken))
        {
            if (pass++ % SweepEvery == 0) await GuardedAsync(() => _sweep.SweepAsync(DateTimeOffset.UtcNow, stoppingToken), "sweep");
            await GuardedAsync(() => _dispatcher.DeliverDueAsync(DateTimeOffset.UtcNow, stoppingToken), "delivery");
        }
    }

    private static async Task<bool> WaitAsync(PeriodicTimer timer, CancellationToken ct)
    {
        try
        {
            return await timer.WaitForNextTickAsync(ct);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    private async Task GuardedAsync(Func<Task> pass, string what)
    {
        try
        {
            await pass();
        }
        catch (OperationCanceledException)
        {
            // Shutting down; the next process picks up whatever is still pending.
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Admin notice {What} pass failed", what);
        }
    }
}
