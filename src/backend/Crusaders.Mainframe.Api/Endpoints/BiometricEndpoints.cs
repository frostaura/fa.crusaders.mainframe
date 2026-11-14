using Crusaders.Mainframe.Api.Biometric;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
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
            if (result.Ok) return Results.Ok(new { template_id = result.TemplateId });
            return result.FailureReason switch
            {
                BiometricService.MemberNotFound => Results.NotFound(new { error = result.FailureReason }),
                NoBiometricDevice.Unavailable => Results.Json(new { error = result.FailureReason }, statusCode: StatusCodes.Status503ServiceUnavailable),
                _ => Results.BadRequest(new { error = result.FailureReason ?? "enrollment_failed" }),
            };
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

        court.MapPost("/{courtNumber:int}/biometric/match", async (
            int courtNumber, CourtMatchRequest? req, BiometricService svc, IdentificationResolver identities, CancellationToken ct) =>
        {
            // Blueprint B.2 — the at-court payer override, and the volunteer has to prove
            // who they are.
            //
            // This used to take a bare `payer_user_id` off the request body, which moved a
            // full court charge onto any member in the tenant with no second identification
            // and no consent artefact of any kind. The ids needed are not secret either —
            // GET /api/v1/schedule hands every authenticated member the owner id of every
            // slot. The role gate was no defence: `admin` is what the shared courtside
            // kiosk runs as, so it is exactly the session an opportunist has access to.
            //
            // So the volunteer presents the same thing a walk-up presents: a token this
            // server minted, for this tenant, that expires in sixty seconds. QR only, for
            // the reason IdentificationResolver spells out — a PIN checked against the
            // whole roll rather than against a booking's candidates is a 10,000-space
            // oracle over every member.
            Guid? payerUserId = null;
            if (!string.IsNullOrWhiteSpace(req?.PayerToken))
            {
                payerUserId = await identities.ResolveAsync(req.PayerMethod ?? "qr", req.PayerToken, ct);

                // Refused rather than quietly falling back to charging the booked player.
                // Silently ignoring an unreadable volunteer token bills the wrong person
                // and tells nobody.
                if (payerUserId is null) return Results.BadRequest(new { error = "payer_not_recognised" });
            }

            var (match, activation) = await svc.MatchAtCourtAsync(courtNumber, payerUserId, ct);
            return MatchResponse(match, activation);
        });

        return app;
    }

    /// <summary>
    /// Identified: the shared courtside contract with the read-quality extras appended. A
    /// refusal (insufficient balance, not chargeable) surfaces as <c>activated:false</c> +
    /// <c>reason</c> at HTTP 200, exactly as the PIN and QR endpoints answer it — this used
    /// to discard the activation outcome and report a refusal as a plain successful match.
    /// No match: the original shape, unchanged.
    /// </summary>
    private static IResult MatchResponse(BiometricMatchResult match, ActivationResult? activation)
    {
        if (match.Matched && match.MatchedUserId is Guid matchedUserId)
        {
            // The service fabricates ActivationResult.NoBooking for a match with nothing
            // to activate, precisely so that a match always carries an outcome — so the
            // match alone decides the branch, and a null here is a service bug, not a
            // shape to answer.
            return CourtActivationResponse.For(
                activation!, matchedUserId, match.Confidence, match.LivenessScore, match.LatencyMs);
        }

        return Results.Ok(new
        {
            matched = false,
            user_id = (Guid?)null,
            confidence = match.Confidence,
            liveness = match.LivenessScore,
            latency_ms = match.LatencyMs,
        });
    }
}

public sealed record EnrollRequest(Guid UserId, string? FingerLabel, string? ConsentReceiptHash);
/// <summary>
/// The optional payer override at the court.
///
/// <para>
/// A token rather than a user id, deliberately: see the handler. <c>PayerMethod</c> exists
/// so the field means the same thing here as everywhere else a member identifies, and so
/// the refusal of a non-QR method is explicit rather than implied.
/// </para>
/// </summary>
public sealed record CourtMatchRequest(string? PayerMethod, string? PayerToken);
