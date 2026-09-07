using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// "Did this court have any reachable box at that instant?" — answered from the evidence
/// that existed AT that instant, so the answer cannot change afterwards.
///
/// <para>
/// The question is about the COURT, not about a box: a court is dark when every enabled box
/// driving it was unreachable, or when the club's boxes on it have all been switched out of
/// service — and a court the club has put no box on at all is never dark. See
/// <see cref="CourtWasDark"/> for what each of those costs when it is got wrong.
/// </para>
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
///     A <see cref="DeviceOutage"/> row only exists once something has noticed. A sweep that
///     runs before that sees no row at all. That was the defect this class was rewritten to
///     close: the same booking, the same silence, settled at 97.60 when the sweep was prompt
///     and at 100.00 when it was five minutes late, because by then a row existed whose
///     <c>StartedAt</c> reached back over the deadline.
///   </item>
/// </list>
///
/// <para>
/// Both sources therefore contribute the same shape — a stretch of silence, opened by the last
/// heartbeat before it and closed by the first one after it — and the threshold is applied to
/// that stretch at the instant asked about. An outage row that began two minutes before the
/// deadline says the box had been quiet for two minutes at the deadline; two minutes is under the
/// threshold, so the box was not yet unreachable then, whether the row was written before the
/// sweep or after it.
/// </para>
///
/// <para>
/// <b>The mirror direction, and why the recovery has to write a row.</b> Reading the two sources
/// together is not enough on its own, because a silence that crossed the threshold and then
/// ENDED before anything recorded it leaves no trace in either: no row was opened, and the
/// heartbeat that ended it moved <c>LastSeenAt</c> past the whole thing. That is the club power
/// cut shorter than the health sweep's stride, and it produced the same two prices with the
/// order reversed. It is closed at the source rather than here —
/// <see cref="DeviceSilenceLog.NoteHeartbeat"/> writes the row as part of the same save that
/// moves <c>LastSeenAt</c> — so by the time this index is built, every silence past the
/// threshold that has ended is carried by a row.
/// </para>
///
/// <para>
/// <b>A silence ends at the first instant the box was heard from after it began.</b> Rows are
/// read as witnesses to that, not as objects: a row's own <c>EndedAt</c>, the ends of the other
/// rows for the same box, and the box's current <c>LastSeenAt</c> are all the same kind of
/// evidence, and the earliest one after the silence began is the one that counts. That is what
/// makes a row the health sweep has not closed yet, and one it closed a tick or two late, answer
/// the same question the same way as the heartbeat that actually ended the silence.
/// </para>
///
/// <para>
/// The three tests that pin this are
/// <c>PeripheralHealthTests.The_waiver_is_the_same_whichever_order_the_two_workers_run_in</c>,
/// <c>A_box_past_the_threshold_at_the_deadline_waives_before_any_outage_row_exists</c> and
/// <c>The_waiver_is_the_same_whether_the_box_came_back_before_or_after_the_sweep</c>.
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
    /// One stretch during which a box was not heart-beating: <paramref name="DeviceId"/> was last
    /// heard from at <paramref name="LastHeartbeat"/>, and was heard from again at
    /// <paramref name="Ended"/> (null while it is still quiet).
    ///
    /// <para>
    /// It is keyed by the box rather than by the courts, because the question S5a asks is about
    /// a court and has to be answered across ALL the boxes driving it — see
    /// <see cref="CourtWasDark"/>.
    /// </para>
    /// </summary>
    private sealed record Silence(Guid DeviceId, DateTimeOffset LastHeartbeat, DateTimeOffset? Ended);

    private readonly Dictionary<Guid, int> _courtNumberById;
    private readonly Dictionary<int, List<Guid>> _deviceIdsByCourtNumber;
    private readonly Dictionary<int, DateTimeOffset> _outOfServiceFromByCourtNumber;
    private readonly Dictionary<Guid, DateTimeOffset> _knownToExistFrom;
    private readonly List<Silence> _silences;
    private readonly TimeSpan _offlineAfter;

    private DeviceOutageIndex(
        Dictionary<Guid, int> courtNumberById,
        Dictionary<int, List<Guid>> deviceIdsByCourtNumber,
        Dictionary<int, DateTimeOffset> outOfServiceFromByCourtNumber,
        Dictionary<Guid, DateTimeOffset> knownToExistFrom,
        List<Silence> silences,
        TimeSpan offlineAfter)
    {
        _courtNumberById = courtNumberById;
        _deviceIdsByCourtNumber = deviceIdsByCourtNumber;
        _outOfServiceFromByCourtNumber = outOfServiceFromByCourtNumber;
        _knownToExistFrom = knownToExistFrom;
        _silences = silences;
        _offlineAfter = offlineAfter;
    }

    /// <summary>No courts and no silences — nothing is ever dark. Used where a caller has no context to build from.</summary>
    public static DeviceOutageIndex Empty { get; } = new([], [], [], [], [], TimeSpan.Zero);

    /// <summary>
    /// The current tenant's stretches of box silence that could still matter, i.e. outages still
    /// open or ended on or after <paramref name="since"/>, plus whatever silence each enabled box
    /// is in right now. Callers pass the sweep's own lookback floor, so the index covers exactly
    /// the bookings the sweep can still reach, and <paramref name="offlineAfterSeconds"/> — the
    /// tenant's own threshold, from <see cref="HeartbeatCadence.OfflineAfterSeconds"/>.
    ///
    /// <para>
    /// <b>Disabled boxes contribute no SILENCE, in either direction.</b> An admin who switches a
    /// box off has said it is not expected to call in — the same reason
    /// <c>PeripheralHealthWorker</c> skips them — so a disabled box is neither dark evidence nor
    /// live evidence about a court that still has working hardware on it.
    /// </para>
    ///
    /// <para>
    /// <b>They are read for one thing only: whether the club has hardware on the court at all.</b>
    /// A box the API refuses cannot light anything — <c>DeviceIdentity.ResolveAsync</c> answers
    /// 403 on every courtside endpoint for <c>!device.IsActive</c> — so when the LAST box on a
    /// court is switched off, that court has no working check-in at all and every no-show on it
    /// was charged the full 30% for a door the club had closed. See <see cref="CourtWasDark"/>,
    /// which is where the two halves are put back together, and
    /// <c>A_court_whose_only_box_is_out_of_service_waives_the_penalty</c>.
    /// </para>
    ///
    /// <para>
    /// <b>The direction in which that filter now moves money is the OTHER one, and this comment
    /// used to name the wrong scenario.</b> It cited the decommissioned row left silent in the
    /// table, which <see cref="CourtWasDark"/> stopped depending on the moment it came to require
    /// EVERY box on the court to be dark: a silent extra box no longer waives anything by itself,
    /// so the filter is not what protects the club there, and
    /// <c>A_decommissioned_box_left_in_the_table_does_not_waive_the_penalty</c> stopped
    /// discriminating it — flipping that fixture's <c>enabled</c> flag changes nothing. What the
    /// filter still decides is a court whose enabled boxes are ALL dark with a switched-off box
    /// beside them that was heard from seconds ago — the spare on the bench, the replacement not
    /// yet configured. Keep it and the member gets the S5a waiver they are owed; drop it and the
    /// bench spare reads as a live box on the court and the member pays 30% for hardware that was
    /// not driving anything. Pinned, in both directions, by
    /// <c>A_disabled_box_heard_from_seconds_ago_does_not_block_the_waiver</c> and
    /// <c>A_stale_but_enabled_box_beside_a_healthy_one_does_not_waive_the_penalty</c>.
    /// </para>
    /// </summary>
    public static async Task<DeviceOutageIndex> BuildAsync(
        MainframeDbContext db, DateTimeOffset since, int offlineAfterSeconds, CancellationToken ct)
    {
        // Read once and split, because the two halves answer different questions: the enabled
        // boxes carry the silence, and the switched-off ones only say whether the club has any
        // hardware on the court at all (see OutOfServiceFrom).
        var allDevices = await db.Devices.AsNoTracking().ToListAsync(ct);

        // A box that has never called in is not silent, it is unborn — LastSeenAt is null only
        // between auto-registration and the first save, and in seeded fixtures. Same rule the
        // health sweep applies, so the two agree about which boxes exist.
        var devices = allDevices.Where(d => d.Enabled && d.LastSeenAt != null).ToList();
        var outOfService = allDevices.Where(d => !d.Enabled).ToList();

        // No hardware anywhere: no silence to record and no court to declare out of service.
        if (devices.Count == 0 && outOfService.Count == 0) return Empty;

        var outages = await db.DeviceOutages.AsNoTracking()
            .Where(o => o.EndedAt == null || o.EndedAt >= since)
            .ToListAsync(ct);

        // The relay mapping, inverted: which boxes drive each court. A device drives the courts
        // named in its own list, so a silence bears on exactly those and nothing else — a club
        // with a second box on the annex court keeps charging no-shows there while the main box
        // is out — and a court with two boxes on it needs both of them before it is dark.
        var deviceIdsByCourtNumber = new Dictionary<int, List<Guid>>();
        foreach (var device in devices)
        {
            foreach (var court in device.CourtNumbers)
            {
                if (!deviceIdsByCourtNumber.TryGetValue(court, out var ids))
                {
                    ids = [];
                    deviceIdsByCourtNumber[court] = ids;
                }

                ids.Add(device.Id);
            }
        }

        var heardFrom = HeardFrom(devices, outages);

        var silences = new List<Silence>(devices.Count + outages.Count);
        foreach (var device in devices)
        {
            // The stretch the box is in NOW, which is the one no outage row describes yet.
            silences.Add(SilenceFrom(device.Id, device.LastSeenAt!.Value, heardFrom[device.Id]));
        }

        foreach (var outage in outages)
        {
            // A row whose box is gone from the enabled set contributes nothing, in either
            // direction — the same rule as the query above.
            if (heardFrom.ContainsKey(outage.DeviceId))
            {
                silences.Add(SilenceFrom(outage.DeviceId, outage.StartedAt, heardFrom[outage.DeviceId]));
            }
        }

        var courtNumberById = await db.Courts.AsNoTracking()
            .ToDictionaryAsync(c => c.Id, c => c.CourtNumber, ct);

        return new DeviceOutageIndex(
            courtNumberById, deviceIdsByCourtNumber, OutOfServiceFrom(outOfService),
            KnownToExistFrom(devices, outages), silences,
            TimeSpan.FromSeconds(offlineAfterSeconds));
    }

    /// <summary>
    /// For each court, the earliest instant at which some box driving it is known to have been
    /// installed and is now switched off.
    ///
    /// <para>
    /// It answers one question and only one: <i>did the club have hardware on this court that
    /// the API will now refuse?</i> A switched-off box is not evidence about silence — see
    /// <see cref="BuildAsync"/> — but it is proof that the club put a board on that court, and
    /// <see cref="CourtWasDark"/> reads it only where no enabled box remains.
    /// </para>
    ///
    /// <para>
    /// <b>Existence is applied here for the same reason it is applied to an enabled board.</b>
    /// <c>Enabled</c> carries no history — a box switched off this afternoon looks, in the table,
    /// exactly like one that was off all week — so without a floor a board registered after the
    /// deadline would retroactively declare a court out of service at an instant it did not
    /// exist at. The floor is the earliest of the row's <c>CreatedAt</c> and its
    /// <c>LastSeenAt</c>, the same two witnesses <see cref="KnownToExistFrom"/> takes.
    /// <c>LastSeenAt</c> may be null here, unlike in the enabled set: a board that registered
    /// and was switched off before it ever heart-beat is still hardware the club installed on
    /// that court, and the question being asked is not about heartbeats.
    /// </para>
    /// </summary>
    private static Dictionary<int, DateTimeOffset> OutOfServiceFrom(List<Device> outOfService)
    {
        var from = new Dictionary<int, DateTimeOffset>();
        foreach (var device in outOfService)
        {
            var existedFrom = device.LastSeenAt is { } seen && seen < device.CreatedAt
                ? seen
                : device.CreatedAt;

            foreach (var court in device.CourtNumbers)
            {
                if (!from.TryGetValue(court, out var earliest) || existedFrom < earliest)
                {
                    from[court] = existedFrom;
                }
            }
        }

        return from;
    }

    /// <summary>
    /// The earliest instant each box is known to have existed: the earliest of its row's
    /// <see cref="Device.CreatedAt"/>, its <see cref="Device.LastSeenAt"/> and the start of any
    /// silence recorded for it.
    ///
    /// <para>
    /// <b>Why a box needs one at all.</b> Without it a board that did not exist at the deadline
    /// still voted on it. <see cref="BoxWasUnreachable"/> answers "had this box been silent
    /// longer than the threshold at <c>instant</c>?", and for an instant BEFORE the box's first
    /// heartbeat the honest answer is "there was no box", while the arithmetic says "no, it was
    /// not silent" — i.e. reachable, i.e. evidence against the member. Auto-registration makes
    /// that reachable by the hour: an unknown MAC is put straight onto the club's first four
    /// courts with <c>Enabled</c> defaulting true, so ONE healthy unconfigured board — the spare
    /// on the desk, or the replacement an admin plugs in while the dead one is still in the
    /// cupboard — vetoed the §6a waiver on courts 1–4 and handed the club's own outage back to
    /// its members as a 30% penalty each. That is the exact direction §6a exists to prevent, and
    /// it arrived as a side effect of requiring every box on a court to be dark.
    /// </para>
    ///
    /// <para>
    /// Read as evidence rather than as a field, for the same reason a silence's end is: a
    /// heartbeat at <c>T</c> proves the board existed at <c>T</c> whatever the row says, and a
    /// row created by that heartbeat carries a <c>CreatedAt</c> no earlier. Taking the earliest
    /// of the three is what makes a row whose history reaches further back than its own creation
    /// stamp — a fixture, a restore, a re-registration after a delete — answer the same question
    /// the same way.
    /// </para>
    /// </summary>
    private static Dictionary<Guid, DateTimeOffset> KnownToExistFrom(
        List<Device> devices, List<DeviceOutage> outages)
    {
        var known = devices.ToDictionary(
            d => d.Id,
            d => d.LastSeenAt is { } seen && seen < d.CreatedAt ? seen : d.CreatedAt);

        foreach (var outage in outages)
        {
            if (known.TryGetValue(outage.DeviceId, out var from) && outage.StartedAt < from)
            {
                known[outage.DeviceId] = outage.StartedAt;
            }
        }

        return known;
    }

    /// <summary>
    /// Every instant the API is known to have heard from each box, from both sources: the
    /// box's current <see cref="Device.LastSeenAt"/> and the end of every recorded silence.
    /// </summary>
    private static Dictionary<Guid, List<DateTimeOffset>> HeardFrom(
        List<Device> devices, List<DeviceOutage> outages)
    {
        var heard = devices.ToDictionary(d => d.Id, d => new List<DateTimeOffset> { d.LastSeenAt!.Value });
        foreach (var outage in outages)
        {
            if (outage.EndedAt is { } ended && heard.TryGetValue(outage.DeviceId, out var instants))
            {
                instants.Add(ended);
            }
        }

        return heard;
    }

    /// <summary>
    /// One stretch of silence, closed by the FIRST instant the box was heard from after it
    /// began — whichever row or column happens to carry that instant.
    ///
    /// <para>
    /// A row's own <c>EndedAt</c> is one witness and not a privileged one. The health sweep
    /// closes a row at the box's <c>LastSeenAt</c> as at the tick that noticed, so a tick that
    /// ran late stamps a later instant than the heartbeat that actually ended the silence, and
    /// a row it has not reached at all stamps none. Taking the earliest witness makes all three
    /// cases agree, which is the property the money rests on.
    /// </para>
    /// </summary>
    private static Silence SilenceFrom(
        Guid deviceId, DateTimeOffset lastHeartbeat, List<DateTimeOffset> heardFrom)
    {
        DateTimeOffset? ended = null;
        foreach (var instant in heardFrom)
        {
            if (instant > lastHeartbeat && (ended is null || instant < ended.Value))
            {
                ended = instant;
            }
        }

        return new Silence(deviceId, lastHeartbeat, ended);
    }

    /// <summary>
    /// Whether <paramref name="courtId"/> had NO reachable box at <paramref name="instant"/> —
    /// which is the waiver `feature-spec.md` §6a and `settlement-model.md` S5a actually define,
    /// and not "some box driving it was unreachable".
    ///
    /// <para>
    /// <b>Every box driving the court has to be dark, and at least one has to exist.</b> The
    /// difference is money. A club that replaces a box and leaves the old row in the table has
    /// two boxes on one court: one heart-beating normally, one silent forever. If one dark box
    /// were enough, every no-show on those courts would be waived for as long as that row sat
    /// there — a member who genuinely did not turn up keeps their 30% because of an admin's
    /// unfinished tidying, and nothing on any screen would say why. Switching the stale row off
    /// removes it from the index entirely (see <see cref="BuildAsync"/>), but that is one act of
    /// housekeeping standing between the club and a permanent leak, so the rule cannot rest on
    /// it. The member is protected the moment there is nothing left that could have lit the
    /// court, which is exactly when they could not have checked in.
    /// </para>
    ///
    /// <para>
    /// A court the club has <b>no box on at all</b> is not dark. There is no evidence either way
    /// — the club has no hardware there — and reading "no reachable box" literally would waive
    /// every no-show at a club that has not installed a box yet.
    /// </para>
    ///
    /// <para>
    /// <b>A court whose boxes are all switched OFF is a different state, and it is dark.</b> This
    /// is the money half of finding M-F3 and it used to be got wrong in the direction that
    /// charges members. The out-of-service switch is what an admin uses on a box that is broken
    /// or has been unplugged for good, and the API then refuses that box 403 on every courtside
    /// endpoint — heartbeat, activate and walkup alike. Take the LAST box off a court and nobody
    /// standing at it can check in by any means; the old rule read that court as "no enabled box,
    /// therefore no evidence, therefore not dark" and settled its no-shows at the full 30%. The
    /// member was billed a penalty for a door the club had closed, and neither the console nor
    /// the spec said so. It is the same test as everywhere else — could the member have checked
    /// in? — applied to the one state where the answer is no by an admin's own deliberate act.
    /// </para>
    ///
    /// <para>
    /// The two are distinguished by whether a row exists, not by a judgement about intent: a
    /// club with nothing on the court has never asked anyone to check in there, while a club
    /// with a switched-off board has taken a working door away. A disabled board that was never
    /// on that court's relays does not appear here at all, because
    /// <see cref="OutOfServiceFrom"/> is keyed by the courts each board actually drives.
    /// </para>
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
        if (!_courtNumberById.TryGetValue(courtId, out var courtNumber)) return false;

        var existed = 0;
        if (_deviceIdsByCourtNumber.TryGetValue(courtNumber, out var deviceIds))
        {
            foreach (var deviceId in deviceIds)
            {
                // A board that did not exist at the deadline is not evidence about it, in either
                // direction — see KnownToExistFrom. It is skipped rather than counted as dark, so
                // a court whose only box arrived afterwards falls through to the clause below and
                // is judged as a court with no enabled box on it.
                if (_knownToExistFrom[deviceId] > instant) continue;

                existed++;
                if (!BoxWasUnreachable(deviceId, instant)) return false;
            }
        }

        // Every box the club expects to hear from on this court was past the threshold.
        if (existed > 0) return true;

        // None of them existed yet, or there are none. The court is dark only if the club had
        // hardware on it that an admin has switched off — a box the API refuses is a door that
        // is shut, not an absence of evidence. See the summary.
        return _outOfServiceFromByCourtNumber.TryGetValue(courtNumber, out var outOfServiceFrom)
            && outOfServiceFrom <= instant;
    }

    /// <summary>
    /// Whether one box had been silent for longer than the threshold at <paramref name="instant"/>,
    /// across every stretch of silence recorded for it.
    /// </summary>
    private bool BoxWasUnreachable(Guid deviceId, DateTimeOffset instant)
    {
        foreach (var silence in _silences)
        {
            if (silence.DeviceId != deviceId) continue;

            var quietAtInstant = instant - silence.LastHeartbeat;
            var stillQuiet = silence.Ended is null || instant < silence.Ended;
            if (quietAtInstant > _offlineAfter && stillQuiet)
            {
                return true;
            }
        }

        return false;
    }
}
