namespace Crusaders.Mainframe.Api.Payments.PayFast;

/// <summary>
/// Which PayFast host a tenant's checkouts go to, resolved from the free-text
/// <c>payfast.environment</c> string in that tenant's settings document.
/// </summary>
/// <remarks>
/// <para>
/// <b>What this closes.</b> The selection was
/// <c>string.Equals(environment, "production", …) ? Live : Sandbox</c>: one recognised value,
/// and <i>everything else</i> — including every near-miss — silently resolving to the sandbox.
/// "Production " with a trailing space, "live", "prod", "PRODUCTION!" all sent real members to
/// <c>sandbox.payfast.co.za</c>. A sandbox checkout looks entirely normal from the member's
/// side: the redirect happens, the form appears, a payment "succeeds". No card is ever charged
/// and no money reaches the club. Nobody finds out from the software — they find out from the
/// bank statement, weeks later, and by then every top-up in between is in question.
/// </para>
/// <para>
/// So there is no fallback. An empty string still means test, because that is the documented
/// default for a club that has not finished configuring; anything set but unrecognised is a
/// <i>misconfiguration</i> and is reported as one, rather than being quietly resolved to the
/// side that loses the club money.
/// </para>
/// </remarks>
public static class PayFastEnvironment
{
    /// <summary>Written by the seeder, and the meaning of an empty value.</summary>
    public const string Test = "test";

    /// <summary>
    /// Spellings accepted for the sandbox. "test" is what this product writes; "sandbox" is
    /// what PayFast's own documentation calls it, so an admin copying from there is right.
    /// </summary>
    private static readonly string[] SandboxNames = { "test", "sandbox" };

    /// <summary>
    /// Spellings accepted for the live gateway. "production" is what this product writes;
    /// "live" is PayFast's own word for it.
    /// </summary>
    private static readonly string[] LiveNames = { "production", "live" };

    /// <summary>
    /// True when <paramref name="environment"/> names a gateway this code understands.
    /// An empty or whitespace value is understood — it means test.
    /// </summary>
    public static bool IsRecognised(string? environment) => TryResolve(environment, out _);

    /// <summary>
    /// The process URL for a recognised environment.
    /// </summary>
    /// <exception cref="ArgumentException">
    /// The value is set but is not a spelling this code understands. Deliberately an exception
    /// rather than a default: the caller has to decide what to do about a club whose gateway
    /// nobody can identify, and silently choosing one is what this class exists to prevent.
    /// </exception>
    public static string ProcessUrl(string? environment)
        => TryResolve(environment, out var url)
            ? url
            : throw new ArgumentException(
                $"PayFast environment '{environment}' is not recognised. Use 'production' (or 'live') "
                + "for the real gateway, or 'test' (or 'sandbox'). It is not defaulted, because the "
                + "default would be the sandbox and a club running there takes no money at all.",
                nameof(environment));

    private static bool TryResolve(string? environment, out string processUrl)
    {
        var value = environment?.Trim() ?? "";
        if (value.Length == 0) { processUrl = PayFastProvider.Sandbox; return true; }
        if (SandboxNames.Contains(value, StringComparer.OrdinalIgnoreCase)) { processUrl = PayFastProvider.Sandbox; return true; }
        if (LiveNames.Contains(value, StringComparer.OrdinalIgnoreCase)) { processUrl = PayFastProvider.Live; return true; }
        processUrl = "";
        return false;
    }
}
