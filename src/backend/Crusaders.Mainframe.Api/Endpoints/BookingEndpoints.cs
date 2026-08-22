using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Authorization;

namespace Crusaders.Mainframe.Api.Endpoints;

public static class BookingEndpoints
{
    public static IEndpointRouteBuilder MapBookingEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/bookings").RequireAuthorization();

        g.MapPost("/", async (CreateBookingRequest req, HttpContext ctx, BookingService svc, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var result = await svc.CreateAsync(req.CourtId, userId, userId, req.StartsAt, req.SliceCount, ct);
            return result switch
            {
                BookingResult.Ok ok => Results.Ok(new { booking_id = ok.Booking.Id, balance_after_credits = ok.BalanceAfterCredits }),
                BookingResult.NotFound => Results.NotFound(),
                BookingResult.PastTime => Results.BadRequest(new { error = "past_time" }),
                BookingResult.TooFarAhead => Results.BadRequest(new { error = "too_far_ahead" }),
                BookingResult.SlotTaken => Results.Conflict(new { error = "slot_taken" }),
                BookingResult.InsufficientBalance ib => Results.Json(new { error = "insufficient_balance", current_credits = ib.CurrentCredits, required_credits = ib.RequiredCredits }, statusCode: 402),
                _ => Results.Problem("Unexpected"),
            };
        });

        g.MapPost("/{bookingId:guid}/cancel", async (Guid bookingId, HttpContext ctx, BookingService svc, CancellationToken ct) =>
        {
            var actorId = ctx.User.Id() ?? Guid.Empty;
            var result = await svc.CancelAsync(bookingId, actorId, waivePenalty: false, ct);
            return result switch
            {
                CancellationResult.Ok ok => Results.Ok(new { refunded_credits = ok.RefundedCredits, penalty_credits = ok.PenaltyCredits }),
                CancellationResult.NotFound => Results.NotFound(),
                CancellationResult.AlreadyStarted => Results.BadRequest(new { error = "already_started" }),
                _ => Results.Problem("Unexpected"),
            };
        });

        // Admin: book on behalf + cancel-with-waive
        var admin = app.MapGroup("/api/v1/admin/bookings").RequireAuthorization(p => p.RequireRole("admin"));

        admin.MapPost("/", async (AdminBookingRequest req, HttpContext ctx, BookingService svc, CancellationToken ct) =>
        {
            var actorId = ctx.User.Id() ?? Guid.Empty;
            var result = await svc.CreateAsync(req.CourtId, req.UserId, actorId, req.StartsAt, req.SliceCount, ct);
            return result switch
            {
                BookingResult.Ok ok => Results.Ok(new { booking_id = ok.Booking.Id, balance_after_credits = ok.BalanceAfterCredits }),
                BookingResult.NotFound => Results.NotFound(),
                BookingResult.PastTime => Results.BadRequest(new { error = "past_time" }),
                BookingResult.TooFarAhead => Results.BadRequest(new { error = "too_far_ahead" }),
                BookingResult.SlotTaken => Results.Conflict(new { error = "slot_taken" }),
                BookingResult.InsufficientBalance ib => Results.Json(new { error = "insufficient_balance", current_credits = ib.CurrentCredits, required_credits = ib.RequiredCredits }, statusCode: 402),
                _ => Results.Problem("Unexpected"),
            };
        });

        admin.MapPost("/{bookingId:guid}/cancel", async (Guid bookingId, AdminCancelRequest? req, HttpContext ctx, BookingService svc, CancellationToken ct) =>
        {
            var actorId = ctx.User.Id() ?? Guid.Empty;
            var result = await svc.CancelAsync(bookingId, actorId, waivePenalty: req?.WaivePenalty ?? false, ct);
            return result switch
            {
                CancellationResult.Ok ok => Results.Ok(new { refunded_credits = ok.RefundedCredits, penalty_credits = ok.PenaltyCredits }),
                CancellationResult.NotFound => Results.NotFound(),
                _ => Results.Problem("Unexpected"),
            };
        });

        return app;
    }
}

public sealed record CreateBookingRequest(Guid CourtId, DateTimeOffset StartsAt, int SliceCount);
public sealed record AdminBookingRequest(Guid CourtId, Guid UserId, DateTimeOffset StartsAt, int SliceCount);
public sealed record AdminCancelRequest(bool WaivePenalty);
