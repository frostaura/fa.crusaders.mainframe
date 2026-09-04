using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// QR identification — the third leg of blueprint B.1's triple-stack alongside biometric
/// and PIN.
///
/// <para>
/// The member's PWA calls <c>POST /api/v1/me/qr/generate</c> and renders what comes back
/// as a QR. What comes back is an <see cref="AccessCode"/>, not a token: twelve
/// characters the court box's scanner can actually carry (see that type for the 24-byte
/// pipeline limit that ruled a JWT out). Which code depends on what the member is about
/// to do —
/// </para>
///
/// <list type="bullet">
///   <item><b>booking</b>: they have a booking whose activation window is in reach, so the
///   code is that booking's own, minted with it and living until its end plus the grace
///   window. The box finds the roster entry by the code, with no search.</item>
///   <item><b>ident</b>: no booking is in reach, so the code is a short-lived member-ident
///   one — for a walk-up, or for volunteering to pay at somebody else's court.</item>
/// </list>
///
/// <para>
/// The courtside camera path (<c>POST /api/v1/court/{n}/qr/match</c>) is an ACTIVATION
/// path, like the box's <c>/activate</c>: it resolves either kind of code through
/// <see cref="IdentificationResolver.ResolveForActivationAsync"/>, and a booking code opens
/// only its own booking — never the member's wallet, which is what the walk-up and
/// payer-override paths ask <see cref="IdentificationResolver.ResolveAsync"/> for.
/// </para>
/// </summary>
public static class QrEndpoints
{
    public static IEndpointRouteBuilder MapQrEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/v1/me/qr/generate", GenerateAsync)
           .RequireAuthorization()
           .RequireRateLimiting(RateLimitPolicies.Auth);

        app.MapPost("/api/v1/court/{courtNumber:int}/qr/match", async (
            int courtNumber, QrMatchRequest req,
            MainframeDbContext db,
            IdentificationResolver identities,
            CourtActivationService activation,
            CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(req.Token)) return Results.BadRequest(new { error = "token_required" });

            // Resolved through the shared resolver rather than inline here. There were two
            // copies of this — one for the courtside camera and one that would have been
            // written for the court box's walk-up path — and two implementations of "is this
            // code real" is one implementation more than a security check should ever have.
            var resolved = await identities.ResolveForActivationAsync("qr", req.Token, ct);
            if (resolved is null) return Results.Ok(new { matched = false, reason = "invalid_or_expired" });
            var userId = resolved.UserId;

            // Identify AND activate. This used to confirm a booking existed and return a
            // user_id — no ledger post, no CheckedInAt, no event, no audit row. So a
            // member who identified by QR played free and was swept as a no-show, since
            // attendance is CheckedInAt and nothing here set it.
            var court = await db.Courts.FirstOrDefaultAsync(c => c.CourtNumber == courtNumber, ct);
            if (court is null) return Results.NotFound();

            var now = DateTimeOffset.UtcNow;

            // Shared window: was hardcoded at -30 minutes here while the no-show sweep used
            // the tenant's grace setting, so the two disagreed about the same booking.
            var booking = await activation.FindForUserAsync(court.Id, userId, now, ct);
            // A booking code names its booking and opens that one only: presented at a
            // court the booking is not on, it is no booking at all here.
            if (booking is null || (resolved.BookingId is { } named && booking.Id != named))
            {
                return Results.Ok(new { matched = false, reason = "no_active_booking" });
            }

            var result = await activation.ActivateAsync(
                court, booking, identifiedUserId: userId, payerOverrideUserId: null, method: "qr", ct);

            return CourtActivationResponse.For(result, userId);
        }).RequireAuthorization(p => p.RequireRole("admin"))
          .RequireRateLimiting(RateLimitPolicies.Auth);

        return app;
    }

    /// <summary>
    /// The code the member's screen should show right now.
    ///
    /// <para>
    /// A booking is "in reach" when its activation window — from <c>cue</c> minutes before
    /// it starts until it ends — overlaps the next <c>roster_window_minutes</c>, the same
    /// horizon the box's cached roster looks ahead. Lazily minted: a booking made before
    /// codes existed, or whose code has been purged, gets one here.
    /// </para>
    /// </summary>
    private static async Task<IResult> GenerateAsync(
        HttpContext ctx,
        MainframeDbContext db,
        ITenantContext tenant,
        TenantSettingsAccessor settingsAccessor,
        AccessCodeService codes,
        CancellationToken ct)
    {
        var userId = ctx.User.Id() ?? Guid.Empty;
        if (userId == Guid.Empty) return Results.Unauthorized();

        var settings = await settingsAccessor.GetAsync(ct);
        var now = DateTimeOffset.UtcNow;

        // [StartsAt − cue, EndsAt] intersects [now, now + roster]  ⇔
        // StartsAt ≤ now + roster + cue  ∧  EndsAt ≥ now. Rearranged so the predicate is
        // a comparison against two constants the provider can translate.
        var latestStart = now.AddMinutes(settings.RosterWindowMinutes + settings.ActivationCueWindowMinutes);
        var booking = await db.Bookings
            .Where(b => b.UserId == userId
                        && b.Status == BookingStatus.Booked
                        && b.StartsAt <= latestStart
                        && b.EndsAt >= now)
            .OrderBy(b => b.StartsAt)
            .FirstOrDefaultAsync(ct);

        if (booking is not null)
        {
            var code = await codes.MintForBookingAsync(booking, TimeSpan.FromMinutes(settings.GraceWindowMinutes), ct);
            var court = await db.Courts.AsNoTracking().FirstOrDefaultAsync(c => c.Id == booking.CourtId, ct);

            return Results.Ok(new
            {
                code = code.Code,
                kind = "booking",
                expires_in_seconds = ExpiresIn(code, now),
                booking_id = booking.Id,
                court_number = court?.CourtNumber,
                starts_at = booking.StartsAt,
            });
        }

        var ident = await codes.MintIdentAsync(userId, TimeSpan.FromSeconds(settings.QrLifetimeSeconds), ct);
        return Results.Ok(new
        {
            code = ident.Code,
            kind = "ident",
            expires_in_seconds = ExpiresIn(ident, now),
        });
    }

    private static int ExpiresIn(AccessCode code, DateTimeOffset now)
        => (int)Math.Max(0, Math.Floor((code.ExpiresAt - now).TotalSeconds));
}

public sealed record QrMatchRequest(string? Token);
