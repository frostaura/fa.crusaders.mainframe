using System.Text.Json;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Payments;
using Crusaders.Mainframe.Api.Payments.PayFast;
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
    private readonly ILogger<TenantSecretsAccessor> _logger;

    public TenantSecretsAccessor(
        MainframeDbContext db, ITenantContext tenant, IConfiguration config, ILogger<TenantSecretsAccessor> logger)
    { _db = db; _tenant = tenant; _config = config; _logger = logger; }

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

        /*
         * An environment nobody can identify is a club that is NOT configured for payments.
         *
         * It used to be a club configured for the sandbox, because the selection was
         * `Equals(env, "production") ? Live : Sandbox` and every near-miss — "Production " with
         * a space, "live", "prod" — fell through to the sandbox. That is the worst possible
         * default: a sandbox checkout looks completely normal to the member, no card is ever
         * charged, and nobody learns about it from the software. Refusing here surfaces as
         * "this club has not set up payments", which an admin can see and fix, instead of weeks
         * of top-ups that took no money.
         */
        if (!PayFastEnvironment.IsRecognised(env))
        {
            _logger.LogError(
                "Tenant {TenantId} has payfast.environment '{Environment}', which is not a value this "
                + "build understands. Payments are refused for this tenant rather than silently routed to "
                + "the sandbox. Set it to 'production' (or 'live'), or 'test' (or 'sandbox').",
                _tenant.TenantId, env);
            return null;
        }

        return new PerTenantCredentials(merchantId, merchantKey, passphrase,
            string.IsNullOrEmpty(env) ? PayFastEnvironment.Test : env);
    }
}
