using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

public static class BookingEndpoints
{
    public static IEndpointRouteBuilder MapBookingEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/bookings").RequireAuthorization();

        g.MapPost("/", async (CreateBookingRequest req, HttpContext ctx, BookingService svc, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;

            // A suspension revokes access, and sign-in already refuses one — but an access
            // token minted before the suspension stays valid until it expires, and booking
            // court time is exactly what a club suspending a member for unpaid dues is
            // stopping. Checked here rather than inside BookingService because it is an
            // authorization question about the caller, not a rule about the slot.
            if (await db.Memberships.AnyAsync(m => m.UserId == userId && m.Status == MembershipStatus.Suspended, ct))
                return Results.Json(new { error = "member_suspended" }, statusCode: 403);

            var result = await svc.CreateAsync(req.CourtId, userId, userId, req.StartsAt, req.SliceCount, ct);
            return ToHttpResult(result, ctx);
        });

        g.MapGet("/{bookingId:guid}/cancellation-quote", async (Guid bookingId, HttpContext ctx, BookingService svc, CancellationToken ct) =>
        {
            var actorId = ctx.User.Id() ?? Guid.Empty;
            var quote = await svc.QuoteCancellationAsync(bookingId, actorId, actorIsAdmin: ctx.User.IsInRole("admin"), ct);
            return quote is null ? Results.NotFound(new { error = "booking_not_found" }) : Results.Ok(quote);
        });

        g.MapPost("/{bookingId:guid}/cancel", async (Guid bookingId, HttpContext ctx, BookingService svc, CancellationToken ct) =>
        {
            var actorId = ctx.User.Id() ?? Guid.Empty;
            var result = await svc.CancelAsync(bookingId, actorId, actorIsAdmin: false, waivePenalty: false, ct);
            return ToHttpResult(result, ctx);
        });

        // Admin: book on behalf + cancel-with-waive
        var admin = app.MapGroup("/api/v1/admin/bookings").RequireAuthorization(p => p.RequireRole("admin"));

        admin.MapPost("/", async (AdminBookingRequest req, HttpContext ctx, BookingService svc, CancellationToken ct) =>
        {
            var actorId = ctx.User.Id() ?? Guid.Empty;
            var result = await svc.CreateAsync(req.CourtId, req.UserId, actorId, req.StartsAt, req.SliceCount, ct);
            return ToHttpResult(result, ctx);
        });

        admin.MapPost("/{bookingId:guid}/cancel", async (Guid bookingId, AdminCancelRequest? req, HttpContext ctx, BookingService svc, CancellationToken ct) =>
        {
            var actorId = ctx.User.Id() ?? Guid.Empty;
            var result = await svc.CancelAsync(bookingId, actorId, actorIsAdmin: true, waivePenalty: req?.WaivePenalty ?? false, ct);
            return ToHttpResult(result, ctx);
        });

        // Admin: block a slot for an event.
        //
        // §8 has promised this since the first spec and §5 lists `admin_block` as a slot
        // state with a label — `SlotCell` could already RENDER one. Nothing in the product
        // could create one, in either half: no endpoint, no screen. A club running a
        // tournament had to book every court out under a member's name.
        var blocks = app.MapGroup("/api/v1/admin/blocks").RequireAuthorization(p => p.RequireRole("admin"));

        blocks.MapPost("/", async (CreateBlockRequest req, HttpContext ctx, AdminBlockService svc, CancellationToken ct) =>
        {
            var actorId = ctx.User.Id() ?? Guid.Empty;
            var result = await svc.CreateAsync(req.CourtId, req.StartsAt, req.SliceCount, req.Label, actorId, ct);
            return ToHttpResult(result, ctx);
        });

        blocks.MapDelete("/{blockId:guid}", async (Guid blockId, HttpContext ctx, AdminBlockService svc, CancellationToken ct) =>
        {
            var actorId = ctx.User.Id() ?? Guid.Empty;
            return await svc.RemoveAsync(blockId, actorId, ct)
                ? Results.NoContent()
                : Results.NotFound(new { error = "block_not_found" });
        });

        return app;
    }

    /// <summary>
    /// Every <see cref="BookingResult"/> the service can return, as an HTTP answer with a
    /// stable snake_case <c>error</c> code the client maps to a sentence.
    ///
    /// <para>
    /// This used to be four copies of a switch that named seven of the ten arms, ending in
    /// <c>_ =&gt; Results.Problem("Unexpected")</c>. The two headline rules of the whole
    /// booking model — peak-hour league exclusivity and the per-day cap — fell into that
    /// default, so a member who hit either got HTTP 500 and the sentence "Booking failed."
    /// The service had already composed the exact refusal, with the peak window and the
    /// member's own minutes in it, and the endpoint threw it away. Worse, nothing reached
    /// the log: <c>Results.Problem</c> is a return, not a throw, so an operator watching
    /// <c>api.log</c> saw no trace of a rule refusing anybody, ever.
    /// </para>
    ///
    /// <para>
    /// One copy now, and the fallback is a logged 500 rather than a silent one — a new
    /// result type reaching it is a defect that says so out loud. Adding a result type
    /// without adding an arm here is still possible; the arms are ordered to match the
    /// declaration order in <c>BookingService.cs</c> so the pair reads as one list.
    /// </para>
    /// </summary>
    private static IResult ToHttpResult(BookingResult result, HttpContext ctx) => result switch
    {
        BookingResult.Ok ok => Results.Ok(new { booking_id = ok.Booking.Id, balance_after_credits = ok.BalanceAfterCredits }),
        BookingResult.NotFound => Results.NotFound(new { error = "court_not_found" }),
        BookingResult.PastTime => Results.BadRequest(new { error = "past_time" }),
        BookingResult.TooFarAhead => Results.BadRequest(new { error = "too_far_ahead" }),
        BookingResult.SlotTaken => Results.Conflict(new { error = "slot_taken" }),
        BookingResult.InsufficientBalance ib => Results.Json(
            new { error = "insufficient_balance", current_credits = ib.CurrentCredits, required_credits = ib.RequiredCredits }, statusCode: 402),
        BookingResult.PeakHoursLeagueOnly p => Results.Conflict(
            new { error = "peak_hours_league_only", peak_start = p.PeakStart, peak_end = p.PeakEnd, regular_advance_hours = p.RegularAdvanceHours }),
        BookingResult.PerDayCapExceeded c => Results.Conflict(
            new { error = "per_day_cap_exceeded", cap_minutes = c.CapMinutes, already_booked_minutes = c.AlreadyBookedMinutes, attempted_minutes = c.AttemptedMinutes }),
        BookingResult.OutOfHours h => Results.Conflict(
            new { error = "out_of_hours", opens_at = h.OpensAt, closes_at = h.ClosesAt }),
        BookingResult.NoTimeAvailable n => Results.Conflict(
            new { error = "no_time_available", requested_minutes = n.RequestedMinutes, available_minutes = n.AvailableMinutes }),
        BookingResult.InvalidDuration id => Results.BadRequest(
            new { error = "invalid_duration", requested_slices = id.RequestedSlices, max_slices = id.MaxSlices }),
        BookingResult.DuplicateRequest => Results.Conflict(new { error = "duplicate_request" }),
        _ => Unmapped(result, ctx),
    };

    private static IResult ToHttpResult(CancellationResult result, HttpContext ctx) => result switch
    {
        CancellationResult.Ok ok => Results.Ok(new { refunded_credits = ok.RefundedCredits, penalty_credits = ok.PenaltyCredits }),
        CancellationResult.NotFound => Results.NotFound(new { error = "booking_not_found" }),
        CancellationResult.AlreadyStarted => Results.BadRequest(new { error = "already_started" }),
        _ => Unmapped(result, ctx),
    };

    /// <summary>
    /// The arm that should never run. It answers 500 as before — but it LOGS, naming the
    /// type it could not map, so the next unmapped result is found by reading the log
    /// rather than by a member reporting that booking is broken.
    /// </summary>
    private static IResult Unmapped(object result, HttpContext ctx)
    {
        ctx.RequestServices.GetRequiredService<ILoggerFactory>()
            .CreateLogger(typeof(BookingEndpoints))
            .LogError("Booking endpoint has no HTTP mapping for result type {ResultType}", result.GetType().FullName);
        return Results.Problem("Unexpected");
    }
}

public sealed record CreateBlockRequest(Guid CourtId, DateTimeOffset StartsAt, int SliceCount, string? Label);
public sealed record CreateBookingRequest(Guid CourtId, DateTimeOffset StartsAt, int SliceCount);
public sealed record AdminBookingRequest(Guid CourtId, Guid UserId, DateTimeOffset StartsAt, int SliceCount);
public sealed record AdminCancelRequest(bool WaivePenalty);
