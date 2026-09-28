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
/// network rather than an error. <c>(device_id, boot_id, seq)</c> is the key — see
/// <see cref="DeviceEventBatch"/> for why a boot identity is part of it — and the filtered unique
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

        // D10: paying for somebody else's court at the box (member-code §9). Online only, and
        // on this group because it moves money exactly as the walk-up does.
        g.MapPost("/pay-for", DevicePayForEndpoint.HandleAsync);
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
    /// The event kind a door gate queues when it opened a door from its cached roster —
    /// <c>eventq::Kind::GateOpen</c>.
    ///
    /// <para>
    /// <b>Queued for OFFLINE opens only.</b> An online open went through
    /// <c>POST /api/v1/device/gate</c>, which wrote its own audit row; queuing it again would
    /// put the same open in the trail twice with two different timestamps. So this kind is
    /// evidence of the one case the API could not see for itself.
    /// </para>
    ///
    /// <para>
    /// <b>It is never attendance and it never touches money.</b> Walking through a door is
    /// not playing a court — the member may be collecting a racquet, or coming in for
    /// somebody else's league night — so nothing here stamps <c>CheckedInAt</c>, reverses a
    /// no-show, charges lit time or writes a ledger row. That is not an omission to be
    /// tidied up later: a gate has no court to attribute any of it to.
    /// </para>
    /// </summary>
    public const string GateOpenKind = "gate_open";

    /// <summary>
    /// The event kind a gate queues when it refused a scan while offline — a token its cached
    /// roster did not carry. It names no member it could resolve, by construction.
    /// </summary>
    public const string UnknownScanKind = "unknown_scan";

    /// <summary>
    /// A board reporting something wrong with itself — GOAL item 7's device half.
    ///
    /// <para>
    /// <b>The seam already existed and terminated in a row nothing read.</b> <c>Kind::Fault</c>
    /// has been on the wire since the queue was written and fell through the dispatch switch to
    /// a <c>device.fault</c> audit row with a null outcome. So this is modelling and surfacing,
    /// not plumbing.
    /// </para>
    ///
    /// <para>
    /// <b>The existing fields are reused rather than extended</b>, and that is a constraint of
    /// the hardware rather than a shortcut: the event record is written to a fixed ring on a
    /// part with no allocator, and widening it costs RAM on both boards. So <c>subject</c>
    /// carries the fault CODE, <c>duration_ms</c> carries the COUNT since that code was last
    /// reported, and <c>court</c> carries the relay when the fault is about one (<c>-1</c>
    /// otherwise).
    /// </para>
    ///
    /// <para>
    /// <b>Aggregation is the rate limit.</b> The board counts a fault rather than queueing it
    /// and emits at most one event per code per window, so a link producing four hundred CRC
    /// errors a minute costs one event carrying the number 1200 rather than four hundred
    /// events. The receipt is still written, so a replayed batch cannot double-count — which is
    /// why the events queue is the right channel and the heartbeat is not.
    /// </para>
    /// </summary>
    public const string FaultKind = "fault";

    /// <summary>
    /// The board restarted. Emitted by both firmwares today and, until now, read by nothing.
    ///
    /// <para>
    /// Recorded at <c>Info</c>, which is not a downgrade: every board boots, so a boot is not a
    /// fault — but a board booting repeatedly is the clearest single signal of a failing power
    /// supply, and the error log's count column is what turns "it rebooted" into "it has
    /// rebooted forty times today".
    /// </para>
    /// </summary>
    public const string BootKind = "boot";

    /// <summary>
    /// Longest <c>kind</c> this endpoint will store. The receipt's column, and — through
    /// <see cref="AuditKind"/> — what bounds the audit row's <c>Action</c>.
    /// </summary>
    public const int MaxKindLength = 32;

    /// <summary>
    /// The outcome for an event whose <c>kind</c> is missing, empty, or longer than
    /// <see cref="MaxKindLength"/>.
    ///
    /// <para>
    /// <b>It is an outcome and not a 4xx, which is the entire fix.</b> A JSON null in
    /// <c>kind</c> dereferenced straight into <c>e.Kind.Length</c> and answered 500; a kind of
    /// 200 characters overflowed <c>AuditLog.Action</c> (128) and answered 500 from the save.
    /// Either one pinned the board's queue for ever: the firmware drains up to
    /// <c>accepted_through</c> and re-posts the rest, so one malformed event at the head of a
    /// ring stopped every event behind it from ever arriving — including the activations the
    /// no-show sweep is waiting on. A board cannot edit what it has already queued, so the
    /// only exit is a receipt.
    /// </para>
    /// </summary>
    public const string Malformed = "malformed";

    /// <summary>
    /// What a COURT BOX's unrecognised scan is filed as, so it never enters the door
    /// vocabulary — D2-B27.
    ///
    /// <para>
    /// <c>unknown_scan</c> is a real thing for a court box to emit: somebody held a code up to
    /// the scanner at a court and the box did not recognise it. But the action
    /// <c>device.unknown_scan</c> is one of the three that <c>DoorTrail</c> matches by
    /// EQUALITY as a door refusal, and the door log filters on "is a scan row" with no
    /// device-kind predicate at all. So a court box uploading one put a <b>refused door
    /// scan at a court box</b> into the club's door activity, counted in its per-day door
    /// totals — and the night trace would have inherited it.
    /// </para>
    ///
    /// <para>
    /// <b>Separated at INGEST rather than filtered at the door log</b>, which is the same
    /// remedy <c>gate_open when device.Kind != Gate</c> already applies one case above: the
    /// door log's query is a keyset read over an append-only table, and excluding a court
    /// box's rows there would mean joining to <c>devices</c> on every page. Filing it under
    /// its own action means the four readers of the door vocabulary are correct by
    /// construction and none of them needs to know this case exists.
    /// </para>
    ///
    /// <para>
    /// The event is still receipted, still audited and still acknowledged — nothing about the
    /// box's queue drain changes. Only the name it is filed under does.
    /// </para>
    /// </summary>
    public const string CourtUnknownScanKind = "court_unknown_scan";

    /// <summary>
    /// The kind as it will be STORED, which for one case is not the kind the board sent.
    ///
    /// <para>
    /// A court box's <c>unknown_scan</c> becomes <see cref="CourtUnknownScanKind"/> — see
    /// there for why the separation happens here and not in the door log's query. Every other
    /// kind is stored exactly as it arrived.
    /// </para>
    /// </summary>
    private static string KindFor(string kind, Device device)
        => kind == UnknownScanKind && device.Kind != DeviceKind.Gate ? CourtUnknownScanKind : kind;

    /// <summary>Whether this <c>kind</c> is one this endpoint can store at all.</summary>
    private static bool Unusable(string? kind) =>
        string.IsNullOrWhiteSpace(kind) || kind.Trim().Length > MaxKindLength;

    /// <summary>
    /// The <c>kind</c> as it is safe to write AND as every decision below reads it: trimmed,
    /// ordinal lower-cased, <c>unknown</c> when there was none, and cut to
    /// <see cref="MaxKindLength"/>.
    ///
    /// <para>
    /// <b>Normalising ONCE, at the top, is the fix — not the lower-casing on its own.</b> This
    /// method already trimmed, and the audit action and the receipt were written from it; the
    /// dispatch switch, the kind guards and the fingerprint were written from
    /// <c>e.Kind</c> RAW. Two readings of one field on one request is a gap, and it was a
    /// credential-sized one: <c>" gate_open "</c> stored and audited as <c>device.gate_open</c>
    /// — indistinguishable in the trail from an honest event — while
    /// <c>e.Kind is not (GateOpenKind or UnknownScanKind)</c> was false for it, so the subject
    /// guard fell through and wrote the live access code into <c>DetailsJson</c> in full. One
    /// space, added by anything holding the club key, undid the whole of G2's B4.
    /// </para>
    ///
    /// <para>
    /// The same spelling stepped around <c>GateOpenKind when device.Kind != Gate</c>, so a
    /// COURT BOX could post a door open and skip the <c>not_a_gate</c> refusal that exists
    /// to stop a false record of who was in the building.
    /// </para>
    ///
    /// <para>
    /// <b>Ordinal, and not the current culture.</b> <c>ToLower()</c> on a Turkish locale maps
    /// <c>I</c> to a dotless <c>ı</c>, so a server's regional settings would decide whether a
    /// board's events were recognised — the class of bug that is invisible everywhere it is
    /// developed.
    /// </para>
    ///
    /// <para>
    /// A literal rather than an empty string for the missing case, because the audit action is
    /// <c>device.{kind}</c> and <c>device.</c> is a row nobody can search for. Cutting rather
    /// than refusing, because the row's value is that the event was received at all.
    /// </para>
    /// </summary>
    private static string AuditKind(string? kind)
    {
        var trimmed = kind?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(trimmed)) return "unknown";
        return trimmed.Length > MaxKindLength ? trimmed[..MaxKindLength] : trimmed;
    }

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
        if (refusal is not null)
        {
            // A board this club has not registered, on a route that does not auto-register.
            // Worth a row: it is how a club finds out a box was re-flashed, swapped, or is
            // pointed at the wrong club. Folded by code, because the MAC is the caller's.
            services.Faults.UnregisteredMac(batch.Mac);
            return refusal;
        }

        var events = (batch.Events ?? []).Take(MaxBatch).ToList();

        // LIVENESS BEFORE THE DECISION, ON EVERY BRANCH — including the ones that throw.
        //
        // This used to be recorded once, after the whole loop, while /activate, /gate and
        // /walkup all record it up front on every branch including their refusals. /events is
        // the route most able to throw: the receipt write rethrows anything that is not a
        // duplicate, and the settlement can exhaust its retries. So a box talking to the API
        // every minute and failing on one poisoned event was declared OFFLINE — every admin
        // mailed "court box not reporting", and the outage index started waiving no-show
        // penalties on those courts. The control board would have painted that box red while
        // it was plainly working, and the error log would have been its only contradicting
        // evidence.
        var uploadSettings = await services.Settings.GetAsync(ct);
        DeviceSilenceLog.NoteHeartbeat(
            services.Db, device!, DateTimeOffset.UtcNow,
            HeartbeatCadence.OfflineAfterSeconds(uploadSettings.HeartbeatSeconds));
        await services.Db.SaveChangesAsync(ct);

        if (events.Count == 0) return Results.Ok(new { accepted_through = 0L, recorded = 0 });

        // The box has no RTC, so an event carries its uptime and the batch carries the
        // box's uptime now. The difference is how long ago it happened; the server clock is
        // the only one anybody can be held to.
        var now = DateTimeOffset.UtcNow;
        long acceptedThrough = 0;
        var recorded = 0;

        // WITHIN THIS BOOT. See DeviceEventBatch.BootId: a board that renumbered from 1
        // after a torn checkpoint is a different boot rather than a retry, and reading its
        // whole evening as duplicates is what this field exists to stop.
        var alreadyRecorded = await SeenAsync(services.Db, device!, events, batch.BootId, ct);

        // A board whose sequence numbers went BACKWARDS inside one boot. Within a boot the
        // sequence is monotonic by construction and the receipt index depends on it, so a
        // board that renumbers without declaring a new boot has its events silently discarded
        // as duplicates — a hole in the evening's record that nothing else reports. A board
        // that genuinely restarted says so with a new boot id and never lands here.
        await NoteSeqRegressionAsync(services, device!, events, batch.BootId, ct);

        foreach (var e in events.OrderBy(e => e.Seq))
        {
            // A retry of something already taken is acknowledged, not re-recorded — which
            // is what lets the box release it and move on.
            if (!alreadyRecorded.Contains(e.Seq))
            {
                var time = TimeOf(batch, e, now) with
                {
                    Kind = KindFor(AuditKind(e.Kind), device!),
                    BootId = batch.BootId,
                };

                // EVERY decision below reads the normalised kind, never e.Kind. See AuditKind:
                // two readings of one field on one request is what let one space around
                // "gate_open" both defeat the not_a_gate guard and put a live access code in
                // the audit trail.
                var kind = time.Kind;

                // Attendance BEFORE the receipt. See the summary for why this order.
                var outcome = Unusable(e.Kind) ? new ActivationOutcome(Malformed, null, kind) : kind switch
                {
                    // A door reporting a court event. Refused explicitly rather than left to
                    // fail the relay-index check against an empty court list — see
                    // GateAccess.NotACourtBox for why an accidental refusal is not one.
                    // Recorded and acknowledged like every other outcome, never 4xx: an
                    // event the board cannot change is a board retrying for ever.
                    ActivationKind or ReleaseKind when device!.Kind != DeviceKind.CourtBox
                        => new ActivationOutcome(GateAccess.NotACourtBox, null, kind),

                    // And the mirror: a court box reporting a door it does not have. Guarded
                    // for the same reason the two above are and not because anything settles
                    // — nothing does — but because the row this writes NAMES A MEMBER. Left
                    // ungated, any holder of the club key with a box's MAC could post an
                    // access code and have the trail record that person opening a door that
                    // does not exist, which is a worse lie than a refusal.
                    GateOpenKind when device!.Kind != DeviceKind.Gate
                        => new ActivationOutcome(GateAccess.NotAGate, null, GateOpenKind),

                    ActivationKind => await ActivationOutcomeAsync(device!, e, time, services, ct),
                    ReleaseKind => await ReleaseOutcomeAsync(device!, e, time.OccurredAt, services, ct),
                    GateOpenKind => await GateOpenOutcomeAsync(device!, e, time, services, ct),

                    // Both of these used to fall through to `_ => null` and land as an audit
                    // row with a null outcome that nothing read. They keep that row — the
                    // trail is where "the box restarted" belongs — and now also reach the
                    // club's monitoring page, which is the surface an admin can act from.
                    FaultKind or BootKind => FaultOutcome(kind),

                    _ => null,
                };

                if (await RecordAsync(services, device!, e, time, outcome, ct))
                {
                    recorded++;

                    // Reported only for an event that was actually RECEIPTED. A duplicate
                    // upload of one batch would otherwise inflate a fault's count by however
                    // many times the box retried, which is the opposite of what a count on a
                    // monitoring page is for.
                    if (kind is FaultKind or BootKind) NoteFault(services, device!, e, kind, time.OccurredAt);

                    NoteServerDetected(services, device!, time, outcome);
                }

                // THE SIDE EFFECT HAS RUN; the batch must not run it again. `alreadyRecorded`
                // was snapshotted once before the loop and never updated inside it, so two
                // events in one batch sharing a seq BOTH passed this gate: the second ran its
                // full settlement — moving money — and only then lost the unique index, which
                // detached its receipt and its audit rows while the settlement's own save had
                // already committed. Money moved with no receipt and no audit row, and
                // `accepted_through` told the box to drop both.
                alreadyRecorded.Add(e.Seq);
            }

            acceptedThrough = e.Seq;
        }

        // Recorded AGAIN, at the end, with a fresh instant.
        //
        // The one above is the liveness signal and runs before anything can throw. This one
        // keeps `last_seen_at` at or after every row this call wrote: `now` is taken before
        // the batch is recorded and is the clock every uploaded event's arithmetic is clamped
        // against, but the audit rows are created DURING the loop, so their CreatedAt — the
        // delivery instant on the wire — is later than `now` by however long the batch took.
        // That put `last_seen_at` a millisecond BEFORE the `delivered_at` of a row the same
        // request had just delivered, which is the product saying it had not yet heard from a
        // board that was at that moment talking to it.
        DeviceSilenceLog.NoteHeartbeat(
            services.Db, device!, DateTimeOffset.UtcNow,
            HeartbeatCadence.OfflineAfterSeconds(uploadSettings.HeartbeatSeconds));
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
    /// What the server could establish about one uploaded event before deciding anything:
    /// when it happened, whether the box's arithmetic had to be overruled to say so, and the
    /// kind as it is safe to store. <see cref="ClampedFrom"/> is null for an ordinary event.
    ///
    /// <para>
    /// <see cref="Kind"/> is here rather than a seventh parameter on <c>RecordAsync</c>, which
    /// is where the complexity gate caps a signature — and the right pressure, because the
    /// three of these are one question. An init property rather than a positional parameter
    /// so <see cref="TimeOf"/>, which answers only the first two, is not asked to invent the
    /// third.
    /// </para>
    /// </summary>
    private sealed record EventFacts(DateTimeOffset OccurredAt, DateTimeOffset? ClampedFrom)
    {
        /// <summary>The event's <c>kind</c>, trimmed, bounded and never empty — see <see cref="AuditKind"/>.</summary>
        public string Kind { get; init; } = "unknown";

        /// <summary>
        /// Which BOOT of the board this event belongs to — see <see cref="DeviceEventBatch"/>.
        ///
        /// <para>
        /// Here for exactly the reason <see cref="Kind"/> is: <c>RecordAsync</c> is at the
        /// complexity gate's six-parameter cap, and these are facts established about the
        /// event before anything is decided rather than arguments a caller chooses. It comes
        /// off the BATCH, not the event, because a board holds one boot's events at a time.
        /// </para>
        /// </summary>
        public long BootId { get; init; }
    }

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
    private static EventFacts TimeOf(DeviceEventBatch batch, DeviceEventDto e, DateTimeOffset now)
    {
        var claimed = now.AddMilliseconds(-(double)(batch.UptimeMs - e.UptimeMs));
        return claimed > now || now - claimed > MaxEventAge
            ? new EventFacts(now, claimed)
            : new EventFacts(claimed, null);
    }

    /// <summary>
    /// Which of the offered sequence numbers this box has already had receipted. One read
    /// for the whole batch rather than one per event: a box back from a week offline arrives
    /// with a full ring, and 32 round trips to answer "seen this?" is 32 round trips.
    /// </summary>
    private static async Task<HashSet<long>> SeenAsync(
        MainframeDbContext db, Device device, List<DeviceEventDto> events, long bootId,
        CancellationToken ct)
    {
        var offered = events.Select(e => e.Seq).ToList();
        var seen = await db.DeviceEventReceipts
            .Where(r => r.DeviceId == device.Id && r.BootId == bootId && offered.Contains(r.Seq))
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
        string Code, Guid? BookingId, string Kind = ActivationKind, Guid? RelatedBookingId = null,
        Guid? SubjectUserId = null, AdminNotice? Notice = null)
    {
        /// <summary>
        /// A v1 code the board accepted offline that the server cannot reproduce, or one used
        /// twice (member-code §7). Receipted — evidence is never refused — and NOT attendance.
        /// </summary>
        public const string ForgerySuspected = "forgery_suspected";

        /// <summary>
        /// A v1 code on an event whose time had to be clamped (a broken uptime counter): the step
        /// it was shown at is unknown, so it can be neither verified nor called forged.
        /// Receipted, audited, not attendance, and no forgery alarm.
        /// </summary>
        public const string Unverifiable = "unverifiable";

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
    ///
    /// <para>
    /// <b>A barred membership is deliberately NOT a refusal here</b>, unlike on
    /// <c>/walkup</c> and <c>/activate</c> (finding K-F1). Those two are the API deciding
    /// whether lights come on; this is a report that they already did. The roster excludes a
    /// barred member from every push, so the only way one reaches this handler is a box that
    /// admitted them from a cache fetched before the club's decision — the member is on the
    /// court and the relay has run. Refusing the attendance would not unlight anything; it
    /// would make them a no-show, refund the court they played and charge the club a penalty
    /// waiver. Recording it keeps the money matching the lights, which is the settlement
    /// model's rule everywhere else too.
    /// </para>
    /// </summary>
    private static async Task<ActivationOutcome> ActivationOutcomeAsync(
        Device device, DeviceEventDto e, EventFacts time, DeviceEventServices services, CancellationToken ct)
    {
        var db = services.Db;
        var occurredAt = time.OccurredAt;

        var (found, userId, refusal) = await EvidenceBookingAsync(device, e, time, services, ct);
        if (refusal is not null) return refusal;
        var booking = found!;

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

        var target = new ActivationTarget(court, booking, userId, e.Method ?? "offline", occurredAt, e.DurationMs);
        var settled = await SettleAsync(services, target, ct);

        // The server's belief about this court's relay.
        //
        // ONLY the reversal branch is written here. Every other settled success reaches
        // CourtActivationService.ActivateAsync, which writes the projection itself — that is
        // the one place attendance is stamped, so it is the one place the belief can be moved
        // for the online scan, the walk-up and the kiosk alike. Writing it here as well would
        // put two `court.lights_on` rows in the night trace for one scan. A reversal does NOT
        // go through that method — it undoes a settled no-show through the booking service —
        // so without this line a member whose late upload rescued their evening would light a
        // court the control board still showed as dark.
        if (settled.Code == ActivationOutcome.ReversedNoShow)
        {
            await NoteLightsOnAsync(
                services,
                new LightEvidence(court.Id, device.Id, e.Court, e.Seq, BootId: 0, At: occurredAt),
                booking, court, userId, ct);
        }
        else if (settled.Code == ActivationOutcome.Ok)
        {
            // The relay and the sequence number, which ActivateAsync cannot know. Diagnosis
            // only — the row is keyed on the court — but it is what lets an admin see that a
            // box lit relay C for a court-1 booking.
            await NoteRelayAsync(services, court.Id, device.Id, e.Court, ct);
        }

        return new ActivationOutcome(settled.Code, booking.Id, ActivationKind, settled.RelatedBookingId);
    }

    /// <summary>
    /// The booking an activation event is evidence for, and whose attendance it is — or the
    /// outcome that refuses it. Lifted out of <see cref="ActivationOutcomeAsync"/> for the
    /// complexity gate.
    /// </summary>
    private static async Task<(Booking? Booking, Guid UserId, ActivationOutcome? Refusal)> EvidenceBookingAsync(
        Device device, DeviceEventDto e, EventFacts time, DeviceEventServices services, CancellationToken ct)
    {
        var (db, _, codes, _, _, _, _, _, _, _, _, _) = services;
        var occurredAt = time.OccurredAt;

        // A v1 member code: the subject is the SCANNED token, re-checked with ON before it is
        // allowed to be anybody's attendance (member-code §7), and the booking is found by
        // member, relay and time because the token names no booking.
        if (MemberCodeMath.IsV1Shaped(e.Subject?.Trim()))
        {
            var v1 = await V1EvidenceAsync(device, e, time, MemberCodeUseClass.Court, "activation_event", services, ct);
            if (v1.Refusal is not null) return (null, Guid.Empty, v1.Refusal);

            if (e.Court is not { } r || r < 0 || r >= device.CourtNumbers.Count) return (null, Guid.Empty, new ActivationOutcome("wrong_court", null));
            var onCourt = await db.Courts.FirstOrDefaultAsync(c => c.CourtNumber == device.CourtNumbers[r], ct);
            var found = onCourt is null
                ? null
                : await services.Activation.FindForEvidenceAsync(onCourt.Id, v1.UserId, occurredAt, services.Players, ct);
            return found is null
                ? (null, Guid.Empty, new ActivationOutcome("unresolved", null, SubjectUserId: v1.UserId))
                : (found, v1.UserId, null);
        }

        // Live at the scan, not at the upload: the roster token expires at the slot's end
        // plus grace, and a box offline past that is precisely the box whose evidence
        // matters most. Past the club's cut-off a legacy code is nobody (§8): judged at the
        // scan too, so a roster fetched before the cut-off still reports honestly.
        var resolved = MemberCodeSettings.LegacyAcceptedAt(await services.Settings.GetAsync(ct), occurredAt)
            ? await codes.ResolveAsync(e.Subject, occurredAt, ct)
            : null;
        if (resolved is null || resolved.Purpose != AccessCodePurpose.BookingActivation || resolved.BookingId is null)
        {
            return (null, Guid.Empty, new ActivationOutcome("unresolved", null));
        }

        var booking = await db.Bookings.FirstOrDefaultAsync(b => b.Id == resolved.BookingId, ct);
        return booking is null
            ? (null, Guid.Empty, new ActivationOutcome("unresolved", null))
            : (booking, resolved.UserId, null);
    }

    /// <summary>Stamps which relay a box used on a court whose belief another path has already moved.</summary>
    private static async Task NoteRelayAsync(
        DeviceEventServices services, Guid courtId, Guid deviceId, int? relay, CancellationToken ct)
    {
        await services.Lights.NoteRelayAsync(courtId, deviceId, relay, ct);
    }

    /// <summary>
    /// Records that a court's lights are believed on, and says so in the club's history.
    ///
    /// <para>
    /// <c>OnUntil</c> is the SOLD end rather than the granted seconds: the grant is clamped by
    /// the relay's ninety-minute cap and a member with a two-hour booking is re-lit past it,
    /// so a countdown to the cap would tell the control board the court frees at 19:30 when it
    /// frees at 20:00 — and an admin would sell the slot twice.
    /// </para>
    /// </summary>
    private static async Task NoteLightsOnAsync(
        DeviceEventServices services, LightEvidence evidence, Booking booking, Court court,
        Guid userId, CancellationToken ct)
    {
        var row = await services.Lights.RecordOnAsync(
            evidence, BookingService.OriginalEndsAt(booking),
            booking.UserId is null ? LightCause.WalkUp : LightCause.Member,
            userId, booking.Id, ct);
        if (row is null) return;

        services.Lights.Audit(
            CourtLightStateService.LightsOnAction, court.Id, court.CourtNumber, booking.UserId,
            new
            {
                device_id = evidence.DeviceId,
                relay = evidence.Relay,
                booking_id = booking.Id,
                seq = evidence.Seq,
            });
    }

    /// <summary>
    /// Files a fault when this batch offers a sequence number below one already receipted for
    /// the same board and the same boot. One query, and only when the batch could regress.
    /// </summary>
    private static async Task NoteSeqRegressionAsync(
        DeviceEventServices services, Device device, List<DeviceEventDto> events, long bootId,
        CancellationToken ct)
    {
        var lowest = events.Min(e => e.Seq);
        var highest = await services.Db.DeviceEventReceipts.AsNoTracking()
            .Where(r => r.DeviceId == device.Id && r.BootId == bootId)
            .Select(r => (long?)r.Seq)
            .MaxAsync(ct);

        if (highest is { } seen && lowest < seen)
        {
            services.Faults.SeqRegression(device, bootId, lowest, seen);
        }
    }

    /// <summary>
    /// What the SERVER noticed about this event, onto the club's error log — the second half
    /// of GOAL item 7.
    ///
    /// <para>
    /// <b>The board did not report any of these; the server decided them.</b> A clamped clock,
    /// a relay wired to a court the event did not name, a body that could not be read, a
    /// refusal of any other kind — each is a fact about the estate that only this side knows,
    /// and each used to exist only as an audit row in a trail nobody reads for board health.
    /// </para>
    ///
    /// <para>
    /// <c>clock_clamped</c> is recorded here <b>as well as</b> the existing
    /// <c>device.event_time_clamped</c> audit row, and that duplication is deliberate: the
    /// audit row is the DOORS TRAIL, read by the doors console and pinned by its own posture
    /// test, and this row is the MONITORING view. Unifying them would either put board health
    /// into the door log — the defect <c>DoorAuditActions</c> is named after — or make the
    /// error log depend on the door vocabulary. Written down so the next reader does not
    /// "fix" it.
    /// </para>
    /// </summary>
    private static void NoteServerDetected(
        DeviceEventServices services, Device device, EventFacts time, ActivationOutcome? outcome)
    {
        if (time.ClampedFrom is { } claimed)
        {
            Note(services, device, DeviceErrorCodes.ClockClamped, $"claimed {claimed:O}", time.OccurredAt);
        }

        var code = outcome?.Code;
        if (code is null or ActivationOutcome.Ok or ActivationOutcome.ReversedNoShow) return;

        // A relay the box lit that is not wired to the booking's court is its own fault: the
        // member is standing on the wrong court, which no other refusal means.
        var mapped = code == "wrong_court"
            ? DeviceErrorCodes.CourtNotMapped
            : code == Malformed ? DeviceErrorCodes.MalformedBody : DeviceErrorCodes.EventRejected;

        Note(services, device, mapped, $"{time.Kind}: {code}", time.OccurredAt);
    }

    /// <summary>One server-detected fault, off the request thread. See <see cref="DeviceErrorService.InBackground"/>.</summary>
    private static void Note(
        DeviceEventServices services, Device device, string code, string detail, DateTimeOffset at)
    {
        DeviceErrorService.InBackground(
            services.Scopes, services.Logs.CreateLogger(typeof(DeviceEventEndpoints)),
            device.TenantId, services.Tenant.TenantSlug,
            new DeviceErrorReport(
                code, DeviceErrorSource.Server, DeviceId: device.Id,
                ClaimedDeviceCode: device.DeviceCode, Detail: detail, At: at));
    }

    /// <summary>
    /// The outcome for a <c>fault</c> or <c>boot</c> event: <c>ok</c>, so the existing audit
    /// row keeps its shape and no second <c>device.fault_&lt;code&gt;</c> row is written.
    ///
    /// <para>
    /// A board reporting a fault has not failed at reporting it, and a non-ok outcome here
    /// would put a second row in the door trail for every diagnostic a board sends. The
    /// fault's own record lives in <c>device_errors</c>, which is a health STATE rather than a
    /// list to scroll — the distinction item 7 is actually asking for.
    /// </para>
    /// </summary>
    private static ActivationOutcome FaultOutcome(string kind)
    {
        return new ActivationOutcome(ActivationOutcome.Ok, BookingId: null, Kind: kind);
    }

    /// <summary>
    /// One reported fault onto the club's error log.
    ///
    /// <para>
    /// Off the request thread, for the reason every device-facing write to that table is: this
    /// runs on the path a box drains its queue down, and an error log that can fail a device
    /// upload converts a scanner fault into a lost activation. A monitoring feature that makes
    /// the hardware less reliable in order to report on its reliability is not worth having.
    /// </para>
    ///
    /// <para>
    /// A <c>boot</c> event carries no code of its own, so it is recorded under the
    /// <c>boot</c> code with the board's uptime as its detail. The digit-collapsing in the
    /// fingerprint is what keeps that one row rather than one per restart.
    /// </para>
    /// </summary>
    private static void NoteFault(
        DeviceEventServices services, Device device, DeviceEventDto e, string kind, DateTimeOffset at)
    {
        var code = kind == BootKind ? DeviceErrorCodes.Boot : e.Subject;

        // duration_ms carries the COUNT since this code was last reported — see FaultKind.
        // Clamped rather than believed: a board with a wild counter is still reporting
        // something real, and refusing the row would lose it.
        var count = (int)Math.Clamp(e.DurationMs, 1, DeviceErrorService.MaxReportedCount);

        DeviceErrorService.InBackground(
            services.Scopes, services.Logs.CreateLogger(typeof(DeviceEventEndpoints)),
            device.TenantId, services.Tenant.TenantSlug,
            new DeviceErrorReport(
                code, DeviceErrorSource.Device,
                DeviceId: device.Id,
                ClaimedDeviceCode: device.DeviceCode,
                Detail: kind == BootKind ? $"uptime_ms={e.UptimeMs}" : null,

                // -1 is the wire's "no court", and it must not become relay -1 on the row.
                Court: e.Court is >= 0 ? e.Court : null,
                Count: kind == BootKind ? 1 : count,
                At: at));
    }

    /// <summary>
    /// What a <c>gate_open</c> event becomes: a receipt, and an audit row naming whoever the
    /// code identified. Nothing else.
    ///
    /// <para>
    /// Resolved at <paramref name="occurredAt"/> rather than at the upload, for the reason
    /// <see cref="AccessCodeService.ResolveAsync(string?, DateTimeOffset, CancellationToken)"/>
    /// records: a code that was live when the member held it up identified them THEN, and
    /// judging it by the upload clock turns a member who walked in during an outage into a
    /// stranger. The subject is what makes the row worth keeping — "somebody opened the side
    /// door at 06:40" answers nothing anyone will ask.
    /// </para>
    ///
    /// <para>
    /// <b>The outcome code is always <c>ok</c>, including when the code resolved to nobody.</b>
    /// A non-ok code would write a second <c>device.gate_open_&lt;code&gt;</c> audit row, and
    /// there is nothing for a desk to do about an offline open whose token has since been
    /// pruned: the door opened, the member is inside, and no money turns on it. The single row
    /// records the open with whatever identity survived. This is the one place a gate's event
    /// handling is deliberately quieter than a court box's, and it is quieter because there is
    /// nothing at stake, not because nothing can go wrong.
    /// </para>
    ///
    /// <para>
    /// <c>BookingId</c> is left null even when the token was a booking-activation code, so a
    /// later <c>release</c> can never pair against this receipt: a door has no relay session
    /// to settle and pairing one would re-price a court from a doorway.
    /// </para>
    /// </summary>
    private static async Task<ActivationOutcome> GateOpenOutcomeAsync(
        Device device, DeviceEventDto e, EventFacts time, DeviceEventServices services, CancellationToken ct)
    {
        var occurredAt = time.OccurredAt;
        if (MemberCodeMath.IsV1Shaped(e.Subject?.Trim()))
        {
            var v1 = await V1EvidenceAsync(device, e, time, MemberCodeUseClass.Door, "gate_open_event", services, ct);
            return v1.Refusal ?? new ActivationOutcome(
                ActivationOutcome.Ok, BookingId: null, Kind: GateOpenKind, SubjectUserId: v1.UserId);
        }

        var resolved = MemberCodeSettings.LegacyAcceptedAt(await services.Settings.GetAsync(ct), occurredAt)
            ? await services.Codes.ResolveAsync(e.Subject, occurredAt, ct)
            : null;
        return new ActivationOutcome(
            ActivationOutcome.Ok, BookingId: null, Kind: GateOpenKind, SubjectUserId: resolved?.UserId);
    }

    /// <summary>What a v1 subject on an uploaded event proved: its member, or the outcome that refuses it.</summary>
    private sealed record V1Evidence(Guid UserId, ActivationOutcome? Refusal);

    /// <summary>
    /// The member-code evidence re-check (§7), shared by <c>activation</c> and <c>gate_open</c>.
    ///
    /// <para>
    /// A genuine offline use is recorded in the use table under its class — the same row an online
    /// use writes — and an already-taken row is the third kind of forgery: one code acted on twice
    /// for the same kind of thing, across devices. Every forgery is RECEIPTED, never refused (the
    /// board must be able to release its evidence), stages the non-optional
    /// <c>code.forgery_suspected</c> notice on the receipt's own save, and is not attendance.
    /// </para>
    /// </summary>
    private static async Task<V1Evidence> V1EvidenceAsync(
        Device device, DeviceEventDto e, EventFacts time, string useClass, string kind,
        DeviceEventServices services, CancellationToken ct)
    {
        var settings = await services.Settings.GetAsync(ct);
        var evidence = await services.MemberCodes.CheckEvidenceAsync(e.Subject!.Trim(), time.OccurredAt, settings, ct);

        if (evidence is MemberCodeEvidence.Genuine genuine)
        {
            var claim = await services.MemberCodes.TryClaimAsync(genuine.Match, useClass, device.Id, kind, ct);
            if (claim is not null) return new V1Evidence(genuine.Match.UserId, null);

            // Taken — but by whom? The SAME board holding this code's use in this class is the
            // same act, not a second one: a box that got an online grant and also queued its
            // roster fallback (the answer was lost on the way back), or this very upload retried
            // after a failure that left its claim behind. That is a receipt and nothing else —
            // the attendance is already stamped, and paging every admin about a member's own
            // single scan was the defect. Only a DIFFERENT board is one code used twice.
            var taken = await services.MemberCodes.FindUseAsync(genuine.Match, useClass, ct);
            if (taken is not null && taken.DeviceId == device.Id) return new V1Evidence(genuine.Match.UserId, null);
            evidence = new MemberCodeEvidence.Forged("reused", genuine.Match.UserId, genuine.Match.Ref);
        }

        // A clamped event time is not a time: the box's counter was broken, so the step the code
        // was shown at is unknown and a check around the upload instant proves nothing either
        // way. Recorded as unverifiable — not attendance, no forgery alarm on a guess.
        if (time.ClampedFrom is not null)
        {
            var who = evidence is MemberCodeEvidence.Forged { UserId: { } u } ? u : (Guid?)null;
            return new V1Evidence(Guid.Empty, new ActivationOutcome(
                ActivationOutcome.Unverifiable, null, useClass == MemberCodeUseClass.Door ? GateOpenKind : ActivationKind, SubjectUserId: who));
        }

        var forged = (MemberCodeEvidence.Forged)evidence;
        var name = forged.UserId is { } uid
            ? await services.Db.Memberships.AsNoTracking().Where(m => m.UserId == uid).Select(m => m.FullName).FirstOrDefaultAsync(ct)
            : null;
        var notice = AdminNotices.CodeForgerySuspected(device, time.BootId, e.Seq, name, forged.UserId, forged.Why);
        var outcomeKind = useClass == MemberCodeUseClass.Door ? GateOpenKind : ActivationKind;
        return new V1Evidence(Guid.Empty, new ActivationOutcome(
            ActivationOutcome.ForgerySuspected, null, outcomeKind, SubjectUserId: forged.UserId, Notice: notice));
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
        var (db, _, _, _, bookings, _, _, _, _, _, _, _) = services;
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

        // The lights are believed OFF, and the MEASURED end is kept on the row so the control
        // board and the night trace can still say how long the court was actually lit. This is
        // also the event the power-dip restore reads back: a member who pressed OFF early has
        // this receipt, and it is the only thing on the server that says they did — the
        // booking's own LightsOffCuedAt is set by the slot-end sweep, never by the device.
        var court = await db.Courts.AsNoTracking().FirstOrDefaultAsync(c => c.Id == booking.CourtId, ct);
        if (court is not null)
        {
            var evidence = new LightEvidence(court.Id, device.Id, relay, e.Seq, BootId: 0, At: window.End);
            var row = await services.Lights.RecordOffAsync(evidence, ct);
            if (row is not null)
            {
                services.Lights.Audit(
                    CourtLightStateService.LightsOffAction, court.Id, court.CourtNumber, booking.UserId,
                    new { device_id = device.Id, relay, booking_id = booking.Id, minutes = window.Minutes });
            }
        }

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
        var (db, _, _, activation, bookings, settingsAccessor, _, _, _, _, _, _) = services;
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
    /// <see cref="UploadAsync"/>. False when the unique index on (tenant, device, boot_id, seq)
    /// refused the receipt: two uploads of the same batch were in flight together, the other
    /// one recorded this event, and the box is told it is accepted because it is. Any
    /// activation this event carried has already been applied, idempotently, by whichever
    /// request got there first.
    /// </summary>
    private static async Task<bool> RecordAsync(
        DeviceEventServices services, Device device, DeviceEventDto e, EventFacts time,
        ActivationOutcome? outcome, CancellationToken ct)
    {
        var (db, tenant, _, _, _, _, _, _, _, _, _, _) = services;

        var receipt = new DeviceEventReceipt
        {
            TenantId = tenant.TenantId,
            DeviceId = device.Id,
            BootId = time.BootId,
            Seq = e.Seq,
            Kind = time.Kind,
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

            // The club's own label for the door, as the ONLINE gate path has always written
            // it and this one did not. Every reader resolves the name by `device_id` at reply
            // time — the row is not the authority and a rename must not leave a history
            // stranded on an old label — so this is purely the fallback for a board DELETED
            // since the scan, which is the one case resolution cannot answer. Null on a court
            // box, which has no key. See MeDoorEndpoints.DoorNameOf, and S1.
            gate_key = device.GateKey,

            // And the board's DISPLAY name beside it, for the same reason and the same one
            // case: a board DELETED since the scan. A row from a removed door used to reach
            // the console as `door: null`, which the log page dereferenced (A1 / E-C1 / C1).
            // See DoorRowDoor.
            door_name = device.Name,

            // WHICH BOOT THE SEQUENCE BELONGS TO. Without it a trail shows `seq 1` twice
            // and nothing to tell the two apart, which is exactly the confusion the key
            // change exists to end.
            boot_id = time.BootId,
            seq = e.Seq,
            kind = time.Kind,
            court = e.Court,
            method = e.Method,
            subject = SubjectFor(e),
            duration_ms = e.DurationMs,
            occurred_at = time.OccurredAt,
            occurred_at_clamped_from = time.ClampedFrom,
            outcome = outcome?.Code,
            booking_id = outcome?.BookingId,
            related_booking_id = outcome?.RelatedBookingId,
        };
        var detailsJson = System.Text.Json.JsonSerializer.Serialize(details);

        // Named when the handler could name them. Only the gate-open path sets this today:
        // an activation names its member through the booking on the receipt, while a door
        // open has no booking to reach one through, so the audit row is the only place the
        // identity can live at all.
        var subject = outcome?.SubjectUserId;

        var rows = new List<AuditLog>(3)
        {
            new() { TenantId = tenant.TenantId, ActorUserId = Guid.Empty, SubjectUserId = subject, Action = $"device.{time.Kind}", DetailsJson = detailsJson },
        };
        if (outcome is not null && outcome.Code != ActivationOutcome.Ok)
        {
            rows.Add(new() { TenantId = tenant.TenantId, ActorUserId = Guid.Empty, SubjectUserId = subject, Action = $"device.{AuditKind(outcome.Kind)}_{outcome.Code}", DetailsJson = detailsJson });
        }
        if (time.ClampedFrom is not null)
        {
            // The box's uptime counter cannot be believed; the desk needs to know before
            // the next event from it, not after.
            rows.Add(new() { TenantId = tenant.TenantId, ActorUserId = Guid.Empty, SubjectUserId = subject, Action = "device.event_time_clamped", DetailsJson = detailsJson });
        }
        db.AuditLogs.AddRange(rows);

        // A forgery's notice rides the receipt's own save, so a duplicate upload that loses the
        // receipt index raises nothing — the notice exists if and only if the receipt does.
        var notice = outcome?.Notice is { } n ? AdminNotices.Stage(db, tenant.TenantId, n) : null;

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
            if (notice is not null) db.Entry(notice).State = EntityState.Detached;
            return false;
        }
    }

    /// <summary>
    /// What the audit row may say about the token a door event carried: a short fingerprint,
    /// never the token.
    ///
    /// <para>
    /// <b>A live access code in a trail an admin can read is a credential in a log.</b> The
    /// online path has said so since it shipped — §5 of the spec leaves the token out of
    /// <c>gate.opened</c> on purpose — and the OFFLINE path wrote it in full. A
    /// <c>gate_open</c> or an <c>unknown_scan</c> carries the bytes the member held up at the
    /// door, and those bytes open every door in the club for the length of that booking's
    /// window; <c>RetentionWorker</c> anonymises a row's SUBJECT and never touches its
    /// <c>DetailsJson</c>, so they stayed readable for as long as the row did. Any admin, any
    /// console session, any database dump.
    /// </para>
    ///
    /// <para>
    /// The fingerprint is the first eight hex characters of SHA-256 over the normalised code,
    /// which keeps the one property the field was worth having for: <b>two scans of one code
    /// still correlate</b>, so "the same badge tried the side door eleven times" is still a
    /// question the trail answers. It is not reversible, and it is not a lookup key — the
    /// identity lives on <c>SubjectUserId</c>, which the resolved gate-open path sets.
    /// </para>
    ///
    /// <para>
    /// <b>It is keyed on nothing, which is the point.</b> It was keyed on the event's KIND —
    /// the two door kinds only — and that was wrong twice over. It was wrong MECHANICALLY,
    /// because it read <c>e.Kind</c> raw while everything else on this route read the trimmed
    /// value, so <c>" gate_open "</c> was audited as a door event and had its token written
    /// out in full; that half is fixed by normalising once, at the top (see
    /// <see cref="AuditKind"/>). And it was wrong in SUBSTANCE, which is why the guard is now
    /// unconditional rather than merely corrected.
    /// </para>
    ///
    /// <para>
    /// The narrow version reasoned that a court box's own <c>activation</c> token "is the
    /// roster token for a booking the receipt already names", so nothing was gained by hiding
    /// it. That was true when it was written and stopped being true the moment the gate
    /// shipped: since D2 the same roster token <b>opens every door in the club</b> for the
    /// length of its booking's window. The receipt naming the booking does not make the bytes
    /// less live, and an unknown kind — a board ahead of this server, or one with a bug — has
    /// no claim to be trusted with them either. There is no kind whose subject is safe to
    /// write down, so there is no test to get wrong.
    /// </para>
    ///
    /// <para>
    /// Resolution is unaffected: every handler above resolves <c>e.Subject</c> in memory, and
    /// only this value ever reaches a row.
    /// </para>
    /// </summary>
    private static string? SubjectFor(DeviceEventDto e)
    {
        if (string.IsNullOrWhiteSpace(e.Subject)) return null;

        var digest = System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(e.Subject.Trim().ToUpperInvariant()));
        return Convert.ToHexString(digest)[..8].ToLowerInvariant();
    }

    /// <summary>
    /// The unique index on (tenant, device, boot_id, seq) refusing a concurrent duplicate, as
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
    /// The reference the undo of that purchase is posted under — the purchase's own with a
    /// suffix, so the two read as a pair on the ledger and so two concurrent undos of one
    /// purchase post one refund (the filtered unique index refuses the second).
    /// </summary>
    public static string VoidReference(string purchaseReference) => $"{purchaseReference}:void";

    /// <summary>
    /// The walk-up decision for an already-authenticated box. Public, and separate from the
    /// HTTP handler, so the decision can be driven directly by a test that does not want to
    /// sign requests — the money and court semantics live here, the wire lives above.
    /// </summary>
    public static async Task<IResult> WalkUpForDeviceAsync(
        Device device, WalkUpRequest req, WalkUpServices services, CancellationToken ct)
    {
        var (db, _, _, _, settingsAccessor, _, _, _, _) = services;

        var settings = await settingsAccessor.GetAsync(ct);

        // A box selling court time is a box that is reporting (finding L-F5). Recorded
        // before the decision, so a refused purchase counts as liveness too — the box
        // called, whatever the answer was.
        await DeviceSilenceLog.NoteContactAsync(db, device, settings, DateTimeOffset.UtcNow, ct);

        // A door sells nothing. Refused before the nonce, before the replay check and long
        // before anything commits — see GateAccess.NotACourtBox for why this is stated rather
        // than left to `court_not_on_device`, which is what a gate's empty court list answers
        // today and which stops being a refusal the moment somebody puts a court on one.
        if (device.Kind != DeviceKind.CourtBox) return Results.BadRequest(new { error = GateAccess.NotACourtBox });

        if (RefuseNonce(req) is { } badNonce) return badNonce;
        var reference = WalkUpReference(device.Id, req.Nonce!);

        // Replay before anything else, including validation: the fields of a retried
        // request already passed once, and the only question is whether this purchase
        // has already been made.
        if (await ReplayAsync(reference, req, services, ct) is { } replayed) return replayed;

        if (RefuseFields(device, req, settings) is { } badRequest) return badRequest;

        var court = await db.Courts.FirstOrDefaultAsync(c => c.CourtNumber == req.Court && c.IsActive, ct);
        if (court is null) return Results.NotFound(new { error = "court_not_found" });

        // Either code family (member-code §4.1). A v1 code is checked at the instant the box
        // read it — two presses ago, which is what scan_age_ms carries — and identifies its
        // member; a legacy code must be a member-ident code, as it always had to be.
        var (userId, match) = await WalkUpBuyerAsync(req, services, settings, ct);
        if (userId is null) return Results.BadRequest(new { error = "not_recognised" });

        // A member the club has barred cannot buy court time here (finding K-F1). This was
        // the one door into the money with no membership test on it: the app's booking route
        // refuses with `member_suspended`, and the activation paths and the cached roster
        // both drop a barred member's bookings — but a walk-up CREATES its booking, so it
        // never met a candidate set and never met a filter. A member suspended at the desk
        // walked up, was charged fifty credits and had the court lit, twice, while the
        // console's own suspend modal promised they could not "open a court at the box".
        //
        // Checked BEFORE CreateWalkUpAsync, not after: everything below this line commits
        // money, and a refusal that arrives after the debit is a refund to write rather than
        // a sale not made.
        //
        // Answered as `not_recognised` — the same refusal an unreadable code gets — for two
        // reasons. It is the only walk-up refusal whose firmware row sets `recognised:false`
        // (WalkUp.cpp kErrors), so the box arms no button window for a barred member, which
        // is the behaviour wanted; and it puts SEE THE DESK on the glass, which is exactly
        // what the member must do. Naming the suspension at the court would explain it to
        // whoever happens to be standing there, which is the reasoning CourtActivationService
        // already records for the pre-booked path.
        //
        // The REPLAY above is deliberately not gated. It is the box retrying a purchase
        // already made and already paid for; refusing it leaves the member charged and the
        // court dark, which is the H3 defect the nonce exists to prevent.
        if (await MembershipAccess.IsBarredFromCourtsAsync(db, userId.Value, ct))
        {
            return Results.BadRequest(new { error = "not_recognised" });
        }

        // The purchase is not finished when this returns, and the confirmation is not sent.
        //
        // The commit takes the money and would, left to itself, mail the member "this is court
        // time bought at the box, so it has already started… not refunded once the lights have
        // been on, and there is nothing to cancel". The activation is the line below it, and
        // on a refusal every clause of that sentence was false: the lights never came on, the
        // booking was still refundable, and there was very much something to cancel. The mail
        // is held and sent after the activation instead, which is the only ordering in which
        // it describes what happened.
        // One money use per code (§4.4), claimed before anything is charged and given back on
        // every path below that ends without a sale — or that throws. AFTER the replay check
        // above, so a box retrying its own nonce is answered with the first purchase, never
        // `code_used`; and keyed by that nonce, so two identical retries IN FLIGHT together (both
        // past the replay check before either committed) re-enter one claim instead of one of
        // them reading CODE USED for a purchase that went through.
        MemberCodeClaim? claim = null;
        if (match is not null)
        {
            claim = await services.MemberCodes.TryClaimAsync(
                match, MemberCodeUseClass.Money, device.Id, "walkup", ct, claimKey: "walkup:" + req.Nonce);
            if (claim is null) return Results.Conflict(new { error = MemberCodeIdentity.CodeUsed });
        }

        return await SellAsync(new WalkUpSale(device, req, court, userId.Value, reference, claim), services, ct);
    }

    /// <summary>
    /// Who is buying: the member a v1 code or a legacy member-ident code identifies, by a method
    /// that identifies globally, and the match to claim the use against. Null user otherwise.
    /// </summary>
    private static async Task<(Guid? UserId, MemberCodeMatch? Match)> WalkUpBuyerAsync(
        WalkUpRequest req, WalkUpServices services, TenantSettingsView settings, CancellationToken ct)
    {
        if (!IdentificationResolver.CanIdentifyGlobally(req.Method)) return (null, null);
        var (resolved, match) = await MemberCodeIdentity.ResolveAsync(
            services.Codes, services.MemberCodes, new ScannedCode(req.Token, req.ScanAgeMs), settings, DateTimeOffset.UtcNow, ct);
        return resolved?.Purpose == AccessCodePurpose.MemberIdent ? (resolved.UserId, match) : (null, null);
    }

    /// <summary>One walk-up purchase, decided up to the point of selling it. See <see cref="SellAsync"/>.</summary>
    private sealed record WalkUpSale(Device Device, WalkUpRequest Req, Court Court, Guid UserId, string Reference, MemberCodeClaim? Claim);

    /// <summary>
    /// The sale itself: the purchase, its activation, and the use given back on every path that
    /// ends without one. Lifted out of <see cref="WalkUpForDeviceAsync"/> for the complexity gate.
    /// </summary>
    private static async Task<IResult> SellAsync(WalkUpSale sale, WalkUpServices services, CancellationToken ct)
    {
        var (device, req, court, userId, reference, claim) = sale;
        var (db, bookings, activation, _, _, _, _, _, _) = services;

        BookingResult created;
        try
        {
            created = await bookings.CreateWalkUpAsync(
                court.Id, userId, userId, req.Minutes, reference, ct);
        }
        catch
        {
            await services.MemberCodes.ReleaseAsync(claim);
            throw;
        }

        // Two retries in flight together: the replay check above found nothing because the
        // other attempt had not committed yet, and the database refused this one — on the
        // reference's unique index, or on the slot the other attempt has just taken. Either
        // way the purchase exists now, so re-read it and answer with it. The claim is KEPT: the
        // purchase it stands for was made, under this very nonce.
        if (created is BookingResult.DuplicateRequest or BookingResult.SlotTaken
            && await ReplayAsync(reference, req, services, ct) is { } original)
        {
            return original;
        }

        if (created is not BookingResult.Ok ok)
        {
            await services.MemberCodes.ReleaseAsync(claim);
            // A purchase the club would not sell, onto the monitoring page. The member is at
            // the box with their card out and the court did not come on, and the reason —
            // out of hours, no time available, the court already in use — is a fact about the
            // CLUB's configuration that only an admin can act on.
            services.Faults.WalkUpRefused(device, WalkUpRefusalOf(created));
            return Refusal(created);
        }

        // Straight into the one activation path, so attendance, the audit row and
        // booking.lights_on all come from the place that is allowed to produce them. Not
        // wrapped like the purchase above: past CreateWalkUpAsync's commit the money has moved,
        // and a use that moved money keeps its row — the box's retry of this nonce is answered
        // by the replay, never by a second purchase.
        var activated = await ActivateOnceAsync(db, activation,
            new ActivationTarget(court, ok.Booking, userId, req.Method ?? "qr", OccurredAt: null, DurationMs: 0), ct);
        if (activated is not ActivationResult.Activated live)
        {
            // The purchase is undone rather than left standing. Charged and un-checked-in on a
            // court nobody can now buy, it would be settled as a no-show at the grace deadline
            // and carry the club's penalty — for a member the API itself refused. No mail was
            // sent above, so nothing has yet told them a lie about it either.
            await bookings.VoidUnstartedWalkUpAsync(ok.Booking, VoidReference(reference), ct);
            await services.MemberCodes.ReleaseAsync(claim);
            return Results.Conflict(new { error = "activation_refused" });
        }

        // NOW the confirmation, with the lights on and the sentence in it true.
        await ok.SendConfirmationAsync!(ct);

        return Results.Ok(Grant(
            ok.Booking, live.AmountCredits, ok.BalanceAfterCredits, replayed: false,
            display: await MemberDisplay.ForAsync(db, userId, ct)));
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
        var (db, bookings, activation, _, _, ledger, _, _, _) = services;

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

        // Read BEFORE the activation below, which is the whole point of reading it: an
        // unstamped booking is one whose first attempt died between the charge and the
        // check-in, so its confirmation was never sent and this replay owes the member one.
        // A stamped one was confirmed by whichever attempt stamped it, and mailing again
        // would send a second "you are on court" for a single purchase.
        var wasNeverActivated = booking.CheckedInAt is null;

        var activated = await ActivateOnceAsync(db, activation,
            new ActivationTarget(court, booking, entry.UserId, req.Method ?? "qr", OccurredAt: null, DurationMs: 0), ct);
        if (activated is not ActivationResult.Activated)
        {
            // Same reasoning as the first attempt, and the same idempotent reference: a
            // purchase this endpoint will not open is a purchase the member gets back, not
            // one left on the court to be swept as a no-show.
            await bookings.VoidUnstartedWalkUpAsync(booking, VoidReference(reference), ct);
            return Results.Conflict(new { error = "activation_refused" });
        }

        // The confirmation the first attempt owed and never sent. See `wasNeverActivated`.
        if (wasNeverActivated) await bookings.SendWalkUpConfirmationAsync(booking, ct);

        // The balance now rather than as it stood after the first attempt: the box shows
        // the member what they have, and a movement between the two attempts is real.
        var balance = await ledger.GetBalanceAsync(entry.UserId, ct);
        return Results.Ok(Grant(
            booking, -entry.AmountCredits, balance, replayed: true, now,
            await MemberDisplay.ForAsync(db, entry.UserId, ct)));
    }

    // Block bodies, not expression bodies, for the two members below. lizard's C# parser
    // mis-scopes an expression-bodied member containing braces and emits a *global*
    // pseudo-function whose reported length is the whole file — see memory/gotchas.md.
    /// <summary>
    /// What the box puts on the relay timer, and the name it greets the buyer with.
    ///
    /// <para>
    /// <paramref name="display"/> is GOAL item 4's greeting line — see
    /// <see cref="MemberDisplay"/> for why the SERVER truncates it rather than the board.
    /// Absent when the club has no name on file, which changes the greeting and nothing else:
    /// the court still comes on.
    /// </para>
    /// </summary>
    private static object Grant(
        Booking booking, decimal amountCredits, decimal balanceAfterCredits, bool replayed,
        DateTimeOffset? now = null, string? display = null)
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
            member_display = display,
        };
    }

    /// <summary>The refusal's own word, for the fault row's detail. Block body for the lizard reason in <c>memory/gotchas.md</c>.</summary>
    private static string WalkUpRefusalOf(BookingResult created)
    {
        return created switch
        {
            BookingResult.InsufficientBalance => "insufficient_balance",
            BookingResult.NoTimeAvailable => "no_time_available",
            BookingResult.SlotTaken => "court_in_use",
            BookingResult.OutOfHours => "out_of_hours",
            _ => "walk_up_refused",
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

            // The club is shut, and the box can say so (finding M-F5). This collapsed into
            // the catch-all below, which threw away the two times the member actually needs
            // — at a locked club, after hours, in front of a screen reading SEE THE DESK
            // when there is no desk. Every other refusal on this path has a purpose-written
            // screen; this is the one the Settings page promises ("a walk-up at the box is
            // cut short at closing") and could not deliver the other half of.
            //
            // `club_closed` rather than the app route's `out_of_hours`: that one means "the
            // slot you picked falls outside opening hours" and can be answered by picking
            // another slot, while this one means "the club is shut right now" and cannot.
            // 400, like the catch-all it replaces, so a firmware build that does not yet
            // know the code still falls through byStatus(400) to the screen it shows today
            // rather than to 409's COURT NOT FREE, which would be a new lie.
            BookingResult.OutOfHours h => Results.BadRequest(new
            {
                error = "club_closed",
                opens_at = h.OpensAt,
                closes_at = h.ClosesAt,
            }),

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
    LedgerService Ledger,
    /// <summary>
    /// Where a refused purchase is recorded for the club's monitoring page.
    ///
    /// <para>
    /// POSITIONAL, for the reason <c>DeviceEventServices</c>' three are: this record is built
    /// by <c>[AsParameters]</c>, which does NOT resolve init-only properties from the
    /// container. As a property it would have been null on every walk-up, and the first
    /// refused purchase would have thrown from inside a member's card payment rather than
    /// answering them.
    /// </para>
    /// </summary>
    DeviceFaultSink Faults,
    /// <summary>Legacy access codes, for the family check (member-code §4.1).</summary>
    AccessCodeService Codes,
    /// <summary>The v1 member-code check and its use table (member-code §4).</summary>
    MemberCodeService MemberCodes);

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
    TenantSettingsAccessor Settings,
    /// <summary>
    /// The light-state projection an activation and a release both move — GOAL items 10 and 17.
    ///
    /// <para>
    /// POSITIONAL, and that is not a style choice. These three were init-only properties for
    /// one build, and <c>[AsParameters]</c> does not resolve those from the container: every
    /// handler on this route bound them as <c>null</c> and the first activation threw a
    /// <c>NullReferenceException</c> from inside a device upload. A required constructor
    /// parameter makes a missing dependency a COMPILE error at every construction site,
    /// including the fixtures — which is the failure mode a service this route cannot run
    /// without has to have.
    /// </para>
    /// </summary>
    CourtLightStateService Lights,
    /// <summary>For the fault rows this route raises off the request thread. See <see cref="DeviceErrorService.InBackground"/>.</summary>
    IServiceScopeFactory Scopes,
    /// <summary>The logger factory those background writes report their own failures to.</summary>
    ILoggerFactory Logs,
    /// <summary>The refusal sites' fault recorder. See <see cref="DeviceFaultSink"/>.</summary>
    DeviceFaultSink Faults,
    /// <summary>The member-code evidence re-check and use table (member-code §7).</summary>
    MemberCodeService MemberCodes,
    /// <summary>Who plays on a booking — the seam P11 extends. See <see cref="IBookingPlayers"/>.</summary>
    IBookingPlayers Players);

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
///
/// <para>
/// <b><c>boot_id</c> is the third field of the idempotency key, and it is here because
/// <c>(device, seq)</c> was not one.</b> A box's ring is RAM-only, so no event survives a
/// reboot; <c>seq</c> resumes from a single checkpoint record in the board's flash, written
/// in blocks of 64. Erase or tear that record — a reflash, a wiped NVS partition, a torn
/// write — and the board renumbers from 1, against the PERMANENT unique index this table
/// carries. Every event of the next evening is then silently receipted as a duplicate and
/// discarded, <i>including</i> the <c>boot</c> event the firmware queues precisely so that
/// an operator can see the board restarted. Two boards accidentally sharing a MAC dedup
/// each other the same way.
/// </para>
///
/// <para>
/// So the board sends a per-boot random 32-bit value and the key is
/// <c>(tenant, device, boot_id, seq)</c>. <b>Absent means 0</b>, which is exactly the
/// behaviour <c>(device, seq)</c> always had: a court box, whose renderer omits the field,
/// and every gate image flashed before this change share one boot identity and dedup
/// against themselves as before. <c>long</c> rather than <c>int</c> because the value is a
/// full unsigned 32-bit number, up to 4294967295.
/// </para>
///
/// <para>
/// <c>accepted_through</c> is unchanged by this: a board holds one boot's events at a time,
/// so the highest sequence number in a batch means what it always meant.
/// </para>
/// </summary>
public sealed record DeviceEventBatch(
    [property: JsonPropertyName("mac")] string? Mac,
    [property: JsonPropertyName("uptime_ms")] long UptimeMs,
    [property: JsonPropertyName("events")] IReadOnlyList<DeviceEventDto>? Events,
    [property: JsonPropertyName("boot_id")] long BootId = 0);

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
    [property: JsonPropertyName("nonce")] string? Nonce,
    /// <summary>How long ago the scanner read a v1 token, ms (member-code §4.2). Absent means 0.</summary>
    [property: JsonPropertyName("scan_age_ms")] long? ScanAgeMs = null);
