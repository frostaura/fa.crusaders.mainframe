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
/// drains. Two endpoints, and the reason they exist separately from the courtside
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
    /// booking they already paid for is a member in the dark, and that path stays offline.
    /// </para>
    ///
    /// <para>
    /// The identification token is passed through and verified <i>here</i>, which is what lets
    /// a 60-second signed QR work at all: it cannot be pre-cached on the box by construction.
    /// </para>
    /// </summary>
    private static async Task<IResult> WalkUpAsync(
        WalkUpRequest req,
        [AsParameters] WalkUpServices services,
        HttpContext ctx,
        CancellationToken ct)
    {
        var (db, bookings, activation, identities) = services;

        var deviceId = ctx.User.DeviceId();
        if (deviceId is null) return Results.Unauthorized();

        var device = await db.Devices.FirstOrDefaultAsync(d => d.Id == deviceId.Value, ct);
        if (device is null) return Results.NotFound();

        if (req.Minutes is <= 0 or > 240) return Results.BadRequest(new { error = "minutes_out_of_range" });

        // The court is the one this box is fitted at, never one named in the request. A box
        // that could sell time on any court is a box that opens any court in the club.
        //
        // WI-8 rewrites this: a box now drives a LIST of courts (Device.CourtNumbers, in
        // relay order) and the walk-up request must carry which one the member selected
        // (review C5). Until then this path is only defined for a single-court box, and a
        // multi-court box is refused here rather than guessed at.
        if (device.CourtNumbers.Count != 1) return Results.BadRequest(new { error = "device_has_no_court" });
        var courtNumber = device.CourtNumbers[0];

        var court = await db.Courts.FirstOrDefaultAsync(c => c.CourtNumber == courtNumber && c.IsActive, ct);
        if (court is null) return Results.NotFound(new { error = "court_not_found" });

        var userId = await identities.ResolveAsync(req.Method, req.Token, ct);
        if (userId is null) return Results.BadRequest(new { error = "not_recognised" });

        var created = await bookings.CreateWalkUpAsync(court.Id, userId.Value, userId.Value, req.Minutes, ct);

        switch (created)
        {
            case BookingResult.InsufficientBalance ib:
                return Results.Json(new
                {
                    error = "insufficient_balance",
                    current_credits = ib.CurrentCredits,
                    required_credits = ib.RequiredCredits,
                }, statusCode: StatusCodes.Status402PaymentRequired);

            case BookingResult.NoTimeAvailable:
                // Distinct from slot_taken: the court is free and the next player is simply
                // imminent. A 16x2 display saying "court busy" when nobody is on it sends the
                // member away for no reason.
                return Results.Conflict(new { error = "no_time_available" });

            case BookingResult.SlotTaken:
                return Results.Conflict(new { error = "court_in_use" });

            case not BookingResult.Ok:
                return Results.BadRequest(new { error = "walk_up_refused" });
        }

        var ok = (BookingResult.Ok)created;

        // Straight into the one activation path, so attendance, the audit row and
        // booking.lights_on all come from the place that is allowed to produce them.
        var activated = await activation.ActivateAsync(court, ok.Booking, userId.Value, null, req.Method ?? "qr", ct);
        if (activated is not ActivationResult.Activated live)
        {
            return Results.Conflict(new { error = "activation_refused" });
        }

        return Results.Ok(new
        {
            server_unix = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            booking_id = ok.Booking.Id,
            granted_minutes = (int)(ok.Booking.EndsAt - ok.Booking.StartsAt).TotalMinutes,
            amount_credits = live.AmountCredits,
            balance_after_credits = ok.BalanceAfterCredits,
        });
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
    IdentificationResolver Identities);

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

/// <summary>What a box asks for when somebody buys court time at it.</summary>
public sealed record WalkUpRequest(
    [property: JsonPropertyName("minutes")] int Minutes,
    [property: JsonPropertyName("method")] string? Method,
    [property: JsonPropertyName("token")] string? Token);
