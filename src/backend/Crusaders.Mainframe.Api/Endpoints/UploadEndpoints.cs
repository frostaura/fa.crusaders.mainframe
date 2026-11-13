using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

public static class UploadEndpoints
{
    public static IEndpointRouteBuilder MapUploadEndpoints(this IEndpointRouteBuilder app)
    {
        // Anonymous — registration is the primary upload path and happens before any auth.
        //
        // BP-04: it was anonymous AND unbounded — any bytes labelled image/jpeg were kept, under the
        // global per-address backstop of 6,000 a minute, and nothing ever removed a file a
        // registration did not go on to use: 25 MB went in within a second. Now the bytes decide the
        // type, the auth limit (ten a minute per address) applies, the club's recent intake is
        // capped, and the orphan sweep removes what no membership references. See MemberPhotoFiles.
        app.MapPost("/api/v1/uploads/photo", async (HttpRequest req, ITenantContext tenant, MemberPhotoFiles photos, CancellationToken ct) =>
        {
            if (!req.HasFormContentType) return Results.BadRequest(new { error = "expected_multipart" });

            var form = await req.ReadFormAsync(ct);
            var saved = await photos.SaveAsync(tenant.TenantSlug, form.Files.GetFile("file"), ct);
            return saved.Ok
                ? Results.Ok(new { url = saved.Url, bytes = saved.Bytes })
                : Refusal(saved);
        }).AllowAnonymous().DisableAntiforgery().RequireRateLimiting(RateLimitPolicies.Auth);

        return app;
    }

    /// <summary>A refused save, with the cap where the refusal is about size.</summary>
    internal static IResult Refusal(MemberPhotoFiles.SaveResult saved) => saved.Error == "file_too_large"
        ? Results.BadRequest(new { error = saved.Error, max_bytes = MemberPhotoFiles.MaxBytes })
        : Results.Json(new { error = saved.Error }, statusCode: saved.Status);
}
