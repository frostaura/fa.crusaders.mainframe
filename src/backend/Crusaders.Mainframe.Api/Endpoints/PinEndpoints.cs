using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Phase 8.6 — PIN identification endpoints (per blueprint B.1).
///
/// PIN is the cheapest alternative-ident method to ship — no hardware needed beyond the
/// touchpad keyboard. 4–6 digits, hashed at rest with PBKDF2. Players set their own via
/// <c>POST /api/v1/me/pin</c>; admins can set a member's PIN via the admin endpoint when
/// onboarding (e.g. for members who don't have the app yet).
/// </summary>
public static class PinEndpoints
{
    public static IEndpointRouteBuilder MapPinEndpoints(this IEndpointRouteBuilder app)
    {
        // Self-service — current user sets their own PIN.
        app.MapPost("/api/v1/me/pin", async (
            SetPinRequest req, HttpContext ctx, MainframeDbContext db, IPasswordHasher hasher, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var validation = ValidatePin(req.Pin);
            if (validation is not null) return Results.BadRequest(new { error = validation });

            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
            if (user is null) return Results.Unauthorized();
            user.PinHash = hasher.Hash(req.Pin!);
            db.AuditLogs.Add(new AuditLog
            {
                TenantId = user.TenantId,
                ActorUserId = userId,
                SubjectUserId = userId,
                Action = "user.pin_set",
            });
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { pin_set = true });
        }).RequireAuthorization();

        app.MapDelete("/api/v1/me/pin", async (HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
            if (user is null) return Results.Unauthorized();
            user.PinHash = null;
            db.AuditLogs.Add(new AuditLog
            {
                TenantId = user.TenantId,
                ActorUserId = userId,
                SubjectUserId = userId,
                Action = "user.pin_cleared",
            });
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        }).RequireAuthorization();

        // Admin — set a member's PIN (used during in-person onboarding when the member doesn't
        // have the app yet, or as a reset path when the member forgets).
        app.MapPost("/api/v1/admin/members/{memberId:guid}/pin", async (
            Guid memberId, SetPinRequest req, HttpContext ctx,
            MainframeDbContext db, IPasswordHasher hasher, CancellationToken ct) =>
        {
            var validation = ValidatePin(req.Pin);
            if (validation is not null) return Results.BadRequest(new { error = validation });
            var membership = await db.Memberships.FirstOrDefaultAsync(m => m.Id == memberId, ct);
            if (membership is null) return Results.NotFound();
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == membership.UserId, ct);
            if (user is null) return Results.NotFound();

            user.PinHash = hasher.Hash(req.Pin!);
            db.AuditLogs.Add(new AuditLog
            {
                TenantId = membership.TenantId,
                ActorUserId = ctx.User.Id() ?? Guid.Empty,
                SubjectUserId = user.Id,
                Action = "user.pin_set_by_admin",
            });
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { pin_set = true });
        }).RequireAuthorization(p => p.RequireRole("admin"));

        // Court-side — identify by PIN. Returns the matched user_id if any active-booking holder's
        // PIN matches the input; otherwise no_match. Restricted to admin (the courtside terminal runs
        // in admin mode).
        app.MapPost("/api/v1/court/{courtNumber:int}/pin/match", async (
            int courtNumber, PinMatchRequest req,
            MainframeDbContext db, IPasswordHasher hasher,
            Crusaders.Mainframe.Api.Multitenancy.ITenantContext tenant,
            CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(req.Pin)) return Results.BadRequest(new { error = "pin_required" });

            var court = await db.Courts.FirstOrDefaultAsync(c => c.CourtNumber == courtNumber, ct);
            if (court is null) return Results.NotFound();

            var now = DateTimeOffset.UtcNow;
            var windowStart = now.AddMinutes(-30);
            var windowEnd = now.AddHours(2);

            // Candidate set: users with a booked-or-active booking on this court within the window
            // who have a PIN set.
            var candidates = await (
                from b in db.Bookings
                where b.CourtId == court.Id
                    && b.Status == BookingStatus.Booked
                    && b.StartsAt < windowEnd && b.EndsAt > windowStart
                join u in db.Users on b.UserId equals u.Id
                where u.PinHash != null
                select new { u.Id, u.PinHash }
            ).Distinct().ToListAsync(ct);

            foreach (var c in candidates)
            {
                if (c.PinHash is null) continue;
                if (hasher.Verify(req.Pin, c.PinHash))
                    return Results.Ok(new { matched = true, user_id = c.Id });
            }
            return Results.Ok(new { matched = false, user_id = (Guid?)null });
        }).RequireAuthorization(p => p.RequireRole("admin"));

        return app;
    }

    private static string? ValidatePin(string? pin)
    {
        if (string.IsNullOrEmpty(pin)) return "pin_required";
        if (pin.Length < 4 || pin.Length > 6) return "pin_must_be_4_to_6_digits";
        foreach (var ch in pin) if (ch < '0' || ch > '9') return "pin_must_be_numeric";
        return null;
    }
}

public sealed record SetPinRequest(string? Pin);
public sealed record PinMatchRequest(string? Pin);
