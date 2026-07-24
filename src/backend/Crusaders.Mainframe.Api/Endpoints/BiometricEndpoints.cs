using Crusaders.Mainframe.Api.Biometric;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

public static class BiometricEndpoints
{
    public static IEndpointRouteBuilder MapBiometricEndpoints(this IEndpointRouteBuilder app)
    {
        // Admin-only enrollment
        var admin = app.MapGroup("/api/v1/admin/biometric").RequireAuthorization(p => p.RequireRole("admin"));

        admin.MapPost("/enroll", async (EnrollRequest req, HttpContext ctx, BiometricService svc, CancellationToken ct) =>
        {
            var actor = ctx.User.Id() ?? Guid.Empty;
            var result = await svc.EnrollAsync(req.UserId, actor, req.FingerLabel, req.ConsentReceiptHash ?? "v1", ct);
            return result.Ok
                ? Results.Ok(new { template_id = result.TemplateId })
                : Results.BadRequest(new { error = result.FailureReason ?? "enrollment_failed" });
        });

        admin.MapGet("/enrollments", async (MainframeDbContext db, CancellationToken ct) =>
        {
            // Active members + their active (non-superseded) templates. Members with no templates
            // are still returned so admins can find them and enroll.
            var memberships = await db.Memberships
                .Where(m => m.Status == MembershipStatus.Active)
                .Join(db.Users, m => m.UserId, u => u.Id, (m, u) => new { m, u })
                .Select(x => new { x.m.UserId, x.u.Email, x.m.FullName, x.m.PhotoUrl, x.m.MembershipNumber })
                .ToListAsync(ct);

            var templates = await db.EnrolledTemplates
                .Where(t => t.SupersededAt == null)
                .Select(t => new { t.UserId, t.TemplateId, t.FingerLabel, t.CreatedAt })
                .ToListAsync(ct);

            var byUser = templates
                .GroupBy(t => t.UserId)
                .ToDictionary(g => g.Key, g => g.OrderByDescending(t => t.CreatedAt).ToList());

            var rows = memberships
                .Select(m => new
                {
                    user_id = m.UserId,
                    full_name = m.FullName,
                    email = m.Email,
                    photo_url = m.PhotoUrl,
                    membership_number = m.MembershipNumber,
                    templates = (byUser.TryGetValue(m.UserId, out var ts) ? ts : new())
                        .Select(t => new
                        {
                            template_id = t.TemplateId,
                            finger_label = t.FingerLabel,
                            created_at = t.CreatedAt,
                        }).ToList(),
                })
                .OrderByDescending(r => r.templates.Count)
                .ThenBy(r => r.full_name)
                .ToList();

            return Results.Ok(rows);
        });

        admin.MapDelete("/templates/{templateId}", async (string templateId, MainframeDbContext db, IBiometricDevice device, CancellationToken ct) =>
        {
            var t = await db.EnrolledTemplates.FirstOrDefaultAsync(x => x.TemplateId == templateId, ct);
            if (t is null) return Results.NotFound();
            await device.RemoveTemplateAsync(templateId, ct);
            t.SupersededAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        // Court-side match endpoint — admin or kiosk role
        var court = app.MapGroup("/api/v1/court").RequireAuthorization(p => p.RequireRole("admin"));

        court.MapPost("/{courtNumber:int}/biometric/match", async (int courtNumber, CourtMatchRequest? req, BiometricService svc, CancellationToken ct) =>
        {
            // Per blueprint B.2 — optional at-court payer override. The courtside UI resolves the
            // second player via biometric / PIN / QR and passes their user_id as payer_user_id;
            // the booking_charge then debits that user's account instead of the booked player's.
            var match = await svc.MatchAtCourtAsync(courtNumber, req?.PayerUserId, ct);
            return Results.Ok(new
            {
                matched = match.Matched,
                user_id = match.MatchedUserId,
                confidence = match.Confidence,
                liveness = match.LivenessScore,
                latency_ms = match.LatencyMs,
            });
        });

        return app;
    }
}

public sealed record EnrollRequest(Guid UserId, string? FingerLabel, string? ConsentReceiptHash);
public sealed record CourtMatchRequest(Guid? PayerUserId);
