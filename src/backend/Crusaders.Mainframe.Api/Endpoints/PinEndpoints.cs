using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.RateLimiting;
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

            var actor = ctx.User.Id() ?? Guid.Empty;
            user.PinHash = hasher.Hash(req.Pin!);
            db.AuditLogs.Add(new AuditLog
            {
                TenantId = membership.TenantId,
                ActorUserId = actor,
                SubjectUserId = user.Id,
                Action = "user.pin_set_by_admin",
            });
            // BP-11: a PIN identifies the member at the court and spends their minutes there, so a
            // desk that sets one is changing a credential — on the club's undeletable change record
            // in the same save (never the PIN itself), and told to the member afterwards.
            await ctx.RequestServices.GetRequiredService<AdminChangeRecorder>().StageAsync(new AdminChange(
                Action: AdminChangeActions.MemberPinSet, ActorUserId: actor, SubjectKind: AdminChangeSubjects.User,
                SubjectId: user.Id, SubjectLabel: membership.FullName, After: new { pin_set = true }), ct);
            await db.SaveChangesAsync(ct);

            var services = ctx.RequestServices;
            var queued = await Email.EmailDispatch.QueueAsync(
                services.GetRequiredService<Email.IEmailService>(),
                services.GetRequiredService<ILoggerFactory>().CreateLogger("AdminSetPin"),
                Email.EmailTemplates.PinSetByClub(await services.GetRequiredService<Email.ClubIdentityResolver>().GetAsync(ct), user.Email, membership.FullName),
                $"PIN-set notice for {user.Id}");
            return Results.Ok(new { pin_set = true, member_email_queued = queued });
        }).RequireAuthorization(p => p.RequireRole("admin"));

        // Court-side — identify by PIN. Returns the matched user_id if any active-booking holder's
        // PIN matches the input; otherwise no_match. Restricted to admin (the courtside terminal runs
        // in admin mode).
        // Court-side — identify by PIN and ACTIVATE the court.
        //
        // This used to be a pure identity oracle: it returned a user_id and did nothing
        // else. No ledger post, no CheckedInAt, no event, no audit row — so a member who
        // identified by PIN played free AND was swept as a no-show, because attendance is
        // CheckedInAt and nothing set it. Only the biometric path ever charged. The
        // blueprint calls these a triple stack; in the money model they were not one.
        app.MapPost("/api/v1/court/{courtNumber:int}/pin/match", async (
            int courtNumber, PinMatchRequest req,
            MainframeDbContext db, IPasswordHasher hasher,
            CourtActivationService activation,
            CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(req.Pin)) return Results.BadRequest(new { error = "pin_required" });

            var court = await db.Courts.FirstOrDefaultAsync(c => c.CourtNumber == courtNumber, ct);
            if (court is null) return Results.NotFound();

            var now = DateTimeOffset.UtcNow;

            // The window is the tenant's grace setting, shared with biometric, QR and the
            // no-show sweep. It was hardcoded at 30 minutes here while the sweep used 5,
            // so a member could be inside this window and already marked a no-show.
            var candidateBookings = await activation.CandidatesAsync(court.Id, now, ct);
            // Every player who may activate a candidate — the organiser and each accepted partner
            // (D11) — earliest booking first, so a partner's own PIN finds the game they joined.
            var players = await activation.PlayersOfAsync(candidateBookings, ct);
            var candidateUserIds = players.Select(p => (Guid?)p.UserId).Distinct().ToList();

            var candidates = await db.Users
                .Where(u => candidateUserIds.Contains(u.Id) && u.PinHash != null)
                .Select(u => new { u.Id, u.PinHash })
                .ToListAsync(ct);

            foreach (var c in candidates)
            {
                if (c.PinHash is null || !hasher.Verify(req.Pin, c.PinHash)) continue;

                var booking = players.Where(p => p.UserId == c.Id).Select(p => p.Booking).FirstOrDefault();
                if (booking is null) continue;

                var result = await activation.ActivateAsync(
                    court, booking, identifiedUserId: c.Id, payerOverrideUserId: null, method: "pin", ct);

                return CourtActivationResponse.For(result, c.Id);
            }

            return Results.Ok(new { matched = false, user_id = (Guid?)null });
        }).RequireAuthorization(p => p.RequireRole("admin"))
          // A four-digit PIN is a 10,000-space oracle. Unlimited, it falls in minutes.
          .RequireRateLimiting(RateLimitPolicies.Auth);

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
