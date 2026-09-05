using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Security.DeviceAuth;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// What a court box did while nobody was asking.
///
/// <para>
/// The box decides scans locally and queues what it decided; this is where that queue
/// drains. Two endpoints here plus <see cref="DeviceActivateEndpoint"/> on the same signed
/// group, and the reason they exist separately from the courtside
/// <c>/api/v1/court/…</c> surface is that those are <i>synchronous questions</i> — a browser
/// asking "may this person on court 2 start now?" — while these are <b>reports of things
/// that already happened</b>, possibly hours ago, possibly several at once.
/// </para>
///
/// <para>
/// <b>Idempotency is the whole design.</b> A box may upload an event, lose the link before
/// reading the response, and upload it again — that is the normal shape of an unreliable
/// network rather than an error. <c>(device_id, seq)</c> is the key, and the filtered unique
/// index on <see cref="LedgerEntry.ExternalReference"/> is what makes a retry safe rather
/// than a double charge.
/// </para>
/// </summary>
public static class DeviceEventEndpoints
{
    /// <summary>
    /// Most events a box uploads in one batch. Bounded because a board that has been offline
    /// for a week arrives with a full ring, and one request that takes a minute to process is
    /// a request that times out and gets retried forever.
    /// </summary>
    public const int MaxBatch = 32;

    public static IEndpointRouteBuilder MapDeviceEventEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/device")
            .RequireAuthorization(p => p
                .AddAuthenticationSchemes(DeviceAuthenticationHandler.SchemeName)
                .RequireRole(DeviceAuthenticationHandler.DeviceRole))
            .RequireRateLimiting(RateLimitPolicies.Device);

        g.MapPost("/events", UploadAsync);
        g.MapPost("/walkup", WalkUpAsync);
        // The pre-booked member's path — the mirror of the walk-up, on the same signed
        // device group and the same rate limit. See DeviceActivateEndpoint.
        g.MapPost("/activate", DeviceActivateEndpoint.HandleAsync);
        return app;
    }

    /// <summary>The event kind a box queues when it lit a court from its cached roster.</summary>
    public const string ActivationKind = "activation";

    /// <summary>
    /// The event kind a box queues when a relay opened again — <c>eventq::Kind::Release</c>.
    ///
    /// <para>
    /// It names no member and no booking: it carries a relay index and <c>duration_ms</c> =
    /// how long the relay was actually closed. That number is the <b>only</b> measurement in
    /// the system of what the lights did, as against the <i>grant</i> the activation carries,
    /// and the settlement model leans on it for the price of cancelled-then-lit time and for
    /// the real end of a reversed no-show. See <c>docs/specs/settlement-model.md</c> §4.
    /// </para>
    /// </summary>
    public const string ReleaseKind = "release";

    /// <summary>
    /// How far a release's implied lit end may sit from the release's own time before the
    /// pairing is refused.
    ///
    /// <para>
    /// Both times come off the same uptime accumulator on the same box, so they agree to
    /// within the Mega's timer resolution; two minutes is generous. The check exists because
    /// a release that cannot be paired must correct <b>nothing</b> rather than correct the
    /// wrong session — a missed release on relay B followed by a later one would otherwise
    /// re-price a session it has nothing to do with.
    /// </para>
    /// </summary>
    public static readonly TimeSpan ReleasePairingTolerance = TimeSpan.FromMinutes(2);

    /// <summary>
    /// Records a batch of events and reports the highest sequence number accepted.
    ///
    /// <para>
    /// The box releases its queue up to <c>accepted_through</c> and no further, so a partial
    /// success loses nothing: whatever came after simply stays queued and is offered again.
    /// That is why the response carries a sequence number rather than a bare 200.
    /// </para>
    ///
    /// <para>
    /// <b>An activation event is attendance</b> (review C6). The firmware's whole offline
    /// money model rests on the queued activation stopping the no-show refund; this handler
    /// used to write a receipt and an audit row and nothing else, so a member the box had
    /// admitted from its roster was swept as a no-show, refunded and penalised — and the
    /// acknowledgement made the box release the only evidence. Every not-yet-receipted
    /// activation now goes through <see cref="CourtActivationService"/>, the one path that
    /// stamps <c>CheckedInAt</c>, <i>before</i> its receipt is written.
    /// </para>
    ///
    /// <para>
    /// <b>Each event is its own unit of work.</b> <c>ActivateAsync</c> saves internally, so
    /// a batch-level save was a fiction the moment an activation was in it: whatever was
    /// staged before the activation flushed with it, and a failure after it left a batch
    /// half-committed with no record of which half. Saving per event makes the boundary
    /// honest — receipts exist through the last event that completed, <c>accepted_through</c>
    /// says exactly that, and a retry after a mid-batch failure skips what was taken and
    /// re-runs the rest. Re-running an activation is harmless because it is idempotent on
    /// <c>CheckedInAt</c>; the other order — receipt first — would have acknowledged the
    /// event and lost the attendance permanently on that same failure.
    /// </para>
    /// </summary>
    private static async Task<IResult> UploadAsync(
        DeviceEventBatch batch,
        [AsParameters] DeviceEventServices services,
        CancellationToken ct)
    {
        var (device, refusal) = await DeviceIdentity.ResolveAsync(services.Db, batch.Mac, ct);
        if (refusal is not null) return refusal;

        var events = (batch.Events ?? []).Take(MaxBatch).ToList();
        if (events.Count == 0) return Results.Ok(new { accepted_through = 0L, recorded = 0 });

        // The box has no RTC, so an event carries its uptime and the batch carries the
        // box's uptime now. The difference is how long ago it happened; the server clock is
        // the only one anybody can be held to.
        var now = DateTimeOffset.UtcNow;
        long acceptedThrough = 0;
        var recorded = 0;

        var alreadyRecorded = await SeenAsync(services.Db, device!, events, ct);

        foreach (var e in events.OrderBy(e => e.Seq))
        {
            // A retry of something already taken is acknowledged, not re-recorded — which
            // is what lets the box release it and move on.
            if (!alreadyRecorded.Contains(e.Seq))
            {
                var time = TimeOf(batch, e, now);

                // Attendance BEFORE the receipt. See the summary for why this order.
                var outcome = e.Kind switch
                {
                    ActivationKind => await ActivationOutcomeAsync(device!, e, time.OccurredAt, services, ct),
                    ReleaseKind => await ReleaseOutcomeAsync(device!, e, time.OccurredAt, services, ct),
                    _ => null,
                };

                if (await RecordAsync(services, device!, e, time, outcome, ct)) recorded++;
            }

            acceptedThrough = e.Seq;
        }

        device!.LastSeenAt = now;
        await services.Db.SaveChangesAsync(ct);

        return Results.Ok(new
        {
            accepted_through = acceptedThrough,
            recorded,
        });
    }

    /// <summary>
    /// The sanity bound on how far in the past an uploaded event may claim to have
    /// happened. NOT the roster's six-hour trust: that bounds roster-fetch-to-scan, and
    /// this bounds scan-to-upload, which is the length of the outage — the very thing the
    /// persisted queue exists to survive. A six-hour clamp here re-created the C6 outcome
    /// for every outage longer than six hours: the scan time was replaced with the upload
    /// time, the roster code was judged expired at that instant, the event resolved to
    /// nothing, and the member who played stayed refunded and penalised (closing re-review
    /// #6/#7). Thirty days is past any outage a club will ride out; the access-code grave
    /// (<c>RetentionWorker</c>) is sized to keep booking codes resolvable that long.
    /// </summary>
    public static readonly TimeSpan MaxEventAge = TimeSpan.FromDays(30);

    /// <summary>
    /// When an event happened, and — if the box's arithmetic could not be believed — the
    /// value it claimed. <see cref="ClampedFrom"/> is null for an ordinary event.
    /// </summary>
    private sealed record EventTime(DateTimeOffset OccurredAt, DateTimeOffset? ClampedFrom);

    /// <summary>
    /// The event's time from uptime arithmetic: the box's uptime at upload minus its uptime
    /// at the scan, taken off the server clock. The box's clock is server-derived and its
    /// uptime accumulator is exact within a boot, so the arithmetic is believed however
    /// long ago the scan was — a two-day outage is precisely what the queue is for. Two
    /// things are not believed: a scan in the FUTURE (the queue outlived a reboot and
    /// carries a previous boot's uptime), and one past <see cref="MaxEventAge"/>. Both are
    /// clamped to the upload instant and the claimed value is kept on the audit row
    /// (<c>device.event_time_clamped</c>) so the desk can see the counter is broken.
    /// </summary>
    private static EventTime TimeOf(DeviceEventBatch batch, DeviceEventDto e, DateTimeOffset now)
    {
        var claimed = now.AddMilliseconds(-(double)(batch.UptimeMs - e.UptimeMs));
        return claimed > now || now - claimed > MaxEventAge
            ? new EventTime(now, claimed)
            : new EventTime(claimed, null);
    }

    /// <summary>
    /// Which of the offered sequence numbers this box has already had receipted. One read
    /// for the whole batch rather than one per event: a box back from a week offline arrives
    /// with a full ring, and 32 round trips to answer "seen this?" is 32 round trips.
    /// </summary>
    private static async Task<HashSet<long>> SeenAsync(
        MainframeDbContext db, Device device, List<DeviceEventDto> events, CancellationToken ct)
    {
        var offered = events.Select(e => e.Seq).ToList();
        var seen = await db.DeviceEventReceipts
            .Where(r => r.DeviceId == device.Id && offered.Contains(r.Seq))
            .Select(r => r.Seq)
            .ToListAsync(ct);
        return seen.ToHashSet();
    }

    /// <summary>
    /// What became of one activation event, for the audit trail. <c>ok</c> covers a fresh
    /// stamp and a repeat of a live session alike; everything else names why nothing was
    /// stamped, and is written as its own <c>device.activation_{code}</c> audit row so the
    /// desk can answer "I scanned and it let me in — why am I a no-show?" from the record.
    /// </summary>
    private sealed record ActivationOutcome(
        string Code, Guid? BookingId, string Kind = ActivationKind, Guid? RelatedBookingId = null)
    {
        public const string Ok = "ok";

        /// <summary>
        /// The booking was cancelled by a displacement, not by its member, and the box lit
        /// its court anyway from a roster that still carried it. Nothing is charged
        /// (settlement model I5); the audit row names the booking that displaced it, because
        /// two members reached one court and the desk needs to see which.
        /// </summary>
        public const string DisplacedCollision = "displaced_collision";

        /// <summary>
        /// Stamped, and a settled no-show undone to do it. Success as far as the box is
        /// concerned, and its own audit row because money moved back.
        /// </summary>
        public const string ReversedNoShow = "reversed_no_show";

        /// <summary>
        /// The booking had been cancelled and refunded before the box lit it from a stale
        /// roster; the lit time was charged pro rata (review #21). Its own audit row
        /// because money moved.
        /// </summary>
        public const string AfterCancel = "after_cancel";
    }

    /// <summary>
    /// Turns an activation event into attendance, or says why it could not.
    ///
    /// <para>
    /// The token the box reports is the roster token — the booking's own activation code
    /// — so it names the booking outright; the only questions are whether it is this
    /// club's (the code resolver is tenant-filtered, so another club's code is simply
    /// unknown here), whether the relay the box lit is wired to the booking's court, and
    /// what the one activation path makes of it. <b>Nothing here refuses the batch.</b> A
    /// 4xx on an event the box cannot change is a box retrying forever; every outcome is
    /// receipted and acknowledged, and the refusals are preserved server-side as audit rows
    /// — the evidence the box is about to release.
    /// </para>
    ///
    /// <para>
    /// <c>TooEarly</c> is not stamped. The box let the member in ahead of the cue window —
    /// its clock or its cached window drifted — and the cue rule is the rule; the audit row
    /// is what tells an admin the box is drifting. A charge refusal on a legacy uncharged
    /// row is likewise recorded and not stamped. A booking cancelled after the roster was
    /// pushed is not stamped either, but its lit time IS charged — see <see cref="SettleAsync"/>.
    /// </para>
    ///
    /// <para>
    /// Judged at <paramref name="occurredAt"/> — the scan — not at the upload. A box
    /// offline for longer than the grace window uploads scans the sweep has already ruled
    /// on; see <see cref="SettleAsync"/> for what a settled no-show becomes.
    /// </para>
    /// </summary>
    private static async Task<ActivationOutcome> ActivationOutcomeAsync(
        Device device, DeviceEventDto e, DateTimeOffset occurredAt, DeviceEventServices services, CancellationToken ct)
    {
        var (db, _, codes, _, _, _) = services;

        // Live at the scan, not at the upload: the roster token expires at the slot's end
        // plus grace, and a box offline past that is precisely the box whose evidence
        // matters most.
        var resolved = await codes.ResolveAsync(e.Subject, occurredAt, ct);
        if (resolved is null || resolved.Purpose != AccessCodePurpose.BookingActivation || resolved.BookingId is null)
        {
            return new ActivationOutcome("unresolved", null);
        }

        var booking = await db.Bookings.FirstOrDefaultAsync(b => b.Id == resolved.BookingId, ct);
        if (booking is null) return new ActivationOutcome("unresolved", null);

        var court = await db.Courts.FirstOrDefaultAsync(c => c.Id == booking.CourtId, ct);
        if (court is null) return new ActivationOutcome("unresolved", booking.Id);

        // The event's court is the RELAY INDEX the box lit (eventq::Event::court, 0-3),
        // and the device's court list is the relay mapping — so the relay must be wired
        // to the booking's court. A box that lit relay C for a court-1 booking has a
        // stale or wrong court list, and the member is standing on the wrong court.
        if (e.Court is not { } relay || relay < 0 || relay >= device.CourtNumbers.Count
            || device.CourtNumbers[relay] != court.CourtNumber)
        {
            return new ActivationOutcome("wrong_court", booking.Id);
        }

        var target = new ActivationTarget(court, booking, resolved.UserId, e.Method ?? "offline", occurredAt, e.DurationMs);
        var settled = await SettleAsync(services, target, ct);
        return new ActivationOutcome(settled.Code, booking.Id, ActivationKind, settled.RelatedBookingId);
    }

    /// <summary>
    /// What a <c>release</c> event settles: the measurement of how long a relay was actually
    /// closed, applied to whatever the matching activation left provisional.
    ///
    /// <para>
    /// The release names nothing, so it is paired by <b>device, relay and time</b> against
    /// the last activation receipt for the same relay — which is why the receipt now carries
    /// the relay index and the booking the activation resolved to. A pairing that does not
    /// reconcile within <see cref="ReleasePairingTolerance"/> is audited
    /// <c>device.release_unpaired</c> and corrects nothing.
    /// </para>
    /// </summary>
    private static async Task<ActivationOutcome> ReleaseOutcomeAsync(
        Device device, DeviceEventDto e, DateTimeOffset occurredAt, DeviceEventServices services, CancellationToken ct)
    {
        var (db, _, _, _, bookings, _) = services;
        if (e.Court is not { } relay || relay < 0) return new ActivationOutcome("unpaired", null, ReleaseKind);

        var session = await db.DeviceEventReceipts.AsNoTracking()
            .Where(r => r.DeviceId == device.Id
                        && r.Kind == ActivationKind
                        && r.Court == relay
                        && r.BookingId != null
                        && r.OccurredAt <= occurredAt)
            .OrderByDescending(r => r.OccurredAt)
            .FirstOrDefaultAsync(ct);
        if (session is null) return new ActivationOutcome("unpaired", null, ReleaseKind);

        var impliedEnd = session.OccurredAt.AddMilliseconds(e.DurationMs);
        if ((impliedEnd - occurredAt).Duration() > ReleasePairingTolerance)
        {
            return new ActivationOutcome("unpaired", session.BookingId, ReleaseKind);
        }

        var booking = await db.Bookings.FirstOrDefaultAsync(b => b.Id == session.BookingId, ct);
        if (booking is null) return new ActivationOutcome("unpaired", session.BookingId, ReleaseKind);

        // Grant zero: the release carries the measurement, and the sold window is the only
        // other bound that applies to it.
        var window = LitWindowOf(booking, session.OccurredAt, grantMs: 0, heldMs: e.DurationMs);
        var settled = await bookings.SettleReleaseAsync(booking, window.Minutes, window.End, Guid.Empty, ct);
        var code = settled.Code == ReleaseSettlement.NotApplicable.Code ? ActivationOutcome.Ok : settled.Code;
        return new ActivationOutcome(code, booking.Id, ReleaseKind);
    }

    /// <summary>
    /// The settlement decision for one activation event, driven directly — the same entry
    /// the upload handler uses, public so a test can interleave a sweep between the read
    /// of <paramref name="booking"/> and its stamp without an HTTP client in the way.
    /// </summary>
    public static async Task<string> ActivateOrReverseAsync(DeviceEventServices services, LateActivation evidence, CancellationToken ct)
    {
        var settled = await SettleAsync(services,
            new ActivationTarget(evidence.Court, evidence.Booking, evidence.UserId, evidence.Method, evidence.OccurredAt, evidence.DurationMs), ct);
        return settled.Code;
    }

    /// <summary>One settlement's verdict, plus the other booking it implicates when there is one.</summary>
    private sealed record SettleOutcome(string Code, Guid? RelatedBookingId = null);

    /// <summary>
    /// Turns the activation into attendance — undoing the sweep first if it got there
    /// before the evidence did.
    ///
    /// <para>
    /// A box offline for longer than the grace window lights the court from its roster and
    /// queues the scan; by the time the link returns the sweep has settled the booking as a
    /// no-show, refunded it less the penalty and released the court. The uploaded scan then
    /// resolved to "not chargeable" and the member who played kept the refund and paid the
    /// penalty. A settled no-show is now reversed by <see cref="BookingService"/> — two new
    /// ledger rows, the row <c>Booked</c> and checked in at the scan — and the outcome is
    /// receipted as its own audit row, because money moved back. The cue gate applies on
    /// this branch too: a box that admitted a member ahead of the window and lost the link
    /// is reporting a scan that broke the rule, not one that kept it.
    /// </para>
    ///
    /// <para>
    /// <b>The sweep-versus-upload race lands here as well</b> (review #18). The upload reads
    /// a <c>Booked</c> row, the 30-second sweep settles it in between, and the stamp loses
    /// on the concurrency token. Re-running the activation against the reloaded row used to
    /// answer <c>not_chargeable</c> — the C6 outcome with the box's evidence released. The
    /// reload is now looked at: a row that became <c>NoShow</c> underneath the upload goes
    /// through the reversal, and only a row that is still live is activated again.
    /// </para>
    ///
    /// <para>
    /// A reversal that loses to a concurrent upload of the same evidence re-reads the row
    /// and takes the ordinary path, which finds it live and is the idempotent no-op it is
    /// meant to be. A row cancelled after its code was pushed has its lit time charged
    /// (review #21); <c>not_chargeable</c> is kept for what remains: blocked, or otherwise
    /// past charging.
    /// </para>
    /// </summary>
    private static async Task<SettleOutcome> SettleAsync(DeviceEventServices services, ActivationTarget t, CancellationToken ct)
    {
        var (db, _, _, activation, bookings, settingsAccessor) = services;
        var settings = await settingsAccessor.GetAsync(ct);

        for (var attempt = 0; attempt < 3; attempt++)
        {
            // Settlement model I7. The cue gate is the rule on every settled branch, not
            // just the no-show one. It was present above the reversal and absent one branch
            // below it, which made the cancelled-then-lit charge the single path a box with
            // a drifted clock could still spend a member's credits down.
            if (t.Booking.Status is BookingStatus.NoShow or BookingStatus.Cancelled
                && t.OccurredAt is { } scannedAt
                && scannedAt < t.Booking.StartsAt.AddMinutes(-settings.ActivationCueWindowMinutes))
            {
                return new SettleOutcome("too_early");
            }

            if (t.Booking.Status == BookingStatus.NoShow)
            {
                // The system actor, as the sweep's own rows are: the evidence came from a box,
                // and Guid.Empty is how every device-originated row already names it.
                var provisional = LitWindowOf(t.Booking, t.OccurredAt ?? DateTimeOffset.UtcNow, t.DurationMs, heldMs: null);
                var reversal = await bookings.ReverseNoShowAsync(
                    t.Booking, t.OccurredAt ?? DateTimeOffset.UtcNow, Guid.Empty, ct, provisional.End);
                if (reversal is NoShowReversalResult.Ok) return new SettleOutcome(ActivationOutcome.ReversedNoShow);
                t = t with { Booking = await FreshAsync(db, t.Booking, ct) };
                continue;
            }

            if (t.Booking.Status == BookingStatus.Cancelled) return await CancelledOutcomeAsync(bookings, t, ct);

            var request = new ActivationRequest(t.Court, t.Booking, t.UserId, null, t.Method, t.OccurredAt);
            try
            {
                return new SettleOutcome(await activation.ActivateAsync(request, ct) switch
                {
                    ActivationResult.Activated => ActivationOutcome.Ok,
                    ActivationResult.TooEarly => "too_early",
                    ActivationResult.InsufficientBalance => "unpaid",
                    _ => "not_chargeable",
                });
            }
            catch (DbUpdateConcurrencyException)
            {
                // The failed save leaves its audit row tracked as Added; forget it, or the
                // next save on this context would insert it against a stamp this request
                // never made. Then reload and look again — the row may now be a no-show.
                DetachAdded(db);
                t = t with { Booking = await FreshAsync(db, t.Booking, ct) };
            }
        }

        return new SettleOutcome("not_chargeable");
    }

    /// <summary>
    /// The lights ran on a row that is already cancelled. Either its member cancelled it and
    /// owes the time that ran (bounded by the settlement model's ceiling), or the system
    /// displaced it — in which case nothing is owed and the collision is what matters.
    /// </summary>
    private static async Task<SettleOutcome> CancelledOutcomeAsync(
        BookingService bookings, ActivationTarget t, CancellationToken ct)
    {
        var window = LitWindowOf(t.Booking, t.OccurredAt ?? DateTimeOffset.UtcNow, t.DurationMs, heldMs: null);
        var lit = await bookings.ChargeLitCancelledBookingAsync(
            t.Booking, t.OccurredAt ?? DateTimeOffset.UtcNow, window.Minutes, ct);
        return lit switch
        {
            CancelledLightsResult.Displaced d => new SettleOutcome(ActivationOutcome.DisplacedCollision, d.DisplacedByBookingId),
            CancelledLightsResult.NotCharged => new SettleOutcome("not_chargeable"),
            _ => new SettleOutcome(ActivationOutcome.AfterCancel),
        };
    }

    /// <summary>The interval the relay is believed to have been closed for, and its whole minutes.</summary>
    internal sealed record LitWindow(DateTimeOffset Start, DateTimeOffset End, int Minutes);

    /// <summary>
    /// The lit window, bounded every way the settlement model requires (I6).
    ///
    /// <para>
    /// <paramref name="grantMs"/> is what the relay was <i>told</i> to run for and
    /// <paramref name="heldMs"/> what it is measured to have run for; the measurement wins
    /// when it exists and is otherwise absent by construction, because a release event
    /// arrives at least one request after the activation it belongs to.
    /// </para>
    ///
    /// <para>
    /// Three bounds, and every one of them was missing. <b>Lower bound at
    /// <c>StartsAt</c>:</b> the roster's window opens a cue window <i>before</i> the slot, so
    /// a member scanning at 17:52 for an 18:00 court was granted — and billed — 68 minutes of
    /// a 60-minute booking. <b>Upper bound at the sold window and the sold minutes:</b> the
    /// same reason from the other end. <b>The relay hard cap:</b> the bank cuts the lights at
    /// ninety minutes whatever it is told, so no honest charge can exceed it.
    /// </para>
    /// </summary>
    internal static LitWindow LitWindowOf(Booking booking, DateTimeOffset scannedAt, long grantMs, long? heldMs)
    {
        var soldEnd = BookingService.OriginalEndsAt(booking);
        var start = scannedAt > booking.StartsAt ? scannedAt : booking.StartsAt;

        var end = grantMs > 0 ? scannedAt.AddMilliseconds(grantMs) : soldEnd;
        if (heldMs is > 0 and { } held)
        {
            var measured = scannedAt.AddMilliseconds(held);
            if (measured < end) end = measured;
        }
        if (end > soldEnd) end = soldEnd;

        var soldMinutes = booking.SliceMinutes * booking.SliceCount;
        var minutes = end <= start ? 0 : (int)Math.Ceiling((end - start).TotalMinutes);
        return new LitWindow(start, end, Math.Clamp(minutes, 0, Math.Min(soldMinutes, RelayHardCap.Minutes)));
    }

    /// <summary>The row as the database has it now: reloaded in place if still tracked, else read fresh.</summary>
    private static async Task<Booking> FreshAsync(MainframeDbContext db, Booking booking, CancellationToken ct)
    {
        var entry = db.Entry(booking);
        if (entry.State != EntityState.Detached)
        {
            await entry.ReloadAsync(ct);
            return booking;
        }
        return await db.Bookings.FirstAsync(b => b.Id == booking.Id, ct);
    }

    private static void DetachAdded(MainframeDbContext db)
    {
        foreach (var entry in db.ChangeTracker.Entries().Where(e => e.State == EntityState.Added).ToList())
        {
            entry.State = EntityState.Detached;
        }
    }

    /// <summary>
    /// Writes one event's receipt and audit rows and saves them — its own unit of work, see
    /// <see cref="UploadAsync"/>. False when the unique index on (tenant, device, seq)
    /// refused the receipt: two uploads of the same batch were in flight together, the other
    /// one recorded this event, and the box is told it is accepted because it is. Any
    /// activation this event carried has already been applied, idempotently, by whichever
    /// request got there first.
    /// </summary>
    private static async Task<bool> RecordAsync(
        DeviceEventServices services, Device device, DeviceEventDto e, EventTime time,
        ActivationOutcome? outcome, CancellationToken ct)
    {
        var (db, tenant, _, _, _, _) = services;

        var receipt = new DeviceEventReceipt
        {
            TenantId = tenant.TenantId,
            DeviceId = device.Id,
            Seq = e.Seq,
            Kind = e.Kind.Length > 32 ? e.Kind[..32] : e.Kind,
            OccurredAt = time.OccurredAt,

            // The relay and the booking are on the receipt so a later `release` — which
            // names neither — can find the session it belongs to. See ReleaseOutcomeAsync
            // and docs/specs/settlement-model.md §4. -1 is the wire's "no court".
            Court = e.Court is >= 0 ? e.Court : null,
            BookingId = outcome?.BookingId,
        };
        db.DeviceEventReceipts.Add(receipt);

        var details = new
        {
            device_id = device.Id,
            device_code = device.DeviceCode,
            seq = e.Seq,
            kind = e.Kind,
            court = e.Court,
            method = e.Method,
            subject = e.Subject,
            duration_ms = e.DurationMs,
            occurred_at = time.OccurredAt,
            occurred_at_clamped_from = time.ClampedFrom,
            outcome = outcome?.Code,
            booking_id = outcome?.BookingId,
            related_booking_id = outcome?.RelatedBookingId,
        };
        var detailsJson = System.Text.Json.JsonSerializer.Serialize(details);

        var rows = new List<AuditLog>(3)
        {
            new() { TenantId = tenant.TenantId, ActorUserId = Guid.Empty, Action = $"device.{e.Kind}", DetailsJson = detailsJson },
        };
        if (outcome is not null && outcome.Code != ActivationOutcome.Ok)
        {
            rows.Add(new() { TenantId = tenant.TenantId, ActorUserId = Guid.Empty, Action = $"device.{outcome.Kind}_{outcome.Code}", DetailsJson = detailsJson });
        }
        if (time.ClampedFrom is not null)
        {
            // The box's uptime counter cannot be believed; the desk needs to know before
            // the next event from it, not after.
            rows.Add(new() { TenantId = tenant.TenantId, ActorUserId = Guid.Empty, Action = "device.event_time_clamped", DetailsJson = detailsJson });
        }
        db.AuditLogs.AddRange(rows);

        try
        {
            await db.SaveChangesAsync(ct);
            return true;
        }
        catch (DbUpdateException ex) when (IsDuplicateReceipt(ex))
        {
            // Forget the refused rows, or the next save on this context would offer them
            // again against the same index.
            db.Entry(receipt).State = EntityState.Detached;
            foreach (var row in rows) db.Entry(row).State = EntityState.Detached;
            return false;
        }
    }

    /// <summary>
    /// The unique index on (tenant, device, seq) refusing a concurrent duplicate, as distinct
    /// from any other reason a save can fail.
    /// </summary>
    private static bool IsDuplicateReceipt(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == "23505";

    /// <summary>
    /// A member buying court time at the box, right now.
    ///
    /// <para>
    /// <b>This is the one court-box operation that needs the network</b>, and deliberately so.
    /// A walk-up is truncated at the next booking and charged pro rata; the box knows neither
    /// the tariff nor the next booking, and guessing at either sells a member something the
    /// club did not agree to. Refusing to sell new time is a member at the desk — refusing a
    /// booking they already paid for is a member in the dark, and that path is
    /// <c>/activate</c>.
    /// </para>
    ///
    /// <para>
    /// The identification token is passed through and verified <i>here</i>, which is what lets
    /// a 60-second signed QR work at all: it cannot be pre-cached on the box by construction.
    /// </para>
    ///
    /// <para>
    /// <b>The court comes from the request</b>, validated against the box's court list
    /// (review C5). A box drives four relays and the member pressed one of four buttons; the
    /// old contract carried no court at all, so the backend booked and charged the box's one
    /// configured court while the firmware lit whichever relay was pressed — ledger and
    /// lights diverged on three courts out of four.
    /// </para>
    ///
    /// <para>
    /// <b>The nonce makes a retry safe</b> (review H3). Booking, debit and check-in all
    /// commit before the 200 is written, and the box sends <c>!ON</c> only on a 200 it
    /// actually read; a lost response used to leave the member charged, the court dark, and
    /// every retry answered "court in use" by their own fresh booking. The box now mints a
    /// nonce per purchase and sends the same one on every retry; the reference
    /// <c>walkup:{device}:{nonce}</c> is looked up first and, when found, the original grant
    /// comes back with <c>replayed: true</c>.
    /// </para>
    /// </summary>
    private static async Task<IResult> WalkUpAsync(
        WalkUpRequest req,
        [AsParameters] WalkUpServices services,
        CancellationToken ct)
    {
        var (device, refusal) = await DeviceIdentity.ResolveAsync(services.Db, req.Mac, ct);
        if (refusal is not null) return refusal;

        return await WalkUpForDeviceAsync(device!, req, services, ct);
    }

    /// <summary>Longest purchase nonce accepted. The firmware sends sixteen hex characters.</summary>
    public const int MaxNonceLength = 32;

    /// <summary>The ledger reference under which one purchase from one box is posted, retries included.</summary>
    public static string WalkUpReference(Guid deviceId, string nonce) => $"walkup:{deviceId:N}:{nonce}";

    /// <summary>
    /// The walk-up decision for an already-authenticated box. Public, and separate from the
    /// HTTP handler, so the decision can be driven directly by a test that does not want to
    /// sign requests — the money and court semantics live here, the wire lives above.
    /// </summary>
    public static async Task<IResult> WalkUpForDeviceAsync(
        Device device, WalkUpRequest req, WalkUpServices services, CancellationToken ct)
    {
        var (db, bookings, activation, identities, settingsAccessor, _) = services;

        if (RefuseNonce(req) is { } badNonce) return badNonce;
        var reference = WalkUpReference(device.Id, req.Nonce!);

        // Replay before anything else, including validation: the fields of a retried
        // request already passed once, and the only question is whether this purchase
        // has already been made.
        if (await ReplayAsync(reference, req, services, ct) is { } replayed) return replayed;

        var settings = await settingsAccessor.GetAsync(ct);
        if (RefuseFields(device, req, settings) is { } badRequest) return badRequest;

        var court = await db.Courts.FirstOrDefaultAsync(c => c.CourtNumber == req.Court && c.IsActive, ct);
        if (court is null) return Results.NotFound(new { error = "court_not_found" });

        var userId = await identities.ResolveAsync(req.Method, req.Token, ct);
        if (userId is null) return Results.BadRequest(new { error = "not_recognised" });

        var created = await bookings.CreateWalkUpAsync(court.Id, userId.Value, userId.Value, req.Minutes, reference, ct);

        // Two retries in flight together: the replay check above found nothing because the
        // other attempt had not committed yet, and the database refused this one — on the
        // reference's unique index, or on the slot the other attempt has just taken. Either
        // way the purchase exists now, so re-read it and answer with it.
        if (created is BookingResult.DuplicateRequest or BookingResult.SlotTaken
            && await ReplayAsync(reference, req, services, ct) is { } original)
        {
            return original;
        }

        if (created is not BookingResult.Ok ok) return Refusal(created);

        // Straight into the one activation path, so attendance, the audit row and
        // booking.lights_on all come from the place that is allowed to produce them.
        var activated = await ActivateOnceAsync(db, activation,
            new ActivationTarget(court, ok.Booking, userId.Value, req.Method ?? "qr", OccurredAt: null, DurationMs: 0), ct);
        if (activated is not ActivationResult.Activated live)
        {
            return Results.Conflict(new { error = "activation_refused" });
        }

        return Results.Ok(Grant(ok.Booking, live.AmountCredits, ok.BalanceAfterCredits, replayed: false));
    }

    /// <summary>
    /// Who is activating what, how and when — the arguments <see cref="ActivateOnceAsync"/>
    /// retries with. <c>OccurredAt</c> is null for a walk-up happening now and the scan's
    /// own time for an uploaded event; <c>DurationMs</c> is how long the box's relay ran
    /// for an uploaded event, zero for a walk-up.
    /// </summary>
    private sealed record ActivationTarget(Court Court, Booking Booking, Guid UserId, string Method, DateTimeOffset? OccurredAt, long DurationMs);

    /// <summary>
    /// Activation that survives its twin. Two retries of one purchase — or two uploads of
    /// one event batch — can reach this from both sides, and whichever stamps
    /// <c>CheckedInAt</c> second finds the concurrency token moved under it. That is not a
    /// failure: the row was stamped, by the other attempt. Re-read it and go again, and the
    /// second pass sees a live session and is the idempotent no-op it is meant to be.
    /// </summary>
    private static async Task<ActivationResult> ActivateOnceAsync(
        MainframeDbContext db, CourtActivationService activation, ActivationTarget t, CancellationToken ct)
    {
        var request = new ActivationRequest(t.Court, t.Booking, t.UserId, null, t.Method, t.OccurredAt);
        try
        {
            return await activation.ActivateAsync(request, ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            // The failed save leaves its audit row tracked as Added; forget it, or the next
            // save on this context would insert it against a stamp this request never made.
            foreach (var entry in db.ChangeTracker.Entries().Where(e => e.State == EntityState.Added).ToList())
            {
                entry.State = EntityState.Detached;
            }
            await db.Entry(t.Booking).ReloadAsync(ct);
            return await activation.ActivateAsync(request, ct);
        }
    }

    private static IResult? RefuseNonce(WalkUpRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Nonce)) return Results.BadRequest(new { error = "nonce_required" });
        if (req.Nonce.Length > MaxNonceLength) return Results.BadRequest(new { error = "nonce_too_long", max_length = MaxNonceLength });
        return null;
    }

    /// <summary>
    /// The request's own fields, checked against the box and the tenant. The minutes bound is
    /// the smaller of the club's walk-up cap and the relay's hard cap — it was a hardcoded
    /// 240 here, while the relay bank cuts the lights at ninety whatever it is told (review M1).
    /// </summary>
    private static IResult? RefuseFields(Device device, WalkUpRequest req, TenantSettingsView settings)
    {
        var maxMinutes = Math.Min(settings.WalkUpMaxMinutes, RelayHardCap.Minutes);
        if (req.Minutes < 1 || req.Minutes > maxMinutes)
        {
            return Results.BadRequest(new { error = "minutes_out_of_range", max_minutes = maxMinutes });
        }

        // The court must be one this box drives. A box that could name any court is a box
        // that opens any court in the club; a box that cannot name one at all books the
        // wrong court for three buttons out of four.
        if (!device.CourtNumbers.Contains(req.Court))
        {
            return Results.BadRequest(new { error = "court_not_on_device", court = req.Court });
        }

        return null;
    }

    /// <summary>
    /// The original grant for a reference already on the ledger, or null if this purchase is
    /// new. Runs the booking through activation again on the way out: a first attempt that
    /// died between the charge and the check-in left the member charged and unstamped, and
    /// activation is idempotent on a live session, so this costs nothing when the first
    /// attempt got that far and repairs it when it did not.
    ///
    /// <para>
    /// <b>A replay grants the remainder, and nothing once the purchase is over</b> (review
    /// #20). The box reuses a nonce for as long as the same purchase stays undecided and
    /// a booking code is a stable token for the whole slot, so the same nonce can come
    /// back an hour later. Answering it with the ORIGINAL length lit the court for that
    /// long from now — over whoever held the next slots, unpaid. <c>granted_minutes</c>
    /// on a replay is what is left of the window; a purchase whose window has ended, or
    /// that is no longer <c>Booked</c>, is <c>409 purchase_ended</c>, and the box shows the
    /// member the desk.
    /// </para>
    /// </summary>
    private static async Task<IResult?> ReplayAsync(
        string reference, WalkUpRequest req, WalkUpServices services, CancellationToken ct)
    {
        var (db, _, activation, _, _, ledger) = services;

        var entry = await db.LedgerEntries.AsNoTracking()
            .FirstOrDefaultAsync(l => l.ExternalReference == reference, ct);
        if (entry?.RelatedBookingId is null) return null;

        var booking = await db.Bookings.FirstOrDefaultAsync(b => b.Id == entry.RelatedBookingId, ct);
        if (booking is null) return null;

        var now = DateTimeOffset.UtcNow;
        if (booking.Status != BookingStatus.Booked || booking.EndsAt <= now)
        {
            return Results.Conflict(new { error = "purchase_ended", booking_id = booking.Id, ended_at = booking.EndsAt });
        }

        var court = await db.Courts.FirstAsync(c => c.Id == booking.CourtId, ct);
        var activated = await ActivateOnceAsync(db, activation,
            new ActivationTarget(court, booking, entry.UserId, req.Method ?? "qr", OccurredAt: null, DurationMs: 0), ct);
        if (activated is not ActivationResult.Activated)
        {
            return Results.Conflict(new { error = "activation_refused" });
        }

        // The balance now rather than as it stood after the first attempt: the box shows
        // the member what they have, and a movement between the two attempts is real.
        var balance = await ledger.GetBalanceAsync(entry.UserId, ct);
        return Results.Ok(Grant(booking, -entry.AmountCredits, balance, replayed: true, now));
    }

    // Block bodies, not expression bodies, for the two members below. lizard's C# parser
    // mis-scopes an expression-bodied member containing braces and emits a *global*
    // pseudo-function whose reported length is the whole file — see memory/gotchas.md.
    private static object Grant(Booking booking, decimal amountCredits, decimal balanceAfterCredits, bool replayed, DateTimeOffset? now = null)
    {
        // A fresh purchase is granted what was sold; a replay what is left of it, rounded
        // up so a member is not cut off ahead of the window they paid for.
        var sold = (int)(booking.EndsAt - booking.StartsAt).TotalMinutes;
        var granted = replayed
            ? Math.Clamp((int)Math.Ceiling((booking.EndsAt - (now ?? DateTimeOffset.UtcNow)).TotalMinutes), 0, sold)
            : sold;
        return new
        {
            booking_id = booking.Id,
            granted_minutes = granted,
            amount_credits = amountCredits,
            balance_after_credits = balanceAfterCredits,
            replayed,
        };
    }

    private static IResult Refusal(BookingResult created)
    {
        return created switch
        {
            BookingResult.InsufficientBalance ib => Results.Json(new
            {
                error = "insufficient_balance",
                current_credits = ib.CurrentCredits,
                required_credits = ib.RequiredCredits,
            }, statusCode: StatusCodes.Status402PaymentRequired),

            // Distinct from slot_taken: the court is free and the next player is simply
            // imminent. A display saying "court busy" when nobody is on it sends the member
            // away for no reason.
            BookingResult.NoTimeAvailable => Results.Conflict(new { error = "no_time_available" }),

            BookingResult.SlotTaken => Results.Conflict(new { error = "court_in_use" }),

            _ => Results.BadRequest(new { error = "walk_up_refused" }),
        };
    }
}

/// <summary>
/// The services the walk-up handler needs, bundled.
///
/// <para>
/// Minimal APIs bind each of these individually, which reads fine and puts eight parameters
/// on one method — past the complexity gate's limit of six, and past the point where a
/// reader can see the shape of the handler at a glance. <c>[AsParameters]</c> keeps the
/// binding identical and the signature honest.
/// </para>
/// </summary>
public sealed record WalkUpServices(
    MainframeDbContext Db,
    BookingService Bookings,
    CourtActivationService Activation,
    IdentificationResolver Identities,
    TenantSettingsAccessor Settings,
    LedgerService Ledger);

/// <summary>
/// One activation as a box reported it, resolved: the court and booking the token named,
/// the member, how they identified, when the scan happened and how long the relay ran.
/// The argument of <see cref="DeviceEventEndpoints.ActivateOrReverseAsync"/>.
/// </summary>
public sealed record LateActivation(Court Court, Booking Booking, Guid UserId, string Method, DateTimeOffset OccurredAt, long DurationMs);

/// <summary>
/// The services the event upload needs, bundled — see <see cref="WalkUpServices"/>. The code
/// resolver and the activation path are what turn an activation event into attendance; the
/// booking service is what undoes a no-show the sweep settled before the evidence arrived.
/// </summary>
public sealed record DeviceEventServices(
    MainframeDbContext Db,
    ITenantContext Tenant,
    AccessCodeService Codes,
    CourtActivationService Activation,
    BookingService Bookings,
    TenantSettingsAccessor Settings);

/// <summary>
/// One event as the box queued it. Names mirror <c>lib/eventq</c>'s wire form. <c>court</c> is
/// the RELAY INDEX the box acted on (0–3, <c>eventq::Event::court</c>), not a court number:
/// the device's court list maps it.
/// </summary>
public sealed record DeviceEventDto(
    [property: JsonPropertyName("seq")] long Seq,
    [property: JsonPropertyName("uptime_ms")] long UptimeMs,
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("court")] int? Court,
    [property: JsonPropertyName("method")] string? Method,
    [property: JsonPropertyName("subject")] string? Subject,
    [property: JsonPropertyName("duration_ms")] long DurationMs);

/// <summary>
/// A batch, plus the box's uptime at the moment it sent them — which is what turns each
/// event's own uptime into "this happened N seconds ago".
/// </summary>
public sealed record DeviceEventBatch(
    [property: JsonPropertyName("mac")] string? Mac,
    [property: JsonPropertyName("uptime_ms")] long UptimeMs,
    [property: JsonPropertyName("events")] IReadOnlyList<DeviceEventDto>? Events);

/// <summary>
/// What a box asks for when somebody buys court time at it. <c>court</c> is the court
/// NUMBER the member selected, which must be one of the box's; <c>nonce</c> is the box's
/// per-purchase token, the same on every retry of the same purchase.
/// </summary>
public sealed record WalkUpRequest(
    [property: JsonPropertyName("mac")] string? Mac,
    [property: JsonPropertyName("minutes")] int Minutes,
    [property: JsonPropertyName("method")] string? Method,
    [property: JsonPropertyName("token")] string? Token,
    [property: JsonPropertyName("court")] int Court,
    [property: JsonPropertyName("nonce")] string? Nonce);
