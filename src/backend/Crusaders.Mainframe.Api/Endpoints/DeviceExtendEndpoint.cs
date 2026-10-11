using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Extending play on a lit court at the box — <c>POST /api/v1/device/extend</c>.
///
/// <para>
/// <b>Anyone recognised may extend whatever is in play, on their own minutes.</b> Any member of
/// the tenant who is not barred scans at the box and asks for N more minutes on a court number the
/// box drives. The session in play there (and any extension already chained onto it) is found; the
/// extension is a NEW booking for the scanner that starts exactly at its end, truncated at the next
/// booking and at closing, charged like a walk-up of that length at that time, and checked in at
/// creation (<see cref="BookingService.CreateExtensionAsync"/>) so it is never a no-show.
/// </para>
///
/// <para>
/// <b>The walk-up's wire, deliberately.</b> Same device auth, same JSON error envelope and statuses,
/// the same member-code money claim and the same nonce idempotency — under
/// <c>extend:{device}:{nonce}</c>, so a retry after a lost answer gets the first grant back with
/// <c>replayed:true</c> and is never charged twice.
/// </para>
/// </summary>
public static class DeviceExtendEndpoint
{
    public const string CourtNotLit = "court_not_lit";
    public const string NoTimeAvailable = "no_time_available";
    public const string InsufficientBalance = "insufficient_balance";
    public const string CourtNotOnDevice = "court_not_on_device";

    /// <summary>
    /// The audit row naming which session an extension extended. Declared in
    /// <see cref="TraceKinds.NotAPersonsNight"/>: the extension's own <c>booking.walk_up_created</c>
    /// row already tells the scanner's Night.
    /// </summary>
    public const string ExtendedAction = "court.extended";

    /// <summary>Longest extension accepted — the relay bank's hard cap.</summary>
    public const int MaxMinutes = 90;

    /// <summary>How many already-lit extensions are followed past the session in play before giving up.</summary>
    private const int MaxChain = 16;

    /// <summary>The ledger reference one extension from one box is posted under, retries included.</summary>
    public static string Reference(Guid deviceId, string nonce) => $"extend:{deviceId:N}:{nonce}";

    public static async Task<IResult> HandleAsync(ExtendRequest req, [AsParameters] ExtendServices services, CancellationToken ct)
    {
        var (device, refusal) = await DeviceIdentity.ResolveAsync(services.Db, req.Mac, ct, services.Clock);
        if (refusal is not null) return refusal;
        return await ExtendForDeviceAsync(device!, req, services, ct);
    }

    /// <summary>The extension decision for an already-authenticated box. Public so a test can drive it unsigned.</summary>
    public static async Task<IResult> ExtendForDeviceAsync(Device device, ExtendRequest req, ExtendServices services, CancellationToken ct)
    {
        var db = services.Db;
        var now = services.Clock.GetUtcNow();
        var settings = await services.Settings.GetAsync(ct);
        await DeviceSilenceLog.NoteContactAsync(db, device, settings, now, ct);

        if (device.Kind != DeviceKind.CourtBox) return Results.BadRequest(new { error = GateAccess.NotACourtBox });

        if (string.IsNullOrWhiteSpace(req.Nonce)) return Results.BadRequest(new { error = "nonce_required" });
        if (req.Nonce.Length > DeviceEventEndpoints.MaxNonceLength)
        {
            return Results.BadRequest(new { error = "nonce_too_long", max_length = DeviceEventEndpoints.MaxNonceLength });
        }
        var reference = Reference(device.Id, req.Nonce);

        // Replay first, ungated, as the walk-up does: a retry of a purchase already made is answered
        // with that purchase, never refused for something that changed since.
        if (await ReplayAsync(reference, services, ct) is { } replayed) return replayed;

        if (RefuseFields(device, req) is { } badRequest) return badRequest;

        var court = await db.Courts.FirstOrDefaultAsync(c => c.CourtNumber == req.Court && c.IsActive, ct);
        if (court is null) return Results.NotFound(new { error = "court_not_found" });

        var (userId, match) = await BuyerAsync(req, services, settings, now, ct);
        if (userId is null) return Results.BadRequest(new { error = "not_recognised" });
        // Barred: `not_recognised`, the walk-up's answer for the walk-up's reasons (finding K-F1).
        if (await MembershipAccess.IsBarredFromCourtsAsync(db, userId.Value, ct))
        {
            return Results.BadRequest(new { error = "not_recognised" });
        }

        var inPlay = await InPlayEndAsync(db, court.Id, now, ct);
        if (inPlay is not { } play)
        {
            services.Faults.WalkUpRefused(device, "extend:" + CourtNotLit);
            return Results.Conflict(new { error = CourtNotLit });
        }

        // One money use per code (§4.4), exactly as the walk-up claims it: a code that has lit a
        // court at this step buys nothing, and a retry of this nonce re-enters its own claim.
        MemberCodeClaim? claim = null;
        if (match is not null)
        {
            if (!await services.MemberCodes.IsUsedAsync(match, MemberCodeUseClass.Court, ct))
            {
                claim = await services.MemberCodes.TryClaimAsync(
                    match, MemberCodeUseClass.Money, device.Id, "extend", ct, claimKey: "extend:" + req.Nonce);
            }
            if (claim is null)
            {
                await services.Faults.CodeUsedAtCourtAsync(device, userId.Value, court.CourtNumber, "extend", req.Method);
                return Results.Conflict(new { error = MemberCodeIdentity.CodeUsed });
            }
        }

        return await SellAsync(new Extension(device, req, court, userId.Value, play, reference, claim), services, ct);
    }

    private sealed record Extension(
        Device Device, ExtendRequest Req, Court Court, Guid UserId, (Booking Booking, DateTimeOffset EndsAt) InPlay,
        string Reference, MemberCodeClaim? Claim);

    private static async Task<IResult> SellAsync(Extension x, ExtendServices services, CancellationToken ct)
    {
        var db = services.Db;
        BookingResult created;
        try
        {
            created = await services.Bookings.CreateExtensionAsync(
                x.Court.Id, x.UserId, x.InPlay.EndsAt, x.Req.Minutes, x.Reference, ct);
        }
        catch
        {
            if (!await db.LedgerEntries.AsNoTracking().AnyAsync(l => l.ExternalReference == x.Reference))
            {
                await services.MemberCodes.ReleaseAsync(x.Claim);
            }
            throw;
        }

        // A twin of this request in flight committed first: its purchase is the answer.
        if (created is not BookingResult.Ok && await ReplayAsync(x.Reference, services, ct) is { } original) return original;

        if (created is not BookingResult.Ok ok)
        {
            await services.MemberCodes.ReleaseAsync(x.Claim);
            var (reason, refusal) = Refusal(created);
            services.Faults.WalkUpRefused(x.Device, "extend:" + reason);
            return refusal;
        }

        await services.MemberCodes.HoldAgainAsync(x.Claim, ct);

        // The audit row naming what was extended (CommitAsync wrote the booking's own, actor and
        // subject the scanner), and the control board's belief of when the court frees moved on.
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = ok.Booking.TenantId,
            ActorUserId = x.UserId,
            SubjectUserId = x.UserId,
            Action = ExtendedAction,
            DetailsJson = JsonSerializer.Serialize(new
            {
                booking_id = ok.Booking.Id,
                extends_booking_id = x.InPlay.Booking.Id,
                court_number = x.Court.CourtNumber,
                minutes = ok.Booking.SliceMinutes,
                method = x.Req.Method,
                device_id = x.Device.Id,
            }),
        });
        var light = await services.Lights.ExtendOnUntilAsync(x.Court.Id, ok.Booking.EndsAt, ct);
        await db.SaveChangesAsync(ct);
        if (light is not null) await services.Lights.PublishAsync(light, x.Court.CourtNumber, ct);

        return Results.Ok(await GrantAsync(db, ok.Booking, ok.Booking.AmountChargedMinutes, ok.BalanceAfterMinutes, false, ct));
    }

    /// <summary>
    /// When play on this court ends: the non-cancelled booking spanning now, followed through any
    /// LIT bookings chained exactly onto its end (earlier extensions). Null when nothing is in play.
    /// </summary>
    private static async Task<(Booking Booking, DateTimeOffset EndsAt)?> InPlayEndAsync(
        MainframeDbContext db, Guid courtId, DateTimeOffset now, CancellationToken ct)
    {
        var current = await db.Bookings.AsNoTracking()
            .Where(b => b.CourtId == courtId
                && b.Status != BookingStatus.Cancelled && b.Status != BookingStatus.AdminBlock
                && b.StartsAt <= now && b.EndsAt > now)
            .OrderByDescending(b => b.EndsAt)
            .FirstOrDefaultAsync(ct);
        if (current is null) return null;

        var end = current.EndsAt;
        for (var i = 0; i < MaxChain; i++)
        {
            var at = end;
            var chained = await db.Bookings.AsNoTracking()
                .Where(b => b.CourtId == courtId && b.StartsAt == at && b.CheckedInAt != null
                    && b.Status != BookingStatus.Cancelled && b.Status != BookingStatus.AdminBlock)
                .OrderByDescending(b => b.EndsAt)
                .FirstOrDefaultAsync(ct);
            if (chained is null) break;
            end = chained.EndsAt;
        }
        return (current, end);
    }

    private static async Task<(Guid? UserId, MemberCodeMatch? Match)> BuyerAsync(
        ExtendRequest req, ExtendServices services, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        if (!IdentificationResolver.CanIdentifyGlobally(req.Method)) return (null, null);
        var (resolved, match) = await MemberCodeIdentity.ResolveAsync(
            services.Codes, services.MemberCodes, new ScannedCode(req.Token, req.ScanAgeMs), settings, now, ct);
        return resolved?.Purpose == AccessCodePurpose.MemberIdent ? (resolved.UserId, match) : (null, null);
    }

    private static IResult? RefuseFields(Device device, ExtendRequest req)
    {
        if (req.Minutes < 1 || req.Minutes > MaxMinutes)
        {
            return Results.BadRequest(new { error = "minutes_out_of_range", max_minutes = MaxMinutes });
        }
        if (!device.CourtNumbers.Contains(req.Court))
        {
            return Results.BadRequest(new { error = CourtNotOnDevice, court = req.Court });
        }
        return null;
    }

    /// <summary>The original grant for an extension already on the ledger, or null if this one is new.</summary>
    private static async Task<IResult?> ReplayAsync(string reference, ExtendServices services, CancellationToken ct)
    {
        var db = services.Db;
        var entry = await db.LedgerEntries.AsNoTracking().FirstOrDefaultAsync(l => l.ExternalReference == reference, ct);
        if (entry?.RelatedBookingId is null) return null;
        var booking = await db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == entry.RelatedBookingId, ct);
        if (booking is null) return null;

        if (booking.Status == BookingStatus.Cancelled || booking.EndsAt <= services.Clock.GetUtcNow())
        {
            return Results.Conflict(new { error = "purchase_ended", booking_id = booking.Id, ended_at = booking.EndsAt });
        }

        var balance = await services.Ledger.GetBalanceAsync(entry.UserId, ct);
        return Results.Ok(await GrantAsync(db, booking, -entry.AmountMinutes, balance, true, ct));
    }

    private static async Task<object> GrantAsync(
        MainframeDbContext db, Booking booking, int amountMinutes, int balanceAfterMinutes, bool replayed, CancellationToken ct)
    {
        return new
        {
            booking_id = booking.Id,
            extended_minutes = (int)(booking.EndsAt - booking.StartsAt).TotalMinutes,
            amount_minutes = amountMinutes,
            balance_after_minutes = balanceAfterMinutes,
            ends_at = booking.EndsAt.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture),
            replayed,
            greeting_name = booking.UserId is { } uid ? await MemberDisplay.GreetingNameAsync(db, uid, ct) : "",
        };
    }

    /// <summary>The walk-up's refusal envelope and statuses, worded for an extension.</summary>
    private static (string Reason, IResult Result) Refusal(BookingResult created)
    {
        return created switch
        {
            BookingResult.InsufficientBalance ib => (InsufficientBalance, Results.Json(new
            {
                error = InsufficientBalance,
                current_minutes = ib.CurrentMinutes,
                required_minutes = ib.RequiredMinutes,
            }, statusCode: StatusCodes.Status402PaymentRequired)),
            // A slot race lost to a booking made meanwhile is the same fact as no time: the next
            // player is already there at the session's end.
            BookingResult.NoTimeAvailable or BookingResult.SlotTaken => (NoTimeAvailable, Results.Conflict(new { error = NoTimeAvailable })),
            _ => ("extend_refused", Results.BadRequest(new { error = "extend_refused" })),
        };
    }
}

/// <summary>The services the extension needs, bundled — positional for the <c>[AsParameters]</c> reason on <see cref="WalkUpServices"/>.</summary>
public sealed record ExtendServices(
    MainframeDbContext Db,
    BookingService Bookings,
    TenantSettingsAccessor Settings,
    LedgerService Ledger,
    DeviceFaultSink Faults,
    AccessCodeService Codes,
    MemberCodeService MemberCodes,
    CourtLightStateService Lights,
    TimeProvider Clock);

/// <summary>
/// What a box sends to extend play: <c>court</c> is the club court NUMBER (one of the box's),
/// <c>minutes</c> 1–90, <c>nonce</c> the box's per-purchase token, the same on every retry.
/// </summary>
public sealed record ExtendRequest(
    [property: JsonPropertyName("mac")] string? Mac,
    [property: JsonPropertyName("method")] string? Method,
    [property: JsonPropertyName("token")] string? Token,
    [property: JsonPropertyName("court")] int Court,
    [property: JsonPropertyName("minutes")] int Minutes,
    [property: JsonPropertyName("nonce")] string? Nonce,
    [property: JsonPropertyName("scan_age_ms")] long? ScanAgeMs = null)
{
    /// <summary>Read through <see cref="DeviceBody"/>, as every device body is.</summary>
    public static ValueTask<ExtendRequest> BindAsync(HttpContext ctx) => DeviceBody.ReadAsync<ExtendRequest>(ctx);
}
