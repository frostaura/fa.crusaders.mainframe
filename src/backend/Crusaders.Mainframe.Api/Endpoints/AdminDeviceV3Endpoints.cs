using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The admin surface device contract v3 adds (device-api.md §6–§8, §10): key rotation in place of
/// v2's Regenerate, the club's device network, and signed firmware releases with their rollout.
///
/// <para>
/// <b>Why Regenerate is gone.</b> It killed the old key on the next request and every board then
/// needed a cable (BA-01, BD-3, IO-02). Every unretired key now authenticates, so starting a
/// rotation can never strand a board; only retiring can, and it refuses to without a typed
/// confirmation naming who it strands.
/// </para>
/// </summary>
public static class AdminDeviceV3Endpoints
{
    public const string OwnerOnly = "owner_only";

    public static RouteGroupBuilder MapAdminDeviceV3Endpoints(this RouteGroupBuilder g)
    {
        g.MapGet("/api-key", StatusAsync);
        g.MapPost("/api-key/rotate", RotateAsync);
        g.MapPost("/api-key/retire", RetireAsync);
        g.MapPost("/api-key/restore", RestoreAsync);

        g.MapGet("/network", NetworkAsync);
        g.MapPut("/network", SaveNetworkAsync);

        g.MapGet("/firmware", FirmwareAsync);
        g.MapPost("/firmware", UploadAsync).DisableAntiforgery();
        g.MapPatch("/firmware/{id:guid}", RolloutAsync);
        return g;
    }

    /// <summary><c>GET /api/v1/device/firmware/{id}</c>: the image, to an authenticated board of the same club.</summary>
    public static RouteGroupBuilder MapDeviceFirmwareDownload(this RouteGroupBuilder g)
    {
        g.MapGet("/firmware/{id}", DownloadAsync);
        return g;
    }

    private static bool InDemo(HttpContext ctx) =>
        Services.Demo.DemoTenants.IsDemo(ctx.RequestServices.GetRequiredService<Multitenancy.ITenantContext>().TenantId);

    private const string DemoKeyRefusal = "Boxes can't connect to the demo club.";

    // ---- §6 keys ----

    private static async Task<IResult> StatusAsync(DeviceKeyRing keys, TenantSettingsAccessor settings, HttpContext ctx, CancellationToken ct)
    {
        if (InDemo(ctx)) return Services.Demo.DemoTenants.Refusal(DemoKeyRefusal);
        return Results.Ok(await keys.StatusAsync(ctx.User.Id() ?? Guid.Empty, await settings.GetAsync(ct), ct));
    }

    private static async Task<IResult> RotateAsync(DeviceKeyRing keys, TenantSettingsAccessor settings, HttpContext ctx, CancellationToken ct)
    {
        if (InDemo(ctx)) return Services.Demo.DemoTenants.Refusal(DemoKeyRefusal);
        var actor = ctx.User.Id() ?? Guid.Empty;
        var result = await keys.RotateAsync(actor, ct);
        if (result.Error is { } error) return Results.Conflict(new { error });
        return Results.Ok(await keys.StatusAsync(actor, await settings.GetAsync(ct), ct));
    }

    private static async Task<IResult> RetireAsync(
        KeyConfirmRequest? req, DeviceKeyRing keys, TenantSettingsAccessor settings, HttpContext ctx, CancellationToken ct)
    {
        if (InDemo(ctx)) return Services.Demo.DemoTenants.Refusal(DemoKeyRefusal);
        var actor = ctx.User.Id() ?? Guid.Empty;
        var result = await keys.RetireAsync(actor, req?.Confirm, ct);
        if (result.Error is { } error) return Results.Conflict(result.Detail ?? new { error });
        return Results.Ok(await keys.StatusAsync(actor, await settings.GetAsync(ct), ct));
    }

    /// <summary>
    /// <c>POST …/api-key/restore</c> (§6, IO-01): owner only — a deployment's inherent
    /// administrator (<c>Admins:Emails</c>), the person who holds the club's secret backup.
    /// The value is never echoed back by this route and never logged.
    /// </summary>
    private static async Task<IResult> RestoreAsync(
        KeyRestoreRequest? req, [AsParameters] KeyRestoreServices services, HttpContext ctx, CancellationToken ct)
    {
        var (keys, settings, owners, db) = services;
        if (InDemo(ctx)) return Services.Demo.DemoTenants.Refusal(DemoKeyRefusal);
        var actor = ctx.User.Id() ?? Guid.Empty;
        var email = await db.Users.AsNoTracking().Where(u => u.Id == actor).Select(u => u.Email).FirstOrDefaultAsync(ct);
        if (!owners.Includes(email)) return Results.Json(new { error = OwnerOnly }, statusCode: StatusCodes.Status403Forbidden);

        var result = await keys.RestoreAsync(actor, req?.Key, req?.Confirm, ct);
        if (result.Error is { } error) return Results.BadRequest(result.Detail ?? new { error });
        var status = await keys.StatusAsync(actor, await settings.GetAsync(ct), ct);
        return Results.Ok(status);
    }

    // ---- §8 network ----

    private static async Task<IResult> NetworkAsync(DeviceNetworkService network, CancellationToken ct) =>
        Results.Ok(await network.ViewAsync(ct));

    private static async Task<IResult> SaveNetworkAsync(
        DeviceNetworkRequest? req, DeviceNetworkService network, HttpContext ctx, CancellationToken ct)
    {
        if (req is null) return Results.BadRequest(new { error = "body_required" });
        var error = await network.SaveAsync(req, ctx.User.Id() ?? Guid.Empty, ct);
        if (error is not null) return Results.BadRequest(new { error });
        return Results.Ok(await network.ViewAsync(ct));
    }

    // ---- §7 firmware ----

    private static async Task<IResult> FirmwareAsync(FirmwareService firmware, CancellationToken ct) =>
        Results.Ok(await firmware.ListAsync(ct));

    /// <summary>
    /// <c>POST …/firmware</c>, multipart: <c>image</c> (the bytes) and <c>manifest</c> (the JSON
    /// <c>ota_sign.py</c> writes). Refused unless a board would boot it.
    /// </summary>
    private static async Task<IResult> UploadAsync(FirmwareService firmware, HttpContext ctx, CancellationToken ct)
    {
        if (!ctx.Request.HasFormContentType) return Results.BadRequest(new { error = FirmwareService.ImageRequired });
        var form = await ctx.Request.ReadFormAsync(ct);
        byte[]? image = null;
        if (form.Files.GetFile("image") is { } file)
        {
            using var buffer = new MemoryStream();
            await file.CopyToAsync(buffer, ct);
            image = buffer.ToArray();
        }

        var manifest = FirmwareService.ParseManifest(form["manifest"].ToString());
        var (release, error) = await firmware.UploadAsync(image, manifest, ctx.User.Id() ?? Guid.Empty, ct);
        if (error is not null) return Results.BadRequest(new { error });
        return Results.Ok(new { id = release!.Id, target = release.Target, version = release.Version, size = release.Size, sha256 = release.Sha256 });
    }

    private static async Task<IResult> RolloutAsync(
        Guid id, FirmwareRolloutRequest req, FirmwareService firmware, HttpContext ctx, CancellationToken ct)
    {
        var (found, error) = await firmware.SetRolloutAsync(id, req, ctx.User.Id() ?? Guid.Empty, ct);
        if (!found) return Results.NotFound();
        if (error is not null) return Results.BadRequest(new { error });
        return Results.Ok(await firmware.ListAsync(ct));
    }

    /// <summary>
    /// The bytes, with <c>Content-Length</c> equal to the size and
    /// <c>application/octet-stream</c>, never chunked (§7). Another club's id is a 404: the
    /// tenant's query filter is what scopes it, and "not found" says nothing about other clubs.
    /// </summary>
    private static async Task<IResult> DownloadAsync(string id, FirmwareService firmware, CancellationToken ct)
    {
        var image = await firmware.ImageAsync(id, ct);
        if (image is null) return Results.NotFound(new { error = "firmware_not_found" });
        return Results.Bytes(image, "application/octet-stream");
    }
}

/// <summary>What the owner-only restore needs, bundled for the parameter gate.</summary>
public sealed record KeyRestoreServices(DeviceKeyRing Keys, TenantSettingsAccessor Settings, InherentAdmins Owners, MainframeDbContext Db);

/// <summary>The retire body: the typed confirmation, required only when boards would be stranded.</summary>
public sealed record KeyConfirmRequest([property: JsonPropertyName("confirm")] string? Confirm);

/// <summary>The restore body: the 43-character key the boards hold, and the typed confirmation.</summary>
public sealed record KeyRestoreRequest(
    [property: JsonPropertyName("key")] string? Key,
    [property: JsonPropertyName("confirm")] string? Confirm);
