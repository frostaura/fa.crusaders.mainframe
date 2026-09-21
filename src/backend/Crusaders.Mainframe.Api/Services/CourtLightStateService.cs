using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// What one event says about a court's lights: the fact, plus the evidence that lets a later,
/// out-of-order event be recognised as older.
/// </summary>
/// <param name="CourtId">The court. Never a relay index — see <see cref="CourtLightState"/>.</param>
/// <param name="DeviceId">The board that reported it, when one did.</param>
/// <param name="Relay">The relay index that board used, for diagnosis only.</param>
/// <param name="Seq">The board's sequence number for this event, or 0 for a server-originated change.</param>
/// <param name="BootId">Which boot of that board <paramref name="Seq"/> belongs to.</param>
/// <param name="At">When it HAPPENED — the scan or the release, never the upload.</param>
public sealed record LightEvidence(
    Guid CourtId, Guid? DeviceId, int? Relay, long Seq, long BootId, DateTimeOffset At);

/// <summary>
/// The only writer of <c>court_light_state</c>, and the publisher of the control board's
/// per-court deltas.
///
/// <para>
/// <b>One writer, because three call sites were going to be four.</b> Activation, release, the
/// health sweep's outage and the power-dip restore all change what the server believes about a
/// relay, and each of them knows a different subset of the row — the out-of-order guard, the
/// cause vocabulary and the publish are the parts that must be identical at all four. Written
/// four times they would be identical at three.
/// </para>
///
/// <para>
/// <b>Nothing here saves.</b> Every method stages the change on the caller's own
/// <c>DbContext</c> and the caller's own unit of work decides whether it stands. That matters
/// most on the activation path, which charges a member: a light-state write that could fail a
/// save would turn a projection into a reason a member's court does not come on. The publish
/// is deliberately separate (<see cref="PublishAsync"/>) and is called AFTER the commit — a
/// court that flashes "on" on a wall screen and then silently reverts is worse than one that is
/// a second late.
/// </para>
/// </summary>
public sealed class CourtLightStateService
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly IRealtimeBus _bus;

    public CourtLightStateService(MainframeDbContext db, ITenantContext tenant, IRealtimeBus bus)
    {
        _db = db;
        _tenant = tenant;
        _bus = bus;
    }

    /// <summary>The audit action written when the server first believes a court's lights came on.</summary>
    public const string LightsOnAction = "court.lights_on";

    /// <summary>The audit action written when the server first believes a court's lights went out.</summary>
    public const string LightsOffAction = "court.lights_off";

    /// <summary>
    /// The audit action written when a box re-energised a relay from the heartbeat's restore
    /// answer — GOAL item 17's record, and the reason the control board and the night trace can
    /// say "restored after power loss" rather than inventing a scan nobody made.
    /// </summary>
    public const string LightsRestoredAction = "court.lights_restored";

    /// <summary>
    /// Records that a court's lights are believed ON, and returns the row — or null when the
    /// evidence is older than what the row already holds.
    ///
    /// <para>
    /// <paramref name="until"/> is the GRANT's end and is stored as such. A countdown is never
    /// stored; the read model computes the remaining seconds against its own clock, because a
    /// stored countdown is wrong the instant it is written.
    /// </para>
    /// </summary>
    public async Task<CourtLightState?> RecordOnAsync(
        LightEvidence evidence, DateTimeOffset until, LightCause cause, Guid? causedByUserId,
        Guid? bookingId, CancellationToken ct)
    {
        var row = await RowForAsync(evidence.CourtId, ct);
        if (!Supersedes(row, evidence)) return null;

        row.State = LightState.On;
        row.OnSince = evidence.At;
        row.OnUntil = until;
        row.BookingId = bookingId;
        row.Cause = cause;
        row.CausedByUserId = causedByUserId;
        Stamp(row, evidence);
        return row;
    }

    /// <summary>
    /// Records that a court's lights are believed OFF.
    ///
    /// <para>
    /// <see cref="CourtLightState.OnUntil"/> is left holding the MEASURED end rather than
    /// cleared, so the control board and the trace can still answer "how long was it lit"
    /// after the fact. <see cref="CourtLightState.OnSince"/> is cleared, because a court that
    /// is off has not been on since anything.
    /// </para>
    /// </summary>
    public async Task<CourtLightState?> RecordOffAsync(LightEvidence evidence, CancellationToken ct)
    {
        var row = await RowForAsync(evidence.CourtId, ct);
        if (!Supersedes(row, evidence)) return null;

        row.State = LightState.Off;
        row.OnSince = null;
        row.OnUntil = evidence.At;
        Stamp(row, evidence);
        return row;
    }

    /// <summary>
    /// Records that the server can no longer make a claim about a court — the board driving it
    /// has gone dark.
    ///
    /// <para>
    /// <b>Unknown and not Off, and the difference is the whole honesty of the control board.</b>
    /// The previous belief was assembled from events THAT BOARD sent, and a board that has
    /// stopped talking may have been cut by the same power event that silenced it — or may be
    /// happily running a relay the server will never hear about again. Writing Off would be
    /// the server claiming to have seen something switched off that it did not, which is how a
    /// club leaves a court lit all night believing the software knows.
    /// </para>
    ///
    /// <para>
    /// The cause and the booking are deliberately left as they were: "we do not know whether
    /// Priya's court is still lit" is more useful than "we do not know anything", and it is
    /// what lets a tile read "was on for Priya Naidoo — the box has not reported since 18:41".
    /// </para>
    ///
    /// <para>
    /// This is NOT gated on <see cref="Supersedes"/>. An outage is a statement about the
    /// board's silence, established from <c>LastSeenAt</c> rather than from any event, so it
    /// carries no sequence number to compare and must not be discarded for lacking one.
    /// </para>
    /// </summary>
    public async Task<CourtLightState> RecordUnknownAsync(
        Guid courtId, Guid? deviceId, DateTimeOffset at, CancellationToken ct)
    {
        var row = await RowForAsync(courtId, ct);
        row.State = LightState.Unknown;
        row.DeviceId ??= deviceId;
        row.LastEventAt = at;
        row.UpdatedAt = at;
        return row;
    }

    /// <summary>
    /// Records what the BOX says a relay is doing — independently of what the server believes.
    ///
    /// <para>
    /// Two columns rather than one, because a box reporting a relay open while the server
    /// believes it granted time is a contradiction an admin must SEE. Folding the report into
    /// <see cref="CourtLightState.State"/> would resolve the disagreement by quietly adopting
    /// the box's view and destroying the evidence that they ever disagreed — which is exactly
    /// the case where somebody has to walk to the cupboard.
    /// </para>
    ///
    /// <para>
    /// Not gated on the out-of-order guard: a heartbeat carries no sequence number, and its
    /// report is about the instant it was sent rather than about an event in a queue.
    /// </para>
    /// </summary>
    public async Task RecordConfirmationAsync(
        Guid courtId, Guid deviceId, int relay, bool closed, DateTimeOffset at, CancellationToken ct)
    {
        var row = await RowForAsync(courtId, ct);
        row.ConfirmedAt = at;
        row.ConfirmedState = closed ? LightState.On : LightState.Off;
        row.DeviceId ??= deviceId;
        row.Relay ??= relay;
        row.UpdatedAt = at;
    }

    /// <summary>
    /// Every court this board drives, in relay order, for the restore and outage paths.
    ///
    /// <para>
    /// The device's <c>CourtNumbers</c> list IS the relay mapping — index 0 is relay A — so the
    /// answer is a lookup of those court numbers, and the position in the returned list is the
    /// relay index. A court number the club has since deleted maps to null rather than shifting
    /// every relay after it, which is the bug that would put a member on the wrong court.
    /// </para>
    /// </summary>
    public async Task<IReadOnlyList<Court?>> CourtsByRelayAsync(Device device, CancellationToken ct)
    {
        var numbers = device.CourtNumbers;
        if (numbers.Count == 0) return [];

        var courts = await _db.Courts.AsNoTracking()
            .Where(c => numbers.Contains(c.CourtNumber))
            .ToListAsync(ct);

        return [.. numbers.Select(n => courts.FirstOrDefault(c => c.CourtNumber == n))];
    }

    /// <summary>
    /// Whether <paramref name="evidence"/> describes a world NEWER than the row already holds.
    ///
    /// <para>
    /// A board back from an outage uploads a full ring; the batch is ordered but two batches in
    /// flight together are not, and a retried upload can land behind a fresher one. Without
    /// this, the last write wins and a court shows "off" because a two-hour-old release arrived
    /// after the activation that followed it.
    /// </para>
    ///
    /// <para>
    /// <b>The comparison resets whenever the identity behind the sequence changes.</b> A
    /// different board, or the same board on a different boot, numbers from wherever it likes —
    /// a torn sequence checkpoint makes a board renumber from 1 — so comparing across either
    /// boundary would discard a brand-new board's entire first evening as stale. That is the
    /// exact failure the receipt table's boot id exists to prevent, borrowed here.
    /// </para>
    ///
    /// <para>
    /// Within one board and one boot, an equal seq is NOT superseding: it is the same event
    /// arriving twice, and re-applying it would move <c>UpdatedAt</c> for nothing.
    /// </para>
    /// </summary>
    private static bool Supersedes(CourtLightState row, LightEvidence evidence)
    {
        var sameSource = row.DeviceId == evidence.DeviceId && row.LastEventBootId == evidence.BootId;
        if (!sameSource) return true;
        if (evidence.Seq == 0 && row.LastEventSeq == 0) return true;
        return evidence.Seq > row.LastEventSeq;
    }

    private static void Stamp(CourtLightState row, LightEvidence evidence)
    {
        row.DeviceId = evidence.DeviceId ?? row.DeviceId;
        row.Relay = evidence.Relay ?? row.Relay;
        row.LastEventAt = evidence.At;
        row.LastEventSeq = evidence.Seq;
        row.LastEventBootId = evidence.BootId;
        row.UpdatedAt = DateTimeOffset.UtcNow;
    }

    /// <summary>
    /// The row for this court, created if the backfill never made one — a court added after the
    /// table shipped has no row until something happens on it, and the first thing that happens
    /// must not be a null reference.
    /// </summary>
    private async Task<CourtLightState> RowForAsync(Guid courtId, CancellationToken ct)
    {
        var row = await _db.CourtLightStates.FirstOrDefaultAsync(s => s.CourtId == courtId, ct);
        if (row is not null) return row;

        row = new CourtLightState
        {
            TenantId = _tenant.TenantId,
            CourtId = courtId,
            State = LightState.Unknown,
            LastEventAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };
        _db.CourtLightStates.Add(row);
        return row;
    }

    /// <summary>
    /// Publishes one court's delta to the control board — <b>after</b> the caller's commit.
    ///
    /// <para>
    /// The payload is intentionally thin: the court id and the light block. A full tile needs
    /// the current booking, the next one and the board's health, none of which this service
    /// knows and all of which the periodic snapshot carries. A client applies the light block
    /// to the tile it already has, and the resync repairs anything it inferred wrong.
    /// </para>
    ///
    /// <para>
    /// Never throws and never blocks: the fan-out is a bounded drop-oldest write per
    /// subscriber, so a wedged wall screen cannot hold up the request that lit the court.
    /// </para>
    /// </summary>
    public Task PublishAsync(CourtLightState row, int courtNumber, CancellationToken ct = default)
    {
        var now = DateTimeOffset.UtcNow;
        var payload = JsonSerializer.Serialize(new
        {
            court_id = row.CourtId,
            court_number = courtNumber,
            lights = new
            {
                state = StateWire(row.State),
                since = row.OnSince,
                until = row.OnUntil,
                seconds_remaining = row.SecondsRemainingAt(now),
                as_of = row.LastEventAt,
                cause = CauseWire(row.Cause),
                booking_id = row.BookingId,
            },
            at = now,
        });

        _bus.Publish(RealtimeTopic.ControlBoard(_tenant.TenantId), new RealtimeMessage("court", payload));
        return Task.CompletedTask;
    }

    /// <summary>The wire spelling of a light state — lower snake, a closed set of three.</summary>
    public static string StateWire(LightState state) => state switch
    {
        LightState.On => "on",
        LightState.Off => "off",
        _ => "unknown",
    };

    /// <summary>
    /// The wire spelling of a cause. <c>restore_after_power_dip</c> is spelled out rather than
    /// abbreviated because the screen shows it to a volunteer admin and "restored after a power
    /// cut" is the sentence they need.
    /// </summary>
    public static string CauseWire(LightCause cause) => cause switch
    {
        LightCause.Member => "member",
        LightCause.WalkUp => "walk_up",
        LightCause.Admin => "admin",
        LightCause.RestoreAfterPowerDip => "restore_after_power_dip",
        _ => "unknown",
    };

    /// <summary>Writes the audit row that puts a lights change into the night trace and the club's history.</summary>
    public void Audit(string action, Guid courtId, int courtNumber, Guid? subjectUserId, object details)
    {
        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = Guid.Empty,
            SubjectUserId = subjectUserId,
            Action = action,
            DetailsJson = JsonSerializer.Serialize(new
            {
                court_id = courtId,
                court_number = courtNumber,
                details,
            }),
        });
    }
}
