using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The admin notices nobody's write raises: the ones that are an OBSERVATION about a club rather
/// than a consequence of one request — applications that have waited too long, a door turning a
/// lot of people away, many faults at once — and the pruning of the feed they all land on.
///
/// <para>
/// <b>Per club, each in a fresh scope with the club set</b> — the
/// <c>ScheduleMaterialisationWorker</c> idiom. One scope across the loop leaves one club's rows
/// tracked while the next club saves, which is how a sweep writes one club's notice into
/// another's feed.
/// </para>
///
/// <para>
/// <b>Every threshold is the club's own.</b> The spike on a door is exactly the flag the doors
/// tile raises (<see cref="DoorSignals"/>, over the club's <c>door_refusal_spike_*</c>), so an
/// admin mailed about a door and an admin looking at its tile see the same verdict. The fault
/// spike and the reminder read <see cref="AdminNotificationSettings"/>.
/// </para>
/// </summary>
public sealed class AdminNotificationSweep
{
    /// <summary>How many boards a fault-spike mail names. The Faults page has the rest.</summary>
    public const int BoardsNamed = 5;

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<AdminNotificationSweep> _logger;

    public AdminNotificationSweep(IServiceScopeFactory scopes, ILogger<AdminNotificationSweep> logger)
    {
        _scopes = scopes; _logger = logger;
    }

    /// <summary>One pass over every club at <paramref name="now"/>.</summary>
    public async Task SweepAsync(DateTimeOffset now, CancellationToken ct)
    {
        List<Tenant> tenants;
        using (var scope = _scopes.CreateScope())
        {
            tenants = await scope.ServiceProvider.GetRequiredService<MainframeDbContext>()
                .Tenants.IgnoreQueryFilters().AsNoTracking().ToListAsync(ct);
        }

        foreach (var tenant in tenants)
        {
            try
            {
                await SweepClubAsync(tenant, now.ToUniversalTime(), ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Admin notice sweep failed for {Slug}", tenant.Slug);
            }
        }
    }

    private async Task SweepClubAsync(Tenant tenant, DateTimeOffset now, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(tenant.Id, tenant.Slug);
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var settings = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(ct);

        await RemindAboutApplicationsAsync(db, tenant.Id, settings, now, ct);
        await DetectRefusalSpikesAsync(db, tenant.Id, settings, now, ct);
        await DetectFaultSpikeAsync(db, tenant.Id, settings, now, ct);
        await PruneAsync(db, settings, now, ct);
    }

    /// <summary>
    /// The daily reminder, once the club's day has begun: applications older than the club's
    /// threshold, named by the oldest. Keyed on the club's own date, so it is daily at most, and
    /// held until the club opens so nobody is mailed a reminder at five past midnight.
    /// </summary>
    internal static async Task RemindAboutApplicationsAsync(
        MainframeDbContext db, Guid tenantId, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var zone = ClubClock.ZoneOf(settings);
        var local = TimeZoneInfo.ConvertTime(now, zone);
        if (local.Hour * 60 + local.Minute < settings.DayStartMinute) return;

        var threshold = AdminNotificationSettings.ApplicationReminderHours(settings);
        var cutoff = now.AddHours(-threshold);
        var waiting = await db.Memberships.AsNoTracking()
            .Where(m => m.Status == MembershipStatus.PendingApproval && m.CreatedAt <= cutoff)
            .OrderBy(m => m.CreatedAt)
            .Select(m => new { m.FullName, m.CreatedAt })
            .ToListAsync(ct);
        if (waiting.Count == 0) return;

        var oldest = waiting[0];
        var hours = (int)Math.Floor((now - oldest.CreatedAt).TotalHours);
        var notice = AdminNotices.ApplicationsPending(DateOnly.FromDateTime(local.DateTime), waiting.Count, oldest.FullName, hours);
        await AdminNotices.RaiseAsync(db, tenantId, notice, now, ct);
    }

    /// <summary>
    /// A door turning many scans away, judged by the doors tile's own rule. Only doors an admin
    /// has acknowledged and left in service: an unacknowledged board mails nobody, whatever it
    /// does, for the flood reason <c>decisions-device-alerts.md</c> records.
    /// </summary>
    internal static async Task DetectRefusalSpikesAsync(
        MainframeDbContext db, Guid tenantId, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var doors = await db.Devices.AsNoTracking()
            .Where(d => d.Kind == DeviceKind.Gate && d.Enabled && !d.AutoRegistered)
            .ToListAsync(ct);
        if (doors.Count == 0) return;

        var minutes = DoorSettings.RefusalSpikeMinutes(settings);
        var floor = now.AddMinutes(-minutes).ToUniversalTime();
        var rows = await db.AuditLogs.AsNoTracking()
            .Where(DoorTrail.IsScanRow)
            .Where(a => a.CreatedAt >= floor)
            .Select(a => new { a.Action, a.CreatedAt, a.SubjectUserId, a.DetailsJson })
            .ToListAsync(ct);

        var scans = rows
            .Select(r => (Details: DoorActivityView.Details(r.DetailsJson), r.Action, r.CreatedAt, r.SubjectUserId))
            .GroupBy(r => DoorTrail.DeviceIdOf(r.Details))
            .ToDictionary(
                g => g.Key ?? Guid.Empty,
                g => g.Select(r => DoorSignals.ScanOf(r.Action, r.CreatedAt, r.SubjectUserId, r.Details)).ToList());

        var bucket = Bucket(now, minutes);
        foreach (var door in doors)
        {
            if (!scans.TryGetValue(door.Id, out var list)) continue;
            var spike = DoorSignals.For(list, settings, now).FirstOrDefault(s => s.Kind == DoorSignals.RefusalSpike);
            if (spike is null) continue;
            await AdminNotices.RaiseAsync(db, tenantId, AdminNotices.RefusalSpike(bucket, door, spike.Scans, minutes), now, ct);
        }
    }

    /// <summary>
    /// Many different faults at once: open rows of error severity or worse that OPENED inside the
    /// club's window. Distinct rows, not occurrences — one board repeating one fault is one row
    /// however loudly it repeats, and that is the Faults page's business.
    ///
    /// <para>
    /// <b>Opened, not last seen.</b> Counting by <c>LastSeenAt</c> made five faults that opened a
    /// week ago and are still repeating — a flaky sensor does exactly that — a "spike" in every
    /// window for ever: about twenty mails a day headlined "5 device faults in 15 minutes" when
    /// nothing had opened in any of them. A spike is new faults arriving together; old ones that
    /// keep repeating are already on the Faults page and were already announced.
    /// </para>
    /// </summary>
    internal static async Task DetectFaultSpikeAsync(
        MainframeDbContext db, Guid tenantId, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var minutes = AdminNotificationSettings.FaultSpikeMinutes(settings);
        var since = now.AddMinutes(-minutes).ToUniversalTime();
        var faults = await db.DeviceErrors.AsNoTracking()
            .Where(e => e.ResolvedAt == null && e.Severity >= DeviceErrorSeverity.Error && e.FirstSeenAt >= since)
            .Select(e => new { e.DeviceId, e.ClaimedDeviceCode })
            .ToListAsync(ct);
        if (faults.Count < AdminNotificationSettings.FaultSpikeCount(settings)) return;

        var ids = faults.Where(f => f.DeviceId != null).Select(f => f.DeviceId!.Value).Distinct().ToList();
        var codes = await db.Devices.AsNoTracking().Where(d => ids.Contains(d.Id))
            .ToDictionaryAsync(d => d.Id, d => d.DeviceCode, ct);
        var boards = faults
            .Select(f => f.DeviceId is { } id && codes.TryGetValue(id, out var code) ? code : f.ClaimedDeviceCode ?? "unknown board")
            .GroupBy(b => b).OrderByDescending(g => g.Count()).ThenBy(g => g.Key, StringComparer.Ordinal)
            .Take(BoardsNamed).Select(g => g.Key).ToArray();

        var notice = AdminNotices.FaultSpike(Bucket(now, minutes), faults.Count, minutes, boards);
        await AdminNotices.RaiseAsync(db, tenantId, notice, now, ct);
    }

    /// <summary>
    /// Deletes finished notices older than the club's retention. Pending ones are never deleted
    /// by age: a notice nobody has been told about yet is not history.
    ///
    /// <para>
    /// <b>Never kept past the club's own <c>retention_years</c>.</b> A notice carries names, an
    /// applicant's address, membership numbers and balances; the club's promise about how long it
    /// keeps personal data is <c>retention_years</c>, and a feed setting of 730 days must not
    /// outlast a club that said one year. The shorter of the two wins.
    /// </para>
    ///
    /// <para>
    /// <b>A schedule clash is kept until its first clash has passed.</b> Its row is the only thing
    /// that stops the sweep raising the same standing clash again (its dedupe key is the schedule
    /// and the first clash date, and the horizon re-collides every tick). A clash is only ever
    /// raised for a night inside the horizon, so a row older than the horizon plus a day names a
    /// night already in the past, which no sweep can re-collide with. Its payload is a schedule
    /// name and dates, no member's data, so the floor does not reopen the point above.
    /// </para>
    /// </summary>
    internal static async Task PruneAsync(
        MainframeDbContext db, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var byDays = now.AddDays(-AdminNotificationSettings.RetentionDays(settings));
        var byYears = now.AddYears(-Math.Max(1, settings.RetentionYears));
        var cutoff = (byDays > byYears ? byDays : byYears).ToUniversalTime();
        var clashFloor = now.AddDays(-(ScheduleSettings.EffectiveHorizonDays(settings) + 1)).ToUniversalTime();
        var clashCutoff = clashFloor < cutoff ? clashFloor : cutoff;

        var old = db.AdminNotifications
            .Where(n => n.State != AdminNotificationState.Pending && n.CreatedAt < cutoff)
            .Where(n => n.Kind != AdminEventCatalogue.ScheduleConflict || n.CreatedAt < clashCutoff);

        if (db.Database.IsNpgsql())
        {
            await old.ExecuteDeleteAsync(ct);
            return;
        }

        db.AdminNotifications.RemoveRange(await old.ToListAsync(ct));
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Which window of <paramref name="minutes"/> an instant falls in — the unit a spike is deduplicated by.</summary>
    internal static long Bucket(DateTimeOffset now, int minutes) =>
        now.ToUnixTimeSeconds() / (Math.Max(minutes, 1) * 60L);
}
