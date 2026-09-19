using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// <c>GET /api/v1/admin/doors</c> — every door, its day, and what its own rows say about it.
///
/// <para>
/// <b>One read, because the page is one question.</b> "Is the front door working?" was
/// answerable only by reading rows on a list that mixed doors and court boxes, and the count
/// an admin would actually quote did not exist at all. A console assembling this from three
/// calls would render three different failure states for one sentence.
/// </para>
///
/// <para>
/// <b>Order is name ascending and nothing else — there is no sort parameter and there is not
/// going to be one (A2.3).</b> One headline number per door on a sortable list of doors is a
/// footfall ranking by accident, which is the exact shape <c>door-gate.md</c> §1 and the P3
/// rule exist to prevent. The tie-break is the device code so two doors a club has named the
/// same appear in the same order on every read rather than in whatever order the database
/// happened to return them.
/// </para>
/// </summary>
public static class AdminDoorsOverviewEndpoint
{
    /// <summary>
    /// The day's counts, the two derived signals and the club-wide shut state, for every gate.
    /// </summary>
    public static async Task<IResult> HandleAsync(
        MainframeDbContext db, TenantSettingsAccessor settingsAccessor, CancellationToken ct)
    {
        var settings = await settingsAccessor.GetAsync(ct);
        var now = DateTimeOffset.UtcNow;
        var day = DoorDay.StartOfToday(settings, now);

        var doors = await db.Devices.AsNoTracking()
            .Where(d => d.Kind == DeviceKind.Gate)
            .OrderBy(d => d.Name)
            .ThenBy(d => d.DeviceCode)
            .ToListAsync(ct);

        var scans = await ScansAsync(db, settings, day.DayStartedAt, now, ct);

        return Results.Ok(new
        {
            day_started_at = day.DayStartedAt,
            timezone = day.Timezone,

            // A1.5's banner. True while ANY door is still shut by a fleet shut-all — an
            // individual shut does not set the column, which is the whole distinction it
            // exists to hold. See Device.ShutByShutAllAt.
            shut_all_active = doors.Any(d => d.ShutByShutAllAt is not null),

            // The same distinction as two NAMED lists, because the banner has to say it in
            // words and a boolean cannot (C1).
            //
            // "Reopen all 3" against a club where one door was shut on its own answered
            // `{"doors":[]}` and the page printed "0 doors reopened" — the fleet control
            // existed, was labelled with the wrong count, and silently did nothing. With these
            // the console can offer the fleet control ONLY while `shut_together` is non-empty,
            // label it with that count, and say of the others that they were shut on their own
            // and are reopened from their own page. `name` and `gate_key` are here so the
            // banner can link to each door by the label the club uses for it.
            shut_together = doors
                .Where(d => d.ShutByShutAllAt is not null)
                .Select(d => new { id = d.Id, name = d.Name, gate_key = d.GateKey })
                .ToList(),
            shut_individually = doors
                .Where(d => !d.Enabled && d.ShutByShutAllAt is null)
                .Select(d => new { id = d.Id, name = d.Name, gate_key = d.GateKey })
                .ToList(),

            doors = doors.Select(d => new
            {
                device = DeviceView.Of(d, settings.HeartbeatSeconds),
                today = Today(d.Id, scans, day),
                signals = DoorSignals
                    .For(scans.TryGetValue(d.Id, out var own) ? own : [], settings, now)
                    .Select(s => s.ToWire())
                    .ToList(),
            }).ToList(),
        });
    }

    /// <summary>
    /// Every door scan in this club since the earliest instant any of the three readings needs,
    /// grouped by the board it names.
    ///
    /// <para>
    /// <b>One range read rather than three, and rather than one per door.</b> The alternative
    /// is a query per door per reading — rows are attributed by a <c>device_id</c> inside a
    /// jsonb document with no foreign key behind it, so each of those is a containment scan —
    /// and a club with six doors would pay eighteen. Bounded by time on an indexed column
    /// (<c>IX_audit_log_TenantId_CreatedAt</c>) and narrowed to the four door actions in SQL,
    /// so what comes back is a club's scans for a day and not its whole audit trail.
    /// </para>
    ///
    /// <para>
    /// The floor is the EARLIEST of the three windows, because the spike window is a tenant
    /// setting that can reach four hours back and the club's day can be thirty seconds old at
    /// one minute past midnight. Each reading narrows to its own window afterwards, so widening
    /// this read can never widen a flag.
    /// </para>
    /// </summary>
    private static async Task<Dictionary<Guid, List<DoorScan>>> ScansAsync(
        MainframeDbContext db, TenantSettingsView settings, DateTimeOffset dayStart, DateTimeOffset now,
        CancellationToken ct)
    {
        var spikeFloor = now.AddMinutes(-DoorSettings.RefusalSpikeMinutes(settings));
        var stuckFloor = now.AddSeconds(-DoorSignals.MayNotBeReleasingWindowSeconds);

        // .ToUniversalTime() is not cosmetic: Npgsql REFUSES to write a DateTimeOffset with a
        // non-zero offset to a `timestamp with time zone`, and the club's day boundary carries
        // the club's own offset by construction (DoorDay). Without this the doors page threw a
        // 500 for every club outside UTC — which is every real one — and passed for the fixture
        // clubs that run on UTC, which is exactly the shape of bug memory/gotchas.md warns a
        // green suite hides. Same instant either way; the WIRE keeps the local offset, because
        // that is what lets the console say "since 00:00 club time".
        var floor = new[] { dayStart, spikeFloor, stuckFloor }.Min().ToUniversalTime();

        var rows = await db.AuditLogs.AsNoTracking()
            .Where(DoorTrail.IsScanRow)
            .Where(a => a.CreatedAt >= floor)
            .Select(a => new { a.Action, a.CreatedAt, a.SubjectUserId, a.DetailsJson })
            .ToListAsync(ct);

        var grouped = new Dictionary<Guid, List<DoorScan>>();
        foreach (var row in rows)
        {
            var details = DoorActivityView.Details(row.DetailsJson);
            if (DoorTrail.DeviceIdOf(details) is not { } deviceId) continue;

            if (!grouped.TryGetValue(deviceId, out var list))
            {
                list = [];
                grouped[deviceId] = list;
            }
            list.Add(DoorSignals.ScanOf(row.Action, row.CreatedAt, row.SubjectUserId, details));
        }
        return grouped;
    }

    /// <summary>
    /// This door's day, or null when there is no day to count against.
    ///
    /// <para>
    /// <b>Null and zero are different answers and the difference is the whole of A2.3.</b> Zero
    /// means nobody came through this door today, which is a fact a club may act on; null means
    /// this server could not establish when the club's day began, and rendering that as zero is
    /// the <c>admin-failed-read</c> defect wearing a number. The console has a distinct sentence
    /// for it.
    /// </para>
    ///
    /// <para>
    /// <b>Two numbers, never one.</b> A single headline per door is a ranking; opens and
    /// refusals side by side are a diagnosis. Block body for the lizard reason in
    /// <c>memory/gotchas.md</c>.
    /// </para>
    /// </summary>
    private static object? Today(
        Guid deviceId, IReadOnlyDictionary<Guid, List<DoorScan>> scans,
        (DateTimeOffset DayStartedAt, string Timezone, bool Countable) day)
    {
        if (!day.Countable) return null;

        var own = scans.TryGetValue(deviceId, out var list) ? list : [];
        var today = own.Where(s => s.At >= day.DayStartedAt).ToList();

        return new
        {
            // "released", not "opened": the board energised a relay and this product has no
            // sensor that could say the door moved. P2, and A1.2's wording.
            released = today.Count(s => s.Released),
            refused = today.Count(s => !s.Released),
        };
    }
}
