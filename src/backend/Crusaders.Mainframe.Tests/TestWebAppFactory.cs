using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Boots the real <c>Program</c> over HTTP without requiring a database.
///
/// <para>
/// <c>Database:AutoMigrateOnStartup</c> defaults to <c>true</c> (appsettings.json),
/// so a plain <see cref="WebApplicationFactory{T}"/> calls <c>MigrateAsync()</c>
/// during startup and fails with "Connection refused" wherever Postgres is absent —
/// which is every developer machine and the <c>backend</c> CI job, since only
/// <c>backend-integration</c> provisions a Postgres service container.
/// </para>
///
/// <para>
/// Endpoints that genuinely need a database belong in the Postgres-backed
/// integration suite. This factory is for the ones that do not, so they can be
/// tested at the HTTP boundary — routing, middleware order, auth policies — which
/// nothing in this repo currently covers.
/// </para>
/// </summary>
public class TestWebAppFactory : WebApplicationFactory<Program>
{
    /// <summary>
    /// When set, the app is pointed at this database and migrations are allowed to
    /// run. Left null, the app boots with no database access at all.
    /// </summary>
    public string? ConnectionString { get; init; }

    /// <summary>
    /// Per-minute rate-limit ceilings, keyed by the <c>RateLimits:*</c> suffix
    /// ("AuthPerMinute", "DevicePerMinute", "GlobalPerMinute", "FirmwarePerMinute").
    ///
    /// <para>
    /// Defaults are raised far above production so an ordinary test suite never trips a
    /// limiter and fails for a reason it is not testing. The rate-limit tests lower
    /// them deliberately.
    /// </para>
    /// </summary>
    public IReadOnlyDictionary<string, int>? RateLimits { get; init; }

    /// <summary>
    /// The address the in-memory TestServer should report as the connection's remote
    /// peer. Null (the default) leaves it unset, as TestServer does. The forwarded-headers
    /// middleware believes X-Forwarded-* only from a trusted proxy, and trust is decided
    /// by this address — so a test that models the gateway sets it to loopback, and a test
    /// that models a stranger forging the headers sets it to something else.
    /// </summary>
    public System.Net.IPAddress? RemoteIpAddress { get; init; }

    /// <summary>
    /// <c>Gateway:TrustedProxies</c>, as a deployment would set it: one delimited string.
    /// Null leaves <c>appsettings.json</c>'s default (loopback + the pinned compose bridge)
    /// in place. Set it to prove a deployment can NARROW that default — the shape .NET
    /// configuration's index-merged arrays made impossible. See <c>GatewayTrust</c>.
    /// </summary>
    public string? TrustedProxies { get; init; }

    /// <summary>
    /// <c>Gateway:ForwardLimit</c> — how many X-Forwarded-For hops the middleware walks
    /// back. Null leaves the default of 2 (cloudflared in front of the gateway).
    /// </summary>
    public int? ForwardLimit { get; init; }

    private static readonly Dictionary<string, int> DefaultRateLimits = new()
    {
        ["AuthPerMinute"] = 100_000,
        ["DevicePerMinute"] = 100_000,
        ["GlobalPerMinute"] = 100_000,
        ["FirmwarePerMinute"] = 100_000,
    };

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // Program.cs reads builder.Configuration DURING its own execution — the
        // connection string is captured at AddDbContext registration time. Under the
        // minimal hosting model that happens before ConfigureAppConfiguration hooks
        // fire, so layering config here does not reach it. Environment variables do,
        // because WebApplication.CreateBuilder reads them when it builds.
        Environment.SetEnvironmentVariable("Database__AutoMigrateOnStartup", ConnectionString is null ? "false" : "true");
        Environment.SetEnvironmentVariable("Jwt__Secret", "test-only-signing-key-not-used-in-any-real-environment");
        // Set on both branches, not just when present. These variables are process-wide
        // and outlive the factory that set them: leaving a previous factory's value in
        // place gave a deliberately database-free host a live connection string, so a
        // test that should have failed fast on "no database" instead reached Postgres
        // and failed somewhere unrecognisable. Clearing it is what makes ConnectionString
        // == null actually mean no database.
        Environment.SetEnvironmentVariable("ConnectionStrings__DefaultConnection", ConnectionString);

        // Same constraint as the connection string: Program.cs reads the gateway trust
        // configuration while it builds, before ConfigureAppConfiguration hooks fire.
        // Cleared rather than left when null, for the reason spelled out above — these
        // variables are process-wide and outlive the factory that set them.
        Environment.SetEnvironmentVariable("Gateway__TrustedProxies", TrustedProxies);
        Environment.SetEnvironmentVariable("Gateway__ForwardLimit", ForwardLimit?.ToString());

        // Read by Program.cs at limiter-registration time, so this has the same
        // must-be-an-environment-variable constraint as the connection string above.
        foreach (var (key, fallback) in DefaultRateLimits)
        {
            var value = RateLimits is not null && RateLimits.TryGetValue(key, out var v) ? v : fallback;
            Environment.SetEnvironmentVariable($"RateLimits__{key}", value.ToString());
        }

        // "Testing" rather than "Development": Program.cs runs the Seeder under
        // IsDevelopment(), and the Seeder talks to the database.
        builder.UseEnvironment("Testing");

        builder.ConfigureAppConfiguration((_, config) =>
        {
            var settings = new Dictionary<string, string?>
            {
                // Off by default: most tests do not need a database, and the
                // `backend` CI job does not provision one.
                ["Database:AutoMigrateOnStartup"] = ConnectionString is null ? "false" : "true",
                // Program.cs reads this at registration time, so it must be in place
                // before the host is built rather than layered on afterwards.
                ["Jwt:Secret"] = "test-only-signing-key-not-used-in-any-real-environment",
            };

            if (ConnectionString is not null)
            {
                settings["ConnectionStrings:DefaultConnection"] = ConnectionString;
            }

            config.AddInMemoryCollection(settings);
        });

        builder.ConfigureServices(services =>
        {
            // The background workers poll the database on a timer. They swallow
            // their own exceptions, so they would not fail a test — but they would
            // spend the whole run retrying a connection that is never coming, which
            // makes real failures harder to read.
            services.RemoveAll<IHostedService>();

            // A startup filter runs ahead of everything Program.cs adds, so the remote
            // address is in place before UseForwardedHeaders looks at it.
            if (RemoteIpAddress is { } remote)
            {
                services.AddTransient<IStartupFilter>(_ => new RemoteAddressFilter(remote));
            }
        });
    }

    private sealed class RemoteAddressFilter(System.Net.IPAddress remote) : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Use((ctx, nextMiddleware) =>
            {
                ctx.Connection.RemoteIpAddress = remote;
                return nextMiddleware(ctx);
            });
            next(app);
        };
    }
}
