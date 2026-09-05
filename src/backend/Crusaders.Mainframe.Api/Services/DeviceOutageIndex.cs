using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// "Was the box driving this court unreachable at that instant?" — answered from the evidence
/// that existed AT that instant, so the answer cannot change afterwards.
///
/// <para>
/// <b>What "unreachable" means here is what it means everywhere else in the product.</b> A box is
/// unreachable once it has been silent for longer than <c>offline_after_seconds</c>
/// (<see cref="HeartbeatCadence.OfflineAfterSeconds"/>) — the same threshold the Devices page
/// renders "offline" from and the same one <c>PeripheralHealthWorker</c> alerts on. So the
/// question this index answers is: <i>at <c>instant</c>, how long had it been since that box's
/// last heartbeat, and was that longer than the threshold?</i>
/// </para>
///
/// <para>
/// <b>Why not just read <c>LastSeenAt</c>, and why not just read the outage rows.</b> Neither
/// source is sufficient alone, and using either one alone makes money depend on when a background
/// worker happened to run:
/// </para>
/// <list type="bullet">
///   <item>
///     <see cref="Device.LastSeenAt"/> answers only about the CURRENT stretch of silence. The
///     first heartbeat after an outage moves it forward and the outage is gone from the record,
///     so a sweep running after a box recovered would charge the no-show penalty for a window
///     nobody could have scanned in.
///   </item>
///   <item>
///     A <see cref="DeviceOutage"/> row only exists once <c>PeripheralHealthWorker</c> has
///     noticed. A sweep that runs before that tick sees no row at all. That was the defect this
///     class was rewritten to close: the same booking, the same silence, settled at 97.60 when
///     the sweep was prompt and at 100.00 when it was five minutes late, because by then a row
///     existed whose <c>StartedAt</c> reached back over the deadline.
///   </item>
/// </list>
///
/// <para>
/// Both sources therefore contribute the same shape — a stretch of silence, opened by the last
/// heartbeat before it and closed by the first one after it — and the threshold is applied to
/// that stretch at the instant asked about. An outage row that began two minutes before the
/// deadline says the box had been quiet for two minutes at the deadline; two minutes is under the
/// threshold, so the box was not yet unreachable then, whether the row was written before the
/// sweep or after it. That is the whole of the timing-invariance property, and
/// <c>PeripheralHealthTests.The_waiver_is_the_same_whichever_order_the_two_workers_run_in</c>
/// pins it.
/// </para>
///
/// <para>
/// Built once per tenant per tick and answered in memory: the no-show sweep asks per booking,
/// and a query per booking is a table scan per booking.
/// </para>
/// </summary>
public sealed class DeviceOutageIndex
{
    /// <summary>
    /// One stretch during which a box was not heart-beating: it was last heard from at
    /// <paramref name="LastHeartbeat"/>, and was heard from again at <paramref name="Ended"/>
    /// (null while it is still quiet). <paramref name="Courts"/> is what that box drives.
    /// </summary>
    private sealed record Silence(List<int> Courts, DateTimeOffset LastHeartbeat, DateTimeOffset? Ended);

    private readonly Dictionary<Guid, int> _courtNumberById;
    private readonly List<Silence> _silences;
    private readonly TimeSpan _offlineAfter;

    private DeviceOutageIndex(Dictionary<Guid, int> courtNumberById, List<Silence> silences, TimeSpan offlineAfter)
    {
        _courtNumberById = courtNumberById;
        _silences = silences;
        _offlineAfter = offlineAfter;
    }

    /// <summary>No courts and no silences — nothing is ever dark. Used where a caller has no context to build from.</summary>
    public static DeviceOutageIndex Empty { get; } = new([], [], TimeSpan.Zero);

    /// <summary>
    /// The current tenant's stretches of box silence that could still matter, i.e. outages still
    /// open or ended on or after <paramref name="since"/>, plus whatever silence each enabled box
    /// is in right now. Callers pass the sweep's own lookback floor, so the index covers exactly
    /// the bookings the sweep can still reach, and <paramref name="offlineAfterSeconds"/> — the
    /// tenant's own threshold, from <see cref="HeartbeatCadence.OfflineAfterSeconds"/>.
    ///
    /// <para>
    /// <b>Disabled boxes contribute nothing, in either direction.</b> An admin who switches a box
    /// off has said it is not expected to call in — the same reason <c>PeripheralHealthWorker</c>
    /// skips them — and a decommissioned row left in the table would otherwise waive every
    /// no-show on its courts for as long as it sat there.
    /// </para>
    /// </summary>
    public static async Task<DeviceOutageIndex> BuildAsync(
        MainframeDbContext db, DateTimeOffset since, int offlineAfterSeconds, CancellationToken ct)
    {
        // A box that has never called in is not silent, it is unborn — LastSeenAt is null only
        // between auto-registration and the first save, and in seeded fixtures. Same rule the
        // health sweep applies, so the two agree about which boxes exist.
        var devices = await db.Devices.AsNoTracking()
            .Where(d => d.Enabled && d.LastSeenAt != null)
            .ToListAsync(ct);

        if (devices.Count == 0) return Empty;

        var outages = await db.DeviceOutages.AsNoTracking()
            .Where(o => o.EndedAt == null || o.EndedAt >= since)
            .ToListAsync(ct);

        var silences = new List<Silence>(devices.Count + outages.Count);
        foreach (var device in devices)
        {
            // The stretch the box is in NOW, which is the one no outage row describes yet.
            silences.Add(new Silence(device.CourtNumbers, device.LastSeenAt!.Value, null));
        }

        // The relay mapping, per box. A device drives the courts named in its own list, so a
        // silence darkens exactly those and nothing else: a club with a second box on the annex
        // court keeps charging no-shows there while the main box is out.
        var courtsByDevice = devices.ToDictionary(d => d.Id, d => d.CourtNumbers);
        foreach (var outage in outages)
        {
            if (courtsByDevice.TryGetValue(outage.DeviceId, out var courts))
            {
                silences.Add(new Silence(courts, outage.StartedAt, outage.EndedAt));
            }
        }

        var courtNumberById = await db.Courts.AsNoTracking()
            .ToDictionaryAsync(c => c.Id, c => c.CourtNumber, ct);

        return new DeviceOutageIndex(courtNumberById, silences, TimeSpan.FromSeconds(offlineAfterSeconds));
    }

    /// <summary>
    /// Whether some box driving <paramref name="courtId"/> had already been unreachable — silent
    /// for longer than the tenant's threshold — at <paramref name="instant"/>.
    ///
    /// <para>
    /// The comparison is strictly greater-than, matching <c>PeripheralHealthWorker.JudgeAsync</c>
    /// exactly. A box a second inside the threshold is "reachable" to the alert, to the Devices
    /// page and to the money, or the product tells an admin one thing and bills a member on
    /// another.
    /// </para>
    /// </summary>
    public bool CourtWasDark(Guid courtId, DateTimeOffset instant)
    {
        if (_silences.Count == 0) return false;
        if (!_courtNumberById.TryGetValue(courtId, out var courtNumber)) return false;

        foreach (var silence in _silences)
        {
            var quietAtInstant = instant - silence.LastHeartbeat;
            var stillQuiet = silence.Ended is null || instant < silence.Ended;
            if (quietAtInstant > _offlineAfter && stillQuiet && silence.Courts.Contains(courtNumber))
            {
                return true;
            }
        }

        return false;
    }
}
