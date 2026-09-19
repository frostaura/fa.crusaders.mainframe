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
/// <c>?kind=ident</c> asks for the second unconditionally. The member decides, because the
/// server cannot: a member holding a booking code is by definition someone auto would
/// answer, and they are also the member most likely to want a walk-up on a free court
/// before their own slot. See <c>GenerateAsync</c>.
/// </para>
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

    /// <summary>What the caller asked for. <c>?kind=</c> on <c>POST /me/qr/generate</c>.</summary>
    private const string KindAuto = "auto";
    private const string KindIdent = "ident";

    /// <summary>
    /// The code the member's screen should show right now.
    ///
    /// <para>
    /// <c>?kind=auto</c> (the default, and what an omitted parameter means) picks for the
    /// member: a booking is "in reach" when its activation window — from <c>cue</c> minutes
    /// before it starts until it ends — overlaps the next <c>roster_window_minutes</c>, the
    /// same horizon the box's cached roster looks ahead, and then the answer is that
    /// booking's own code. Lazily minted: a booking made before codes existed, or whose
    /// code has been purged, gets one here.
    /// </para>
    ///
    /// <para>
    /// <c>?kind=ident</c> always answers with the member-ident code, booking or no booking.
    /// It exists because auto locked members out of the very things ident codes are for. A
    /// booking code stopped opening a wallet when the resolver was narrowed to MemberIdent
    /// (closing re-review #15), and auto hands out the booking code for the whole
    /// <c>roster_window + cue</c> ahead of a booking — over two hours by default. So a
    /// member with a court at 19:00 who arrived at 17:00 and wanted a walk-up on a free
    /// court, or to pay for a friend, had no path on their phone to a code the box would
    /// accept: it answered <c>not_recognised</c> and the glass said SEE THE DESK
    /// (round-3 finding 6). The two codes coexist — the booking's own is untouched and goes
    /// on opening its court.
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

        // A member the club has barred gets no code at all.
        //
        // Round 7 made a barred member's code INERT at every box — the walk-up route, the
        // activation paths and the cached roster all refuse them — so no money moved. This
        // route went on minting one anyway, and the screen that shows it says the code will
        // "start a walk-up on a free court, or pay for someone else's time". A promise
        // nothing keeps is a defect in its own right, and the member's only way to discover
        // it was to stand at a court and read SEE THE DESK.
        //
        // The same gate the booking routes use, and the same two codes, so one refusal has
        // one sentence wherever it surfaces: `member_suspended` for a membership the club
        // took away, `member_not_active` for one it has not granted. Refusing here without
        // that mapping would be WORSE than minting the code, because a raw token on a
        // member's screen tells them nothing — CourtCode.tsx carries the other half.
        if (await BookingMembershipGate.RefuseIfBarredAsync(db, userId, ct) is { } barred) return barred;

        // Refused rather than silently treated as auto: a typo'd kind that quietly returned
        // a booking code is exactly the lockout this parameter was added to end.
        var requested = ctx.Request.Query["kind"].ToString();
        var kind = string.IsNullOrWhiteSpace(requested) ? KindAuto : requested.Trim().ToLowerInvariant();
        if (kind is not (KindAuto or KindIdent))
        {
            return Results.BadRequest(new { error = "kind_invalid", message = $"kind must be '{KindAuto}' or '{KindIdent}'." });
        }

        var settings = await settingsAccessor.GetAsync(ct);
        var now = DateTimeOffset.UtcNow;

        // [StartsAt − cue, EndsAt] intersects [now, now + roster]  ⇔
        // StartsAt ≤ now + roster + cue  ∧  EndsAt ≥ now. Rearranged so the predicate is
        // a comparison against two constants the provider can translate.
        var latestStart = now.AddMinutes(settings.RosterWindowMinutes + settings.ActivationCueWindowMinutes);
        var booking = kind == KindIdent ? null : await db.Bookings
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
