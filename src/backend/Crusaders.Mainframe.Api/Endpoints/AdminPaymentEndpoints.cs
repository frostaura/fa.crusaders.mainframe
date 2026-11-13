using System.Text.Json;
using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Payments.PayFast;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The club's PayFast credentials, set from the console (money lane BM-4, platform BP-07).
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this exists.</b> Production had no surface for them at all: the settings PUT has no
/// <c>payfast</c> field and <c>ProductionBootstrap</c> writes none by design, so the only way to
/// turn on payments was a hand edit of the settings JSON in Postgres — a typo'd environment, an
/// empty passphrase (BM-1) or a broken document waiting to happen.
/// </para>
/// <para>
/// <b>Contract.</b> <c>GET /api/v1/admin/payments/payfast</c> and
/// <c>PUT /api/v1/admin/payments/payfast</c>, admin role, snake_case both ways. The passphrase is
/// <b>write-only</b>: never returned, never recorded (the change record says only
/// <c>passphrase: set | changed | cleared</c>). Omit it, or send null, to keep the stored one.
/// The merchant id and key are not secrets — they are in every checkout form a member's browser
/// posts — so they are returned. A save is refused <c>400 payfast_credentials_invalid</c> with
/// every <see cref="PayFastCredentialRules"/> problem named; a saved set is, by construction, one
/// the checkout and the ITN accept. Written under the settings row lock, so it cannot interleave
/// with a settings save.
/// </para>
/// </remarks>
public static class AdminPaymentEndpoints
{
    public const string Route = "/api/v1/admin/payments/payfast";

    /// <summary>The PUT body. Each field omitted (null) keeps what is stored.</summary>
    public sealed record PayFastSettingsRequest(
        [property: JsonPropertyName("merchant_id")] string? MerchantId,
        [property: JsonPropertyName("merchant_key")] string? MerchantKey,
        [property: JsonPropertyName("passphrase")] string? Passphrase,
        [property: JsonPropertyName("environment")] string? Environment);

    public static IEndpointRouteBuilder MapAdminPaymentEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup(Route).RequireAuthorization(p => p.RequireRole("admin"));
        group.MapGet("/", (HttpContext ctx, CancellationToken ct) => ReadAsync(ctx, ct));
        group.MapPut("/", (PayFastSettingsRequest req, HttpContext ctx, CancellationToken ct) => SaveAsync(req, ctx, ct));
        return app;
    }

    private static async Task<IResult> ReadAsync(HttpContext ctx, CancellationToken ct)
    {
        var secrets = ctx.RequestServices.GetRequiredService<TenantSecretsAccessor>();
        return Results.Ok(Render(await secrets.ReadStoredAsync(ct), secrets.PassphraseRequired, NotifyUrl(ctx)));
    }

    private static async Task<IResult> SaveAsync(PayFastSettingsRequest req, HttpContext ctx, CancellationToken ct)
    {
        var services = ctx.RequestServices;
        var db = services.GetRequiredService<MainframeDbContext>();
        var tenant = services.GetRequiredService<ITenantContext>();
        var secrets = services.GetRequiredService<TenantSecretsAccessor>();

        await using var tx = await SettingsDocument.LockAsync(db, tenant.TenantId, ct);
        var stored = await secrets.ReadStoredAsync(ct);
        var next = Merge(req, stored);

        var problems = PayFastCredentialRules.Problems(next.MerchantId, next.MerchantKey, next.Passphrase, next.Environment, secrets.PassphraseRequired);
        if (problems.Count > 0) return Results.BadRequest(new { error = "payfast_credentials_invalid", problems });

        await WriteAsync(db, tenant.TenantId, next, ct);

        if (Diff(stored, next) is { } change)
        {
            await services.GetRequiredService<AdminChangeRecorder>().StageAsync(new AdminChange(
                Action: AdminChangeActions.PaymentsConfigured,
                ActorUserId: ctx.User.Id() ?? Guid.Empty,
                SubjectKind: AdminChangeSubjects.Setting,
                SubjectLabel: "PayFast",
                Before: change.Before,
                After: change.After), ct);
        }

        await db.SaveChangesAsync(ct);
        if (tx is not null) await tx.CommitAsync(ct);

        var saved = new Payments.PerTenantCredentials(next.MerchantId, next.MerchantKey, next.Passphrase, next.Environment);
        return Results.Ok(Render(saved, secrets.PassphraseRequired, NotifyUrl(ctx)));
    }

    private sealed record StoredPayFast(string MerchantId, string MerchantKey, string Passphrase, string Environment);

    /// <summary>The request over what is stored: each field the request omits keeps its stored value.</summary>
    private static StoredPayFast Merge(PayFastSettingsRequest req, Payments.PerTenantCredentials? stored)
    {
        return new StoredPayFast(
            Clean(req.MerchantId) ?? stored?.MerchantId ?? "",
            Clean(req.MerchantKey) ?? stored?.MerchantKey ?? "",
            req.Passphrase ?? stored?.SigningSecret ?? "",
            Clean(req.Environment)?.ToLowerInvariant() ?? stored?.Environment ?? PayFastEnvironment.Test);
    }

    /// <summary>Writes the <c>payfast</c> object into the club's settings document, leaving every other key alone. Does not save.</summary>
    private static async Task WriteAsync(MainframeDbContext db, Guid tenantId, StoredPayFast next, CancellationToken ct)
    {
        var row = await db.TenantSettings.FirstOrDefaultAsync(s => s.TenantId == tenantId, ct);
        if (row is null)
        {
            row = new Domain.TenantSettings { TenantId = tenantId, SettingsJson = "{}" };
            db.TenantSettings.Add(row);
        }
        var doc = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(row.SettingsJson) ?? [];
        doc["payfast"] = JsonSerializer.SerializeToElement(new
        {
            merchant_id = next.MerchantId,
            merchant_key = next.MerchantKey,
            passphrase = next.Passphrase,
            environment = next.Environment,
        });
        row.SettingsJson = JsonSerializer.Serialize(doc);
        row.UpdatedAt = DateTimeOffset.UtcNow;
    }

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>The changed fields, with the passphrase reduced to whether it was set — never its value.</summary>
    private static (Dictionary<string, object?> Before, Dictionary<string, object?> After)? Diff(Payments.PerTenantCredentials? stored, StoredPayFast next)
    {
        var change = (Before: new Dictionary<string, object?>(), After: new Dictionary<string, object?>());
        Field(change, "merchant_id", stored?.MerchantId, next.MerchantId);
        Field(change, "merchant_key", stored?.MerchantKey, next.MerchantKey);
        Field(change, "environment", stored?.Environment, next.Environment);
        PassphraseChange(change, stored?.SigningSecret, next.Passphrase);
        return change.After.Count == 0 ? null : change;
    }

    private static void Field((Dictionary<string, object?> Before, Dictionary<string, object?> After) change, string key, string? was, string now)
    {
        if (string.Equals(was ?? "", now, StringComparison.Ordinal)) return;
        change.Before[key] = string.IsNullOrEmpty(was) ? null : was;
        change.After[key] = now;
    }

    /// <summary>Whether the passphrase was set, changed or cleared — the only thing the record may say about it.</summary>
    private static void PassphraseChange((Dictionary<string, object?> Before, Dictionary<string, object?> After) change, string? was, string now)
    {
        if (string.Equals(was ?? "", now, StringComparison.Ordinal)) return;
        var had = !string.IsNullOrEmpty(was);
        change.Before["passphrase"] = had ? "set" : "not set";
        change.After["passphrase"] = now.Length == 0 ? "cleared" : had ? "changed" : "set";
    }

    /// <summary>The read: what is stored (no passphrase), whether payments are on, and every reason they are not.</summary>
    private static object Render(Payments.PerTenantCredentials? stored, bool passphraseRequired, string notifyUrl)
    {
        var problems = stored is null
            ? ["not_configured"]
            : PayFastCredentialRules.Problems(stored.MerchantId, stored.MerchantKey, stored.SigningSecret, stored.Environment, passphraseRequired);
        return new
        {
            configured = problems.Count == 0,
            problems,
            merchant_id = Blank(stored?.MerchantId),
            merchant_key = Blank(stored?.MerchantKey),
            passphrase_set = !string.IsNullOrEmpty(stored?.SigningSecret),
            passphrase_required = passphraseRequired,
            environment = Blank(stored?.Environment),
            notify_url = notifyUrl,
        };
    }

    private static string? Blank(string? value) => string.IsNullOrEmpty(value) ? null : value;

    /// <summary>Where this club's ITNs arrive — what the admin can compare against PayFast's ITN log.</summary>
    private static string NotifyUrl(HttpContext ctx)
    {
        var publicBase = ctx.RequestServices.GetRequiredService<IConfiguration>()["App:PublicBaseUrl"] ?? "http://localhost:8089";
        var slug = ctx.RequestServices.GetRequiredService<ITenantContext>().TenantSlug;
        return $"{publicBase}/api/v1/credit/topup/callback?tenant={slug}";
    }
}
