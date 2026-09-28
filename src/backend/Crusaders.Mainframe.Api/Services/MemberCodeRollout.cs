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
/// administrator moves it backwards, through the settings PUT — and a backward move sets a HOLD
/// the automatic moves respect until an administrator moves forward again (see
/// <see cref="MemberCodeSettings.HoldKey"/>). The transition is written with a
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

        // An administrator rolled the club back and has not moved it forward since: the automatic
        // road is closed until they do. See MemberCodeSettings.HoldKey for the incident.
        if (settings.MemberCodeManualHold) return false;

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

    /// <summary>
    /// Every enabled, ACKNOWLEDGED board of the club reports <c>codes:m1</c>, and there is at
    /// least one.
    ///
    /// <para>
    /// <b>Acknowledged only</b> — a court box an admin has acknowledged, a door with a
    /// <c>gate_key</c> (<see cref="Endpoints.MemberCodeHeartbeat.Acknowledged"/>, the same test that
    /// decides who is sent keys). An auto-registered board is any device that presented the club's
    /// key and a MAC nobody has vouched for: counted, a spare on a bench running old firmware
    /// blocked the whole club's cut-over forever, and — the other way round — a stranger flashing
    /// <c>codes:m1</c> onto a board could be the vote that tipped it. A board nobody has
    /// acknowledged is served no keys and no roster players, so it has no say in the phase either.
    /// </para>
    /// </summary>
    public async Task<bool> EveryEnabledBoardSpeaksAsync(CancellationToken ct)
    {
        var boards = (await _db.Devices.AsNoTracking().Where(d => d.Enabled).ToListAsync(ct))
            .Where(Endpoints.MemberCodeHeartbeat.Acknowledged)
            .ToList();
        return boards.Count > 0 && boards.All(d => d.SpeaksMemberCodes);
    }

    /// <summary>
    /// Ends every legacy access code at the cut-off (§8 step 4): <c>v1_only</c> refuses them on
    /// every path already, and this makes the table say so too, so nothing that reads a code row
    /// directly can find a live one. The expiry is the cut-off INSTANT, not "now or earlier", so
    /// offline evidence of a scan made before the cut-off still resolves at its own time.
    /// </summary>
    public static async Task ExpireLegacyCodesAsync(MainframeDbContext db, DateTimeOffset at, CancellationToken ct)
    {
        var instant = at.Storable();
        if (db.Database.IsRelational())
        {
            await db.AccessCodes.Where(c => c.ExpiresAt > instant)
                .ExecuteUpdateAsync(u => u
                    .SetProperty(c => c.ExpiresAtBeforeCutoff, c => c.ExpiresAt)
                    .SetProperty(c => c.CutoffExpiredAt, instant)
                    .SetProperty(c => c.ExpiresAt, instant), ct);
            return;
        }

        foreach (var code in await db.AccessCodes.Where(c => c.ExpiresAt > instant).ToListAsync(ct))
        {
            code.ExpiresAtBeforeCutoff = code.ExpiresAt;
            code.CutoffExpiredAt = instant;
            code.ExpiresAt = instant;
        }
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Undoes <see cref="ExpireLegacyCodesAsync"/> when an administrator moves the club back out of
    /// <c>v1_only</c>: every code the cut-off ended whose own expiry is still ahead gets it back —
    /// and, for a booking code, only while its booking is still LIVE (booked, not ended). A booking
    /// cancelled, displaced or ended after the cut-off keeps its code dead: reviving it would
    /// hand a door and a court to a slot nobody holds any more (refuted 2026-09-28). The rest stay
    /// expired. Every mark is cleared either way, so a later cut-off marks afresh.
    /// </summary>
    public static async Task RestoreLegacyCodesAsync(MainframeDbContext db, DateTimeOffset now, CancellationToken ct)
    {
        if (db.Database.IsRelational())
        {
            await Restorable(db, now)
                .ExecuteUpdateAsync(u => u.SetProperty(c => c.ExpiresAt, c => c.ExpiresAtBeforeCutoff!.Value), ct);
            await db.AccessCodes.Where(c => c.CutoffExpiredAt != null)
                .ExecuteUpdateAsync(u => u
                    .SetProperty(c => c.CutoffExpiredAt, (DateTimeOffset?)null)
                    .SetProperty(c => c.ExpiresAtBeforeCutoff, (DateTimeOffset?)null), ct);
            return;
        }

        var restorable = await Restorable(db, now).Select(c => c.Id).ToListAsync(ct);
        foreach (var code in await db.AccessCodes.Where(c => c.CutoffExpiredAt != null).ToListAsync(ct))
        {
            if (restorable.Contains(code.Id)) code.ExpiresAt = code.ExpiresAtBeforeCutoff!.Value;
            code.CutoffExpiredAt = null;
            code.ExpiresAtBeforeCutoff = null;
        }
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The cut-off's codes still worth giving back: in date, and — a booking's — for a booking still live.</summary>
    private static IQueryable<AccessCode> Restorable(MainframeDbContext db, DateTimeOffset now)
    {
        return db.AccessCodes.Where(c => c.CutoffExpiredAt != null && c.ExpiresAtBeforeCutoff > now
            && (c.BookingId == null
                || db.Bookings.Any(b => b.Id == c.BookingId && b.Status == BookingStatus.Booked && b.EndsAt > now)));
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
        if (to == MemberCodeSettings.V1Only) await ExpireLegacyCodesAsync(_db, now, ct);
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
               AND ("SettingsJson" -> {MemberCodeSettings.HoldKey}) IS DISTINCT FROM 'true'::jsonb
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
        if (doc[MemberCodeSettings.HoldKey] is JsonValue hold && hold.TryGetValue<bool>(out var held) && held) return false;
        doc[MemberCodeSettings.PhaseKey] = to;
        doc[stampKey] = stamp;
        row.SettingsJson = doc.ToJsonString();
        row.UpdatedAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);
        return true;
    }
}
