using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The server's side of a v3 box's continuous reconcile (device-api.md §4): per court, every beat.
///
/// <para>
/// <b>Why not v2's one-shot settlement.</b> v2 served a restore once per boot, judged by an uptime
/// window, and settled it from one count: a late first beat after a long outage was restored by the
/// box and never recorded (BD-5), and a partial restore was recorded as a full one (BD-6). A v3 box
/// names the relays it re-lit from the snapshot (<c>relight</c>), so exactly those become
/// <c>RestoreAfterPowerDip</c> rows whatever the uptime, and a court the snapshot keeps saying is lit
/// while the box keeps saying it is dark files <c>restore_not_confirmed</c> for that court.
/// </para>
/// </summary>
public static class DeviceSnapshotRestore
{
    /// <summary>Consecutive contradicting beats before a court's restore is reported as not confirmed (§4).</summary>
    public const int DarkBeatsToReport = 2;

    /// <summary>The audit row for a re-light the box reported.</summary>
    public const string RelitAction = "device.relay_relit";

    /// <summary>
    /// Records the box's relay report and re-lights, files any court the box will not confirm, and
    /// returns this beat's snapshot for the answer.
    /// </summary>
    public static async Task<IReadOnlyList<SnapshotCourt>> SettleAsync(
        HeartbeatServices services, Device device, HeartbeatRequest req, TenantSettingsView s,
        DateTimeOffset now, CancellationToken ct)
    {
        await DeviceEndpoints.NoteRelayReportAsync(services, device, req, now, ct);

        var snapshot = await RelayRestorePlan.SnapshotAsync(services.Db, device, now, ct, BookingCodeWindow.CueMinutes(s));
        await RecordRelightAsync(services, device, req.Relight, snapshot, now, ct);
        NoteDarkStreaks(services, device, req, s, snapshot);
        return snapshot;
    }

    /// <summary>
    /// Every <c>"&lt;relay&gt;|&lt;ref&gt;"</c> the box re-lit since its last accepted beat, onto the
    /// light-state projection — exactly the relays named, and only where the snapshot agrees the
    /// court is paid for under that reference (a stale flash copy naming a booking the server no
    /// longer lists is not a restore the club can stand behind).
    /// </summary>
    private static async Task RecordRelightAsync(
        HeartbeatServices services, Device device, string?[]? relight, IReadOnlyList<SnapshotCourt> snapshot,
        DateTimeOffset now, CancellationToken ct)
    {
        if (relight is not { Length: > 0 }) return;

        var recorded = new List<object>();
        foreach (var entry in relight)
        {
            if (Parse(entry) is not { } named) continue;
            var court = snapshot.FirstOrDefault(c => c.Relay == named.Relay);
            if (court?.Item is not { } item || !string.Equals(item.Reference, named.Ref, StringComparison.OrdinalIgnoreCase)) continue;

            var evidence = new LightEvidence(item.CourtId, device.Id, item.Relay, Seq: 0, BootId: 0, At: now);
            var row = await services.Lights.RecordOnAsync(
                evidence, item.EndsAt, LightCause.RestoreAfterPowerDip, item.CausedByUserId, item.BookingId, ct);
            if (row is null) continue;

            services.Lights.Audit(
                CourtLightStateService.LightsRestoredAction, item.CourtId, item.CourtNumber, item.OrganiserUserId,
                new
                {
                    device_id = device.Id,
                    device_code = device.DeviceCode,
                    relay = item.Relay,
                    booking_id = item.BookingId,
                    remaining_seconds = item.RemainingSeconds,
                },
                device.Id);
            recorded.Add(new { relay = item.Relay, court_number = item.CourtNumber, booking_id = item.BookingId });
        }

        DeviceEndpoints.Audit(services, device, RelitAction, new
        {
            device_id = device.Id,
            device_code = device.DeviceCode,
            reported = relight.Where(e => e is not null),
            recorded,
        });
    }

    /// <summary>
    /// Per relay: the snapshot says lit while <c>relay_state</c> says dark. Two such beats in a row of
    /// an acknowledged box with restore enabled files <c>restore_not_confirmed</c> for that court,
    /// once; a confirming or dark beat resets the count. No report (an absent <c>relay_state</c>)
    /// changes nothing — absence is "no report", never "dark".
    /// </summary>
    private static void NoteDarkStreaks(
        HeartbeatServices services, Device device, HeartbeatRequest req, TenantSettingsView s, IReadOnlyList<SnapshotCourt> snapshot)
    {
        if (req.RelayState is not { } report) return;
        if (!MemberCodeHeartbeat.Acknowledged(device) || !BoxSettings.RelayRestoreEnabled(s)) return;

        var closed = DeviceEndpoints.ClosedRelays(report);
        var streaks = Enumerable.Range(0, snapshot.Count)
            .Select(i => i < device.RelayDarkStreak.Count ? device.RelayDarkStreak[i] : 0)
            .ToList();

        foreach (var court in snapshot)
        {
            if (!court.Lit || closed.Contains(court.Relay))
            {
                streaks[court.Relay] = 0;
                continue;
            }

            streaks[court.Relay]++;
            if (streaks[court.Relay] != DarkBeatsToReport) continue;

            DeviceErrorService.InBackground(
                services.Scopes, services.Logs.CreateLogger(typeof(DeviceSnapshotRestore)),
                services.Tenant.TenantId, services.Tenant.TenantSlug,
                new DeviceErrorReport(
                    DeviceErrorCodes.RestoreNotConfirmed, DeviceErrorSource.Server,
                    DeviceId: device.Id, ClaimedDeviceCode: device.DeviceCode, Court: court.CourtNumber,
                    Detail: $"Court {court.CourtNumber} is paid for and should be lit, and the box has reported it dark on two heartbeats in a row."));
        }

        device.RelayDarkStreak = streaks;
    }

    private static (int Relay, string Ref)? Parse(string? entry)
    {
        var pipe = entry?.IndexOf('|') ?? -1;
        if (pipe <= 0) return null;
        if (!int.TryParse(entry![..pipe], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var relay)) return null;
        var reference = entry[(pipe + 1)..];
        var end = reference.IndexOf('|');
        if (end >= 0) reference = reference[..end];
        return reference.Length == 0 ? null : (relay, reference);
    }
}
