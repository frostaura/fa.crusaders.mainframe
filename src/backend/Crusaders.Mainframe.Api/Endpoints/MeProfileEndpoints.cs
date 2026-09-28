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
                top_up_credits_per_zar = tariff.TopUpRate,
                peak_priority = tariff.PeakPriority,

                // GOAL item 12: which glyph pair this club's confirm/decline buttons wear. Here
                // rather than on a settings route because this is the one club-wide value a
                // MEMBER needs and the settings surface is admin-only. It is their own club's by
                // construction — the accessor resolves the tenant from the caller's own token, so
                // there is no id a member could supply to read another club's.
                action_glyphs = ActionGlyphs.For(clubSettings),

                // The club's money symbol, on this payload for exactly the same two reasons —
                // a member needs it (the top-up screens are theirs) and the settings surface is
                // admin-only — and safe for the same third: it is resolved from the caller's own
                // token, so no member can ask for another club's. The alternative, a second
                // endpoint for one string, would be a round trip on the first paint.
                currency_symbol = CurrencySymbol.For(clubSettings),

                // The same object GET /me/preferences answers, embedded so the first paint
                // knows the theme before it draws anything — a separate round trip would flash
                // the wrong theme on every cold load. Defaults when the member has never
                // changed one; reading never creates the row.
                preferences = await prefs.GetAsync(user.Id, ct),

                // D11: credits received as an organiser's shares, held for the partners until the
                // earliest share deadline — so the first paint can say "12 cr held until …".
                held_credits = held.Held,
                held_until = held.ReleasesAt,
            });
        });

        g.MapPut("/profile", async (UpdateProfileRequest req, HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
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
                // Accept either an in-tenant uploaded URL ("/uploads/...") or a data: URI fallback.
                var url = req.PhotoUrl.Trim();
                if (url.Length == 0) membership.PhotoUrl = null;
                else if (url.StartsWith("/uploads/") || url.StartsWith("data:image/")) membership.PhotoUrl = url;
                else return Results.BadRequest(new { error = "photo_url_invalid" });
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
            var result = await auth.ChangePasswordAsync(userId, req.CurrentPassword, req.NewPassword, ct);
            return result switch
            {
                PasswordChangeResult.Ok => Results.Ok(new { changed = true }),
                PasswordChangeResult.CurrentPasswordWrong => Results.BadRequest(new { error = "current_password_incorrect" }),
                PasswordChangeResult.Unchanged => Results.BadRequest(new { error = "password_unchanged" }),
                PasswordChangeResult.NoPasswordSet => Results.BadRequest(new { error = "no_password_set" }),
                _ => Results.Problem("Unexpected"),
            };
        });

        // Authenticated multipart upload: stores under the resolved tenant slug
        // and pins the membership's photo_url to the new URL atomically.
        g.MapPost("/photo", async (HttpRequest req, HttpContext ctx, ITenantContext tenant, IConfiguration config, MainframeDbContext db, ILoggerFactory loggerFactory, CancellationToken ct) =>
        {
            var logger = loggerFactory.CreateLogger("MePhoto");
            if (!req.HasFormContentType) return Results.BadRequest(new { error = "expected_multipart" });

            var form = await req.ReadFormAsync(ct);
            var file = form.Files.GetFile("file");
            if (file is null || file.Length == 0) return Results.BadRequest(new { error = "file_missing" });
            if (file.Length > 5 * 1024 * 1024) return Results.BadRequest(new { error = "file_too_large", max_bytes = 5 * 1024 * 1024 });
            var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "image/jpeg", "image/png", "image/webp", "image/gif" };
            if (!allowed.Contains(file.ContentType ?? "")) return Results.BadRequest(new { error = "unsupported_content_type", got = file.ContentType });

            var userId = ctx.User.Id() ?? Guid.Empty;
            var membership = await db.Memberships.FirstOrDefaultAsync(m => m.UserId == userId, ct);
            if (membership is null) return Results.NotFound(new { error = "membership_not_found" });

            var ext = file.ContentType switch
            {
                "image/jpeg" => "jpg",
                "image/png" => "png",
                "image/webp" => "webp",
                "image/gif" => "gif",
                _ => "bin",
            };
            var storageRoot = config["Media:StoragePath"] ?? "./media";
            var subdir = Path.Combine(storageRoot, tenant.TenantSlug, "photos");
            Directory.CreateDirectory(subdir);
            var fileId = Guid.NewGuid().ToString("N");
            var fullPath = Path.Combine(subdir, $"{fileId}.{ext}");
            await using (var fs = File.Create(fullPath))
            await using (var src = file.OpenReadStream())
                await src.CopyToAsync(fs, ct);

            var url = $"/uploads/{tenant.TenantSlug}/photos/{fileId}.{ext}";
            membership.PhotoUrl = url;
            await db.SaveChangesAsync(ct);
            logger.LogInformation("photo updated for user {UserId}", userId);
            return Results.Ok(new { photo_url = url });
        }).DisableAntiforgery();

        return app;
    }
}

public sealed record UpdateProfileRequest(string? FullName, string? PhotoUrl);
public sealed record ChangePasswordRequest(string CurrentPassword, string NewPassword);
