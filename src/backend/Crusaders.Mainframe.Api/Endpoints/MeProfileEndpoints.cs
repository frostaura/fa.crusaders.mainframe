using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The authenticated user's view of their own profile + edit endpoints.
/// </summary>
public static class MeProfileEndpoints
{
    public static IEndpointRouteBuilder MapMeProfileEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/me").RequireAuthorization();

        g.MapGet("/profile", async (
            HttpContext ctx, ITenantContext tenant, MainframeDbContext db,
            TenantSettingsAccessor settings, UserPreferencesService prefs, LedgerService ledger, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == userId, ct);
            if (user is null) return Results.NotFound();
            var membership = await db.Memberships.AsNoTracking().FirstOrDefaultAsync(m => m.UserId == userId, ct);
            var clubSettings = await settings.GetAsync(ct);
            var tariff = await MemberTariffs.ForAsync(db, userId, clubSettings, ct);
            var held = await ledger.GetHeldAsync(userId, ct);
            return Results.Ok(new
            {
                user_id = user.Id,
                email = user.Email,
                is_admin = user.IsAdmin,
                tenant_slug = tenant.TenantSlug,
                full_name = membership?.FullName,
                membership_number = membership?.MembershipNumber,
                photo_url = membership?.PhotoUrl,
                status = membership?.Status.ToString().ToLowerInvariant(),
                must_change_password = user.MustChangePassword,

                // D2: the member's OWN active groups (names only — never who else is in them,
                // the booking grid's photo-and-name rule) and what they add up to for the two
                // things the member class used to decide.
                groups = tariff.Groups.Select(g => new { id = g.Id, name = g.Name }).ToList(),
                package_discount_bps = tariff.PackageDiscountBps,
                peak_priority = tariff.PeakPriority,

                // The club's money symbol, on this payload because it is the one club-wide
                // value a MEMBER needs (the buy-minutes screens are theirs) and the settings surface
                // is admin-only. It is their own club's by construction — the accessor resolves
                // the tenant from the caller's own token, so no member can ask for another
                // club's. The alternative, a second endpoint for one string, would be a round
                // trip on the first paint. (action_glyphs rode here until P10 retired it.)
                currency_symbol = CurrencySymbol.For(clubSettings),

                // The club's IANA zone. This payload is read at every app start, so the client
                // knows the club's day from boot and no screen — least of all one opened cold
                // from a mail on a phone in another zone — writes a court time in the phone's.
                timezone = DoorClock.ZoneOf(clubSettings).Name,

                // The same object GET /me/preferences answers, embedded so the first paint
                // knows the theme before it draws anything — a separate round trip would flash
                // the wrong theme on every cold load. Defaults when the member has never
                // changed one; reading never creates the row.
                preferences = await prefs.GetAsync(user.Id, ct),

                // D11: minutes received as an organiser's shares, held for the partners until the
                // earliest share deadline — so the first paint can say "12 min held until …".
                held_minutes = held.Held,
                owed_back_minutes = held.OwedBack,
                held_until = held.ReleasesAt,
                // C4: one part per share deadline, soonest first, summing to held_minutes; held_until is the first.
                held_parts = held.WireParts(),
            });
        });

        g.MapPut("/profile", async (UpdateProfileRequest req, HttpContext ctx, MainframeDbContext db, MemberPhotoFiles photos, ITenantContext tenant, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var membership = await db.Memberships.FirstOrDefaultAsync(m => m.UserId == userId, ct);
            if (membership is null) return Results.NotFound(new { error = "membership_not_found" });

            if (req.FullName is not null)
            {
                var name = req.FullName.Trim();
                if (!PersonNames.IsAcceptable(name)) return Results.BadRequest(new { error = PersonNames.FullNameInvalid });
                membership.FullName = name;
            }
            if (req.PhotoUrl is not null)
            {
                // BP-06: only a photo this club issued, whose file exists — never another club's
                // path, an outside URL, a data: URI (a 4 KB one never fitted the column anyway) or
                // nothing at all. The photo is what the booking grid shows other players instead of
                // an email or a membership number, which is why it is mandatory.
                var url = req.PhotoUrl.Trim();
                if (await PhotoRefusalAsync(db, photos, tenant.TenantSlug, url, membership.Id, ct) is { } problem)
                    return Results.BadRequest(new { error = problem });
                if (membership.PhotoUrl != url) photos.TryDelete(tenant.TenantSlug, membership.PhotoUrl);
                membership.PhotoUrl = url;
            }
            await db.SaveChangesAsync(ct);
            return Results.Ok(new
            {
                full_name = membership.FullName,
                photo_url = membership.PhotoUrl,
            });
        });

        // The member changes their own password.
        //
        // There was no way to do this at all: `/profile` offered a photo, a name and passkeys,
        // and the API had no endpoint. So an admin-issued temporary password — emailed in
        // plaintext, shown on an admin's screen — was the account's permanent credential, and
        // with no self-service reset either there was no path out of it.
        //
        // A wrong current password answers 400, never 401. A 401 on an authenticated route is
        // the client's session-expired signal: answering one here would sign the member out for
        // mistyping their old password.
        g.MapPost("/password", async (ChangePasswordRequest req, HttpContext ctx, AuthService auth, CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(req.CurrentPassword) || string.IsNullOrEmpty(req.NewPassword))
                return Results.BadRequest(new { error = "missing_fields" });
            if (req.NewPassword.Length < 8) return Results.BadRequest(new { error = "password_too_short" });

            var userId = ctx.User.Id() ?? Guid.Empty;
            // The change ends every session minted before it, this one included (member-code
            // §10); `access_token` is this session's replacement and the client must adopt it.
            var (result, reissued, epoch) = await auth.ChangePasswordAndReissueAsync(userId, req.CurrentPassword, req.NewPassword, ct);
            return result switch
            {
                PasswordChangeResult.Ok => await PasswordChangedAsync(ctx, userId, reissued, epoch, ct),
                PasswordChangeResult.CurrentPasswordWrong => Results.BadRequest(new { error = "current_password_incorrect" }),
                PasswordChangeResult.Unchanged => Results.BadRequest(new { error = "password_unchanged" }),
                PasswordChangeResult.NoPasswordSet => Results.BadRequest(new { error = "no_password_set" }),
                _ => Results.Problem("Unexpected"),
            };
        });

        // Authenticated multipart upload: stores under the resolved tenant slug
        // and pins the membership's photo_url to the new URL atomically.
        g.MapPost("/photo", ReplacePhotoAsync).DisableAntiforgery();

        return app;
    }

    /// <summary>
    /// Why <paramref name="url"/> cannot be this membership's photo, or null: not one this club
    /// issued, its file gone, or another membership's photo already (a face copied off the grid is
    /// somebody else's face). Shared with registration, where <paramref name="selfMembershipId"/> is null.
    /// </summary>
    internal static async Task<string?> PhotoRefusalAsync(
        MainframeDbContext db, MemberPhotoFiles photos, string tenantSlug, string? url, Guid? selfMembershipId, CancellationToken ct)
    {
        if (photos.Problem(tenantSlug, url) is { } problem) return problem;
        var taken = await db.Memberships.IgnoreQueryFilters()
            .AnyAsync(m => m.PhotoUrl == url!.Trim() && m.Id != selfMembershipId, ct);
        return taken ? "photo_url_invalid" : null;
    }

    /// <summary>
    /// Stores a new photo and points the membership at it, removing the one it replaces (BP-04: the
    /// old file used to stay on the volume forever). The bytes decide the type — see MemberPhotoFiles.
    /// </summary>
    private static async Task<IResult> ReplacePhotoAsync(
        HttpRequest req, HttpContext ctx, ITenantContext tenant, MemberPhotoFiles photos, MainframeDbContext db, CancellationToken ct)
    {
        if (!req.HasFormContentType) return Results.BadRequest(new { error = "expected_multipart" });

        var userId = ctx.User.Id() ?? Guid.Empty;
        var membership = await db.Memberships.FirstOrDefaultAsync(m => m.UserId == userId, ct);
        if (membership is null) return Results.NotFound(new { error = "membership_not_found" });

        var form = await req.ReadFormAsync(ct);
        var saved = await photos.SaveAsync(tenant.TenantSlug, form.Files.GetFile("file"), ct);
        if (!saved.Ok) return UploadEndpoints.Refusal(saved);

        var previous = membership.PhotoUrl;
        membership.PhotoUrl = saved.Url;
        await db.SaveChangesAsync(ct);
        photos.TryDelete(tenant.TenantSlug, previous);
        return Results.Ok(new { photo_url = saved.Url });
    }

    /// <summary>
    /// The change raised the epoch, so the session's refresh cookie died with every other session
    /// (B1); the replacement access token gets a new refresh family beside it, or the member at the
    /// keyboard would be signed out at the next idle spell after doing the responsible thing.
    /// </summary>
    private static async Task<IResult> PasswordChangedAsync(HttpContext ctx, Guid userId, string? reissued, int epoch, CancellationToken ct)
    {
        var family = await SessionCookies.StartAsync(ctx, userId, epoch, ct);
        return Results.Ok(new { changed = true, access_token = reissued is null ? null : SessionCookies.Bind(ctx, reissued, family) });
    }
}

public sealed record UpdateProfileRequest(string? FullName, string? PhotoUrl);
public sealed record ChangePasswordRequest(string CurrentPassword, string NewPassword);
