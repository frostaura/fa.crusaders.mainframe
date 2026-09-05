using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// "Was the box driving this court unreachable at that instant?" — answered from
/// <see cref="DeviceOutage"/> rows rather than from <see cref="Device.LastSeenAt"/>.
///
/// <para>
/// <b>Why not just read <c>LastSeenAt</c>.</b> It answers only about now. The first heartbeat
/// after an outage moves it forward and the outage is gone from the record — so a sweep running
/// even a minute after a box recovered would charge the no-show penalty for a window nobody
/// could have scanned in. Money must not turn on how promptly a background worker happened to
/// run.
/// </para>
///
/// <para>
/// Built once per tenant per tick and answered in memory: the no-show sweep asks per booking,
/// and a query per booking is a table scan per booking.
/// </para>
/// </summary>
public sealed class DeviceOutageIndex
{
    private readonly Dictionary<Guid, int> _courtNumberById;
    private readonly List<(List<int> Courts, DeviceOutage Outage)> _outages;

    private DeviceOutageIndex(Dictionary<Guid, int> courtNumberById, List<(List<int>, DeviceOutage)> outages)
    {
        _courtNumberById = courtNumberById;
        _outages = outages;
    }

    /// <summary>No courts and no outages — nothing is ever dark. Used where a caller has no context to build from.</summary>
    public static DeviceOutageIndex Empty { get; } = new([], []);

    /// <summary>
    /// The current tenant's outages that could still matter, i.e. those still open or ended on
    /// or after <paramref name="since"/>. Callers pass the sweep's own lookback floor, so the
    /// index covers exactly the bookings the sweep can still reach.
    /// </summary>
    public static async Task<DeviceOutageIndex> BuildAsync(MainframeDbContext db, DateTimeOffset since, CancellationToken ct)
    {
        var outages = await db.DeviceOutages.AsNoTracking()
            .Where(o => o.EndedAt == null || o.EndedAt >= since)
            .ToListAsync(ct);

        if (outages.Count == 0) return Empty;

        var courtNumberById = await db.Courts.AsNoTracking()
            .ToDictionaryAsync(c => c.Id, c => c.CourtNumber, ct);

        // The relay mapping, per box. A device drives the courts named in its own list, so an
        // outage darkens exactly those and nothing else: a club with a second box on the annex
        // court keeps charging no-shows there while the main box is out.
        var deviceIds = outages.Select(o => o.DeviceId).Distinct().ToList();
        var courtsByDevice = await db.Devices.AsNoTracking()
            .Where(d => deviceIds.Contains(d.Id))
            .ToDictionaryAsync(d => d.Id, d => d.CourtNumbers, ct);

        var pairs = outages
            .Select(o => (Courts: courtsByDevice.GetValueOrDefault(o.DeviceId) ?? [], Outage: o))
            .ToList();

        return new DeviceOutageIndex(courtNumberById, pairs);
    }

    /// <summary>
    /// Whether some box driving <paramref name="courtId"/> was unreachable at
    /// <paramref name="instant"/>.
    /// </summary>
    public bool CourtWasDark(Guid courtId, DateTimeOffset instant)
    {
        if (_outages.Count == 0) return false;
        if (!_courtNumberById.TryGetValue(courtId, out var courtNumber)) return false;

        foreach (var (courts, outage) in _outages)
        {
            if (outage.Covers(instant) && courts.Contains(courtNumber)) return true;
        }

        return false;
    }
}
