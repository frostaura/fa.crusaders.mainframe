using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// What the API does with the fact that a box just called in: move
/// <see cref="Device.LastSeenAt"/> forward, and — when the call ends a silence that had
/// already passed the tenant's threshold — leave a <see cref="DeviceOutage"/> row behind
/// saying so.
///
/// <para>
/// <b>Why the recovery has to write the row, and not only the sweep.</b>
/// <c>PeripheralHealthWorker</c> writes outage rows on a thirty-second stride and only while
/// the API process is up. A silence that crossed <c>offline_after_seconds</c> and ENDED
/// between two of those ticks was recorded by neither source: the row was never opened, and
/// the first heartbeat back overwrites <c>LastSeenAt</c>, which is the only other witness. The
/// same booking then settled at 100.00 when the sweep ran while the box was still dark and at
/// 97.60 when it ran after the box came back — the mirror of the defect
/// <see cref="DeviceOutageIndex"/> was rewritten to close, and the case a club power cut
/// shorter than the sweep stride produces. The heartbeat is the one actor that observes the
/// exact instant a silence ended, so it is the one that can record it.
/// </para>
///
/// <para>
/// <b>The row is written in the caller's unit of work, deliberately.</b> It flushes with the
/// <c>LastSeenAt</c> that erases the evidence, so there is no ordering in which the erasure
/// commits and the record does not.
/// </para>
///
/// <para>
/// <b>A second row for a silence the sweep also noticed is expected, not a bug.</b> The sweep's
/// row is the alerting marker — it stays open until a tick notices the box is back, so its
/// <c>EndedAt</c> is the first heartbeat A TICK SAW rather than the first heartbeat there was.
/// This row carries the instant itself. The schema allows it (the unique index is filtered to
/// open rows precisely so closed history accumulates), and
/// <see cref="DeviceOutageIndex"/> reads rows as witnesses to when a box was heard from rather
/// than as objects, so one silence described twice answers identically to one described once.
/// </para>
/// </summary>
public static class DeviceSilenceLog
{
    /// <summary>
    /// Records the heartbeat on <paramref name="device"/>. Nothing is saved here; the caller's
    /// own <c>SaveChangesAsync</c> flushes the row and the moved <c>LastSeenAt</c> together.
    /// </summary>
    public static void NoteHeartbeat(
        MainframeDbContext db, Device device, DateTimeOffset now, int offlineAfterSeconds)
    {
        // Strictly greater-than, matching PeripheralHealthWorker.JudgeAsync and
        // DeviceOutageIndex.CourtWasDark. A box a second inside the threshold was never
        // unreachable, so there is no silence to record.
        if (device.LastSeenAt is { } lastSeen && (now - lastSeen).TotalSeconds > offlineAfterSeconds)
        {
            db.DeviceOutages.Add(new DeviceOutage
            {
                TenantId = device.TenantId,
                DeviceId = device.Id,
                StartedAt = lastSeen,
                DetectedAt = now,
                EndedAt = now,
            });
        }

        device.LastSeenAt = now;
    }
}
