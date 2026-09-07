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
        var (device, refusal) = await DeviceIdentity.ResolveAsync(services.Db, req.Mac, ct);
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
        var now = DateTimeOffset.UtcNow;

        // A box asking this question is a box that is reporting (finding L-F5). Recorded
        // before the decision, and on every branch including the refusals — see
        // DeviceSilenceLog.NoteContactAsync for what judging a working box "silent" cost.
        await DeviceSilenceLog.NoteContactAsync(services.Db, device, await services.Settings.GetAsync(ct), now, ct);

        // Same rule as the walk-up: only a method that identifies a member globally. A PIN
        // against the whole roll is an oracle, not an identification.
        if (!IdentificationResolver.CanIdentifyGlobally(req.Method)) return Refused("not_recognised");

        // Tenant-filtered by the context's global query filter, so a code minted at another
        // club resolves to nothing here — the isolation is structural, not a claim compared.
        var resolved = await services.Codes.ResolveAsync(req.Token, ct);
        if (resolved is null) return Refused("not_recognised");

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
        if (await MembershipAccess.IsBarredFromCourtsAsync(services.Db, resolved.UserId, ct))
        {
            return Refused("no_booking");
        }

        // A court named in the request narrows the search, and must be one of this box's.
        if (req.Court is { } narrowed && !device.CourtNumbers.Contains(narrowed)) return Refused("wrong_court");

        var found = resolved.Purpose == AccessCodePurpose.BookingActivation
            ? await ForBookingCodeAsync(device, req, resolved, services, now, ct)
            : await ForIdentCodeAsync(device, req, resolved, services, now, ct);

        if (found.Reason is not null) return Refused(found.Reason, found.Court);

        var result = await services.Activation.ActivateAsync(
            found.Court!, found.Booking!, resolved.UserId, payerOverrideUserId: null, req.Method!, ct);

        return From(result, found.Court!, now);
    }

    private sealed record Found(Booking? Booking, Court? Court, string? Reason);

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
    private static DeviceActivateResponse From(ActivationResult result, Court court, DateTimeOffset now)
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
                StartsInSeconds: null),

            // The remainder of the slot, clamped to what the relay bank will actually hold.
            // A repeat scan of a live session lands here too, with whatever is left — which
            // is how a slot longer than the cap is re-lit past its first ninety minutes.
            ActivationResult.Activated a => new DeviceActivateResponse(
                Activated: true,
                Reason: "ok",
                CourtNumber: court.CourtNumber,
                BookingId: a.Booking.Id,
                GrantedSeconds: Math.Clamp((int)Math.Floor((a.Booking.EndsAt - now).TotalSeconds), 1, RelayHardCap.Seconds),
                StartsInSeconds: null),

            ActivationResult.TooEarly early => new DeviceActivateResponse(
                Activated: false,
                Reason: "too_early",
                CourtNumber: court.CourtNumber,
                BookingId: early.Booking.Id,
                GrantedSeconds: 0,
                StartsInSeconds: early.StartsInSeconds),

            ActivationResult.InsufficientBalance => Refused("insufficient_balance", court),
            ActivationResult.NoBooking => Refused("no_booking", court),
            _ => Refused("not_chargeable", court),
        };
    }

    private static DeviceActivateResponse Refused(string reason, Court? court = null)
    {
        return new DeviceActivateResponse(
            Activated: false,
            Reason: reason,
            CourtNumber: court?.CourtNumber,
            BookingId: null,
            GrantedSeconds: 0,
            StartsInSeconds: null);
    }
}

/// <summary>The services the activation handler needs, bundled — see <see cref="WalkUpServices"/>.</summary>
public sealed record DeviceActivateServices(
    MainframeDbContext Db,
    AccessCodeService Codes,
    CourtActivationService Activation,
    TenantSettingsAccessor Settings);

/// <summary>
/// What a box sends when a scan needs the server. <c>mac</c> names the board;
/// <c>court</c> is optional narrowing — the court NUMBER the member selected, if they
/// selected one — and must be one of the box's.
/// </summary>
public sealed record DeviceActivateRequest(
    [property: JsonPropertyName("mac")] string? Mac,
    [property: JsonPropertyName("method")] string? Method,
    [property: JsonPropertyName("token")] string? Token,
    [property: JsonPropertyName("court")] int? Court);

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
    [property: JsonPropertyName("starts_in_seconds")][property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? StartsInSeconds);
