using System.Text.Json;
using System.Text.Json.Nodes;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Capability negotiation and the club's cut-over (<c>docs/specs/member-code.md</c> §5.1, §8):
/// what each board last said it speaks, and the phase that follows from all of them.
///
/// <para>
/// <b>The phase moves forward on its own and never back.</b> <c>legacy → v1</c> the first time
/// every enabled board reports <c>codes:m1</c> on its latest heartbeat (and at least one board
/// exists); <c>v1 → v1_only</c> once the club's cut-off delay has passed since the cut-over. Only an
/// administrator moves it backwards, through the settings PUT. The transition is written with a
/// conditional JSON merge rather than a read-modify-write of the whole settings document, so a
/// heartbeat and an admin saving the settings page in the same second cannot erase each other.
/// </para>
/// </summary>
public sealed class MemberCodeRollout
{
    /// <summary>Most capability strings kept from one heartbeat, and the longest each may be.</summary>
    public const int MaxCapabilities = 16;
    public const int MaxCapabilityLength = 32;

    public const string PhaseChangedAction = "member_code.phase_changed";

    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;

    public MemberCodeRollout(MainframeDbContext db, ITenantContext tenant)
    {
        _db = db;
        _tenant = tenant;
    }

    /// <summary>
    /// Puts this heartbeat's <c>caps</c> on the row — replaced wholesale, an absent field reading as
    /// "names nothing", because that is exactly what an older image sends. Staged, not saved.
    /// </summary>
    public static void NoteCapabilities(Device device, IReadOnlyList<string?>? caps, DateTimeOffset now)
    {
        device.Capabilities = (caps ?? [])
            .Where(c => !string.IsNullOrWhiteSpace(c))
            .Select(c => c!.Trim())
            .Where(c => c.Length <= MaxCapabilityLength)
            .Distinct(StringComparer.Ordinal)
            .Take(MaxCapabilities)
            .ToList();
        device.CapabilitiesReportedAt = now;
    }

    /// <summary>
    /// Moves the phase if it is time, and raises the one notice a board can earn here. Returns
    /// true when the phase changed, so the caller re-reads the settings it composes its answer from.
    /// Runs AFTER the heartbeat's own save, so the board's new capabilities are what it counts.
    /// </summary>
    public async Task<bool> EvaluateAsync(Device device, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var phase = MemberCodeSettings.Phase(settings);

        if (phase != MemberCodeSettings.Legacy && device.Enabled && !device.SpeaksMemberCodes)
        {
            await AdminNotices.RaiseAsync(_db, _tenant.TenantId, AdminNotices.CodesCapabilityLost(device, phase), now, ct);
        }

        if (phase == MemberCodeSettings.Legacy && await EveryEnabledBoardSpeaksAsync(ct))
        {
            return await MoveAsync(MemberCodeSettings.Legacy, MemberCodeSettings.V1, MemberCodeSettings.CutoverAtKey, now, ct);
        }

        if (phase == MemberCodeSettings.V1
            && settings.MemberCodeCutoverAt is { } cutover
            && now >= cutover.AddDays(MemberCodeSettings.CutoffDays(settings)))
        {
            return await MoveAsync(MemberCodeSettings.V1, MemberCodeSettings.V1Only, MemberCodeSettings.CutoffAtKey, now, ct);
        }

        return false;
    }

    /// <summary>Every enabled board of the club reports <c>codes:m1</c>, and there is at least one.</summary>
    public async Task<bool> EveryEnabledBoardSpeaksAsync(CancellationToken ct)
    {
        var boards = await _db.Devices.AsNoTracking()
            .Where(d => d.Enabled)
            .Select(d => d.Capabilities)
            .ToListAsync(ct);
        return boards.Count > 0 && boards.All(c => c.Contains(MemberCodeWire.Capability));
    }

    private async Task<bool> MoveAsync(string from, string to, string stampKey, DateTimeOffset now, CancellationToken ct)
    {
        var stamp = now.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture);
        var moved = _db.Database.IsRelational()
            ? await MoveInSqlAsync(from, to, stampKey, stamp, ct)
            : await MoveInMemoryAsync(from, to, stampKey, stamp, ct);
        if (!moved) return false;

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = Guid.Empty,
            Action = PhaseChangedAction,
            DetailsJson = JsonSerializer.Serialize(new { from, to, at = now, automatic = true }),
        });
        await _db.SaveChangesAsync(ct);
        return true;
    }

    private async Task<bool> MoveInSqlAsync(string from, string to, string stampKey, string stamp, CancellationToken ct)
    {
        var patch = new JsonObject { [MemberCodeSettings.PhaseKey] = to, [stampKey] = stamp }.ToJsonString();
        var rows = await _db.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE tenant_settings
               SET "SettingsJson" = "SettingsJson" || {patch}::jsonb, "UpdatedAt" = now()
             WHERE "TenantId" = {_tenant.TenantId}
               AND COALESCE("SettingsJson" ->> {MemberCodeSettings.PhaseKey}, {MemberCodeSettings.Legacy}) = {from}
            """, ct);
        return rows == 1;
    }

    private async Task<bool> MoveInMemoryAsync(string from, string to, string stampKey, string stamp, CancellationToken ct)
    {
        var row = await _db.TenantSettings.FirstOrDefaultAsync(s => s.TenantId == _tenant.TenantId, ct);
        if (row is null) return false;
        var doc = JsonNode.Parse(row.SettingsJson)?.AsObject() ?? [];
        var current = doc[MemberCodeSettings.PhaseKey]?.GetValue<string>() ?? MemberCodeSettings.Legacy;
        if (current != from) return false;
        doc[MemberCodeSettings.PhaseKey] = to;
        doc[stampKey] = stamp;
        row.SettingsJson = doc.ToJsonString();
        row.UpdatedAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);
        return true;
    }
}
