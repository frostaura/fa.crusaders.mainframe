using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>What happened when someone identified themselves at a court.</summary>
public abstract record ActivationResult
{
    /// <summary>Charged and checked in. <paramref name="AlreadyActive"/> marks a repeat scan of a live session.</summary>
    public sealed record Activated(Booking Booking, Guid PayerUserId, int AmountMinutes, bool AlreadyActive) : ActivationResult;

    /// <summary>Identified, but with no booking on this court inside the window.</summary>
    public sealed record NoBooking : ActivationResult;

    /// <summary>The payer cannot afford it. <b>Nothing was stamped and no lights were cued.</b></summary>
    public sealed record InsufficientBalance(Guid PayerUserId, int Current, int Required) : ActivationResult;

    /// <summary>The booking is cancelled, expired or otherwise past charging.</summary>
    public sealed record NotChargeable : ActivationResult;

    /// <summary>
    /// Identified and holding the booking, but its start is further off than the cue
    /// window allows. <b>Nothing was charged, stamped or cued.</b> The forward window
    /// finds the booking — it has to be wide enough to disambiguate back-to-back slices —
    /// and the cue window is the narrower one that says when a scan may actually light the
    /// court. Before this the two were the same two hours, so a member scanning on their
    /// way in was stamped present, cued the lights, and locked out their refund, up to two
    /// hours before their slot.
    /// </summary>
    public sealed record TooEarly(Booking Booking, int StartsInSeconds) : ActivationResult;
}

/// <summary>
/// The one path from "a player identified themselves at a court" to "the court is live".
///
/// <para>
/// It exists because there were three touchpoints and only one of them did anything.
/// <c>BiometricService.MatchAtCourtAsync</c> charged, stamped attendance and cued lights;
/// the PIN and QR endpoints were pure identity oracles that returned a <c>user_id</c> and
/// nothing else. A member who identified by PIN or QR therefore got a free game <i>and</i>
/// looked like a no-show to the sweep, because <c>CheckedInAt</c> was never set. The
/// blueprint calls those three a triple stack; in the money model they were not one.
/// </para>
///
/// <para>
/// <b>The ordering here is the fix, and it is deliberate.</b> The old code stamped
/// <c>CheckedInAt</c>, cued the lights and <i>then</i> attempted the charge — and on
/// insufficient balance merely logged a warning. So the lights came on unpaid, and because
/// <c>CheckedInAt</c> was set the booking was disqualified from <c>NoShowWorker</c>: the
/// session settled to free play with nothing to follow up. Charging happens <b>first</b>
/// now, and nothing is stamped and no event is emitted unless it succeeded.
/// </para>
///
/// <para>
/// <b>Not sealed, and <see cref="ActivateAsync(ActivationRequest, CancellationToken)"/> is
/// virtual, for one reason: the refusal branch is otherwise untestable.</b> Every refusal
/// this returns to a walk-up is a race — the booking is decided between the debit and the
/// activation — and no test can schedule that inside one call. The walk-up path now UNDOES
/// the purchase on a refusal (money back, slot released, no confirmation), which is money
/// code, and money code that nothing drives is money code nobody has read. A test double
/// that returns a refusal is the seam; nothing else here is meant to be overridden.
/// </para>
/// </summary>
public class CourtActivationService
{
    private readonly MainframeDbContext _db;
    private readonly BookingService _bookings;
    private readonly TenantSettingsAccessor _settings;
    private readonly ITenantContext _tenant;
    private readonly IEventBus _bus;
    private readonly ILogger<CourtActivationService> _logger;

    public CourtActivationService(
        MainframeDbContext db,
        BookingService bookings,
        TenantSettingsAccessor settings,
        ITenantContext tenant,
        IEventBus bus,
        ActivationPlumbing plumbing)
    {
        _db = db;
        _bookings = bookings;
        _settings = settings;
        _tenant = tenant;
        _bus = bus;
        _logger = plumbing.Logger;
        _lights = plumbing.Lights;
        _clock = plumbing.Clock ?? TimeProvider.System;
    }

    private readonly CourtLightStateService _lights;

    /// <summary>
    /// The instant a live scan is decided and stamped at (R14 D14-4): the DI clock every device
    /// route checks the member code at. The wall clock here let one activation pass the code check
    /// at one instant and the cue gate at another — <c>too_early</c> for a code that had just passed.
    /// </summary>
    private readonly TimeProvider _clock;

    /// <summary>
    /// The window in which an identification <i>finds</i> a booking, from tenant settings.
    ///
    /// <para>
    /// There were three of these and they disagreed: biometric read
    /// <c>Biometric:GraceMinutes</c> from app config — a key absent from
    /// <c>appsettings.json</c>, so always its 5-minute default — while PIN and QR each
    /// hardcoded 30 minutes, and <c>NoShowWorker</c> used the tenant's
    /// <c>grace_window_minutes</c>. A member could be inside PIN's window and already swept
    /// as a no-show by the worker, which is not a grace period so much as a disagreement.
    /// One setting now governs all of them, per the every-configurable-number invariant.
    /// </para>
    ///
    /// <para>
    /// The forward edge is <c>activation_forward_window_minutes</c> — it was a hardcoded two
    /// hours, and it is deliberately wide: wide enough to hold <b>two</b> of a member's
    /// bookings at once, because back-to-back slices are the ordinary shape under a per-day
    /// cap measured in minutes. Both selectors below therefore order by <c>StartsAt</c> and
    /// take the earliest, which is the one the player is standing on: a live booking always
    /// starts before a future one. Neither used to order at all, and the row the database
    /// happened to return first won — the 17:15 slice at 16:58 holding 17:00 and 17:15, the
    /// lights on seventeen minutes early on the wrong row, and the 17:00 booking swept as a
    /// no-show at 17:05 with a penalty for a court the member was playing on.
    /// </para>
    ///
    /// <para>
    /// Finding a booking is not the same as lighting it. That is the cue window, checked in
    /// <see cref="ActivateAsync"/>.
    /// </para>
    /// </summary>
    public async Task<(DateTimeOffset Start, DateTimeOffset End)> WindowAsync(DateTimeOffset now, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        return (
            now.AddMinutes(-settings.GraceWindowMinutes),
            now.AddMinutes(settings.ActivationForwardWindowMinutes));
    }

    /// <summary>
    /// The bookings on this court that an identification could activate right now.
    ///
    /// <para>
    /// A member the club has not approved — <b>suspended</b>, rejected, or still waiting —
    /// has no booking among them. A suspension takes access away without touching money or
    /// bookings — the row, the ledger and every future slot stand, and reactivating restores
    /// all of it — so it is enforced on the candidate set rather than as a new
    /// <see cref="ActivationResult"/> case. That is what keeps it to one clause with no
    /// caller changes: PIN, biometric, QR and the activation endpoints all answer their
    /// existing "no booking", and no new refusal has to be routed through four screens.
    /// The member was told why by email; a court box is not the place to explain it, and one
    /// that named the reason would be explaining it to whoever is standing there.
    /// </para>
    ///
    /// <para>
    /// The test is <c>!= Active</c>, not <c>== Suspended</c>. <see cref="MembershipAccess"/>
    /// is where that rule and its blast radius are written down; this is its query-side
    /// twin, inline because a captured expression does not translate inside a subquery.
    /// </para>
    /// </summary>
    public async Task<List<Booking>> CandidatesAsync(Guid courtId, DateTimeOffset now, CancellationToken ct)
    {
        var (start, end) = await WindowAsync(now, ct);
        var withPartners = BookingPlayerQueries.BookingsWithActivePartners(_db);

        return await _db.Bookings
            .Where(b => b.CourtId == courtId
                        && b.Status == BookingStatus.Booked
                        && b.StartsAt < end && b.EndsAt > start
                        // Ruling 15: an ACTIVE row, not merely the absence of a non-active one.
                        // The old shape let a booking with NO membership row through, which is
                        // the same conflation that opened a door — see MembershipAccess.
                        && (_db.Memberships.Any(m => m.UserId == b.UserId && m.Status == MembershipStatus.Active)
                            // D11: a booking an accepted partner may activate is a candidate even
                            // when the organiser's own membership is not active — the partner's is.
                            || withPartners.Contains(b.Id)))
            .OrderBy(b => b.StartsAt)
            .ToListAsync(ct);
    }

    /// <summary>
    /// Every person who may activate one of <paramref name="candidates"/>, earliest booking first:
    /// the organiser (active membership) and each ACCEPTED partner (active membership) — D11. The
    /// PIN and biometric paths identify a PERSON against this list, so a partner's own PIN or
    /// finger finds the game they accepted a seat in.
    /// </summary>
    public async Task<IReadOnlyList<(Guid UserId, Booking Booking)>> PlayersOfAsync(
        IReadOnlyList<Booking> candidates, CancellationToken ct)
    {
        var ids = candidates.Select(b => b.Id).ToList();
        var partners = await BookingPlayerQueries.ActivePartnersOf(_db, ids).ToListAsync(ct);
        var organiserIds = candidates.Where(b => b.UserId != null).Select(b => b.UserId!.Value).Distinct().ToList();
        var organisers = await _db.Memberships.AsNoTracking()
            .Where(m => m.Status == MembershipStatus.Active && organiserIds.Contains(m.UserId))
            .Select(m => m.UserId)
            .ToListAsync(ct);

        var players = new List<(Guid, Booking)>();
        foreach (var b in candidates)
        {
            if (b.UserId is { } organiser && organisers.Contains(organiser)) players.Add((organiser, b));
            players.AddRange(partners.Where(p => p.BookingId == b.Id).Select(p => (p.UserId, b)));
        }
        return players;
    }

    /// <summary>
    /// This user's activatable booking on this court, if any. Barred memberships are
    /// excluded on the same clause as <see cref="CandidatesAsync"/> — see there.
    /// </summary>
    public async Task<Booking?> FindForUserAsync(Guid courtId, Guid userId, DateTimeOffset now, CancellationToken ct)
    {
        var (start, end) = await WindowAsync(now, ct);

        // D11: the member's OWN booking, or one they accepted a seat in. The membership asked about
        // is the identified member's — for an organiser that is the booking's user, as before.
        var partnerOn = BookingPlayerQueries.PartnerBookingIds(_db, userId);
        return await _db.Bookings
            .Where(b => b.CourtId == courtId
                        && (b.UserId == userId || partnerOn.Contains(b.Id))
                        && b.Status == BookingStatus.Booked
                        && b.StartsAt < end && b.EndsAt > start
                        // Ruling 15: an ACTIVE row, not merely the absence of a non-active one.
                        // The old shape let a booking with NO membership row through, which is
                        // the same conflation that opened a door — see MembershipAccess.
                        && _db.Memberships.Any(m => m.UserId == userId && m.Status == MembershipStatus.Active))
            .OrderBy(b => b.StartsAt)
            .FirstOrDefaultAsync(ct);
    }

    /// <summary>
    /// The booking an OFFLINE v1 activation was evidence for (member-code §7): found by member,
    /// court and time — never by <c>EndsAt</c>, which the no-show sweep truncates, but by the
    /// window the booking was SOLD for, opened a cue window early and held open for the grace
    /// window after, which is the same window a box's roster admitted from.
    ///
    /// <para>
    /// Every status a settlement path can act on is a candidate — <c>Booked</c>, <c>Completed</c>,
    /// a <c>NoShow</c> the upload will reverse, a <c>Cancelled</c> row whose lit time is owed. A
    /// booking whose sold window holds the scan is preferred over one only its grace tail reaches;
    /// within each, a live one over a cancelled one, then the latest already started. The member may be the
    /// organiser or an accepted partner: <see cref="IBookingPlayers"/> decides.
    /// </para>
    /// </summary>
    public async Task<Booking?> FindForEvidenceAsync(
        Guid courtId, Guid userId, DateTimeOffset at, IBookingPlayers players, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        var cue = BookingCodeWindow.CueMinutes(settings);
        var grace = settings.GraceWindowMinutes;
        var earliestStart = at.AddMinutes(-(24 * 60));
        var latestStart = at.AddMinutes(cue);

        var candidates = await _db.Bookings
            .Where(b => b.CourtId == courtId
                        && b.UserId != null
                        && (b.Status == BookingStatus.Booked || b.Status == BookingStatus.Completed
                            || b.Status == BookingStatus.NoShow || b.Status == BookingStatus.Cancelled)
                        && b.StartsAt >= earliestStart
                        && b.StartsAt <= latestStart)
            .OrderBy(b => b.StartsAt)
            .ToListAsync(ct);

        // The member's bookings whose window — sold, opened a cue early, held a grace late —
        // reaches the scan at all.
        var theirs = new List<Booking>();
        foreach (var b in candidates)
        {
            if (BookingService.OriginalEndsAt(b).AddMinutes(grace) < at) continue;
            if (await players.IsPlayerAsync(b, userId, ct)) theirs.Add(b);
        }

        // A booking whose SOLD window [StartsAt − cue, EndsAt] holds the scan beats one whose
        // grace tail merely reaches it. Back-to-back 17:00 and 18:00 slots used to resolve an
        // 18:02 scan to the 17:00 one — the earliest whose tail was still open — so the member
        // who played at 18:00 was stamped on the slot that had ended and swept a no-show on the
        // one they were standing on. Among those that hold it, the latest that has STARTED is
        // the one being played; a scan inside only a cue window is the earliest upcoming.
        var holding = theirs.Where(b => b.StartsAt.AddMinutes(-cue) <= at && at <= BookingService.OriginalEndsAt(b)).ToList();
        return Pick(holding, at) ?? Pick(theirs.Except(holding).ToList(), at);
    }

    /// <summary>Live before cancelled; then the latest already started at <paramref name="at"/>; else the earliest.</summary>
    private static Booking? Pick(List<Booking> bookings, DateTimeOffset at)
    {
        var live = bookings.Where(b => b.Status != BookingStatus.Cancelled).ToList();
        var pool = live.Count > 0 ? live : bookings;
        return pool.Where(b => b.StartsAt <= at).OrderByDescending(b => b.StartsAt).FirstOrDefault()
            ?? pool.OrderBy(b => b.StartsAt).FirstOrDefault();
    }

    /// <summary>
    /// Charges, checks in and cues the lights — in that order. The identification happened
    /// now; see the overload for one that happened earlier.
    ///
    /// <para>
    /// <paramref name="method"/> is recorded on the audit trail so a dispute can be
    /// answered with how the player identified, not merely that they did.
    /// </para>
    /// </summary>
    public Task<ActivationResult> ActivateAsync(
        Court court,
        Booking booking,
        Guid identifiedUserId,
        Guid? payerOverrideUserId,
        string method,
        CancellationToken ct)
    {
        return ActivateAsync(
            new ActivationRequest(court, booking, identifiedUserId, payerOverrideUserId, method, OccurredAt: null), ct);
    }

    /// <summary>
    /// The same decision for an identification that happened at
    /// <see cref="ActivationRequest.OccurredAt"/> rather than now.
    ///
    /// <para>
    /// A court box decides scans offline and uploads them when the link returns, so the
    /// moment a member identified and the moment the server hears of it can be hours
    /// apart. Judging the scan by the upload clock is wrong in both directions: a scan
    /// made ahead of the cue window was admitted once the window had opened by the time it
    /// arrived, and a scan made inside the window was stamped with an arrival time that
    /// belonged to the WiFi, not the member. The cue gate and <c>CheckedInAt</c> now use
    /// the scan's own time; the lights-on event still measures its remaining duration from
    /// the server clock, because the relay timer the box runs is the box's own.
    /// </para>
    /// </summary>
    public virtual async Task<ActivationResult> ActivateAsync(ActivationRequest request, CancellationToken ct)
    {
        var (court, booking, identifiedUserId, payerOverrideUserId, method, when) = request;
        var now = _clock.GetUtcNow();
        var occurredAt = when ?? now;
        var alreadyActive = booking.CheckedInAt is not null;

        // Too early to light, before anything is charged or stamped.
        //
        // The forward window that FOUND this booking is two hours wide so that back-to-back
        // slices can be told apart; the cue window is the narrower one that says when a
        // scan may actually light the court. The two used to be the same two hours, so a
        // member scanning on their way in at 15:10 for a 17:00 slot was stamped present,
        // cued the lights, and — because CheckedInAt was set — lost their refund if they
        // then cancelled. A live session is never too early: a repeat scan of one falls
        // through to the idempotent branch below whatever the clock says.
        //
        // Compared against the scan's own time, not the upload's: a box that admitted a
        // member ahead of the cue window and uploaded the event once the window had
        // opened was reporting a scan that broke the rule, not one that kept it.
        var settings = await _settings.GetAsync(ct);
        // The CLAMPED reading every other path uses (BookingCodeWindow.CueMinutes): a hand-edited
        // value outside the PUT's bounds must not let the pay-for's search and this gate disagree.
        var cueOpensAt = booking.StartsAt.AddMinutes(-BookingCodeWindow.CueMinutes(settings));
        if (!alreadyActive && occurredAt < cueOpensAt)
        {
            return new ActivationResult.TooEarly(booking, (int)Math.Ceiling((booking.StartsAt - occurredAt).TotalSeconds));
        }

        payerOverrideUserId = await OverrideUnlessSplitAsync(booking.Id, payerOverrideUserId, ct);

        // Charge first. Everything below this line is a consequence of it having worked.
        var charge = await _bookings.ChargeOnActivationAsync(
            bookingId: booking.Id,
            payerOverrideUserId: payerOverrideUserId,
            actorUserId: identifiedUserId,
            ct);

        switch (charge)
        {
            case ChargeResult.InsufficientBalance ib:
                // Refused, loudly and with nothing written. The old code logged this and
                // carried on into the lights.
                _logger.LogWarning(
                    "court {Court}: {Method} identified {User} for booking {Booking} but payer {Payer} has {Current} of {Required} minutes — refused, no lights",
                    court.CourtNumber, method, identifiedUserId, booking.Id, ib.PayerUserId, ib.Current, ib.Required);
                return new ActivationResult.InsufficientBalance(ib.PayerUserId, ib.Current, ib.Required);

            case ChargeResult.NotChargeable:
            case ChargeResult.NotFound:
                return new ActivationResult.NotChargeable();
        }

        var payerUserId = charge switch
        {
            ChargeResult.Ok ok => ok.ChargedUserId,
            _ => booking.PaidByUserId ?? booking.UserId ?? identifiedUserId,
        };

        var amount = charge switch
        {
            ChargeResult.Ok ok => ok.AmountMinutes,
            ChargeResult.AlreadyCharged already => already.AmountMinutes,
            _ => booking.AmountChargedMinutes,
        };

        if (alreadyActive)
        {
            // A second scan of a live session. Idempotent: no second charge (the charge
            // service refuses one), no second event, no re-stamp — except the scanning player's
            // OWN arrival (D11), which is theirs to record once whoever lit the court first.
            await RecordRepeatArrivalAsync(booking.Id, identifiedUserId, occurredAt, ct);
            return new ActivationResult.Activated(booking, payerUserId, amount, AlreadyActive: true);
        }

        // Attendance is when the member identified, which for an uploaded event is the
        // scan and not the upload.
        booking.CheckedInAt = occurredAt;
        await StampPlayerArrivalAsync(booking.Id, identifiedUserId, occurredAt, ct);
        booking.LightsOnCuedAt ??= occurredAt;

        _db.AuditLogs.Add(new AuditLog
        {
            TenantId = _tenant.TenantId,
            ActorUserId = identifiedUserId,
            SubjectUserId = booking.UserId,
            Action = "court.activated",
            DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
            {
                booking_id = booking.Id,
                court_number = court.CourtNumber,
                method,
                payer_user_id = payerUserId,
                amount_minutes = amount,
                occurred_at = occurredAt,
            }),
        });

        // THE SERVER'S BELIEF ABOUT THE RELAY, MOVED HERE AND NOWHERE ELSE ON THIS PATH.
        //
        // This is the one method that stamps CheckedInAt, so it is the one place that can move
        // the belief for the online scan, the walk-up, the kiosk and the box's uploaded event
        // alike — the last of which reaches here through the event route's settlement. Writing
        // it at each caller instead would be four writes that agree until one of them does not.
        //
        // OnUntil is the SOLD end rather than the granted seconds: the grant is clamped by the
        // relay's ninety-minute cap and a member with a two-hour booking is re-lit past it, so
        // a countdown to the cap would tell the control board the court frees at 19:30 when it
        // frees at 20:00 — and an admin would sell the slot twice.
        var lightRow = await _lights.RecordOnAsync(
            new LightEvidence(court.Id, DeviceId: null, Relay: null, Seq: 0, BootId: 0, At: occurredAt),
            BookingService.OriginalEndsAt(booking),
            booking.UserId is null ? LightCause.WalkUp : LightCause.Member,
            identifiedUserId, booking.Id, ct);

        if (lightRow is not null)
        {
            _lights.Audit(
                CourtLightStateService.LightsOnAction, court.Id, court.CourtNumber, booking.UserId,
                // E10-2: whose code lit it — a partner or a pay-for payer on the organiser's booking.
                new { method, payer_user_id = payerUserId, booking_id = booking.Id, occurred_at = occurredAt, identified_user_id = identifiedUserId },
                request.DeviceId);
        }

        // Saved before the event so a failure here cannot leave a cued light with no
        // attendance record. The remaining failure direction — charged, then a crash before
        // this save — leaves the booking looking like a no-show, which the sweep refunds.
        // That is the safe way round.
        await _db.SaveChangesAsync(ct);

        // AFTER the commit, never before it. A court that flashes "on" on a wall screen and
        // then silently reverts because the transaction rolled back is worse than one that is
        // a second late — the club walks to a court nobody is on. Publishing here rather than
        // beside the row write is the whole of that ordering.
        if (lightRow is not null) await _lights.PublishAsync(lightRow, court.CourtNumber, ct);

        // R13: announced under the court's cue lock, AFTER the check-in committed above — so the
        // lights-off sweep either already sees this booking lit (and sends no off over it), or has
        // already sent its off before this on (CourtCueLock).
        await EmitUnderCueLockAsync(court, LightsOnEvent(court, booking, (payerUserId, identifiedUserId), method, now), ct);

        return new ActivationResult.Activated(booking, payerUserId, amount, AlreadyActive: false);
    }

    /// <summary>
    /// D11: a split booking is never re-assigned to one payer at the box — the partners' shares
    /// were paid to the organiser, and moving the whole price to somebody else would leave them
    /// paid to a person who no longer bore the court. The scan still checks the player in.
    ///
    /// <para>
    /// "Split" is <see cref="BookingPlayerQueries.IsSplitAsync"/>: a live partner seat asked for a
    /// share, OR any share row on the booking. A live seat alone missed the booking whose partner
    /// had come off with their return still to be posted — the override then moved the court, and
    /// the return owed on it, onto the volunteer (review M1).
    /// </para>
    /// </summary>
    private async Task<Guid?> OverrideUnlessSplitAsync(Guid bookingId, Guid? payerOverrideUserId, CancellationToken ct)
    {
        if (payerOverrideUserId is null) return null;
        return await BookingPlayerQueries.IsSplitAsync(_db, bookingId, ct) ? null : payerOverrideUserId;
    }

    /// <summary>A repeat scan of a live session still records THIS player's arrival, once.</summary>
    private async Task RecordRepeatArrivalAsync(Guid bookingId, Guid userId, DateTimeOffset at, CancellationToken ct)
    {
        if (await StampPlayerArrivalAsync(bookingId, userId, at, ct)) await _db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// The identified player's own <c>CheckedInAt</c> on their seat, when the booking has seats
    /// and theirs is not yet stamped (<see cref="SeatArrival"/>, the rule the no-show reversal
    /// shares). Staged, not saved. Answers whether anything changed.
    /// </summary>
    private async Task<bool> StampPlayerArrivalAsync(Guid bookingId, Guid userId, DateTimeOffset at, CancellationToken ct)
        => await SeatArrival.StampAsync(_db, bookingId, userId, at, ct) is not null;

    /// <summary>
    /// The single <c>booking.lights_on</c> shape.
    ///
    /// <para>
    /// There were two producers with different payloads — this one and
    /// <c>LightsCueWorker</c>'s, which omitted <c>paid_by_user_id</c> and added
    /// <c>starts_at</c>/<c>ends_at</c>. A webhook URL templated from the admin catalogue
    /// would render for one and hard-fail for the other, because a missing template
    /// variable is a config error rather than a retryable failure.
    /// </para>
    /// </summary>
    /// <para>
    /// Review round 10, E10-2: the actor is the member whose code lit the court — a partner, or a
    /// pay-for payer — never assumed to be the booker; <c>user_id</c> stays the booking's owner and
    /// <c>paid_by_user_id</c> is who actually paid. <c>identified_user_id</c> names the scanner in
    /// the payload too, because a webhook consumer reads <c>data</c>, not the envelope.
    /// </para>
    /// <summary>
    /// Review round 11, E11-3: <c>booking.lights_on</c> for a court a box lit offline whose upload
    /// REVERSED a settled no-show — the "roster fallback uploaded later" the webhooks contract
    /// lists. The reversal goes through the booking service, not <see cref="ActivateAsync"/>, so
    /// it emitted nothing and a consumer mirroring lit courts never heard of that session.
    /// </summary>
    /// <remarks>
    /// R12 E12-3: timed at the SCAN (<paramref name="scannedAt"/>), not the upload — <c>occurred_at</c>
    /// is when the lights came on, and <c>duration_seconds</c> runs from then to the restored end (an
    /// upload after the slot read "duration_seconds": 2 for a 25-minute grant). Its off is
    /// <c>LightsCueWorker</c>'s attended-and-over pass, at the restored end.
    /// </remarks>
    /// <remarks>
    /// R14 E14-4: <b>not sent when a lit survivor already covers it.</b> A collided reversal's restored
    /// session ends where a booking that survived on the court begins; when that survivor is lit (its
    /// own off still to come), the reversed session's off is never said — the survivor's closes the
    /// court (<see cref="LightsCueWorker.NextFreeAsync"/>). Its on, stamped back at the scan and arriving
    /// after the survivor's, would then be an on with no off: a per-booking mirror held it lit for ever.
    /// So it is decided by the same rule, under the same lock, and when skipped the booking's cue is
    /// stamped past its reversal so the attended-and-over pass owes it no off either. Pair or nothing.
    /// </remarks>
    /// <remarks>
    /// R15 D15-2: <b>"covered" means lit at the scan.</b> For a collision the restored end IS the
    /// survivor's start, so a lit survivor was always found there and the on was always suppressed —
    /// even when the survivor was lit minutes AFTER the late scan, leaving the court's dark-to-lit at the
    /// scan unsaid. Now the on is suppressed only when the holder's lit-from (<c>min(StartsAt,
    /// CheckedInAt)</c>) is at or before the scan; otherwise it is sent at the scan, and the survivor's
    /// own off closes the court (court-level pairing, webhooks.md) — this booking is still cue-stamped
    /// so the attended-and-over pass says no second off.
    /// </remarks>
    public async ValueTask EmitReversedLightsOnAsync(
        Court court, Booking booking, (Guid Identified, DateTimeOffset ScannedAt) scan, string method, CancellationToken ct)
    {
        var payer = booking.PaidByUserId ?? booking.UserId ?? scan.Identified;
        // R13: under the court's cue lock, like every lights_on — the reversal committed its check-in first.
        await using var cue = await CourtCueLock.BeginAsync(_db, _tenant.TenantId, court.Id, ct);
        var walk = await LightsCueWorker.WalkAsync(_db, booking, ct);
        // R15 D15-2: covered only when the holder was ALREADY lit at the scan. A survivor lit after it
        // did not cover the scan: the court came on at the scan, so that on is said — and its off is
        // the survivor's, which closes the court (so this booking's own off is still never owed).
        if (walk.Holder is null || LightsCueWorker.LitFrom(walk.Holder) > scan.ScannedAt)
        {
            await _bus.EmitAsync(LightsOnEvent(court, booking, (payer, scan.Identified), method, scan.ScannedAt), ct);
        }
        if (walk.FreeAt is null) await CoveredBySurvivorAsync(booking, ct);
        await cue.CommitAsync(ct);
    }

    /// <summary>
    /// R14 E14-4: the reversed session is announced by nobody — a lit survivor holds the court at its
    /// end — so its cue is stamped at or after its reversal: the relit test (<c>NoShowReversedAt &gt;
    /// LightsOffCuedAt</c>) is false and no off is owed for an on that was never said. Inside the cue
    /// lock, on this booking's row only (the sweep's own order: lock, then row).
    /// </summary>
    private async Task CoveredBySurvivorAsync(Booking booking, CancellationToken ct)
    {
        var now = _clock.GetUtcNow();
        booking.LightsOffCuedAt = booking.NoShowReversedAt is { } reversed && reversed > now ? reversed : now;
        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            // Another writer decided the row since the reversal committed; its decision stands, and
            // at worst the attended-and-over pass says an off nobody announced an on for.
            _logger.LogInformation("Reversal cue stamp for booking {BookingId} lost a concurrent write", booking.Id);
            _db.Entry(booking).State = EntityState.Detached;
        }
    }

    /// <summary>
    /// R13: a <c>booking.lights_on</c> sent while holding the court's <see cref="CourtCueLock"/>, in a
    /// transaction of its own that holds nothing else — the check-in it announces is already committed.
    /// </summary>
    private async Task EmitUnderCueLockAsync(Court court, DomainEvent lightsOn, CancellationToken ct)
    {
        await using var cue = await CourtCueLock.BeginAsync(_db, _tenant.TenantId, court.Id, ct);
        await _bus.EmitAsync(lightsOn, ct);
        await cue.CommitAsync(ct);
    }

    private DomainEvent LightsOnEvent(Court court, Booking booking, (Guid Payer, Guid Identified) who, string method, DateTimeOffset now)
    {
        // Block body, not an expression body. lizard's C# parser mis-scopes any
        // expression-bodied member containing braces and emits a *global* pseudo-function
        // whose reported length is the whole file, tripping -L 200 with a warning that
        // names no real function. Recorded in memory/gotchas.md; the fix is this, not a
        // whitelizard entry.
        return new DomainEvent(
            Id: $"evt_{Guid.NewGuid():N}",
            Type: "booking.lights_on",
            TenantId: _tenant.TenantId,
            TenantSlug: _tenant.TenantSlug,
            OccurredAt: now,
            ActorUserId: who.Identified,
            ActorIsAdmin: false,
            SubjectUserId: booking.UserId,
            Data: new()
            {
                ["booking_id"] = booking.Id,
                ["court_id"] = court.Id,
                ["court_number"] = court.CourtNumber,
                ["court_name"] = court.Name,
                ["user_id"] = booking.UserId,
                ["paid_by_user_id"] = who.Payer,
                ["identified_user_id"] = who.Identified,
                ["starts_at"] = booking.StartsAt,
                ["ends_at"] = booking.EndsAt,
                ["identification_method"] = method,
                ["duration_seconds"] = Math.Max(0, (int)(booking.EndsAt - now).TotalSeconds),
            });
    }
}

/// <summary>
/// Who identified, where, how — and when. <see cref="OccurredAt"/> is null for a scan the
/// server is answering live, and the moment of the scan for one a box decided offline and
/// uploaded later; the cue gate and <c>CheckedInAt</c> are judged against it. Bundled so
/// the six positional arguments the courtside touchpoints pass stay as they are.
/// </summary>
public sealed record ActivationRequest(
    Court Court,
    Booking Booking,
    Guid IdentifiedUserId,
    Guid? PayerOverrideUserId,
    string Method,
    DateTimeOffset? OccurredAt)
{
    /// <summary>
    /// The board the identification was made at, when one was — written on the lights-on audit
    /// row so the night names the box rather than the club's automatic check (review round 6,
    /// E6-8). Null for a kiosk, a PIN pad or a biometric reader the server drives itself.
    /// </summary>
    public Guid? DeviceId { get; init; }
}

/// <summary>
/// The two dependencies <see cref="CourtActivationService"/> needs that are not part of the
/// booking decision: somewhere to log, and the light-state projection to move.
///
/// <para>
/// Bundled rather than listed, for the reason <c>HeartbeatServices</c> and
/// <c>AdjustServices</c> are: the complexity gate caps a constructor at six parameters, and a
/// seventh that is a logger says nothing about how hard this class is to reason about. It is
/// registered in the container beside the service it serves.
/// </para>
/// </summary>
public sealed record ActivationPlumbing(
    ILogger<CourtActivationService> Logger,
    CourtLightStateService Lights,
    /// <summary>The device routes' clock (R14 D14-4). Optional so a hand-built fixture compiles; the container supplies it.</summary>
    TimeProvider? Clock = null);
