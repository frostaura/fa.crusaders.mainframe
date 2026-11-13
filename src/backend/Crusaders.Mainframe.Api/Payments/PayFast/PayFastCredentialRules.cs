using System.Text.RegularExpressions;

namespace Crusaders.Mainframe.Api.Payments.PayFast;

/// <summary>
/// What a club's PayFast credentials must look like before the club counts as configured for
/// payments — read by <c>TenantSecretsAccessor</c> on every checkout and ITN, and by the admin
/// save (<c>PUT /api/v1/admin/payments/payfast</c>) so a bad value is refused while there is a
/// person to tell.
/// </summary>
/// <remarks>
/// <para>
/// <b>The passphrase is required outside Development</b> (<c>payments-payfast.md</c>,
/// Configuration). PayFast lets a merchant run without one, and then the ITN signature is an MD5
/// of fields the member's own checkout form shows them — anybody who knew a checkout id could post
/// a "COMPLETE" and be given the package's minutes, recorded as revenue (money lane BM-1 / BP-01,
/// reproduced live). Development alone may run without one, so a developer's own stack is not
/// locked out; the Development seeder writes a random one anyway.
/// </para>
/// <para>
/// <b>Shape, from PayFast's own refusal</b>: a merchant id is 8 digits and a merchant key 13
/// letters or digits. Those are the rules PayFast's process page states when it rejects a
/// checkout ("merchant_id must be 8 digits; merchant_key must be 13 characters"), so holding them
/// here locks out no club PayFast would accept — it only turns the third-party error page a member
/// was sent to (browser lane BM-03, the seeded <c>REPLACE_WITH_…</c> placeholders) into "this
/// club has not set up payments", which an admin can see and fix.
/// </para>
/// </remarks>
public static partial class PayFastCredentialRules
{
    /// <summary>The shortest passphrase accepted. PayFast's dashboard takes any length; a short one can be brute-forced offline from the signed checkout form.</summary>
    public const int MinPassphraseLength = 12;

    /// <summary>PayFast's own cap on the passphrase field.</summary>
    public const int MaxPassphraseLength = 100;

    /// <summary>The marker the old seeder wrote into every field. A value carrying it was never entered by anybody.</summary>
    public const string PlaceholderMarker = "REPLACE_";

    public const string MerchantIdInvalid = "merchant_id_invalid";
    public const string MerchantKeyInvalid = "merchant_key_invalid";
    public const string PassphraseRequired = "passphrase_required";
    public const string PassphraseTooShort = "passphrase_too_short";
    public const string PassphraseTooLong = "passphrase_too_long";
    public const string PassphraseInvalid = "passphrase_invalid";
    public const string EnvironmentInvalid = "environment_invalid";

    [GeneratedRegex("^[0-9]{8}$")]
    private static partial Regex MerchantIdShape();

    [GeneratedRegex("^[A-Za-z0-9]{13}$")]
    private static partial Regex MerchantKeyShape();

    /// <summary>
    /// Every reason these credentials cannot take a payment, as stable snake_case codes; empty
    /// when they can.
    /// </summary>
    /// <param name="requirePassphrase">False only in Development (see the type's remarks).</param>
    public static IReadOnlyList<string> Problems(
        string? merchantId, string? merchantKey, string? passphrase, string? environment, bool requirePassphrase)
    {
        var problems = new List<string>();
        if (merchantId is null || IsPlaceholder(merchantId) || !MerchantIdShape().IsMatch(merchantId)) problems.Add(MerchantIdInvalid);
        if (merchantKey is null || IsPlaceholder(merchantKey) || !MerchantKeyShape().IsMatch(merchantKey)) problems.Add(MerchantKeyInvalid);

        if (PassphraseProblem(passphrase ?? "", requirePassphrase) is { } phraseProblem) problems.Add(phraseProblem);
        if (!PayFastEnvironment.IsRecognised(environment)) problems.Add(EnvironmentInvalid);
        return problems;
    }

    /// <summary>What is wrong with a passphrase, or null when nothing is.</summary>
    private static string? PassphraseProblem(string phrase, bool requirePassphrase)
    {
        if (IsPlaceholder(phrase)) return PassphraseInvalid;
        if (phrase.Length == 0) return requirePassphrase ? PassphraseRequired : null;
        if (phrase.Length < MinPassphraseLength) return PassphraseTooShort;
        if (phrase.Length > MaxPassphraseLength) return PassphraseTooLong;
        return phrase.Any(char.IsControl) || phrase != phrase.Trim() ? PassphraseInvalid : null;
    }

    private static bool IsPlaceholder(string value) =>
        value.Contains(PlaceholderMarker, StringComparison.OrdinalIgnoreCase);
}
