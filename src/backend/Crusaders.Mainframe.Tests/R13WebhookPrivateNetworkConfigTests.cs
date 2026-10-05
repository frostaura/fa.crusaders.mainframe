using System.Net;
using Crusaders.Mainframe.Api.Security.Outbound;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Review round 13, E13-7: <c>docs/specs/webhooks.md</c> promises <c>Webhooks:AllowPrivateNetworks</c>
/// is "on in Development only". The base <c>appsettings.json</c> pinned it <c>false</c> for every
/// environment, so the guard's own environment default never applied and the dev loop (MailHog, a
/// local consumer) could not receive a webhook. Read through the SHIPPED files, layered the way the
/// host layers them, so a change to either file is what turns this red.
/// </summary>
public class R13WebhookPrivateNetworkConfigTests
{
    private sealed class Env : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Production";
        public string ApplicationName { get; set; } = "tests";
        public string ContentRootPath { get; set; } = ".";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private static OutboundAddressGuard ShippedGuard(string environment)
    {
        var api = Path.Combine(DeploymentPostureTests.RepoRoot(), "src", "backend", "Crusaders.Mainframe.Api");
        var config = new ConfigurationBuilder()
            .SetBasePath(api)
            .AddJsonFile("appsettings.json", optional: false)
            .AddJsonFile($"appsettings.{environment}.json", optional: true)
            .Build();
        return new OutboundAddressGuard(config, new Env { EnvironmentName = environment }, NullLogger<OutboundAddressGuard>.Instance);
    }

    [Fact]
    public void Development_reaches_a_local_consumer()
    {
        Assert.Null(ShippedGuard("Development").Check(IPAddress.Loopback));
        Assert.Null(ShippedGuard("Development").Check(IPAddress.Parse("192.168.1.20")));
    }

    /// <summary>The production path is unchanged: the guard stays on, and only the allow-list carves.</summary>
    [Theory]
    [InlineData("Production")]
    [InlineData("Staging")]
    [InlineData("Testing")]
    public void Every_other_environment_keeps_the_guard_on(string environment)
    {
        Assert.NotNull(ShippedGuard(environment).Check(IPAddress.Loopback));
        Assert.NotNull(ShippedGuard(environment).Check(IPAddress.Parse("192.168.1.20")));
    }
}
