using System.Security.Cryptography;
using System.Text;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// A member's photo by URL (perf round, 2026-09-30).
///
/// <para>
/// <b>Why.</b> A photo is stored either as an <c>/uploads/…</c> path or as a <c>data:image/…</c>
/// URI, and the data form travelled INSIDE every read that shows a face — once per booked slot
/// on <c>/schedule</c>, once per row on the admin members list. A read that asks for links
/// (<c>photos=url</c>) is given <c>/api/v1/photos/{userId}/{hash}</c> instead, and the browser
/// fetches each face once and caches it for good.
/// </para>
///
/// <para>
/// <b>Why anonymous, and why that is the same exposure as before.</b> An <c>&lt;img&gt;</c> sends no
/// bearer token, and the uploaded form (<c>/uploads/…</c>) has always been served anonymously at
/// an unguessable path. This is the same model: the URL names the member AND a hash of the photo
/// itself, so only somebody who was handed the URL — a member looking at the grid, where the
/// photo is shown anyway — can fetch it, and a URL for a replaced photo stops working. The hash
/// changing with the content is also what makes the year-long immutable cache safe.
/// </para>
///
/// <para>
/// An SVG photo is served under a sandboxing CSP: as an image it cannot run script, and a
/// member who opens the URL directly gets a document that cannot either.
/// </para>
/// </summary>
public static class PhotoEndpoints
{
    public const string Route = "/api/v1/photos";

    public static IEndpointRouteBuilder MapPhotoEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet(Route + "/{userId:guid}/{hash}", ServeAsync).AllowAnonymous();
        return app;
    }

    /// <summary>
    /// The URL a read hands out for a stored photo: a data URI becomes a link here, anything else
    /// (an <c>/uploads/</c> path, or none) is returned as it is.
    /// </summary>
    public static string? Link(Guid userId, string? photoUrl) =>
        photoUrl is not null && photoUrl.StartsWith("data:", StringComparison.Ordinal)
            ? $"{Route}/{userId:N}/{Hash(photoUrl)}"
            : photoUrl;

    /// <summary>Whether a read asked for photo links (<c>photos=url</c>) rather than the stored values.</summary>
    public static bool Wanted(string? photos) => string.Equals(photos, "url", StringComparison.OrdinalIgnoreCase);

    /// <summary>The first 16 hex digits of the SHA-256 of the stored value — a version and a capability.</summary>
    public static string Hash(string photoUrl) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(photoUrl)))[..16].ToLowerInvariant();

    private static async Task<IResult> ServeAsync(Guid userId, string hash, HttpContext ctx, MainframeDbContext db, CancellationToken ct)
    {
        // Tenantless on purpose (the path is in TenantResolutionMiddleware's list): an <img> carries
        // no token to resolve a club from. The hash is the check, not the club.
        var stored = await db.Memberships.AsNoTracking().IgnoreQueryFilters()
            .Where(m => m.UserId == userId)
            .Select(m => m.PhotoUrl)
            .FirstOrDefaultAsync(ct);
        if (stored is null || !stored.StartsWith("data:", StringComparison.Ordinal)
            || !CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Hash(stored)), Encoding.ASCII.GetBytes(hash)))
        {
            return Results.NotFound();
        }
        if (Decode(stored) is not { } image) return Results.NotFound();

        var headers = ctx.Response.Headers;
        headers.CacheControl = "public, max-age=31536000, immutable";
        headers.Remove("Vary");
        headers.ContentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
        return Results.File(image.Bytes, image.ContentType);
    }

    private sealed record Image(string ContentType, byte[] Bytes);

    /// <summary><c>data:image/&lt;type&gt;;base64,&lt;payload&gt;</c> only; anything else is not a photo this serves.</summary>
    private static Image? Decode(string dataUri)
    {
        var comma = dataUri.IndexOf(',');
        if (comma < 0) return null;
        var meta = dataUri[5..comma];
        if (!meta.EndsWith(";base64", StringComparison.OrdinalIgnoreCase)) return null;
        var contentType = meta[..^7];
        if (!contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase) || contentType.Contains(';')) return null;
        try
        {
            return new Image(contentType.ToLowerInvariant(), Convert.FromBase64String(dataUri[(comma + 1)..]));
        }
        catch (FormatException)
        {
            return null;
        }
    }
}
