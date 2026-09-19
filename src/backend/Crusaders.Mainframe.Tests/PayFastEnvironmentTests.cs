using Crusaders.Mainframe.Api.Payments.PayFast;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Which PayFast host a club's members are actually sent to.
/// </summary>
/// <remarks>
/// <para>
/// The selection was <c>Equals(environment, "production") ? Live : Sandbox</c>. One recognised
/// spelling, and everything else — every near-miss included — resolving silently to the
/// sandbox. A sandbox checkout is indistinguishable from a real one on the member's side: the
/// redirect happens, PayFast's form appears, the payment "succeeds". No card is charged and no
/// money reaches the club. Nothing in the software ever says so; the club finds out from a bank
/// statement, and by then every top-up since the mistake is in question.
/// </para>
/// <para>
/// The near-misses are the whole test. "production" is the one string that worked, and every
/// plausible thing an admin might type instead is a silent, expensive failure.
/// </para>
/// </remarks>
public sealed class PayFastEnvironmentTests
{
    [Theory]
    [InlineData("production")]
    [InlineData("Production")]
    [InlineData("PRODUCTION")]
    // PayFast's own documentation says "live", so an admin copying from there is being sensible.
    [InlineData("live")]
    [InlineData("Live")]
    // Whitespace off a copy-paste is not a different environment.
    [InlineData("  production  ")]
    public void The_live_gateway_is_reachable_by_every_spelling_an_admin_would_use(string env)
    {
        Assert.Equal(PayFastProvider.Live, PayFastEnvironment.ProcessUrl(env));
    }

    [Theory]
    [InlineData("test")]
    [InlineData("TEST")]
    [InlineData("sandbox")]
    [InlineData("  test ")]
    public void The_sandbox_is_reachable_by_its_own_names(string env)
    {
        Assert.Equal(PayFastProvider.Sandbox, PayFastEnvironment.ProcessUrl(env));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void An_unset_environment_still_means_test_which_is_the_documented_default(string? env)
    {
        // A club part-way through configuration has not made a mistake; it has not finished.
        Assert.Equal(PayFastProvider.Sandbox, PayFastEnvironment.ProcessUrl(env));
        Assert.True(PayFastEnvironment.IsRecognised(env));
    }

    [Theory]
    [InlineData("prod")]
    [InlineData("PROD")]
    [InlineData("real")]
    [InlineData("production!")]
    [InlineData("production ,")]
    [InlineData("Produktion")]
    [InlineData("staging")]
    [InlineData("yes")]
    [InlineData("true")]
    public void A_value_nobody_can_identify_is_refused_rather_than_resolved_to_the_sandbox(string env)
    {
        // Every one of these used to mean "sandbox", silently. Several of them are what an
        // admin trying to go live would plausibly type.
        Assert.False(PayFastEnvironment.IsRecognised(env));

        var error = Assert.Throws<ArgumentException>(() => PayFastEnvironment.ProcessUrl(env));
        Assert.Contains(env, error.Message);
        // The message has to say why it is not just picking one.
        Assert.Contains("takes no money", error.Message);
    }

    [Fact]
    public void The_two_hosts_are_not_the_same_host()
    {
        // Guards the degenerate fix: making everything pass by pointing both at one URL.
        Assert.NotEqual(PayFastProvider.Live, PayFastProvider.Sandbox);
        Assert.Contains("sandbox", PayFastProvider.Sandbox);
        Assert.DoesNotContain("sandbox", PayFastProvider.Live);
    }

    [Fact]
    public void The_provider_selects_through_the_same_rule()
    {
        // PayFastProvider.ProcessUrlFor is what the checkout actually calls; if it kept its own
        // copy of the comparison, everything above would be testing a class nobody uses.
        Assert.Equal(PayFastProvider.Live, PayFastProvider.ProcessUrlFor("live"));
        Assert.Throws<ArgumentException>(() => PayFastProvider.ProcessUrlFor("prod"));
    }
}
