using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>One relay a box should re-energise after a power cut, and for how much longer.</summary>
/// <param name="Relay">The relay index on this board, 0–3. An index, never a quantity.</param>
/// <param name="CourtId">The court that relay is wired to.</param>
/// <param name="CourtNumber">That court's club-facing number.</param>
/// <param name="BookingId">The booking IN PLAY — the one the remaining time starts in.</param>
/// <param name="RemainingSeconds">True remaining seconds to the end of the CHAINED run, UNCAPPED — see <see cref="RelayRestorePlan"/>.</param>
/// <param name="EndsAt">When the chained run ends, for the projection row.</param>
/// <param name="CausedByUserId">Who paid for the time being restored (a pay-for payer, else the organiser), so "restored after power loss" can still name a member on the light state.</param>
/// <param name="OrganiserUserId">The booking's organiser: the member the restore's row on the Night is about (R19 E19-4), as every lights row is.</param>
public sealed record RelayRestoreItem(
    int Relay, Guid CourtId, int CourtNumber, Guid BookingId, int RemainingSeconds,
    DateTimeOffset EndsAt, Guid? CausedByUserId, Guid? OrganiserUserId)
{
    /// <summary>
    /// The v2 wire element: <c>&lt;relay&gt;|&lt;remaining_seconds&gt;|&lt;booking_ref&gt;</c>.
    ///
    /// <para>
    /// <b>A pipe-delimited string and not an object, deliberately.</b> The firmware has a
    /// heapless JSON <i>scanner</i>, not a parser — it offers a string-element walker and a
    /// number-element walker and no object-array walker at all. The roster already proves this
    /// idiom works on this board and the firmware already has the code that walks it.
    /// </para>
    ///
    /// <para>
    /// <b>The reference is the first eight hex of the booking id and never an activation
    /// code.</b> It exists so the trace can pair a restore with its booking; a live code would
    /// be a credential travelling to a board that has no use for it.
    /// </para>
    /// </summary>
    public string ToWire() => $"{Relay}|{RemainingSeconds}|{Reference}";

    /// <summary>The booking's short reference — the first eight hex characters of its id.</summary>
    public string Reference => RelayRestorePlan.ReferenceOf(BookingId);
}

/// <summary>
/// One element of the v3 heartbeat snapshot (device-api.md §3): what one mapped relay should be
/// doing now. <see cref="Lit"/> false means dark, with <see cref="Item"/> null.
/// </summary>
public sealed record SnapshotCourt(int Relay, int CourtNumber, Guid? CourtId, RelayRestoreItem? Item, char Kind)
{
    public bool Lit => Item is not null;

    /// <summary><c>&lt;relay&gt;|&lt;lit&gt;|&lt;seconds_left&gt;|&lt;kind&gt;|&lt;ref&gt;</c> — <c>"1|0|0|-|-"</c> when dark.</summary>
    public string ToWire()
    {
        return Item is null ? $"{Relay}|0|0|-|-" : $"{Relay}|1|{Item.RemainingSeconds}|{Kind}|{Item.Reference}";
    }
}

/// <summary>
/// What the API believes should be lit on one board right now — GOAL item 17's answer, and since
/// device contract v3 the complete snapshot every heartbeat carries (device-api.md §3–§4).
///
/// <para>
/// <b>Why this reads BOOKINGS and not <c>court_light_state</c>.</b> The projection is the
/// server's belief, and the health sweep sets it to <c>Unknown</c> precisely when a board goes
/// dark — which is the same power cut the restore exists to recover from. Bookings are the
/// durable truth: <c>CheckedInAt</c> records that the lights were actually cued, and
/// <c>EndsAt</c> records what the member paid for.
/// </para>
///
/// <para>
/// <b>Chain-aware (BD-1, BR-04, DL-11, FSF-08).</b> An extension is a separate, checked-in
/// booking starting exactly where the session in play ends (<c>decisions-court-box-extend</c>).
/// The v2 plan stopped at the end of the segment in play, so after a power dip an extended court
/// went dark at the ORIGINAL end with the extension paid for. The remaining time now runs to the
/// end of the chained run — the booking in play plus every checked-in booking that starts where
/// the previous one ends, up to <see cref="MaxChain"/> links — the walk
/// <c>DeviceExtendEndpoint.InPlayEndAsync</c> makes when it sells one.
/// </para>
///
/// <para>
/// <b>Release-cause-aware (BD-2, BR-03, FSF-03).</b> A member who pressed OFF has a
/// <c>release</c> receipt — the only thing on the server that says they left. v2 dropped a
/// booking after ANY release after its check-in, including the one the bridge synthesised when a
/// Mega watchdog reset opened every relay, so a Mega-only reset darkened a paid court for good.
/// Now only a release whose <c>cause</c> is <c>member</c> (or absent: every 2.x box) and which
/// PAIRED with this session (its <c>booking_id</c> is a booking of the run) takes it out — never
/// <c>mega_reset</c>, <c>autooff</c>, <c>cap</c> or <c>reconcile</c>. Paired by booking, which is
/// by court: another box's OFF on the same court counts, a release on another court never does
/// (BR-13).
/// </para>
///
/// <para>
/// <b><c>remaining_seconds</c> is uncapped and relative to this response.</b> The box clamps to
/// the relay hard cap itself and arms its re-light from the uncapped value, so capping here would
/// silently shorten a member's court.
/// </para>
///
/// <para>
/// <b>Neither form switches anything off.</b> An empty list, or a dark element, is information
/// that nothing SHOULD be on; the box never acts on it as an off-command (§4), so a dropped or cut
/// response cannot darken a court somebody is playing on.
/// </para>
/// </summary>
public static class RelayRestorePlan
{
    /// <summary>The longest chain followed, either way — <c>DeviceExtendEndpoint</c>'s bound.</summary>
    public const int MaxChain = 16;

    /// <summary>The causes a release can carry that mean the member switched the court off.</summary>
    public const string MemberCause = "member";

    /// <summary>A release receipt's outcome when it could not be matched to the session it ended.</summary>
    public const string UnpairedOutcome = "unpaired";

    /// <summary>A release whose <c>duration_ms</c> no relay can hold (device-api.md §9, MCV1-01).</summary>
    public const string ImplausibleOutcome = "implausible";

    /// <summary>The booking's short reference — the first eight hex characters of its id.</summary>
    public static string ReferenceOf(Guid bookingId) => bookingId.ToString("N")[..8];

    /// <summary>
    /// The v2 restore: only the relays that should be ON, in relay order — now chain-aware and
    /// cause-aware, exactly as the v3 snapshot is.
    /// </summary>
    public static async Task<IReadOnlyList<RelayRestoreItem>> ForAsync(
        MainframeDbContext db, Device device, DateTimeOffset now, CancellationToken ct, int cueMinutes = 0)
    {
        var snapshot = await SnapshotAsync(db, device, now, ct, cueMinutes);
        return [.. snapshot.Where(c => c.Item is not null).Select(c => c.Item!)];
    }

    /// <summary>
    /// The v3 snapshot: ONE element per mapped relay, in relay order, always complete (§3).
    /// </summary>
    /// <param name="cueMinutes">
    /// <c>activation_cue_window_minutes</c>, clamped (<c>BookingCodeWindow.CueMinutes</c>): "in play"
    /// starts this long before <c>StartsAt</c>, the same window <c>/activate</c> lights in. A booking
    /// lit during its cue window is in the snapshot from the moment it is lit (MCV1-05: v2's
    /// <c>StartsAt &lt;= now</c> left it out, and a power cut in those minutes left it dark).
    /// </param>
    public static async Task<IReadOnlyList<SnapshotCourt>> SnapshotAsync(
        MainframeDbContext db, Device device, DateTimeOffset now, CancellationToken ct, int cueMinutes = 0)
    {
        var numbers = device.CourtNumbers;
        if (numbers.Count == 0) return [];

        var courts = await db.Courts.AsNoTracking()
            .Where(c => numbers.Contains(c.CourtNumber))
            .ToListAsync(ct);
        var courtIds = courts.Select(c => c.Id).ToList();

        var lit = await LitNearAsync(db, courtIds, now, ct);

        var runs = new Dictionary<Guid, Run>();
        foreach (var court in courts)
        {
            if (RunOf(court.Id, lit, now, TimeSpan.FromMinutes(Math.Max(0, cueMinutes))) is { } run) runs[court.Id] = run;
        }

        var released = await MemberReleasedAsync(db, runs.Values, ct);
        var walkUps = await WalkUpsAsync(db, runs.Values.Select(r => r.InPlay.Id).ToList(), ct);

        var elements = new List<SnapshotCourt>(numbers.Count);
        for (var relay = 0; relay < numbers.Count; relay++)
        {
            var court = courts.FirstOrDefault(c => c.CourtNumber == numbers[relay]);
            Run? run = null;
            var isLit = court is not null && runs.TryGetValue(court.Id, out run) && !released.Contains(run.InPlay.Id);
            elements.Add(isLit ? ElementOf(relay, court!, run!, walkUps, now) : new SnapshotCourt(relay, numbers[relay], court?.Id, null, '-'));
        }

        return elements;
    }

    /// <summary>
    /// Every checked-in, uncancelled booking on these courts near now — the in-play ones, the links
    /// chained after them and the ones they were chained onto. One query for all four relays: a
    /// heartbeat runs every minute per board. The window is wider than any run can be, and a link
    /// outside it simply ends the walk early, never lengthens it.
    /// </summary>
    private static async Task<List<Booking>> LitNearAsync(MainframeDbContext db, List<Guid> courtIds, DateTimeOffset now, CancellationToken ct)
    {
        var lookBack = now.AddHours(-24);
        var lookAhead = now.AddHours(24);
        return await db.Bookings.AsNoTracking()
            .Where(b => courtIds.Contains(b.CourtId)
                        && b.CheckedInAt != null
                        && b.CancelledAt == null
                        && b.Status != BookingStatus.Cancelled
                        && b.Status != BookingStatus.AdminBlock
                        && b.EndsAt > lookBack
                        && b.StartsAt < lookAhead)
            .ToListAsync(ct);
    }

    /// <summary>A lit relay's element: the booking in play, the uncapped remainder to the end of its run, and its kind.</summary>
    private static SnapshotCourt ElementOf(int relay, Court court, Run run, HashSet<Guid> walkUps, DateTimeOffset now)
    {
        var remaining = (int)Math.Min(int.MaxValue, Math.Ceiling((run.EndsAt - now).TotalSeconds));
        var b = run.InPlay;
        var item = new RelayRestoreItem(
            relay, court.Id, court.CourtNumber, b.Id, remaining, run.EndsAt,
            b.PaidByUserId ?? b.UserId, b.UserId);
        var kind = run.InPlayIsExtension ? 'e' : walkUps.Contains(b.Id) ? 'w' : 'b';
        return new SnapshotCourt(relay, court.CourtNumber, court.Id, item, kind);
    }

    /// <summary>
    /// The end of the chained run that <paramref name="inPlay"/> starts: its own end, extended
    /// through every checked-in, uncancelled booking on the court that starts where the previous one
    /// ends, up to <see cref="MaxChain"/> links — <c>DeviceExtendEndpoint.InPlayEndAsync</c>'s walk.
    /// What <c>/activate</c>'s uncapped <c>play_remaining_seconds</c> is measured to (FSF-05).
    /// </summary>
    public static async Task<DateTimeOffset> ChainEndAsync(MainframeDbContext db, Booking inPlay, CancellationToken ct)
    {
        var horizon = inPlay.EndsAt.AddHours(24);
        var after = await db.Bookings.AsNoTracking()
            .Where(b => b.CourtId == inPlay.CourtId && b.Id != inPlay.Id
                        && b.CheckedInAt != null && b.CancelledAt == null
                        && b.Status != BookingStatus.Cancelled && b.Status != BookingStatus.AdminBlock
                        && b.StartsAt >= inPlay.EndsAt && b.StartsAt < horizon)
            .Select(b => new { b.StartsAt, b.EndsAt })
            .ToListAsync(ct);

        var end = inPlay.EndsAt;
        for (var i = 0; i < MaxChain; i++)
        {
            var at = end;
            var next = after.Where(b => b.StartsAt == at).OrderByDescending(b => b.EndsAt).FirstOrDefault();
            if (next is null) break;
            end = next.EndsAt;
        }
        return end;
    }

    /// <summary>The run of chained bookings on one court that contains now, or null when nothing is in play.</summary>
    /// <param name="InPlay">The booking spanning now.</param>
    /// <param name="EndsAt">The end of the last link chained after it.</param>
    /// <param name="Members">Every booking of the run — the ones chained onto, the one in play, the ones chained after.</param>
    /// <param name="InPlayIsExtension">The booking in play was bought as an extension: checked in before it began, onto a lit predecessor.</param>
    private sealed record Run(Booking InPlay, DateTimeOffset EndsAt, IReadOnlyList<Booking> Members, bool InPlayIsExtension);

    private static Run? RunOf(Guid courtId, List<Booking> lit, DateTimeOffset now, TimeSpan cue)
    {
        var onCourt = lit.Where(b => b.CourtId == courtId).ToList();

        // The slot-end sweep has run on it: the server has cued its lights off, so it is not in
        // play however the clock reads. A court with two live cued bookings is not a state the
        // engine can produce (the GiST exclusion forbids overlapping slots); the LATEST start is
        // the one the member is actually playing.
        var inPlay = onCourt
            .Where(b => b.StartsAt - cue <= now && b.EndsAt > now && b.LightsOffCuedAt == null)
            .OrderByDescending(b => b.StartsAt)
            .FirstOrDefault();
        if (inPlay is null) return null;

        var members = new List<Booking> { inPlay };
        var end = inPlay.EndsAt;
        for (var i = 0; i < MaxChain; i++)
        {
            var at = end;
            var next = onCourt.Where(b => b.StartsAt == at).OrderByDescending(b => b.EndsAt).FirstOrDefault();
            if (next is null) break;
            members.Add(next);
            end = next.EndsAt;
        }

        Booking? predecessor = null;
        var start = inPlay.StartsAt;
        for (var i = 0; i < MaxChain; i++)
        {
            var at = start;
            var previous = onCourt.Where(b => b.EndsAt == at).OrderBy(b => b.StartsAt).FirstOrDefault();
            if (previous is null) break;
            predecessor ??= previous;
            members.Add(previous);
            start = previous.StartsAt;
        }

        var isExtension = predecessor is not null && inPlay.CheckedInAt is { } checkedIn && checkedIn <= inPlay.StartsAt;
        return new Run(inPlay, end, members, isExtension);
    }

    /// <summary>
    /// The bookings in play whose member switched the court off: a <c>member</c> (or cause-less)
    /// release paired with a booking of the same run, after the booking in play was checked in.
    /// </summary>
    private static async Task<HashSet<Guid>> MemberReleasedAsync(
        MainframeDbContext db, IEnumerable<Run> runs, CancellationToken ct)
    {
        var all = runs.ToList();
        if (all.Count == 0) return [];

        var ids = all.SelectMany(r => r.Members.Select(m => m.Id)).Distinct().ToList();
        var earliest = all.Min(r => r.InPlay.CheckedInAt!.Value);
        var releases = await db.DeviceEventReceipts.AsNoTracking()
            .Where(r => r.Kind == Endpoints.DeviceEventEndpoints.ReleaseKind
                        && r.BookingId != null
                        && ids.Contains(r.BookingId.Value)
                        && (r.Cause == null || r.Cause == MemberCause)
                        // Only a release that PAIRED with the session (§3): an unpaired one names a
                        // booking only as a guess, and an implausible one (MCV1-01) is a box's
                        // arithmetic error, not a member leaving.
                        && (r.Outcome == null || (r.Outcome != UnpairedOutcome && r.Outcome != ImplausibleOutcome))
                        && r.OccurredAt > earliest)
            .Select(r => new { BookingId = r.BookingId!.Value, r.OccurredAt })
            .ToListAsync(ct);

        var released = new HashSet<Guid>();
        foreach (var run in all)
        {
            var members = run.Members.Select(m => m.Id).ToHashSet();
            var checkedIn = run.InPlay.CheckedInAt!.Value;
            if (releases.Any(r => members.Contains(r.BookingId) && r.OccurredAt > checkedIn)) released.Add(run.InPlay.Id);
        }
        return released;
    }

    /// <summary>The bookings among <paramref name="bookingIds"/> that were bought at the court as light time (a walk-up's charge).</summary>
    private static async Task<HashSet<Guid>> WalkUpsAsync(MainframeDbContext db, List<Guid> bookingIds, CancellationToken ct)
    {
        if (bookingIds.Count == 0) return [];
        var sold = await db.LedgerEntries.AsNoTracking()
            .Where(l => l.Type == LedgerEntryType.LightsPurchase && l.RelatedBookingId != null && bookingIds.Contains(l.RelatedBookingId.Value))
            .Select(l => l.RelatedBookingId!.Value)
            .ToListAsync(ct);
        return [.. sold];
    }
}
