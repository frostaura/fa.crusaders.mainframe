using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// The two disagreements between the bookings and the BOX's own word about a court's lights
/// (BA-04, server half): <b>lights on, nothing booked</b> and <b>checked in, lights off</b>.
///
/// <para>
/// <b>Why the server files them, not only the tile.</b> The control-board tile already shows both
/// (<c>monitoringCopy.lightsMismatch</c>), but only to an admin who is looking at that tile. Lights
/// burning on an empty court cost electricity and can hide a stuck relay or a dead auto-off; a
/// member checked in on a dark court has paid for light they are not getting. Filed as server
/// faults against the box that drives the court, they reach the Faults list, the Overview's
/// "Needs attention" and the fault-spike mail with nothing else to build.
/// </para>
///
/// <para>
/// <b>The same rule as the tile, so the two never disagree.</b> Only the box's CONFIRMED state
/// counts (the club's own record cannot disagree with itself); nothing is said about a court whose
/// box is offline, unlinked or out of service; and each is held for the club's grace window, so a
/// court switching between two bookings is not flagged. When the disagreement clears, the fault
/// resolves itself — an admin is never left closing a fault the court already fixed.
/// </para>
/// </summary>
public static class LightsMismatch
{
    /// <summary>The resolution note a fault that cleared on its own carries.</summary>
    public const string ClearedNote = "Cleared on its own: the box and the bookings agree again.";

    /// <summary>The two codes this check files and resolves — and no other.</summary>
    public static readonly string[] Codes = [DeviceErrorCodes.LightsOnNothingBooked, DeviceErrorCodes.CheckedInLightsOff];

    /// <summary>
    /// Which disagreement this court is in, or null. <paramref name="current"/> is the booking (or
    /// block) on the court at <paramref name="now"/>, not cancelled.
    /// </summary>
    public static string? Classify(CourtLightState? light, Booking? current, DateTimeOffset now, int graceMinutes)
    {
        if (light?.ConfirmedAt is not { } confirmed) return null;
        var graceStart = now.AddMinutes(-Math.Max(0, graceMinutes));
        if (light.ConfirmedState == LightState.On)
        {
            if (current is not null) return null;
            var since = light.State == LightState.On && light.OnSince is { } on ? on : confirmed;
            return since < graceStart ? DeviceErrorCodes.LightsOnNothingBooked : null;
        }
        if (light.ConfirmedState == LightState.Off)
        {
            if (current?.CheckedInAt is not { } checkedIn) return null;
            return confirmed > checkedIn && checkedIn < graceStart ? DeviceErrorCodes.CheckedInLightsOff : null;
        }
        return null;
    }

    /// <summary>The sentence a fault row carries. Stable per court, because the row's fingerprint includes it.</summary>
    public static string DetailOf(string code, int courtNumber) => code == DeviceErrorCodes.LightsOnNothingBooked
        ? $"Court {courtNumber}: the box says its lights are on and nothing is booked on it."
        : $"Court {courtNumber}: somebody checked in and the box says its lights are off.";

    /// <summary>A court the box drives and can be believed about: the box is in service and has called in lately.</summary>
    private static bool Believable(Device box, DateTimeOffset now, int offlineAfterSeconds)
    {
        if (!box.Enabled || box.OutOfServiceSince is not null) return false;
        return box.LastSeenAt is { } seen && (now - seen).TotalSeconds <= offlineAfterSeconds;
    }

    /// <summary>
    /// One pass over one club: files each disagreement found against its court's box, and resolves
    /// every open one of these two codes that no longer holds. Runs in the club's own scope.
    /// </summary>
    public static async Task SweepAsync(
        MainframeDbContext db, DeviceErrorService faults, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var courts = await db.Courts.AsNoTracking().ToListAsync(ct);
        var lights = await db.CourtLightStates.AsNoTracking().ToDictionaryAsync(l => l.CourtId, ct);
        var current = await db.Bookings.AsNoTracking()
            .Where(b => b.Status != BookingStatus.Cancelled && b.StartsAt <= now && b.EndsAt > now)
            .ToListAsync(ct);
        var boxes = await db.Devices.AsNoTracking().Where(d => d.Kind == DeviceKind.CourtBox).ToListAsync(ct);
        var offlineAfter = HeartbeatCadence.OfflineAfterSeconds(settings.HeartbeatSeconds);

        var holding = new HashSet<(Guid Device, int Court, string Code)>();
        foreach (var court in courts)
        {
            var box = boxes.Where(d => d.CourtNumbers.Contains(court.CourtNumber))
                .OrderByDescending(d => d.Enabled).ThenByDescending(d => d.LastSeenAt ?? DateTimeOffset.MinValue)
                .FirstOrDefault();
            if (box is null || !Believable(box, now, offlineAfter)) continue;
            var code = Classify(lights.GetValueOrDefault(court.Id), current.FirstOrDefault(b => b.CourtId == court.Id), now, settings.GraceWindowMinutes);
            if (code is null) continue;
            holding.Add((box.Id, court.CourtNumber, code));
            await faults.RecordAsync(new DeviceErrorReport(
                code, DeviceErrorSource.Server, DeviceId: box.Id, ClaimedDeviceCode: box.DeviceCode,
                Detail: DetailOf(code, court.CourtNumber), Court: court.CourtNumber, At: now), ct);
        }

        var open = await db.DeviceErrors
            .Where(e => e.ResolvedAt == null && e.Source == DeviceErrorSource.Server && Codes.Contains(e.Code))
            .ToListAsync(ct);
        var cleared = open.Where(e => e.DeviceId is not Guid id || e.Court is not int c || !holding.Contains((id, c, e.Code))).ToList();
        foreach (var row in cleared)
        {
            row.ResolvedAt = now.ToUniversalTime();
            row.ResolutionNote = ClearedNote;
        }
        if (cleared.Count > 0) await db.SaveChangesAsync(ct);
    }
}
