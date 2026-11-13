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
    private readonly IHostEnvironment _environment;
    private readonly ILogger<TenantSecretsAccessor> _logger;

    public TenantSecretsAccessor(
        MainframeDbContext db, ITenantContext tenant, IHostEnvironment environment, ILogger<TenantSecretsAccessor> logger)
    { _db = db; _tenant = tenant; _environment = environment; _logger = logger; }

    /// <summary>
    /// Whether a club must have a passphrase to take payments: everywhere but Development
    /// (<see cref="PayFastCredentialRules"/>). One answer for the read below and the admin save.
    /// </summary>
    public bool PassphraseRequired => !_environment.IsDevelopment();

    /// <summary>
    /// This tenant's payment-gateway credentials, or null when the tenant has not been
    /// configured for payments.
    ///
    /// <para>
    /// <b>The passphrase IS required</b> (outside Development) — it used to be deliberately
    /// optional, on the reasoning that PayFast lets a merchant run without one. With no
    /// passphrase the ITN signature is an MD5 of public fields, so a club configured that way
    /// credited minutes to anybody who posted a "COMPLETE" naming a checkout id (money lane BM-1,
    /// BP-01). A club with no passphrase, a placeholder, or a merchant id or key PayFast itself
    /// would refuse is "not configured for payments", which the admin sees and fixes — never a
    /// checkout that dead-ends on PayFast's error page (BM-03) or an ITN nobody can trust.
    /// </para>
    /// </summary>
    public async Task<PerTenantCredentials?> GetPaymentsAsync(CancellationToken ct)
    {
        var stored = await ReadStoredAsync(ct);
        if (stored is null) return null;

        var problems = PayFastCredentialRules.Problems(
            stored.MerchantId, stored.MerchantKey, stored.SigningSecret, stored.Environment, PassphraseRequired);
        if (problems.Count > 0)
        {
            /*
             * An environment nobody can identify is one of these problems, and it is refused
             * rather than defaulted: the selection used to be `Equals(env, "production") ? Live :
             * Sandbox`, so every near-miss ("Production ", "prod") sent real members to a sandbox
             * checkout that takes no money and looks completely normal.
             */
            _logger.LogError(
                "Tenant {TenantId}'s PayFast settings cannot take a payment ({Problems}); payments are "
                + "refused for this club until an admin corrects them under Settings, Payments.",
                _tenant.TenantId, string.Join(", ", problems));
            return null;
        }

        return stored with
        {
            Environment = string.IsNullOrWhiteSpace(stored.Environment) ? PayFastEnvironment.Test : stored.Environment.Trim(),
        };
    }

    /// <summary>
    /// The <c>payfast</c> object exactly as stored, unvalidated — what the admin status read
    /// reports problems against. Null when the club has never stored one.
    /// </summary>
    public async Task<PerTenantCredentials?> ReadStoredAsync(CancellationToken ct)
    {
        var row = await _db.TenantSettings.AsNoTracking().FirstOrDefaultAsync(s => s.TenantId == _tenant.TenantId, ct);
        if (row is null) return null;

        using var doc = JsonDocument.Parse(row.SettingsJson);
        if (!doc.RootElement.TryGetProperty("payfast", out var payfast) || payfast.ValueKind != JsonValueKind.Object) return null;

        string Get(string n) => payfast.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

        return new PerTenantCredentials(Get("merchant_id"), Get("merchant_key"), Get("passphrase"), Get("environment"));
    }
}
