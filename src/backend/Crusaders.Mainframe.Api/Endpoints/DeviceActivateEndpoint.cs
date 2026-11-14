using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// A pre-booked member lighting their court from the box.
///
/// <para>
/// This is the mirror of the walk-up and the path that did not exist (review C3). The
/// device surface was provision, heartbeat, events and walk-up; every endpoint that could
/// stamp <c>CheckedInAt</c> for a booking wanted an admin JWT the box cannot present. So a
/// member who paid online stood at a dark court, was refused on the button path by their own
/// booking, and was then swept as a no-show and penalised.
/// </para>
///
/// <para>
/// The box calls this when its cached roster cannot answer a scan. The token is the code
/// the member's phone showed — a booking-activation code names its booking outright, a
/// member-ident code is searched across the box's courts for the earliest activatable
/// booking — and what comes back is what the box puts on the relay timer:
/// <c>granted_seconds</c>, the remainder of the slot clamped to <see cref="RelayHardCap"/>.
/// A repeat scan of a live session answers the remaining seconds, which is also how a slot
/// longer than the relay cap is re-lit past its first ninety minutes.
/// </para>
///
/// <para>
/// Every refusal is a 200 with <c>activated:false</c> and a <c>reason</c>, like the
/// courtside touchpoints: the box has one LCD and needs to tell the member what is wrong,
/// and an error status is indistinguishable from "we do not know who you are".
/// </para>
/// </summary>
public static class DeviceActivateEndpoint
{
    public static async Task<IResult> HandleAsync(
        DeviceActivateRequest req,
        [AsParameters] DeviceActivateServices services,
        CancellationToken ct)
    {
        var (device, refusal) = await DeviceIdentity.ResolveAsync(services.Db, req.Mac, ct, services.Clock);
        if (refusal is not null) return refusal;

        return Results.Ok(await ActivateForDeviceAsync(device!, req, services, ct));
    }

    /// <summary>
    /// The activation decision for an already-authenticated box. Public, and separate from
    /// the HTTP handler, so a test can drive the decision without signing requests.
    /// </summary>
    public static async Task<DeviceActivateResponse> ActivateForDeviceAsync(
        Device device, DeviceActivateRequest req, DeviceActivateServices services, CancellationToken ct)
    {
        var (answer, recognised) = await DecideAsync(device, req, services, ct);
        if (recognised is not { } userId) return answer;

        // Every answer about a member this tenant knows — lit or refused — carries their first name
        // and what they may spend, read AFTER the decision so a charge it made is in the figure. An
        // unrecognised code gets neither: the fields' presence is what "recognised" means on the wire.
        var settings = await services.Settings.GetAsync(ct);
        return answer with
        {
            GreetingName = await MemberDisplay.GreetingNameAsync(services.Db, userId, ct),
            BalanceMinutes = await MemberDisplay.SpendableMinutesAsync(services.Db, userId, settings, services.Clock.GetUtcNow(), ct),
        };
    }

    /// <summary>The decision itself, and the member it was about when the code resolved to one.</summary>
    private static async Task<(DeviceActivateResponse Answer, Guid? UserId)> DecideAsync(
        Device device, DeviceActivateRequest req, DeviceActivateServices services, CancellationToken ct)
    {
        var now = services.Clock.GetUtcNow();

        // A box asking this question is a box that is reporting (finding L-F5). Recorded
        // before the decision, and on every branch including the refusals — see
        // DeviceSilenceLog.NoteContactAsync for what judging a working box "silent" cost.
        await DeviceSilenceLog.NoteContactAsync(services.Db, device, await services.Settings.GetAsync(ct), now, ct);

        // A door starts nothing. A gate arriving here has no court to light and no booking to
        // stamp, and it must not be refused by the accident of having an empty court list —
        // see GateAccess.NotACourtBox. 200 with activated:false, like every other refusal on
        // this path, so a misflashed board shows it and stops.
        if (device.Kind != DeviceKind.CourtBox) return (Refused(GateAccess.NotACourtBox), null);

        // Same rule as the walk-up: only a method that identifies a member globally. A PIN
        // against the whole roll is an oracle, not an identification.
        if (!IdentificationResolver.CanIdentifyGlobally(req.Method)) return (Refused("not_recognised"), null);

        // A v1 member code (19 characters) is CHECKED — both halves, at the instant the box read
        // it — and then identifies its member exactly as an ident code does (member-code §4). A
        // legacy code resolves as it always has, until the club's cut-off refuses it.
        var settings = await services.Settings.GetAsync(ct);
        var (resolved, match) = await MemberCodeIdentity.ResolveAsync(
            services.Codes, services.MemberCodes, new ScannedCode(req.Token, req.ScanAgeMs), settings, now, ct);
        if (resolved is null) return (Refused("not_recognised"), null);

        // Resolved ONCE, here, and carried onto every branch below including the refusals.
        // The box paints the member's card before it knows the outcome, so a refusal without a
        // name is a screen that greets a member the club knows perfectly well as a stranger.
        var display = await MemberDisplay.ForAsync(services.Db, resolved.UserId, ct);

        // A member the club has barred opens nothing here (finding K-F1, second door). The
        // ident-code branch below already answered "no booking" for one, because it searches
        // through CourtActivationService.FindForUserAsync and that filters them out — but the
        // BOOKING-code branch looks its booking up by id and never met that filter, so a
        // suspended member's own booking code lit their court and charged them. Tested once
        // here rather than in ForBookingCodeAsync so the two branches cannot drift again.
        //
        // "no_booking" rather than a named refusal, matching the ident branch and the
        // reasoning CourtActivationService.CandidatesAsync records: the member was told why
        // by email, and a box that named the reason would be announcing it to whoever is
        // standing at the court.
        var who = new Refusing(device, resolved.UserId, req.Method, match, display)
        {
            // R11 E11-4: the court the box said it was asked at, when it is one of the box's.
            ReportedCourt = req.Court is { } asked && device.CourtNumbers.Contains(asked) ? asked : null,
        };
        if (await MembershipAccess.IsBarredFromCourtsAsync(services.Db, resolved.UserId, ct))
        {
            return (await BookingRefusalAsync(new Found(null, null, "no_booking"), who, services, ct), resolved.UserId);
        }

        // A court named in the request narrows the search, and must be one of this box's.
        if (req.Court is { } narrowed && !device.CourtNumbers.Contains(narrowed))
        {
            return (await BookingRefusalAsync(new Found(null, null, "wrong_court"), who, services, ct), resolved.UserId);
        }

        var found = resolved.Purpose == AccessCodePurpose.BookingActivation
            ? await ForBookingCodeAsync(device, req, resolved, services, now, ct)
            : await ForIdentCodeAsync(device, req, resolved, services, now, ct);

        if (found.Reason is not null) return (await BookingRefusalAsync(found, who, services, ct), resolved.UserId);

        // One acting use per code per class (§4.4): claimed before the court is lit, given back
        // below if it is not. A used code is a DECISION — `code_used` — never a second opinion.
        //
        // MCV1-02 (member-code §13): a repeat activation of the session already lit by THIS box on
        // THIS court is answered as before — a re-grant — but writes no court use, so the member's
        // rescan-then-extend at their own lit court can still buy with the same code. It adds no
        // purchase a photo of the code could not already make there: an unused step at the
        // victim's own lit court can already buy an extension directly.
        var (used, claim) = await ClaimUnlessRepeatAsync(match, found.Booking!, device, services, now, ct);
        if (used) return (await CodeUsedAsync(found.Court, who, services), resolved.UserId);

        // Given back if the activation THROWS, too: a claim stranded by a 500 refused the member's
        // own code as `code_used` for the rest of its window, at a court that never lit.
        ActivationResult result;
        try
        {
            result = await services.Activation.ActivateAsync(
                // R14 D14-4: decided at the instant the code was checked, never a second wall-clock read.
                new ActivationRequest(found.Court!, found.Booking!, resolved.UserId, PayerOverrideUserId: null, req.Method!, OccurredAt: now)
                {
                    DeviceId = device.Id,
                },
                ct);
        }
        catch
        {
            await services.MemberCodes.ReleaseAsync(claim);
            throw;
        }

        var answer = From(result, found.Court!, now, display);
        if (!answer.Activated) await services.MemberCodes.ReleaseAsync(claim);
        else
        {
            // FSF-05 (device-api.md §9): the UNCAPPED time to the end of the chained run beside the
            // capped grant, so a 105-minute booking activated online is not dark at minute 90.
            var end = await RelayRestorePlan.ChainEndAsync(services.Db, found.Booking!, ct);
            answer = answer with { PlayRemainingSeconds = Math.Max(answer.GrantedSeconds, (int)Math.Min(int.MaxValue, Math.Floor((end - now).TotalSeconds))) };
        }

        // A scan the API would not act on, onto the club's monitoring page. Only from here
        // down: the refusals above this line are a board asking a question it should not have
        // asked (a gate on a court route, a method that identifies nobody), which is a
        // firmware fact rather than a club one. THIS one is a member standing at a court that
        // did not come on, which is the sentence an admin needs.
        if (!answer.Activated) services.Faults.ActivationRefused(device, answer.Reason);

        return (answer, resolved.UserId);
    }

    private sealed record Found(Booking? Booking, Court? Court, string? Reason);

    /// <summary>The court-use claim — none for a repeat activation of the session lit here (MCV1-02), whose code is still refused if it bought something.</summary>
    private static async Task<(bool Used, MemberCodeClaim? Claim)> ClaimUnlessRepeatAsync(
        MemberCodeMatch? match, Booking booking, Device device, DeviceActivateServices services, DateTimeOffset now, CancellationToken ct)
    {
        if (match is null || !await IsLitHereAsync(booking, device, now, services, ct)) return await ClaimCourtUseAsync(match, device, services, ct);
        return (await services.MemberCodes.IsUsedAsync(match, MemberCodeUseClass.Money, ct), null);
    }

    /// <summary>Whether <paramref name="booking"/> is checked in and its court is believed lit by this very box for it (MCV1-02).</summary>
    private static async Task<bool> IsLitHereAsync(
        Booking booking, Device device, DateTimeOffset now, DeviceActivateServices services, CancellationToken ct)
    {
        if (booking.CheckedInAt is null || booking.EndsAt <= now) return false;
        // The online grant records its light with no device (the server lit it, not a relay report);
        // a box's own evidence names this box. Either is "lit here": the booking was found among this
        // box's courts, so its court is one this box drives.
        return await services.Db.CourtLightStates.AsNoTracking().AnyAsync(l =>
            l.CourtId == booking.CourtId && l.State == LightState.On && (l.DeviceId == null || l.DeviceId == device.Id)
            && l.BookingId == booking.Id && (l.OnUntil == null || l.OnUntil > now), ct);
    }

    /// <summary>
    /// The court use for a v1 code: <c>Used</c> when the code may not light a court, else the
    /// claim (null for a legacy code, which has no use table). A code that has already BOUGHT
    /// something at this step lights nothing (review round 8, D8-1, the other direction): its
    /// court class is unspent, so a photo of the code that bought a walk-up or paid for a court at
    /// one box lit the member's own booking at another. The mirror of money's court check; the
    /// door is still another class.
    /// </summary>
    private static async Task<(bool Used, MemberCodeClaim? Claim)> ClaimCourtUseAsync(
        MemberCodeMatch? match, Device device, DeviceActivateServices services, CancellationToken ct)
    {
        if (match is null) return (false, null);
        if (await services.MemberCodes.IsUsedAsync(match, MemberCodeUseClass.Money, ct)) return (true, null);
        var claim = await services.MemberCodes.TryClaimAsync(match, MemberCodeUseClass.Court, device.Id, "activate", ct);
        return (claim is null, claim);
    }

    /// <summary>
    /// A refusal decided before the use table — no booking here, wrong court, ended — or
    /// <c>code_used</c> when the v1 code has already been acted on for a court or for money (review
    /// round 8, D8-1). The box arms its buttons for a booking refusal, so that a member with no
    /// booking can buy; for a photo of a code that lit a court at another box, or bought something,
    /// that window's only use was buying on the victim's minutes. <c>code_used</c> arms nothing.
    /// </summary>
    private static async Task<DeviceActivateResponse> BookingRefusalAsync(
        Found found, Refusing who, DeviceActivateServices services, CancellationToken ct)
    {
        if (who.Match is not null
            && await services.MemberCodes.IsUsedAsync(who.Match, MemberCodeUseClass.CourtOrMoney, ct))
        {
            return await CodeUsedAsync(found.Court, who, services);
        }
        return Refused(found.Reason!, found.Court, who.Display);
    }

    /// <summary>The member a refusal is about, once their code resolved — and how the box asked.</summary>
    private sealed record Refusing(Device Device, Guid UserId, string? Method, MemberCodeMatch? Match, string? Display)
    {
        /// <summary>The court the box reported, kept for a refusal that found no booking to name one (R11 E11-4).</summary>
        public int? ReportedCourt { get; init; }
    }

    /// <summary>
    /// <c>code_used</c>, written on the member's record first (review round 9, E9-6) — the door's
    /// refusal of the same code always was, and the Night showed nothing at either court. With no
    /// booking found the court is the one the box reported (R11 E11-4): it sent court 2 and the
    /// row said "a court".
    /// </summary>
    private static async Task<DeviceActivateResponse> CodeUsedAsync(Court? court, Refusing who, DeviceActivateServices services)
    {
        await services.Faults.CodeUsedAtCourtAsync(who.Device, who.UserId, court?.CourtNumber ?? who.ReportedCourt, "activate", who.Method);
        return Refused(MemberCodeIdentity.CodeUsed, court, who.Display);
    }

    /// <summary>
    /// A booking-activation code names its booking; the only questions are whether that
    /// booking is on one of this box's courts (and the named one, if the request named one)
    /// and whether it is inside the activation window at all.
    /// </summary>
    private static async Task<Found> ForBookingCodeAsync(
        Device device, DeviceActivateRequest req, ResolvedAccessCode resolved,
        DeviceActivateServices services, DateTimeOffset now, CancellationToken ct)
    {
        // Matched WITHOUT a status filter, then judged. Filtering on `Status == Booked` in
        // the query made every closed booking indistinguishable from a code that names
        // nothing at all, which is what put NO BOOKING on the glass for the one case
        // SLOT ENDED exists to cover: LightsCueWorker promotes an attended booking to
        // Completed within fifteen seconds of its end, and the sweeper moves an unattended
        // one to NoShow, so a member arriving two minutes late — code still valid, it lives
        // until slot end plus grace — was told there was no booking behind it.
        var booking = await services.Db.Bookings
            .FirstOrDefaultAsync(b => b.Id == resolved.BookingId, ct);
        if (booking is null) return new Found(null, null, "no_booking");

        var court = await services.Db.Courts.FirstOrDefaultAsync(c => c.Id == booking.CourtId && c.IsActive, ct);
        if (court is null) return new Found(null, null, "no_booking");

        if (!device.CourtNumbers.Contains(court.CourtNumber)) return new Found(null, court, "wrong_court");
        if (req.Court is { } named && named != court.CourtNumber) return new Found(null, court, "wrong_court");

        // Closed out and over: SLOT ENDED, the screen `docs/court-lights-flows.html`
        // promises and `ScanFlow.cpp` already maps. Refused here rather than through the
        // activation service, because a booking the sweep has finished with must not be
        // charged, stamped or lit — `ended` is a message, not an activation.
        //
        // A CANCELLED booking is deliberately not this: nothing was ever going to happen
        // on that court, so "no booking behind this code" is the true sentence. An
        // AdminBlock is not a member's booking at all and falls through the same way.
        if (booking.Status is BookingStatus.Completed or BookingStatus.NoShow && booking.EndsAt <= now)
        {
            return new Found(null, court, "ended");
        }

        if (booking.Status != BookingStatus.Booked) return new Found(null, court, "no_booking");

        // The code outlives the window — it is valid until the slot ends plus grace — but a
        // booking days away is not something a scan can act on. Outside the forward window
        // it is no booking as far as the box is concerned; inside it but ahead of the cue
        // window, activation answers too_early with when to come back.
        var (start, end) = await services.Activation.WindowAsync(now, ct);
        if (booking.StartsAt >= end || booking.EndsAt <= start) return new Found(null, court, "no_booking");

        return new Found(booking, court, null);
    }

    /// <summary>
    /// A member-ident code names nobody's booking, so the member's earliest activatable
    /// booking across the box's courts — or the one court the request named — is the one
    /// they are standing on. Earliest, not first: back-to-back slices are ordinary, and the
    /// live one always starts before the future one.
    /// </summary>
    private static async Task<Found> ForIdentCodeAsync(
        Device device, DeviceActivateRequest req, ResolvedAccessCode resolved,
        DeviceActivateServices services, DateTimeOffset now, CancellationToken ct)
    {
        var courtNumbers = req.Court is { } named ? [named] : device.CourtNumbers;
        var courts = await services.Db.Courts
            .Where(c => courtNumbers.Contains(c.CourtNumber) && c.IsActive)
            .ToListAsync(ct);

        Booking? earliest = null;
        Court? on = null;
        foreach (var court in courts)
        {
            var candidate = await services.Activation.FindForUserAsync(court.Id, resolved.UserId, now, ct);
            if (candidate is null || (earliest is not null && candidate.StartsAt >= earliest.StartsAt)) continue;
            earliest = candidate;
            on = court;
        }

        return earliest is null ? new Found(null, null, "no_booking") : new Found(earliest, on, null);
    }

    // Block bodies rather than expression bodies: lizard's C# parser mis-scopes an
    // expression-bodied member containing braces into a *global* pseudo-function the
    // length of the file — see memory/gotchas.md.
    private static DeviceActivateResponse From(
        ActivationResult result, Court court, DateTimeOffset now, string? display)
    {
        return result switch
        {
            // Identified, stamped — and nothing left to light. A scan inside the grace
            // window after the slot's end is still attendance (it stops the sweep), but
            // granted_seconds:0 with activated:true became a one-second relay pulse and a
            // spent scan on the box; the box needs to be told the slot is over.
            ActivationResult.Activated ended when ended.Booking.EndsAt <= now => new DeviceActivateResponse(
                Activated: false,
                Reason: "ended",
                CourtNumber: court.CourtNumber,
                BookingId: ended.Booking.Id,
                GrantedSeconds: 0,
                StartsInSeconds: null,
                MemberDisplay: display),

            // The remainder of the slot, clamped to what the relay bank will actually hold.
            // A repeat scan of a live session lands here too, with whatever is left — which
            // is how a slot longer than the cap is re-lit past its first ninety minutes.
            ActivationResult.Activated a => new DeviceActivateResponse(
                Activated: true,
                Reason: "ok",
                CourtNumber: court.CourtNumber,
                BookingId: a.Booking.Id,
                GrantedSeconds: Math.Clamp((int)Math.Floor((a.Booking.EndsAt - now).TotalSeconds), 1, RelayHardCap.Seconds),
                StartsInSeconds: null,
                MemberDisplay: display),

            ActivationResult.TooEarly early => new DeviceActivateResponse(
                Activated: false,
                Reason: "too_early",
                CourtNumber: court.CourtNumber,
                BookingId: early.Booking.Id,
                GrantedSeconds: 0,
                StartsInSeconds: early.StartsInSeconds,
                MemberDisplay: display),

            ActivationResult.InsufficientBalance => Refused("insufficient_balance", court, display),
            ActivationResult.NoBooking => Refused("no_booking", court, display),
            _ => Refused("not_chargeable", court, display),
        };
    }

    private static DeviceActivateResponse Refused(
        string reason, Court? court = null, string? display = null)
    {
        return new DeviceActivateResponse(
            Activated: false,
            Reason: reason,
            CourtNumber: court?.CourtNumber,
            BookingId: null,
            GrantedSeconds: 0,
            StartsInSeconds: null,
            MemberDisplay: display);
    }
}

/// <summary>The services the activation handler needs, bundled — see <see cref="WalkUpServices"/>.</summary>
public sealed record DeviceActivateServices(
    MainframeDbContext Db,
    AccessCodeService Codes,
    CourtActivationService Activation,
    TenantSettingsAccessor Settings,
    /// <summary>Where a refused scan is recorded for the club's monitoring page. See <see cref="DeviceFaultSink"/>.</summary>
    DeviceFaultSink Faults,
    /// <summary>The v1 member-code check and its use table (member-code §4).</summary>
    MemberCodeService MemberCodes,
    /// <summary>The instant the decision is taken at, and so the member-code step it checks — see <see cref="GateServices.Clock"/>.</summary>
    TimeProvider Clock);

/// <summary>
/// What a box sends when a scan needs the server. <c>mac</c> names the board;
/// <c>court</c> is optional narrowing — the court NUMBER the member selected, if they
/// selected one — and must be one of the box's.
/// </summary>
public sealed record DeviceActivateRequest(
    [property: JsonPropertyName("mac")] string? Mac,
    [property: JsonPropertyName("method")] string? Method,
    [property: JsonPropertyName("token")] string? Token,
    [property: JsonPropertyName("court")] int? Court,
    /// <summary>How long ago the scanner read a v1 token, ms (member-code §4.2). Absent means 0; a legacy body never carries it.</summary>
    [property: JsonPropertyName("scan_age_ms")] long? ScanAgeMs = null)
{
    /// <summary>R15 D15-1: read through <see cref="DeviceBody"/> — lenient UTF-8, 400 <c>malformed_body</c> for anything not JSON.</summary>
    public static ValueTask<DeviceActivateRequest> BindAsync(HttpContext ctx) => DeviceBody.ReadAsync<DeviceActivateRequest>(ctx);
}

/// <summary>
/// The activation answer. <c>granted_seconds</c> is what goes on the relay timer; zero on
/// every refusal, and a refusal — <c>reason:"ended"</c> — is what a slot with nothing left
/// answers, never <c>activated:true</c> with zero seconds. Pinned by
/// <c>activate-response-ok</c>, <c>activate-response-too-early</c> and
/// <c>activate-response-ended</c> in the shared corpus.
/// </summary>
public sealed record DeviceActivateResponse(
    [property: JsonPropertyName("activated")] bool Activated,
    [property: JsonPropertyName("reason")] string Reason,
    [property: JsonPropertyName("court_number")][property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? CourtNumber,
    [property: JsonPropertyName("booking_id")][property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Guid? BookingId,
    [property: JsonPropertyName("granted_seconds")] int GrantedSeconds,
    [property: JsonPropertyName("starts_in_seconds")][property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)][property: JsonPropertyOrder(1)] int? StartsInSeconds,
    /// <summary>
    /// The member's name for the LCD's greeting line, at most
    /// <see cref="MemberDisplay.MaxLength"/> characters — GOAL item 4.
    ///
    /// <para>
    /// Present on EVERY response where the API resolved a member, refusals included, because
    /// the box paints the name card BEFORE it knows the outcome: "HI PRIYA — no booking found"
    /// is a sentence, and "HI THERE — no booking found" to a member the club knows perfectly
    /// well is the software looking broken at the worst moment.
    /// </para>
    ///
    /// <para>
    /// Omitted when nobody was identified, which is exactly the existing <c>not_recognised</c>
    /// case surfaced as copy. Last in the record so the field is purely additive on the wire.
    /// </para>
    /// </summary>
    [property: JsonPropertyName("member_display")][property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)][property: JsonPropertyOrder(1)] string? MemberDisplay = null)
{
    /// <summary>
    /// The member's FIRST name for the box's greeting (<see cref="Services.MemberDisplay.GreetingNameAsync"/>):
    /// ASCII, upper-case, at most 16 characters, empty when the club has no name on file. Present on
    /// every answer whose code resolved to a member of this tenant, lit or refused; absent otherwise.
    /// </summary>
    [JsonPropertyName("greeting_name")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonPropertyOrder(1)]
    public string? GreetingName { get; init; }

    /// <summary>
    /// Device contract v3 §9 (FSF-05): the UNCAPPED seconds to the end of the chained run of
    /// checked-in bookings on this court, beside <see cref="GrantedSeconds"/> (capped at 5400 for
    /// the relay). A v3 bridge arms its re-light from this, falling back to the grant when it is
    /// absent (every 2.x server). Present only on a grant. Ordered right after the grant
    /// (<c>v3-activate-response-play-remaining</c>), before the greeting.
    /// </summary>
    [JsonPropertyName("play_remaining_seconds")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? PlayRemainingSeconds { get; init; }

    /// <summary>
    /// What that member may spend now, in whole minutes — the ledger sum less held shares, read after
    /// the decision. Present exactly when <see cref="GreetingName"/> is.
    /// </summary>
    [JsonPropertyName("balance_minutes")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    [JsonPropertyOrder(1)]
    public int? BalanceMinutes { get; init; }
}
