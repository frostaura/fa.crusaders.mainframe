using System.Text.Json;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Payments;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Per-tenant secrets read from the tenant_settings JSON document. For v1 we store credentials
/// directly in the document; production hardening (Phase 7) moves these to an at-rest-encrypted
/// tenant_secrets table with a master KEK in env.
/// </summary>
public sealed class TenantSecretsAccessor
{
    private readonly MainframeDbContext _db;
    private readonly ITenantContext _tenant;
    private readonly IConfiguration _config;

    public TenantSecretsAccessor(MainframeDbContext db, ITenantContext tenant, IConfiguration config)
    { _db = db; _tenant = tenant; _config = config; }

    public async Task<PerTenantCredentials?> GetPeachAsync(CancellationToken ct)
    {
        var row = await _db.TenantSettings.AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == _tenant.TenantId, ct);
        if (row is null) return null;
        using var doc = JsonDocument.Parse(row.SettingsJson);
        if (!doc.RootElement.TryGetProperty("peach_payments", out var peach)) return null;

        string Get(string n) => peach.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        var entityId = Get("entity_id");
        var token = Get("access_token");
        var secret = Get("webhook_secret");
        var env = Get("environment");
        if (string.IsNullOrEmpty(entityId) || string.IsNullOrEmpty(token)) return null;
        return new PerTenantCredentials(entityId, token, secret, string.IsNullOrEmpty(env) ? "test" : env);
    }
}
