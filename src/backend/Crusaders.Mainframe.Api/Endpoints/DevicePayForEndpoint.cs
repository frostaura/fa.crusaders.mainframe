using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// D10 — paying for somebody else's court at the box (<c>docs/specs/member-code.md</c> §9).
///
/// <para>
/// <b>Two presses, one nonce.</b> <c>confirm:false</c> is the QUOTE and moves nothing; the glass
/// asks the member to agree to the server's own <c>amount_label</c>. <c>confirm:true</c> echoes
/// that label and pays — a label that is not the current one is <c>price_changed</c>, so a member
/// pays what they agreed to or nothing.
/// </para>
///
/// <para>
/// <b>The money goes through the one reassignment path there is</b>,
/// <see cref="BookingService.ChargeOnActivationAsync"/>: a refund to the booking's current payer
/// and a debit to the new one, posted together under the payer lock and the booking's
/// concurrency token, actor the payer, subject the booking. When the booking has not been started
/// and its cue window is open, the confirm goes through <see cref="CourtActivationService"/>
/// instead, which does the same reassignment and also stamps attendance and lights the court —
/// <c>granted_seconds</c> is then the remainder, exactly as <c>/activate</c> would grant.
/// </para>
///
/// <para>
/// <b>Idempotent on (tenant, device, nonce).</b> The confirm claims its nonce in
/// <c>device_pay_fors</c> before any money moves; a retry after a lost answer finds the claim and
/// is answered with the FIRST payment (<c>replayed:true</c>), never a second one, and never
/// <c>code_used</c> — the replay is checked before the use table.
/// </para>
///
/// <para>
/// <b>Every decision is a 200.</b> A refusal is an answer; only "the server could not decide"
/// (a confirm still in flight in another request) is a non-200, which the box treats as no
/// decision and retries with the same nonce.
/// </para>
/// </summary>
public static class DevicePayForEndpoint
{
    public const string NotBooked = "not_booked";
    public const string SplitBooking = "split_booking";
    public const string OwnBooking = "own_booking";
    public const string AlreadyPaid = "already_paid";
    public const string InsufficientBalance = "insufficient_balance";
    public const string NotRecognised = "not_recognised";
    public const string MemberNotActive = "member_not_active";
    public const string Ended = "ended";
    public const string CourtNotOnDevice = "court_not_on_device";
    public const string PriceChanged = "price_changed";
    public const string NotChargeable = "not_chargeable";

    /// <summary>
    /// A price whose label would not fit the glass (more than six characters). Not in the spec's
    /// list: the box reads any reason it does not know as SEE THE DESK, which is the honest
    /// answer to "this court costs more than the box can show".
    /// </summary>
    public const string AmountUnshowable = "amount_unshowable";

    /// <summary>The widest label the box's glass can show verbatim.</summary>
    public const int MaxLabelLength = 6;

    /// <summary>The nonce the box mints: sixteen lower-case hex characters. At most this many are accepted.</summary>
    public const int MaxNonceLength = 32;

    public static async Task<IResult> HandleAsync(PayForRequest req, [AsParameters] PayForServices services, CancellationToken ct)
    {
        var (device, refusal) = await DeviceIdentity.ResolveAsync(services.Db, req.Mac, ct);
        if (refusal is not null) return refusal;
        return await DecideAsync(device!, req, services, ct);
    }

    /// <summary>The decision for an already-resolved board. Public so tests can drive it without HTTP.</summary>
    public static async Task<IResult> DecideAsync(Device device, PayForRequest req, PayForServices services, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var settings = await services.Settings.GetAsync(ct);
        await DeviceSilenceLog.NoteContactAsync(services.Db, device, settings, now, ct);

        if (string.IsNullOrWhiteSpace(req.Nonce) || req.Nonce.Length > MaxNonceLength)
        {
            return Results.BadRequest(new { error = "nonce_invalid" });
        }

        // Replay FIRST — before validation, before the use table (§4.4): the fields of a retried
        // confirm already passed once, and the only question is whether it paid.
        if (req.Confirm && await ReplayAsync(device, req, services, now, ct) is { } replayed) return replayed;

        var decision = await JudgeAsync(device, req, services, settings, now, ct);
        if (decision.Refusal is { } no) return Refuse(req, no);

        if (!req.Confirm)
        {
            return Results.Ok(new PayForQuoteResponse(true, "ok", req.Court, WireCredits(decision.Amount), decision.Label));
        }

        if (!string.Equals(req.AmountLabel, decision.Label, StringComparison.Ordinal))
        {
            return Results.Ok(new PayForConfirmResponse(false, PriceChanged, req.Court, AmountLabel: decision.Label));
        }

        return await PayAsync(device, req, decision, services, settings, now, ct);
    }

    /// <summary>Everything decided before any money: who pays, which booking, how much.</summary>
    private sealed record Judgement(
        string? Refusal, string? Label = null, decimal Amount = 0m, Guid PayerUserId = default,
        Booking? Booking = null, Court? Court = null, MemberCodeMatch? Match = null);

    private static async Task<Judgement> JudgeAsync(
        Device device, PayForRequest req, PayForServices services, TenantSettingsView settings,
        DateTimeOffset now, CancellationToken ct)
    {
        var db = services.Db;
        if (device.Kind != DeviceKind.CourtBox) return new Judgement(GateAccess.NotACourtBox);
        if (!device.CourtNumbers.Contains(req.Court)) return new Judgement(CourtNotOnDevice);
        if (!IdentificationResolver.CanIdentifyGlobally(req.Method)) return new Judgement(NotRecognised);

        // A WALLET identity (§4.1): a v1 code, checked, or a legacy member-ident code. A legacy
        // booking code names a booking, not a payer — the same rule the walk-up keeps.
        var (resolved, match) = await MemberCodeIdentity.ResolveAsync(
            services.Codes, services.MemberCodes, req.Token, req.ScanAgeMs, settings, now, ct);
        if (resolved is not { Purpose: AccessCodePurpose.MemberIdent }) return new Judgement(NotRecognised);
        var payer = resolved.UserId;

        if (match is not null && await services.MemberCodes.IsUsedAsync(match, MemberCodeUseClass.Money, ct))
        {
            return new Judgement(MemberCodeIdentity.CodeUsed);
        }

        if (await MembershipAccess.IsBarredFromCourtsAsync(db, payer, ct)) return new Judgement(MemberNotActive);

        var court = await db.Courts.FirstOrDefaultAsync(c => c.CourtNumber == req.Court && c.IsActive, ct);
        if (court is null) return new Judgement(NotBooked);

        var latestStart = now.AddMinutes(BookingCodeWindow.CueMinutes(settings));
        var booking = await db.Bookings
            .Where(b => b.CourtId == court.Id && b.Status == BookingStatus.Booked && b.UserId != null
                        && b.StartsAt <= latestStart && b.EndsAt > now)
            .OrderBy(b => b.StartsAt)
            .FirstOrDefaultAsync(ct);
        if (booking is null)
        {
            var grace = now.AddMinutes(-settings.GraceWindowMinutes);
            var justEnded = await db.Bookings.AnyAsync(
                b => b.CourtId == court.Id && b.UserId != null
                     && (b.Status == BookingStatus.Booked || b.Status == BookingStatus.Completed || b.Status == BookingStatus.NoShow)
                     && b.EndsAt <= now && b.EndsAt > grace, ct);
            return new Judgement(justEnded ? Ended : NotBooked);
        }

        if (booking.UserId == payer) return new Judgement(OwnBooking);
        var currentPayer = booking.PaidByUserId ?? booking.UserId;
        if (currentPayer != booking.UserId || currentPayer == payer) return new Judgement(AlreadyPaid);
        if (await services.Players.IsSplitAsync(booking, ct)) return new Judgement(SplitBooking);

        var amount = booking.AmountChargedCredits;
        var label = Label(amount);
        if (label.Length > MaxLabelLength) return new Judgement(AmountUnshowable);

        // No overdraft at a device (§9.2): god mode never reaches a device path.
        if (await services.Ledger.GetBalanceAsync(payer, ct) < amount) return new Judgement(InsufficientBalance, label);

        return new Judgement(null, label, amount, payer, booking, court, match);
    }

    private static async Task<IResult> PayAsync(
        Device device, PayForRequest req, Judgement j, PayForServices services, TenantSettingsView settings,
        DateTimeOffset now, CancellationToken ct)
    {
        var db = services.Db;
        var booking = j.Booking!;
        var refunded = booking.PaidByUserId ?? booking.UserId;

        // The nonce claim: the unique index decides between two concurrent confirms.
        var row = new DevicePayFor
        {
            TenantId = device.TenantId,
            DeviceId = device.Id,
            Nonce = req.Nonce!,
            BookingId = booking.Id,
            PayerUserId = j.PayerUserId,
            RefundedUserId = refunded,
            CourtNumber = req.Court,
            AmountCredits = j.Amount,
            AmountLabel = j.Label!,
            CreatedAt = now,
        };
        db.DevicePayFors.Add(row);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            db.Entry(row).State = EntityState.Detached;
            return await ReplayAsync(device, req, services, now, ct) ?? InFlight();
        }

        Guid? claim = null;
        if (j.Match is not null)
        {
            claim = await services.MemberCodes.TryClaimAsync(j.Match, MemberCodeUseClass.Money, device.Id, "pay_for", ct);
            if (claim is null) return await UnclaimAsync(services, row, null, req, MemberCodeIdentity.CodeUsed, ct);
        }

        var (outcome, granted) = await MoveMoneyAsync(req, j, services, settings, now, ct);
        if (outcome is not null) return await UnclaimAsync(services, row, claim, req, outcome, ct);

        row.Paid = true;
        row.GrantedSeconds = granted;
        row.BalanceAfterCredits = await services.Ledger.GetBalanceAsync(j.PayerUserId, ct);
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = device.TenantId,
            ActorUserId = j.PayerUserId,
            SubjectUserId = booking.UserId,
            Action = PaidAction,
            DetailsJson = JsonSerializer.Serialize(new
            {
                booking_id = booking.Id,
                device_id = device.Id,
                device_code = device.DeviceCode,
                court_number = req.Court,
                amount_credits = j.Amount,
                refunded_user_id = refunded,
                granted_seconds = granted,
            }),
        });
        await db.SaveChangesAsync(ct);

        await NotifyAsync(services, j, refunded, ct);

        return Results.Ok(new PayForConfirmResponse(
            true, "ok", req.Court, WireCredits(j.Amount), j.Label, WireCredits(row.BalanceAfterCredits), false, granted));
    }

    public const string PaidAction = "booking.paid_for_at_box";

    /// <summary>
    /// The money. A booking nobody has started, inside its cue window, is ACTIVATED with the
    /// payer as the new payer — attendance stamped for them, the court lit for its remainder.
    /// Anything else is a straight reassignment and lights nothing.
    /// </summary>
    private static async Task<(string? Refusal, int Granted)> MoveMoneyAsync(
        PayForRequest req, Judgement j, PayForServices services, TenantSettingsView settings,
        DateTimeOffset now, CancellationToken ct)
    {
        var booking = j.Booking!;
        var cueOpen = now >= booking.StartsAt.AddMinutes(-settings.ActivationCueWindowMinutes);

        if (booking.CheckedInAt is null && cueOpen)
        {
            var result = await services.Activation.ActivateAsync(
                j.Court!, booking, j.PayerUserId, j.PayerUserId, req.Method ?? "qr", ct);
            return result switch
            {
                ActivationResult.Activated when booking.EndsAt > now => (null,
                    Math.Clamp((int)Math.Floor((booking.EndsAt - now).TotalSeconds), 1, RelayHardCap.Seconds)),
                ActivationResult.Activated => (null, 0),
                ActivationResult.InsufficientBalance => (InsufficientBalance, 0),
                _ => (NotChargeable, 0),
            };
        }

        var charge = await services.Bookings.ChargeOnActivationAsync(booking.Id, j.PayerUserId, j.PayerUserId, ct);
        return charge switch
        {
            ChargeResult.Ok => (null, 0),
            ChargeResult.AlreadyCharged => (AlreadyPaid, 0),
            ChargeResult.InsufficientBalance => (InsufficientBalance, 0),
            _ => (NotChargeable, 0),
        };
    }

    private static async Task<IResult> UnclaimAsync(
        PayForServices services, DevicePayFor row, Guid? claim, PayForRequest req, string reason, CancellationToken ct)
    {
        await services.MemberCodes.ReleaseAsync(claim, ct);
        services.Db.DevicePayFors.Remove(row);
        await services.Db.SaveChangesAsync(ct);
        return Refuse(req, reason);
    }

    /// <summary>
    /// The first answer for a nonce this box has already paid with, or null when it has not.
    /// A claim still in flight is 503 — no decision — so the box retries the same payment.
    /// </summary>
    private static async Task<IResult?> ReplayAsync(
        Device device, PayForRequest req, PayForServices services, DateTimeOffset now, CancellationToken ct)
    {
        var row = await services.Db.DevicePayFors.AsNoTracking()
            .FirstOrDefaultAsync(p => p.DeviceId == device.Id && p.Nonce == req.Nonce, ct);
        if (row is null) return null;
        if (!row.Paid) return InFlight();

        // What is LEFT of the grant, never the original length from now (the walk-up's review
        // #20): a retry an hour later must not light a court over whoever holds it next.
        var granted = 0;
        if (row.GrantedSeconds > 0)
        {
            var booking = await services.Db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == row.BookingId, ct);
            if (booking is { Status: BookingStatus.Booked } && booking.EndsAt > now)
            {
                granted = Math.Clamp((int)Math.Floor((booking.EndsAt - now).TotalSeconds), 1, RelayHardCap.Seconds);
            }
        }

        return Results.Ok(new PayForConfirmResponse(
            true, "ok", row.CourtNumber, WireCredits(row.AmountCredits), row.AmountLabel,
            WireCredits(row.BalanceAfterCredits), true, granted));
    }

    private static IResult InFlight() => Results.Json(new { error = "in_progress" }, statusCode: StatusCodes.Status503ServiceUnavailable);

    private static IResult Refuse(PayForRequest req, string reason)
    {
        return req.Confirm
            ? Results.Ok(new PayForConfirmResponse(false, reason, req.Court))
            : Results.Ok(new PayForQuoteResponse(false, reason, req.Court));
    }

    private static async Task NotifyAsync(PayForServices services, Judgement j, Guid? refunded, CancellationToken ct)
    {
        try
        {
            var db = services.Db;
            var ids = new[] { j.PayerUserId, refunded ?? Guid.Empty };
            var people = await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id))
                .Select(u => new { u.Id, u.Email, Name = db.Memberships.Where(m => m.UserId == u.Id).Select(m => m.FullName).FirstOrDefault() })
                .ToListAsync(ct);
            var payer = people.FirstOrDefault(p => p.Id == j.PayerUserId);
            var booker = people.FirstOrDefault(p => p.Id == refunded);
            var settings = await services.Settings.GetAsync(ct);
            var when = TimeZoneInfo.ConvertTime(j.Booking!.StartsAt, MemberCodeMath.ZoneOf(settings.Timezone))
                .ToString("ddd dd MMM, HH:mm", CultureInfo.InvariantCulture);
            var club = await services.Club.GetAsync(ct);

            if (payer is not null)
            {
                await services.Email.SendAsync(EmailTemplates.YouPaidForACourt(
                    club, payer.Email, new PaidForCourt(j.Court!.Name, when, j.Amount, booker?.Name ?? "another member")), ct);
            }
            if (booker is not null)
            {
                await services.Email.SendAsync(EmailTemplates.YourCourtWasPaidFor(
                    club, booker.Email, new PaidForCourt(j.Court!.Name, when, j.Amount, payer?.Name ?? "another member")), ct);
            }
        }
        catch (Exception ex)
        {
            // The money is committed; the mail is the courtesy. Logged, never unwound.
            services.Logs.CreateLogger(typeof(DevicePayForEndpoint)).LogWarning(ex, "Pay-for emails failed for booking {BookingId}", j.Booking!.Id);
        }
    }

    /// <summary>
    /// The server's label for an amount (§9.2): invariant culture, at most two decimals, no
    /// trailing zeros — <c>50</c>, <c>32.5</c>. The box shows it verbatim.
    /// </summary>
    public static string Label(decimal credits) =>
        Math.Round(credits, 2, MidpointRounding.AwayFromZero).ToString("0.##", CultureInfo.InvariantCulture);

    /// <summary>
    /// Credits as the wire carries them — at least one decimal (<c>50.0</c>, <c>32.5</c>,
    /// <c>12.25</c>), which is how the corpus pins them and how System.Text.Json writes a decimal
    /// whose scale is one.
    /// </summary>
    public static decimal WireCredits(decimal credits) =>
        decimal.Parse(
            Math.Round(credits, 2, MidpointRounding.AwayFromZero).ToString("0.0#", CultureInfo.InvariantCulture),
            CultureInfo.InvariantCulture);
}

/// <summary>The services the pay-for decision needs, bundled — see <see cref="WalkUpServices"/>.</summary>
public sealed record PayForServices(
    MainframeDbContext Db,
    ITenantContext Tenant,
    TenantSettingsAccessor Settings,
    AccessCodeService Codes,
    MemberCodeService MemberCodes,
    BookingService Bookings,
    CourtActivationService Activation,
    LedgerService Ledger,
    IBookingPlayers Players,
    IEmailService Email,
    ClubIdentityResolver Club,
    ILoggerFactory Logs);

/// <summary>
/// <c>POST /api/v1/device/pay-for</c> (§9.2). Field order is the firmware's:
/// <c>mac, method, token, court, nonce, confirm, [amount_label], [scan_age_ms]</c>.
/// </summary>
public sealed record PayForRequest(
    [property: JsonPropertyName("mac")] string? Mac,
    [property: JsonPropertyName("method")] string? Method,
    [property: JsonPropertyName("token")] string? Token,
    [property: JsonPropertyName("court")] int Court,
    [property: JsonPropertyName("nonce")] string? Nonce,
    [property: JsonPropertyName("confirm")] bool Confirm,
    [property: JsonPropertyName("amount_label")] string? AmountLabel = null,
    [property: JsonPropertyName("scan_age_ms")] long? ScanAgeMs = null);

/// <summary>The quote's answer. Declaration order is the corpus's byte order.</summary>
public sealed record PayForQuoteResponse(
    [property: JsonPropertyName("payable")] bool Payable,
    [property: JsonPropertyName("reason")] string Reason,
    [property: JsonPropertyName("court_number")] int CourtNumber,
    [property: JsonPropertyName("amount_credits")][property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] decimal? AmountCredits = null,
    [property: JsonPropertyName("amount_label")][property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? AmountLabel = null);

/// <summary>The confirm's answer. Declaration order is the corpus's byte order.</summary>
public sealed record PayForConfirmResponse(
    [property: JsonPropertyName("paid")] bool Paid,
    [property: JsonPropertyName("reason")] string Reason,
    [property: JsonPropertyName("court_number")] int CourtNumber,
    [property: JsonPropertyName("amount_credits")][property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] decimal? AmountCredits = null,
    [property: JsonPropertyName("amount_label")][property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? AmountLabel = null,
    [property: JsonPropertyName("balance_after_credits")][property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] decimal? BalanceAfterCredits = null,
    [property: JsonPropertyName("replayed")][property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? Replayed = null,
    [property: JsonPropertyName("granted_seconds")][property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? GrantedSeconds = null);
