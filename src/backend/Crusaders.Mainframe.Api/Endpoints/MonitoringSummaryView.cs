using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The boards a page of faults names, and the people who resolved them — read once per page
/// rather than once per row.
///
/// <para>
/// A monitoring list is the one admin surface most likely to be opened while something is
/// already wrong, so a query per row is the worst possible time to pay for one. Both reads are
/// tenant-filtered by the context's global query filter.
/// </para>
/// </summary>
public sealed record MonitoringLookups(
    IReadOnlyDictionary<Guid, Device> Devices, IReadOnlyDictionary<Guid, string> Names)
{
    /// <summary>The boards and the resolvers named by one page of rows, in two reads.</summary>
    public static async Task<MonitoringLookups> ForAsync(
        MainframeDbContext db, IEnumerable<DeviceError> rows, CancellationToken ct)
    {
        var page = rows.ToList();

        var deviceIds = page.Select(r => r.DeviceId).Where(d => d is not null)
            .Select(d => d!.Value).Distinct().ToList();
        var devices = deviceIds.Count == 0
            ? []
            : await db.Devices.AsNoTracking().Where(d => deviceIds.Contains(d.Id))
                .ToDictionaryAsync(d => d.Id, d => d, ct);

        var userIds = page.Select(r => r.ResolvedByUserId).Where(u => u is not null)
            .Select(u => u!.Value).Distinct().ToList();
        var names = userIds.Count == 0
            ? []
            : await db.Memberships.AsNoTracking().Where(m => userIds.Contains(m.UserId))
                .Select(m => new { m.UserId, m.FullName })
                .ToDictionaryAsync(m => m.UserId, m => m.FullName, ct);

        return new MonitoringLookups(devices, names);
    }

    /// <summary>
    /// The board this row came from, when the club still has its row.
    /// </summary>
    /// <remarks>
    /// Block body, and <c>is not Guid id</c> rather than <c>is { } id</c>: lizard's C# parser
    /// reads the <c>{</c> of a property pattern in an EXPRESSION body as the end of the
    /// function and dumps the rest of the file into a global pseudo-function that trips the
    /// length gate. Same family as the object-initialiser trap in <c>memory/gotchas.md</c>.
    /// </remarks>
    public Device? DeviceOf(DeviceError row)
    {
        if (row.DeviceId is not Guid id) return null;
        return Devices.TryGetValue(id, out var device) ? device : null;
    }

    /// <summary>The name of whoever resolved this row, or null — including for a row the retention sweep aged out, which nobody resolved.</summary>
    public string? ResolverOf(DeviceError row)
    {
        if (row.ResolvedByUserId is not Guid id) return null;
        return Names.TryGetValue(id, out var name) ? name : null;
    }
}

/// <summary>
/// One fault, as the club's monitoring page reads it.
///
/// <para>
/// <b>Composed in one place, and used by four routes.</b> The list, the export, the single
/// resolve and the bulk resolve all hand a console the same row — and a resolve that answered a
/// differently-shaped row from the list it was clicked in is the defect that makes a page
/// re-fetch after every action.
/// </para>
/// </summary>
public static class MonitoringErrorRow
{
    /// <summary>
    /// The row. <paramref name="lookups"/> supplies the board and the resolver's name; both are
    /// legitimately absent, and neither absence is an error.
    /// </summary>
    public static object Of(DeviceError row, MonitoringLookups lookups)
    {
        var device = lookups.DeviceOf(row);
        return new
        {
            id = row.Id,
            device_id = row.DeviceId,

            // The live board's code where there is one, and what the caller CLAIMED where there
            // is not — a board that has since been deleted, or an auth failure that never had a
            // row. A fault list rendering a blank where a board's name was is a list an admin
            // cannot act on.
            device_code = device?.DeviceCode ?? row.ClaimedDeviceCode,
            device_name = device?.Name,
            device_kind = device is null ? null : DeviceKinds.Wire(device.Kind),
            claimed_mac = row.ClaimedMac,

            source = DeviceErrorService.SourceWire(row.Source),
            code = row.Code,
            severity = DeviceErrorService.SeverityWire(row.Severity),
            detail = row.Detail,
            court = row.Court,

            first_seen_at = row.FirstSeenAt,
            last_seen_at = row.LastSeenAt,
            count = row.Count,

            resolved_at = row.ResolvedAt,
            resolved_by_name = lookups.ResolverOf(row),
            resolution_note = row.ResolutionNote,

            // The sentence, composed server-side from the code. This audience is club members
            // and volunteer admins, and `relay_cmd_dropped` is not a sentence.
            headline = DeviceErrorCodes.HeadlineOf(row.Code),
        };
    }
}

/// <summary>
/// <c>GET /api/v1/admin/monitoring/summary</c> — the club's estate in one read: how much is
/// open, which board is worst, and what has moved in a day.
///
/// <para>
/// <b>The counts here are not the list's.</b> The list answers a filtered question and its
/// totals are that filter's; this answers the unfiltered one — how many OPEN faults does this
/// club have, right now, at each severity — because that is the number a page puts in its
/// heading and an admin quotes. A summary computed from whatever filter happened to be on
/// screen is a summary that changes when somebody clicks a chip.
/// </para>
/// </summary>
public static class MonitoringSummaryView
{
    /// <summary>
    /// The window <c>last_24h</c> covers. Rolling rather than the club's day, and named so,
    /// because "since midnight" answers nothing useful at 00:10 on a night a board failed at
    /// 23:50.
    /// </summary>
    public static readonly TimeSpan RecentWindow = TimeSpan.FromHours(24);

    /// <summary>
    /// The whole payload. Four reads, none of which grows with the number of boards.
    /// </summary>
    public static async Task<object> BuildAsync(
        MainframeDbContext db, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        var since = now - RecentWindow;

        var open = await db.DeviceErrors.AsNoTracking()
            .Where(e => e.ResolvedAt == null)
            .GroupBy(e => e.Severity)
            .Select(g => new { Severity = g.Key, Count = g.Count() })
            .ToListAsync(ct);

        // Grouped on the board, so the per-device block is one read whatever the club's size.
        // Rows with no board are deliberately absent — see ByDeviceAsync.
        var perDevice = await db.DeviceErrors.AsNoTracking()
            .Where(e => e.ResolvedAt == null && e.DeviceId != null)
            .GroupBy(e => e.DeviceId!.Value)
            .Select(g => new
            {
                DeviceId = g.Key,
                Open = g.Count(),
                Worst = g.Max(e => e.Severity),
                LastSeenAt = g.Max(e => e.LastSeenAt),
            })
            .ToListAsync(ct);

        var boards = perDevice.Count == 0
            ? []
            : await db.Devices.AsNoTracking()
                .Where(d => perDevice.Select(p => p.DeviceId).Contains(d.Id))
                .ToDictionaryAsync(d => d.Id, d => d, ct);

        var opened = await db.DeviceErrors.AsNoTracking().CountAsync(e => e.FirstSeenAt >= since, ct);
        var resolved = await db.DeviceErrors.AsNoTracking().CountAsync(e => e.ResolvedAt >= since, ct);

        var offlineAfter = HeartbeatCadence.OfflineAfterSeconds(settings.HeartbeatSeconds);
        var effective = HeartbeatCadence.Effective(settings.HeartbeatSeconds);

        // Worst board first, then most open — which is the order an admin would walk the club
        // in, and not the order Postgres happened to group in.
        var byDevice = perDevice
            .OrderByDescending(p => p.Worst).ThenByDescending(p => p.Open)
            .Select(p => new
            {
                device_id = p.DeviceId,
                device_code = boards.TryGetValue(p.DeviceId, out var found) ? found.DeviceCode : null,
                device_name = boards.TryGetValue(p.DeviceId, out var named) ? named.Name : null,
                open = p.Open,
                worst = DeviceErrorService.SeverityWire(p.Worst),

                // The newest OPEN FAULT's instant, not the board's last heartbeat: whether the
                // board is talking is already `link`, in full, and a second rendering of one
                // fact where a distinct one is available answers nothing. This one answers "is
                // it still happening", which is the question that decides whether somebody
                // walks over tonight.
                last_seen_at = p.LastSeenAt,

                link = MonitoringLink.Of(
                    boards.TryGetValue(p.DeviceId, out var board) ? board : null, now, effective, offlineAfter),
            })
            .ToList();

        var worst = byDevice.Count == 0 ? null : byDevice.MaxBy(d => d.open);

        return new
        {
            open = new
            {
                critical = CountOf(open.Select(o => (o.Severity, o.Count)), DeviceErrorSeverity.Critical),
                error = CountOf(open.Select(o => (o.Severity, o.Count)), DeviceErrorSeverity.Error),
                warning = CountOf(open.Select(o => (o.Severity, o.Count)), DeviceErrorSeverity.Warning),
                info = CountOf(open.Select(o => (o.Severity, o.Count)), DeviceErrorSeverity.Info),
            },
            by_device = byDevice,
            last_24h = new { opened, resolved },

            // Null rather than an empty object when nothing is open. "The worst board is — "
            // with a blank after it is a sentence a page renders; null is a state it can branch
            // on and say "nothing is open" instead.
            worst_offender = worst is null ? null : new { device_code = worst.device_code, open = worst.open },

            // So the page states the club's own retention rather than a constant the console
            // carries, and the club's zone rather than the reader's.
            retention_days = MonitoringSettings.RetentionDays(settings),
            timezone = DoorClock.ZoneOf(settings).Name,
            generated_at = now,
        };
    }

    private static int CountOf(
        IEnumerable<(DeviceErrorSeverity Severity, int Count)> counts, DeviceErrorSeverity severity)
        => counts.Where(c => c.Severity == severity).Sum(c => c.Count);
}

/// <summary>
/// How much of what a board says can currently be believed — the four bands a board can be in.
///
/// <para>
/// <b>Four and not five.</b> The control board's own derivation has a fifth, <c>unlinked</c>,
/// for a COURT that no box drives; this list is keyed on boards that have actually reported a
/// fault, so every entry has one by construction. The two derivations are deliberately the same
/// arithmetic — <c>silent</c> past one effective heartbeat, <c>offline</c> past the club's own
/// threshold, and the club's own decision outranking both — because an admin moving between the
/// control board and the fault list must not be told two different things about one box.
/// </para>
/// </summary>
public static class MonitoringLink
{
    /// <summary>The band, given the club's effective heartbeat and offline threshold.</summary>
    public static string Of(Device? device, DateTimeOffset now, int effective, int offlineAfter)
    {
        if (device is null) return "offline";

        // The club's own decision outranks the board's chatter: a board an admin shut is out of
        // service even while it is heartbeating, because the decision is the fact.
        if (!device.Enabled || device.OutOfServiceSince is not null) return "out_of_service";

        // Never heard from at all is OFFLINE, not online-with-a-null.
        if (device.LastSeenAt is not DateTimeOffset seen) return "offline";

        var quiet = Math.Max(0, (now - seen).TotalSeconds);
        if (quiet > offlineAfter) return "offline";
        return quiet > effective ? "silent" : "online";
    }
}
