using Crusaders.Mainframe.Api.Multitenancy;
using Microsoft.AspNetCore.Authorization;

namespace Crusaders.Mainframe.Api.Endpoints;

public static class UploadEndpoints
{
    private static readonly HashSet<string> AllowedContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/jpeg", "image/png", "image/webp", "image/gif",
    };
    private const long MaxBytes = 5 * 1024 * 1024;

    public static IEndpointRouteBuilder MapUploadEndpoints(this IEndpointRouteBuilder app)
    {
        // Anonymous — registration is the primary upload path and happens before any auth.
        app.MapPost("/api/v1/uploads/photo", async (HttpRequest req, ITenantContext tenant, IConfiguration config, ILoggerFactory loggerFactory, CancellationToken ct) =>
        {
            var logger = loggerFactory.CreateLogger("UploadPhoto");
            if (!req.HasFormContentType) return Results.BadRequest(new { error = "expected_multipart" });

            var form = await req.ReadFormAsync(ct);
            var file = form.Files.GetFile("file");
            if (file is null || file.Length == 0) return Results.BadRequest(new { error = "file_missing" });
            if (file.Length > MaxBytes) return Results.BadRequest(new { error = "file_too_large", max_bytes = MaxBytes });
            if (!AllowedContentTypes.Contains(file.ContentType ?? "")) return Results.BadRequest(new { error = "unsupported_content_type", got = file.ContentType });

            var storageRoot = config["Media:StoragePath"] ?? "./media";
            var subdir = Path.Combine(storageRoot, tenant.TenantSlug, "photos");
            Directory.CreateDirectory(subdir);

            var ext = file.ContentType switch
            {
                "image/jpeg" => "jpg",
                "image/png" => "png",
                "image/webp" => "webp",
                "image/gif" => "gif",
                _ => "bin",
            };
            var fileId = Guid.NewGuid().ToString("N");
            var fullPath = Path.Combine(subdir, $"{fileId}.{ext}");

            await using (var fs = File.Create(fullPath))
            await using (var src = file.OpenReadStream())
                await src.CopyToAsync(fs, ct);

            // Public URL pattern; the served-from path is mapped below.
            var url = $"/uploads/{tenant.TenantSlug}/photos/{fileId}.{ext}";
            logger.LogInformation("photo uploaded for tenant {Slug}: {Url}", tenant.TenantSlug, url);
            return Results.Ok(new { url, content_type = file.ContentType, bytes = file.Length });
        }).AllowAnonymous().DisableAntiforgery();

        return app;
    }
}
