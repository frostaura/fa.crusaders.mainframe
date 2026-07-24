using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
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

        g.MapGet("/profile", async (HttpContext ctx, ITenantContext tenant, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == userId, ct);
            if (user is null) return Results.NotFound();
            var membership = await db.Memberships.AsNoTracking().FirstOrDefaultAsync(m => m.UserId == userId, ct);
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
                if (name.Length < 2 || name.Length > 120) return Results.BadRequest(new { error = "full_name_invalid" });
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
                "image/jpeg" => "jpg", "image/png" => "png", "image/webp" => "webp", "image/gif" => "gif",
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
