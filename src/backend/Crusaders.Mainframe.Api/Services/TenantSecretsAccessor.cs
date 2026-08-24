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

    /// <summary>
    /// This tenant's payment-gateway credentials, or null when the tenant has not been
    /// configured for payments.
    ///
    /// <para>
    /// Note the passphrase is deliberately NOT required: PayFast lets a merchant run
    /// without one, and demanding it here would lock out a legitimately-configured club.
    /// The signature is computed without the pair in that case, which is a different string
    /// and is what PayFast expects.
    /// </para>
    /// </summary>
    public async Task<PerTenantCredentials?> GetPaymentsAsync(CancellationToken ct)
    {
        var row = await _db.TenantSettings.AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == _tenant.TenantId, ct);
        if (row is null) return null;

        using var doc = JsonDocument.Parse(row.SettingsJson);
        if (!doc.RootElement.TryGetProperty("payfast", out var payfast)) return null;

        string Get(string n) => payfast.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

        var merchantId = Get("merchant_id");
        var merchantKey = Get("merchant_key");
        var passphrase = Get("passphrase");
        var env = Get("environment");

        if (string.IsNullOrEmpty(merchantId) || string.IsNullOrEmpty(merchantKey)) return null;

        return new PerTenantCredentials(merchantId, merchantKey, passphrase, string.IsNullOrEmpty(env) ? "test" : env);
    }
}
