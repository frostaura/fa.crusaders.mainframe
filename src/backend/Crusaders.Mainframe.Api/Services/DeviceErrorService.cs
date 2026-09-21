using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>One thing that went wrong, as the caller knows it.</summary>
/// <param name="Code">Raw as reported. Normalised through <see cref="DeviceErrorCodes.Normalise"/> by the writer.</param>
/// <param name="Source">Whether the board said so or this server noticed.</param>
/// <param name="DeviceId">The board's row, when one resolved. Null for an auth failure, by construction.</param>
/// <param name="ClaimedDeviceCode">What the caller said it was, when there is no row to confirm it.</param>
/// <param name="ClaimedMac">What the caller said its MAC was.</param>
/// <param name="Detail">Free text. Truncated, never refused.</param>
/// <param name="Court">The relay index, when the fault is about one.</param>
/// <param name="Count">How many occurrences this report stands for. Clamped into <c>[1, 65535]</c>.</param>
/// <param name="At">When it happened. Defaults to now.</param>
public sealed record DeviceErrorReport(
    string? Code,
    DeviceErrorSource Source,
    Guid? DeviceId = null,
    string? ClaimedDeviceCode = null,
    string? ClaimedMac = null,
    string? Detail = null,
    int? Court = null,
    int Count = 1,
    DateTimeOffset? At = null,
    /// <summary>
    /// Fold every report of this code into ONE row for the club, ignoring which board or MAC
    /// it came from.
    ///
    /// <para>
    /// <b>This is the flood control for the codes whose subject is attacker-chosen.</b>
    /// <c>unregistered_mac</c> is raised by anything holding the club's device key, once per
    /// MAC it invents — so fingerprinting it on the MAC, as every other code is fingerprinted,
    /// would let one key-holder open a thousand rows and bury the club's real faults under
    /// them. Folded by code it is a single row whose count climbs and whose detail carries the
    /// most recent MAC, which is also the more useful sentence: "412 boards you have not
    /// registered tried to check in" rather than 412 rows saying one each.
    /// </para>
    /// </summary>
    bool FoldByCode = false);

/// <summary>
/// The one writer of <c>device_errors</c> — GOAL item 7's ingest.
///
/// <para>
/// <b>The write is ONE statement, not a read-then-write.</b> Two reports of one fault arriving
/// together both pass a check-then-insert and one of them loses the unique index — which is
/// the same shape as the board-count cap that thirty-two concurrent heartbeats walk straight
/// through. <c>INSERT … ON CONFLICT … DO UPDATE</c> against the filtered unique index makes
/// de-duplication the database's job. EF Core has no first-class upsert on a partial index, so
/// this is raw SQL through <c>ExecuteSqlInterpolatedAsync</c>, parameterised throughout.
/// </para>
///
/// <para>
/// <b><c>GREATEST</c> on the last-seen, and that is not defensive.</b> A board back from an
/// outage uploads events whose times were clamped but never ordered, so an older report can
/// arrive after a newer one; taking the maximum means the "last seen" column means last seen
/// rather than last written.
/// </para>
///
/// <para>
/// <b>Never on the request's critical path.</b> The device-facing calls go through
/// <see cref="InBackground"/>, in the shape the email dispatch already uses: an error log that
/// can fail a device upload converts a scanner fault into a lost activation, and a monitoring
/// feature that can darken a court is worse than no monitoring feature.
/// </para>
/// </summary>
public sealed class DeviceErrorService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly IRealtimeBus _bus;
    private readonly TenantSettingsAccessor _settings;

    public DeviceErrorService(
        MainframeDbContext db, ITenantContext tenant, IRealtimeBus bus, TenantSettingsAccessor settings)
    {
        _db = db;
        _tenant = tenant;
        _bus = bus;
        _settings = settings;
    }

    /// <summary>
    /// Largest occurrence count one report may claim. The device wire carries it in a field
    /// sized for a duration, so a board with a wild counter is clamped rather than believed —
    /// and clamped rather than refused, because the report is still evidence that something is
    /// very wrong with that board.
    /// </summary>
    public const int MaxReportedCount = 65_535;

    /// <summary>
    /// Records one fault, folding it into the open row for the same fingerprint when there is
    /// one. Returns the row as it now stands, or null when the report was suppressed by one of
    /// the two per-board bounds.
    /// </summary>
    public async Task<DeviceError?> RecordAsync(DeviceErrorReport report, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        var code = DeviceErrorCodes.Normalise(report.Code);

        // The RAW code is worth more than the fact that it was unrecognised. A firmware ahead
        // of this server reports something real, and dropping the string would make the
        // monitoring page go quiet exactly when a new release starts misbehaving.
        var detail = code == DeviceErrorCodes.Unknown && !string.IsNullOrWhiteSpace(report.Code)
            ? Truncate($"{report.Code.Trim()}{(string.IsNullOrWhiteSpace(report.Detail) ? "" : " — " + report.Detail.Trim())}")
            : Truncate(report.Detail);

        var at = report.At ?? DateTimeOffset.UtcNow;
        var count = Math.Clamp(report.Count, 1, MaxReportedCount);

        if (await SuppressedAsync(report, settings, at, ct))
        {
            return await OverflowAsync(report, count, at, ct);
        }

        return await UpsertAsync(report, code, detail, count, at, ct);
    }

    /// <summary>
    /// Whether this report must be folded into the board's overflow row rather than opening or
    /// touching a row of its own.
    ///
    /// <para>
    /// Two bounds, both per BOARD, and both deliberately checked only for a fingerprint that is
    /// not already open: a board at its ceiling must still be able to increment the counts of
    /// the faults it is already reporting, or the page freezes at the moment the board gets
    /// worse. The cheapest check runs first.
    /// </para>
    /// </summary>
    private async Task<bool> SuppressedAsync(
        DeviceErrorReport report, TenantSettingsView settings, DateTimeOffset at, CancellationToken ct)
    {
        // A board with no row cannot be rate-limited per board; it is bounded by the route's
        // own tenant limiter and by the fingerprint, which folds a flood of identical auth
        // failures into one row whatever their volume.
        if (report.DeviceId is not { } deviceId) return false;

        var perMinute = MonitoringSettings.IngestPerMinute(settings);
        var since = at.AddMinutes(-1);
        var recent = await _db.DeviceErrors.AsNoTracking()
            .CountAsync(e => e.DeviceId == deviceId && e.LastSeenAt >= since, ct);
        if (recent >= perMinute) return true;

        var maxOpen = MonitoringSettings.MaxOpenRows(settings);
        var open = await _db.DeviceErrors.AsNoTracking()
            .CountAsync(e => e.DeviceId == deviceId && e.ResolvedAt == null, ct);
        return open >= maxOpen;
    }

    /// <summary>
    /// Folds a suppressed report into this board's single overflow row, whose detail carries
    /// the running <c>suppressed=</c> count.
    ///
    /// <para>
    /// The page can then say "and 412 more we stopped recording — this board is in trouble",
    /// which is a sentence an admin can act on. 412 rows is not.
    /// </para>
    /// </summary>
    private async Task<DeviceError?> OverflowAsync(
        DeviceErrorReport report, int count, DateTimeOffset at, CancellationToken ct)
    {
        var fingerprint = DeviceErrorFingerprint.Of(
            _tenant.TenantId, report.DeviceId, report.ClaimedMac,
            DeviceErrorCodes.ErrorLogOverflow, court: null, detail: null);

        var existing = await _db.DeviceErrors
            .FirstOrDefaultAsync(e => e.Fingerprint == fingerprint && e.ResolvedAt == null, ct);

        var suppressed = count + (existing is null ? 0 : SuppressedOf(existing.Detail));

        // The overflow row counts REPORTS, not occurrences, and its detail carries the running
        // total — so the count column climbs by one per suppressed report rather than by the
        // suppressed occurrences, which would double-count against the number in the detail.
        return await UpsertRawAsync(
            report,
            new Upsert(
                DeviceErrorCodes.ErrorLogOverflow, $"suppressed={suppressed}",
                Court: null, fingerprint, at, CountDelta: 1),
            ct);
    }

    private static int SuppressedOf(string? detail)
    {
        if (detail is null) return 0;
        var marker = detail.LastIndexOf("suppressed=", StringComparison.Ordinal);
        if (marker < 0) return 0;
        var digits = new string([.. detail[(marker + 11)..].TakeWhile(char.IsAsciiDigit)]);
        return int.TryParse(digits, out var n) ? n : 0;
    }

    private async Task<DeviceError?> UpsertAsync(
        DeviceErrorReport report, string code, string? detail, int count, DateTimeOffset at,
        CancellationToken ct)
    {
        // A folded code ignores the board AND the detail, so every report lands on one row.
        // See DeviceErrorReport.FoldByCode for which codes need that and why.
        var fingerprint = report.FoldByCode
            ? DeviceErrorFingerprint.Of(_tenant.TenantId, null, null, code, null, null)
            : DeviceErrorFingerprint.Of(
                _tenant.TenantId, report.DeviceId, report.ClaimedMac, code, report.Court, detail);
        return await UpsertRawAsync(
            report, new Upsert(code, detail, report.Court, fingerprint, at, count), ct);
    }

    /// <summary>
    /// The single-statement upsert, and the publish that follows it.
    ///
    /// <para>
    /// The statement's <c>RETURNING</c> tells the caller whether this opened a NEW row, which
    /// is what decides between an <c>error_opened</c> frame and a quiet count increment: an
    /// admin's monitoring page should announce a new fault and should not shout once a second
    /// while an existing one climbs.
    /// </para>
    /// </summary>
    /// <summary>One row's worth of values, already normalised, bounded and fingerprinted.</summary>
    private sealed record Upsert(
        string Code, string? Detail, int? Court, string Fingerprint, DateTimeOffset At, int CountDelta);

    private async Task<DeviceError?> UpsertRawAsync(
        DeviceErrorReport report, Upsert upsert, CancellationToken ct)
    {
        var (code, detail, court, fingerprint, at, countDelta) = upsert;
        var id = Guid.NewGuid();
        var severity = (int)DeviceErrorCodes.SeverityOf(code);
        var source = (int)report.Source;
        var claimedCode = Cut(report.ClaimedDeviceCode, DeviceError.MaxClaimedDeviceCodeLength);
        var claimedMac = Cut(report.ClaimedMac, DeviceError.MaxClaimedMacLength);

        await _db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO device_errors
                ("Id","TenantId","DeviceId","ClaimedDeviceCode","ClaimedMac","Source","Code",
                 "Severity","Detail","Court","FirstSeenAt","LastSeenAt","Count","Fingerprint")
            VALUES ({id},{_tenant.TenantId},{report.DeviceId},{claimedCode},{claimedMac},{source},{code},
                    {severity},{detail},{court},{at},{at},{countDelta},{fingerprint})
            ON CONFLICT ("TenantId","Fingerprint") WHERE "ResolvedAt" IS NULL
            DO UPDATE SET
                "LastSeenAt" = GREATEST(device_errors."LastSeenAt", EXCLUDED."LastSeenAt"),
                "Count"      = device_errors."Count" + EXCLUDED."Count",
                "Detail"     = EXCLUDED."Detail",
                "DeviceId"   = COALESCE(device_errors."DeviceId", EXCLUDED."DeviceId")
            """, ct);

        var row = await _db.DeviceErrors.AsNoTracking()
            .FirstOrDefaultAsync(e => e.Fingerprint == fingerprint && e.ResolvedAt == null, ct);
        if (row is null) return null;

        // A brand-new row is the one that got this call's own id back. Cheaper and more exact
        // than comparing counts, which a concurrent report would have moved underneath us.
        if (row.Id == id) PublishOpened(row);
        return row;
    }

    private void PublishOpened(DeviceError row)
    {
        var payload = JsonSerializer.Serialize(new
        {
            id = row.Id,
            device_id = row.DeviceId,
            code = row.Code,
            severity = SeverityWire(row.Severity),
            headline = DeviceErrorCodes.HeadlineOf(row.Code),
            count = row.Count,
            first_seen_at = row.FirstSeenAt,
            last_seen_at = row.LastSeenAt,
        });
        _bus.Publish(RealtimeTopic.Monitoring(_tenant.TenantId), new RealtimeMessage("error_opened", payload));
    }

    /// <summary>The wire spelling of a severity — lower snake, a closed set of four.</summary>
    public static string SeverityWire(DeviceErrorSeverity severity)
    {
        return severity switch
        {
            DeviceErrorSeverity.Critical => "critical",
            DeviceErrorSeverity.Error => "error",
            DeviceErrorSeverity.Warning => "warning",
            _ => "info",
        };
    }

    /// <summary>The wire spelling of a source.</summary>
    public static string SourceWire(DeviceErrorSource source) =>
        source == DeviceErrorSource.Device ? "device" : "server";

    private static string? Truncate(string? value) => Cut(value, DeviceError.MaxDetailLength);

    private static string? Cut(string? value, int max)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var trimmed = value.Trim();
        return trimmed.Length > max ? trimmed[..max] : trimmed;
    }

    /// <summary>
    /// Records a fault on its own scope, off the caller's request.
    ///
    /// <para>
    /// The shape the booking service's email dispatch already uses, and here for a sharper
    /// reason than there: every device-facing call site of this service is on a path that
    /// lights a court or opens a door. A monitoring write that can throw on that path is a
    /// feature that makes the club's own hardware less reliable in order to report on its
    /// reliability.
    /// </para>
    ///
    /// <para>
    /// The tenant is passed explicitly and set on the new scope, because the ambient tenant
    /// context belongs to a request that will have finished.
    /// </para>
    /// </summary>
    public static void InBackground(
        IServiceScopeFactory scopes, ILogger logger, Guid tenantId, string tenantSlug,
        DeviceErrorReport report)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                using var scope = scopes.CreateScope();
                scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(tenantId, tenantSlug);
                var service = scope.ServiceProvider.GetRequiredService<DeviceErrorService>();
                await service.RecordAsync(report, CancellationToken.None);
            }
            catch (Exception ex)
            {
                // Swallowed on purpose, and logged so it is not silent. This is the LAST
                // resort of a diagnostic feature: if recording the fault fails, the club loses
                // one row on a monitoring page. If it propagated, the club loses the court.
                logger.LogWarning(ex, "Could not record device error {Code}", report.Code);
            }
        });
    }
}
