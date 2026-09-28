using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Microsoft.Extensions.Hosting;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// <c>MemberCodes:MasterKey</c> at startup (<c>docs/specs/member-code.md</c> §3.1): Production refuses
/// to start without a real key; Development and Testing get the published development key.
/// </summary>
public class MemberCodeKeyPolicyTests
{
    private static readonly string Real = Convert.ToBase64String(Enumerable.Range(1, 48).Select(i => (byte)i).ToArray());

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("CHANGE-ME-random-string-of-at-least-32-characters")]
    [InlineData("REPLACE_WITH_member_code_master_key")]
    [InlineData("DEV_ONLY_key")]
    public void Production_refuses_a_missing_or_placeholder_key(string? configured)
    {
        Assert.Throws<InvalidOperationException>(() => MemberCodeKeyPolicy.Resolve(configured, lenient: false));
    }

    [Fact]
    public void Production_refuses_a_key_that_is_not_base64_or_the_wrong_length()
    {
        Assert.Throws<InvalidOperationException>(() => MemberCodeKeyPolicy.Resolve("not base64 at all!!", lenient: false));
        Assert.Throws<InvalidOperationException>(() => MemberCodeKeyPolicy.Resolve(Convert.ToBase64String(new byte[31]), lenient: false));
        Assert.Throws<InvalidOperationException>(() => MemberCodeKeyPolicy.Resolve(Convert.ToBase64String(new byte[65]), lenient: false));
    }

    [Fact]
    public void Production_takes_a_real_key_and_it_is_never_the_development_one()
    {
        var key = MemberCodeKeyPolicy.Resolve(Real, lenient: false);
        Assert.False(key.IsDevelopmentKey);
        Assert.Equal(48, key.Bytes.Length);
        Assert.NotEqual(MemberCodeKeyPolicy.Development.Bytes, key.Bytes);
    }

    /// <summary>
    /// Keys published in this repository pass every length rule, so they are refused by VALUE:
    /// the development key, the fixed key the test host once ran with, and the corpus's fixture
    /// master key — read from <c>derivation.json</c> itself, so the list cannot drift from it.
    /// </summary>
    [Fact]
    public void Production_refuses_every_key_published_in_the_repository()
    {
        var corpus = Convert.FromHexString(
            MemberCodeCorpusTests.Load("derivation.json").GetProperty("fixture_master_key_hex").GetString()!);
        foreach (var published in new[]
        {
            MemberCodeKeyPolicy.Development.Bytes,
            System.Text.Encoding.ASCII.GetBytes("test-only member-code master key, 48 bytes long!"),
            corpus,
        })
        {
            Assert.Throws<InvalidOperationException>(() => MemberCodeKeyPolicy.Resolve(Convert.ToBase64String(published), lenient: false));
        }
    }

    /// <summary>A key must look random: all one byte, or fewer than sixteen distinct values, is refused.</summary>
    [Theory]
    [InlineData(0x00, 1)]
    [InlineData(0x41, 1)]
    [InlineData(0x10, 15)]
    public void Production_refuses_a_low_entropy_key(int seed, int distinct)
    {
        var bytes = Enumerable.Range(0, 48).Select(i => (byte)(seed + (i % distinct))).ToArray();
        Assert.Throws<InvalidOperationException>(() => MemberCodeKeyPolicy.Resolve(Convert.ToBase64String(bytes), lenient: false));
    }

    /// <summary>Only Development is lenient: the test host runs under Production's rule and injects a random key.</summary>
    [Fact]
    public void Only_development_is_lenient()
    {
        static IHostEnvironment Env(string name) => new Microsoft.Extensions.Hosting.Internal.HostingEnvironment { EnvironmentName = name };
        var config = new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build();

        Assert.True(MemberCodeKeyPolicy.Resolve(config, Env("Development")).IsDevelopmentKey);
        Assert.Throws<InvalidOperationException>(() => MemberCodeKeyPolicy.Resolve(config, Env("Testing")));
        Assert.Throws<InvalidOperationException>(() => MemberCodeKeyPolicy.Resolve(config, Env("Production")));

        var host = MemberCodeKeyPolicy.Resolve(TestWebAppFactory.TestMemberCodeMasterKey, lenient: false);
        Assert.False(host.IsDevelopmentKey);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("CHANGE-ME-please")]
    public void Development_falls_back_to_the_published_development_key(string? configured)
    {
        var key = MemberCodeKeyPolicy.Resolve(configured, lenient: true);
        Assert.True(key.IsDevelopmentKey);
        Assert.Equal(32, key.Bytes.Length);
    }

    /// <summary>Changing the master key changes every member's secret: nothing survives it.</summary>
    [Fact]
    public void A_different_master_key_is_a_different_secret_for_every_member()
    {
        var tenant = Guid.NewGuid();
        var user = Guid.NewGuid();
        Assert.NotEqual(
            MemberCodeMath.MemberSecret(MemberCodeKeyPolicy.Development.Bytes, tenant, user, 1),
            MemberCodeMath.MemberSecret(MemberCodeKeyPolicy.Resolve(Real, false).Bytes, tenant, user, 1));
    }
}
