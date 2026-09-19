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
/// driving it was unreachable, or when the club's boxes on it had all been switched out of
/// service by that instant — and a court the club has put no box on at all is never dark. The
/// switch-off is read from the instant it was recorded at, not from the present value of
/// <see cref="Device.Enabled"/>, and that bound is load-bearing rather than pedantic: without
/// it, flipping a box out of service today changed the price of deadlines that passed while it
/// was working, which is the invariant in the sentence above. See <see cref="DarknessAt"/> for
/// what each of those costs when it is got wrong.
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
/// <summary>
/// Why a court could or could not have been lit at a given instant. The distinction is not
/// cosmetic: it decides which mail the member gets, and only one of the two states can be
/// undone by the box coming back.
/// </summary>
public enum CourtDarkness
{
    /// <summary>A board that could have lit the court was reachable at that instant.</summary>
    Lit = 0,

    /// <summary>
    /// Every board driving the court had been silent past <c>offline_after_seconds</c>. The
    /// boards are still in service, so anything they queued arrives when they reconnect and the
    /// sweep is reversed (S6).
    /// </summary>
    Unreachable = 1,

    /// <summary>
    /// No board in service drove the court, and the hardware that did had already stopped
    /// answering by that instant. It is switched off now, so the API refuses it on all five
    /// <c>/api/v1/device/*</c> routes, <c>/events</c> included — nothing it holds will ever
    /// arrive and the settlement is final.
    /// </summary>
    OutOfService = 2,
}

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
    private readonly Dictionary<int, List<Guid>> _outOfServiceIdsByCourtNumber;
    private readonly Dictionary<Guid, DateTimeOffset> _knownToExistFrom;
    private readonly Dictionary<Guid, DateTimeOffset> _outOfServiceSince;
    private readonly List<Silence> _silences;
    private readonly TimeSpan _offlineAfter;

    private DeviceOutageIndex(
        Dictionary<Guid, int> courtNumberById,
        Dictionary<int, List<Guid>> deviceIdsByCourtNumber,
        Dictionary<int, List<Guid>> outOfServiceIdsByCourtNumber,
        Dictionary<Guid, DateTimeOffset> knownToExistFrom,
        Dictionary<Guid, DateTimeOffset> outOfServiceSince,
        List<Silence> silences,
        TimeSpan offlineAfter)
    {
        _courtNumberById = courtNumberById;
        _deviceIdsByCourtNumber = deviceIdsByCourtNumber;
        _outOfServiceIdsByCourtNumber = outOfServiceIdsByCourtNumber;
        _knownToExistFrom = knownToExistFrom;
        _outOfServiceSince = outOfServiceSince;
        _silences = silences;
        _offlineAfter = offlineAfter;
    }

    /// <summary>No courts and no silences — nothing is ever dark. Used where a caller has no context to build from.</summary>
    public static DeviceOutageIndex Empty { get; } = new([], [], [], [], [], [], TimeSpan.Zero);

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
    /// <b>They are read for one thing: whether the club had hardware on the court that the API
    /// had stopped accepting.</b> A box the API refuses cannot light anything —
    /// <c>DeviceIdentity.ResolveAsync</c> answers 403 for <c>!device.IsActive</c> on all five
    /// <c>/api/v1/device/*</c> routes — so when the LAST box on a court is switched off, that
    /// court has no check-in of its own left and every no-show on it was charged the full 30% for
    /// a door the club had closed. (The shared courtside terminal's own
    /// <c>/api/v1/court/{n}/…</c> routes are NOT refused — they never resolve a device — which is
    /// why the waiver is argued in <c>settlement-model.md</c> S5a from what the box can no longer
    /// do, rather than from a claim that nobody could check in.) See <see cref="DarknessAt"/>,
    /// which is where the two halves are put back together, and
    /// <c>A_court_whose_only_box_is_out_of_service_waives_the_penalty</c>.
    /// </para>
    ///
    /// <para>
    /// <b>Their silence is measured too, and it decides everything before the switch was thrown.</b>
    /// A switched-off row still carries <see cref="Device.LastSeenAt"/> and its old
    /// <see cref="DeviceOutage"/> rows, and for any instant at or before
    /// <see cref="Device.OutOfServiceSince"/> that evidence is what answers — the same question
    /// the enabled branch asks, so the click changes no answer that had already been given.
    /// Without it, one click waived every unsettled deadline back to the sweep's lookback floor —
    /// see <see cref="DarknessAt"/>, <see cref="DoorWasShutFor"/> and
    /// <c>A_switch_off_darkens_only_the_deadlines_the_board_had_already_gone_quiet_for</c>.
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
        // COURT BOXES, stated. This read had no filter on kind at all, and a gate was left out
        // only because auto-registration gives it an empty CourtNumbers list — so it fell out
        // of CourtIndex by accident rather than by rule. `PATCH /admin/devices/{id}` refuses
        // court numbers on a gate row today, but nothing stops a fixture, a restore or a
        // future migration putting one there, and the moment one appears a silent DOOR starts
        // waiving no-show penalties on a court it does not drive and a healthy door starts
        // vetoing the §6a waiver on a court whose box is genuinely dark. Neither is a door's
        // business: a gate lights nothing, stamps no attendance, and §1 says walking through a
        // door is not playing a court. A rule enforced by the emptiness of an unrelated list
        // is not enforced — the same sentence GateAccess.NotACourtBox is written for.
        //
        // Read once and split, because the two halves answer different questions: the enabled
        // boxes carry the silence, and the switched-off ones only say whether the club has any
        // hardware on the court at all, and from when (see CourtIndex and DarknessAt).
        var allDevices = await db.Devices.AsNoTracking().Where(d => d.Kind == DeviceKind.CourtBox).ToListAsync(ct);

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

        // Every board whose silence is worth measuring: the enabled ones, because a court is
        // dark only when all of them were past the threshold, and the switched-off ones,
        // because a switched-off board only shuts the door from the moment it stopped being
        // heard from. A board that has never called in at all carries no measurable silence
        // and is handled separately below.
        var heard = devices.Concat(outOfService.Where(d => d.LastSeenAt != null)).ToList();
        var heardFrom = HeardFrom(heard, outages);

        var silences = new List<Silence>(heard.Count + outages.Count + outOfService.Count);
        foreach (var device in heard)
        {
            // The stretch the box is in NOW, which is the one no outage row describes yet.
            silences.Add(SilenceFrom(device.Id, device.LastSeenAt!.Value, heardFrom[device.Id]));
        }

        foreach (var device in outOfService.Where(d => d.LastSeenAt is null))
        {
            // Never heard from, so there is no heartbeat to measure a silence from and no
            // instant at which it was reachable. It has been quiet since before time, which
            // combines with the existence floor to mean "quiet for the whole of its life".
            silences.Add(new Silence(device.Id, DateTimeOffset.MinValue, null));
        }

        foreach (var outage in outages)
        {
            // A row whose box is in neither set contributes nothing, in either direction —
            // the same rule as the query above.
            if (heardFrom.ContainsKey(outage.DeviceId))
            {
                silences.Add(SilenceFrom(outage.DeviceId, outage.StartedAt, heardFrom[outage.DeviceId]));
            }
        }

        var courtNumberById = await db.Courts.AsNoTracking()
            .ToDictionaryAsync(c => c.Id, c => c.CourtNumber, ct);

        // The recorded switch-off instants, for the boards that are switched off now. A row
        // whose column is null carries no instant and is judged by its silence alone — see
        // DoorWasShutFor.
        var outOfServiceSince = outOfService
            .Where(d => d.OutOfServiceSince is not null)
            .ToDictionary(d => d.Id, d => d.OutOfServiceSince!.Value);

        return new DeviceOutageIndex(
            courtNumberById, CourtIndex(devices), CourtIndex(outOfService),
            KnownToExistFrom([.. devices, .. outOfService], outages), outOfServiceSince, silences,
            TimeSpan.FromSeconds(offlineAfterSeconds));
    }

    /// <summary>
    /// The relay mapping, inverted: which boxes drive each court. A device drives the courts
    /// named in its own list, so a silence bears on exactly those and nothing else — a club
    /// with a second box on the annex court keeps charging no-shows there while the main box
    /// is out — and a court with two boxes on it needs both of them before it is dark.
    ///
    /// <para>
    /// Built twice over disjoint sets, because the two answer different questions: the enabled
    /// boards decide whether the court was dark, and the switched-off ones decide whether the
    /// club had a door there at all. Keyed by court number rather than by court id because that
    /// is what <see cref="Device.CourtNumbers"/> holds.
    /// </para>
    /// </summary>
    private static Dictionary<int, List<Guid>> CourtIndex(List<Device> devices)
    {
        var byCourtNumber = new Dictionary<int, List<Guid>>();
        foreach (var device in devices)
        {
            foreach (var court in device.CourtNumbers)
            {
                if (!byCourtNumber.TryGetValue(court, out var ids))
                {
                    ids = [];
                    byCourtNumber[court] = ids;
                }

                ids.Add(device.Id);
            }
        }

        return byCourtNumber;
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
    /// and not "some box driving it was unreachable". <see cref="DarknessAt"/> carries the same
    /// answer with the reason attached, for the mail that has to explain it.
    /// </summary>
    public bool CourtWasDark(Guid courtId, DateTimeOffset instant)
        => DarknessAt(courtId, instant) != CourtDarkness.Lit;

    /// <summary>
    /// Whether the court had a box that could have lit it at <paramref name="instant"/>, and if
    /// not, which of the two ways it did not.
    ///
    /// <para>
    /// <b>Every box driving the court has to be dark, and at least one has to exist.</b> The
    /// difference is money. A club that replaces a box and leaves the old row in the table has
    /// two boxes on one court: one heart-beating normally, one silent forever. If one dark box
    /// were enough, every no-show on those courts would be waived for as long as that row sat
    /// there — a member who genuinely did not turn up keeps their 30% because of an admin's
    /// unfinished tidying, and nothing on any screen would say why. Switching the stale row off
    /// takes it out of the enabled set (see <see cref="BuildAsync"/>), but that is one act of
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
    /// <b>A court whose boxes are all switched OFF is a different state, and it is dark from the
    /// moment that hardware stopped answering.</b> This is the money half of finding M-F3 and it
    /// has now been got wrong in both directions. The out-of-service switch is what an admin uses
    /// on a box that is broken or has been unplugged for good, and the API then refuses that box
    /// 403 on all five of its own routes — heartbeat, activate, walkup, events and gate alike. Take the
    /// LAST box off a court and that court has no check-in of its own left; the first rule read
    /// that court as "no enabled box, therefore no evidence, therefore not dark" and settled its
    /// no-shows at the full 30%, billing the member a penalty for a door the club had closed.
    /// </para>
    ///
    /// <para>
    /// <b>The second rule fixed that and broke the invariant at the top of this file instead.</b>
    /// <c>Enabled</c> carries no history, so "dark because the switch is thrown" was read as
    /// "dark for as far back as this board has existed": flipping the switch re-priced deadlines
    /// that had already passed. A board that ran perfectly for thirty days and was switched off
    /// five minutes ago darkened every unsettled deadline back to the sweep's lookback floor, and
    /// the club lost penalty revenue it was owed on courts that were working at the time. It
    /// needed no unusual timing — any sweep landing after the click settles them, including the
    /// next thirty-second tick.
    /// </para>
    ///
    /// <para>
    /// <b>The third rule fixed THAT and cost the member up to three minutes of a court the club
    /// had already shut.</b> It bounded the switch by the board's own silence — treating
    /// <see cref="Device.LastSeenAt"/> on a switched-off row as the recorded shadow of the
    /// switch-off — so the court became out of service only once that evidence had run past
    /// <c>offline_after_seconds</c>. The last heartbeat is not the click: the click lands some
    /// seconds or minutes after it, and for that whole gap the court read Lit while the board
    /// itself was already answering <c>403</c>. A booking whose grace deadline fell in it
    /// was settled as an ordinary no-show, penalty and all, and mailed the plain "Missed booking"
    /// notice — for a door an admin had closed a minute earlier.
    /// </para>
    ///
    /// <para>
    /// <b>So the switch-off instant is recorded, and the rule is answered from it.</b>
    /// <see cref="Device.OutOfServiceSince"/> is stamped where the transition happens
    /// (<c>DeviceRegistryService.UpdateAsync</c>). After it the door is shut with no waiting
    /// period, because the club has declared it and there is nothing left to be uncertain about;
    /// at or before it the board was in service and is judged by exactly the silence test its
    /// enabled siblings get, so no deadline is re-priced by the click. Bounding it at
    /// <c>LastSeenAt</c> instead — the obvious alternative, and the one this file used to
    /// argue for — puts the retroactive switch back for every deadline in
    /// <c>(LastSeenAt, LastSeenAt + offline_after_seconds)</c>. See
    /// <see cref="DoorWasShutFor"/>, which is where both parts live. A board that has never
    /// called in at all was never in service, and is a closed door from the moment it existed.
    /// </para>
    ///
    /// <para>
    /// The two "not dark" cases are distinguished by whether a row exists, not by a judgement
    /// about intent: a club with nothing on the court has never asked anyone to check in there,
    /// while a club with a switched-off board has taken a working door away. A disabled board
    /// that was never on that court's relays does not appear here at all, because
    /// <see cref="CourtIndex"/> is keyed by the courts each board actually drives.
    /// </para>
    ///
    /// <para>
    /// The comparison is strictly greater-than, matching <c>PeripheralHealthWorker.JudgeAsync</c>
    /// exactly. A box a second inside the threshold is "reachable" to the alert, to the Devices
    /// page and to the money, or the product tells an admin one thing and bills a member on
    /// another.
    /// </para>
    /// </summary>
    public CourtDarkness DarknessAt(Guid courtId, DateTimeOffset instant)
    {
        if (!_courtNumberById.TryGetValue(courtId, out var courtNumber)) return CourtDarkness.Lit;

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
                if (!BoxWasUnreachable(deviceId, instant)) return CourtDarkness.Lit;
            }
        }

        // Every box the club expects to hear from on this court was past the threshold.
        if (existed > 0) return CourtDarkness.Unreachable;

        // None of them existed yet, or there are none. See the summary.
        return DoorWasShutAt(courtNumber, instant);
    }

    /// <summary>
    /// The out-of-service half, asked only where no enabled board drove the court at that
    /// instant: had the club put hardware on this court whose door was already shut?
    ///
    /// <para>
    /// The shape mirrors the enabled loop above deliberately — at least one board existed, and
    /// every board that existed had its door shut — because the question is the same one. A club
    /// with two switched-off boards on a court, one of which the club had not yet switched off
    /// and which was still heart-beating at the deadline, had a working door there at the
    /// deadline.
    /// </para>
    /// </summary>
    private CourtDarkness DoorWasShutAt(int courtNumber, DateTimeOffset instant)
    {
        if (!_outOfServiceIdsByCourtNumber.TryGetValue(courtNumber, out var deviceIds))
        {
            return CourtDarkness.Lit;
        }

        var existed = 0;
        foreach (var deviceId in deviceIds)
        {
            if (_knownToExistFrom[deviceId] > instant) continue;

            existed++;
            if (!DoorWasShutFor(deviceId, instant)) return CourtDarkness.Lit;
        }

        return existed > 0 ? CourtDarkness.OutOfService : CourtDarkness.Lit;
    }

    /// <summary>
    /// Whether one switched-off board's door was shut at <paramref name="instant"/>, in either of
    /// the two ways it can be — and this is the whole of the out-of-service rule.
    ///
    /// <para>
    /// <b>After the switch was thrown, the door is shut, full stop.</b> The club has declared it:
    /// from that instant the API answers <c>403</c> for this board on all five
    /// <c>/api/v1/device/*</c> routes, so it admits nobody, is told nothing and reports nothing,
    /// and there is nothing left to wait <c>offline_after_seconds</c> for. Waiting anyway is not
    /// neutral — it charged the member the full 30% for a door the club had shut up to three
    /// minutes earlier, which is the exact direction §6a exists to prevent. The comparison is
    /// strictly greater-than, so a deadline landing exactly ON the recorded instant is judged by
    /// the branch below rather than by this one; pinned by
    /// <c>A_deadline_exactly_on_the_recorded_switch_off_instant_is_judged_by_the_silence_test</c>.
    /// </para>
    ///
    /// <para>
    /// <b>What that 403 does NOT cover, because this comment claimed it did for two rounds.</b>
    /// The three <c>/api/v1/court/{n}/…</c> routes — PIN, QR and biometric at the shared courtside
    /// terminal — resolve a <c>Courts.CourtNumber</c>, never look at a <see cref="Device"/> row,
    /// and still set <c>CheckedInAt</c>. So a member at a court whose every box is out of service
    /// can still identify at the terminal, and the sentence "nobody standing at the court can
    /// check in by any means" was false. The rule below is unchanged by that correction — the
    /// sweep only ever reaches bookings nobody checked into — but its justification is, and it is
    /// argued out in <c>settlement-model.md</c> S5a rather than asserted here.
    /// </para>
    ///
    /// <para>
    /// <b>Before the switch was thrown, it is the enabled board's own question, asked the same
    /// way.</b> The board was in service then, so what decides is what decides for any board in
    /// service: had it been silent longer than the threshold at that instant. This half is what
    /// keeps the click from re-pricing the past — every deadline that had already passed when the
    /// admin clicked keeps the answer it had before the click, because the same
    /// <see cref="BoxWasUnreachable"/> call answers it on both sides of the switch. A deadline the
    /// board was answering across is Lit either way; a deadline it had genuinely gone quiet across
    /// is dark either way — <b>including one that falls BEFORE the board's most recent
    /// heartbeat</b>, because <see cref="BoxWasUnreachable"/> scans every silence recorded for the
    /// board, closed <see cref="DeviceOutage"/> rows included, not only the stretch since
    /// <see cref="Device.LastSeenAt"/>. This comment used to say the opposite — "a deadline at or
    /// before the board's last heartbeat is Lit either way" — and
    /// <c>A_board_dark_across_the_deadline_still_waives_it_after_an_admin_switches_it_off</c> was
    /// green against it the whole time.
    /// </para>
    ///
    /// <para>
    /// <b>Why this needs a column and could not be read off <see cref="Device.LastSeenAt"/>.</b>
    /// That was the previous rule, and this file argued for it at length: a disabled board is
    /// refused <c>403</c>, so its last heartbeat was said to be "the recorded shadow of the
    /// switch-off". It is not the same instant. The switch is thrown some seconds or minutes
    /// AFTER the last heartbeat, and a deadline inside that gap is priced differently by the two
    /// readings — so the gap is money. Using the threshold there (the shipped rule) charged the
    /// member for up to <c>offline_after_seconds</c> of a court the club had already shut; using
    /// the last heartbeat exactly (the obvious alternative) flipped a deadline that had already
    /// passed from penalty to waiver the moment an admin clicked, which is the retroactive switch
    /// this class was rewritten twice to remove. Measured, not reasoned: with the second rule in
    /// place the whole backend suite stayed green while a sixty-second-old deadline changed price
    /// by 2.40 on the click alone. Recording the instant is what lets both answers be right.
    /// </para>
    ///
    /// <para>
    /// <b>A row with no recorded instant falls back to its silence alone</b>, which is what
    /// shipped before the column existed. Every switch thrown through the product records one
    /// (<c>DeviceRegistryService.UpdateAsync</c>), so this covers rows disabled by a fixture, a
    /// seed or a restore, where the honest answer is that nobody knows when the door shut. It
    /// falls the conservative way: the club's own evidence decides, and no click moves anything.
    /// </para>
    /// </summary>
    private bool DoorWasShutFor(Guid deviceId, DateTimeOffset instant)
    {
        if (_outOfServiceSince.TryGetValue(deviceId, out var switchedOffAt) && instant > switchedOffAt)
        {
            return true;
        }

        return BoxWasUnreachable(deviceId, instant);
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
