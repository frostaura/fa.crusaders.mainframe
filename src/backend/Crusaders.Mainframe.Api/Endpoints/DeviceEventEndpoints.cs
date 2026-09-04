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

    /// <summary>
    /// Records a batch of events and reports the highest sequence number accepted.
    ///
    /// <para>
    /// The box releases its queue up to <c>accepted_through</c> and no further, so a partial
    /// success loses nothing: whatever came after simply stays queued and is offered again.
    /// That is why the response carries a sequence number rather than a bare 200.
    /// </para>
    /// </summary>
    private static async Task<IResult> UploadAsync(
        DeviceEventBatch batch,
        MainframeDbContext db,
        ITenantContext tenant,
        HttpContext ctx,
        CancellationToken ct)
    {
        var deviceId = ctx.User.DeviceId();
        if (deviceId is null) return Results.Unauthorized();

        var device = await db.Devices.FirstOrDefaultAsync(d => d.Id == deviceId.Value, ct);
        if (device is null) return Results.NotFound();

        var events = (batch.Events ?? []).Take(MaxBatch).ToList();
        if (events.Count == 0) return Results.Ok(new { accepted_through = 0L, recorded = 0 });

        // The box has no RTC, so an event carries its uptime and the batch carries the
        // box's uptime now. The difference is how long ago it happened; the server clock is
        // the only one anybody can be held to.
        var now = DateTimeOffset.UtcNow;
        long acceptedThrough = 0;
        var recorded = 0;

        // One read for the whole batch rather than one per event: a box back from a week
        // offline arrives with a full ring, and 32 round trips to answer "seen this?" is 32
        // round trips.
        var offered = events.Select(e => e.Seq).ToList();
        var seen = await db.DeviceEventReceipts
            .Where(r => r.DeviceId == device.Id && offered.Contains(r.Seq))
            .Select(r => r.Seq)
            .ToListAsync(ct);
        var alreadyRecorded = seen.ToHashSet();

        foreach (var e in events.OrderBy(e => e.Seq))
        {
            if (alreadyRecorded.Contains(e.Seq))
            {
                // A retry of something already taken. Acknowledged, not re-recorded — which
                // is what lets the box release it and move on.
                acceptedThrough = e.Seq;
                continue;
            }

            var occurredAt = now.AddMilliseconds(-Math.Max(0, batch.UptimeMs - e.UptimeMs));

            db.DeviceEventReceipts.Add(new DeviceEventReceipt
            {
                TenantId = tenant.TenantId,
                DeviceId = device.Id,
                Seq = e.Seq,
                Kind = e.Kind.Length > 32 ? e.Kind[..32] : e.Kind,
                OccurredAt = occurredAt,
            });

            db.AuditLogs.Add(new AuditLog
            {
                TenantId = tenant.TenantId,
                ActorUserId = Guid.Empty,
                SubjectUserId = null,
                Action = $"device.{e.Kind}",
                DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
                {
                    device_id = device.Id,
                    device_code = device.DeviceCode,
                    seq = e.Seq,
                    kind = e.Kind,
                    court = e.Court,
                    method = e.Method,
                    subject = e.Subject,
                    duration_ms = e.DurationMs,
                    occurred_at = occurredAt,
                }),
            });

            acceptedThrough = e.Seq;
            recorded++;
        }

        device.LastSeenAt = now;

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsDuplicateReceipt(ex))
        {
            // Two uploads of the same batch, in flight together. The index refused the
            // second, which is the outcome that was wanted — and the box is told the events
            // are accepted, because they are: the other request recorded them.
            return Results.Ok(new
            {
                server_unix = now.ToUnixTimeSeconds(),
                accepted_through = acceptedThrough,
                recorded = 0,
                note = "already recorded by a concurrent upload",
            });
        }

        return Results.Ok(new
        {
            server_unix = now.ToUnixTimeSeconds(),
            accepted_through = acceptedThrough,
            recorded,
        });
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
        HttpContext ctx,
        CancellationToken ct)
    {
        var deviceId = ctx.User.DeviceId();
        if (deviceId is null) return Results.Unauthorized();

        var device = await services.Db.Devices.FirstOrDefaultAsync(d => d.Id == deviceId.Value, ct);
        if (device is null) return Results.NotFound();

        return await WalkUpForDeviceAsync(device, req, services, ct);
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
        var activated = await ActivateOnceAsync(services, court, ok.Booking, userId.Value, req.Method, ct);
        if (activated is not ActivationResult.Activated live)
        {
            return Results.Conflict(new { error = "activation_refused" });
        }

        return Results.Ok(Grant(ok.Booking, live.AmountCredits, ok.BalanceAfterCredits, replayed: false));
    }

    /// <summary>
    /// Activation that survives its twin. Two retries of one purchase can reach this from
    /// both sides — the winner after its commit, the loser after re-reading the winner's
    /// booking — and whichever stamps <c>CheckedInAt</c> second finds the concurrency token
    /// moved under it. That is not a failure of the purchase: the row was stamped, by the
    /// other attempt. Re-read it and go again, and the second pass sees a live session and
    /// is the idempotent no-op it is meant to be.
    /// </summary>
    private static async Task<ActivationResult> ActivateOnceAsync(
        WalkUpServices services, Court court, Booking booking, Guid userId, string? method, CancellationToken ct)
    {
        var (db, _, activation, _, _, _) = services;
        try
        {
            return await activation.ActivateAsync(court, booking, userId, null, method ?? "qr", ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            // The failed save leaves its audit row tracked as Added; forget it, or the next
            // save on this context would insert it against a stamp this request never made.
            foreach (var entry in db.ChangeTracker.Entries().Where(e => e.State == EntityState.Added).ToList())
            {
                entry.State = EntityState.Detached;
            }
            await db.Entry(booking).ReloadAsync(ct);
            return await activation.ActivateAsync(court, booking, userId, null, method ?? "qr", ct);
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
    /// </summary>
    private static async Task<IResult?> ReplayAsync(
        string reference, WalkUpRequest req, WalkUpServices services, CancellationToken ct)
    {
        var (db, _, _, _, _, ledger) = services;

        var entry = await db.LedgerEntries.AsNoTracking()
            .FirstOrDefaultAsync(l => l.ExternalReference == reference, ct);
        if (entry?.RelatedBookingId is null) return null;

        var booking = await db.Bookings.FirstOrDefaultAsync(b => b.Id == entry.RelatedBookingId, ct);
        if (booking is null) return null;

        var court = await db.Courts.FirstAsync(c => c.Id == booking.CourtId, ct);
        var activated = await ActivateOnceAsync(services, court, booking, entry.UserId, req.Method, ct);
        if (activated is not ActivationResult.Activated)
        {
            return Results.Conflict(new { error = "activation_refused" });
        }

        // The balance now rather than as it stood after the first attempt: the box shows
        // the member what they have, and a movement between the two attempts is real.
        var balance = await ledger.GetBalanceAsync(entry.UserId, ct);
        return Results.Ok(Grant(booking, -entry.AmountCredits, balance, replayed: true));
    }

    // Block bodies, not expression bodies, for the two members below. lizard's C# parser
    // mis-scopes an expression-bodied member containing braces and emits a *global*
    // pseudo-function whose reported length is the whole file — see memory/gotchas.md.
    private static object Grant(Booking booking, decimal amountCredits, decimal balanceAfterCredits, bool replayed)
    {
        return new
        {
            server_unix = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            booking_id = booking.Id,
            granted_minutes = (int)(booking.EndsAt - booking.StartsAt).TotalMinutes,
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

/// <summary>One event as the box queued it. Names mirror <c>lib/eventq</c>'s wire form.</summary>
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
    [property: JsonPropertyName("uptime_ms")] long UptimeMs,
    [property: JsonPropertyName("events")] IReadOnlyList<DeviceEventDto>? Events);

/// <summary>
/// What a box asks for when somebody buys court time at it. <c>court</c> is the court
/// NUMBER the member selected, which must be one of the box's; <c>nonce</c> is the box's
/// per-purchase token, the same on every retry of the same purchase.
/// </summary>
public sealed record WalkUpRequest(
    [property: JsonPropertyName("minutes")] int Minutes,
    [property: JsonPropertyName("method")] string? Method,
    [property: JsonPropertyName("token")] string? Token,
    [property: JsonPropertyName("court")] int Court,
    [property: JsonPropertyName("nonce")] string? Nonce);
