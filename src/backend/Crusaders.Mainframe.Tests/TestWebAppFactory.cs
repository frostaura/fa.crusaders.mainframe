using Crusaders.Mainframe.Api.Payments;
using Crusaders.Mainframe.Api.Payments.PayFast;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Console;

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
    /// ("AuthPerMinute", "DevicePerMinute", "GlobalPerMinute", "GlobalPerIpPerMinute", "FirmwarePerMinute",
    /// "WritesPerMinute", "WritesBurst").
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

    /// <summary>
    /// The hosting environment name. Null is "Testing", which is what every suite but one
    /// wants — <c>Program.cs</c> runs the dev Seeder under <c>IsDevelopment()</c> and the
    /// Seeder talks to a database.
    ///
    /// <para>
    /// <b>Set it to "Production" to test what a CLUB'S deployment answers.</b> Development
    /// adds the developer exception page, which turns a malformed request into a stack trace
    /// naming types, assemblies and absolute source paths on the machine that built it; the
    /// review stack ran in Development and the reviewer read that as the product's behaviour.
    /// The only way to know is to boot the environment the club runs. See
    /// <c>DeploymentPostureTests</c>.
    /// </para>
    /// </summary>
    public string? EnvironmentName { get; init; }

    /// <summary>
    /// What PayFast's validate call answers for every ITN this host receives. The real validator
    /// POSTs to PayFast; no test may, so every host swaps in <see cref="StubItnValidator"/> answering
    /// this (default <see cref="ItnValidation.Valid"/>, so a suite about the API's own handling is
    /// testing that). A test of the refusal sets <c>Invalid</c> or <c>Unavailable</c>; the real
    /// validator's HTTP leg has its own unit tests over a fake handler.
    /// </summary>
    public ItnValidation PayFastValidation { get; init; } = ItnValidation.Valid;

    /// <summary>The stub every host's ITN path asks; <see cref="StubItnValidator.Calls"/> counts what it was asked.</summary>
    public StubItnValidator ItnValidator => _itnValidator ??= new StubItnValidator(PayFastValidation);
    private StubItnValidator? _itnValidator;

    /// <summary>
    /// The member-code master key every factory host runs with: 48 RANDOM bytes, drawn once per
    /// test process. Random rather than a committed constant because the host runs under the same
    /// key policy Production does (only Development is lenient) and that policy refuses every key
    /// published in this repository — the constant this used to be among them.
    /// </summary>
    public static readonly string TestMemberCodeMasterKey =
        Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(48));

    private static readonly Dictionary<string, int> DefaultRateLimits = new()
    {
        ["AuthPerMinute"] = 100_000,
        ["AuthPerIpPerMinute"] = 100_000,
        ["DevicePerMinute"] = 100_000,
        ["GlobalPerMinute"] = 100_000,
        ["GlobalPerIpPerMinute"] = 100_000,
        ["FirmwarePerMinute"] = 100_000,

        // Review round 4: the writes bucket too. It is floored at AuthPerMinute, so a suite that
        // left it unlisted ran at the production 60/min, burst 20 — and a test that happened to
        // make its 21st write in a second met a 429 it was not testing.
        ["WritesPerMinute"] = 100_000,
        ["WritesBurst"] = 100_000,
    };

    // Variables this factory used to SET to configure the app, and a developer shell might
    // still export. Cleared once, to the same value by every factory, so a host with
    // ConnectionString == null still means no database — see ConfigureWebHost.
    private static readonly string[] FormerlyExportedVariables =
    [
        "Database__AutoMigrateOnStartup", "Jwt__Secret", "MemberCodes__MasterKey",
        "ConnectionStrings__DefaultConnection", "Gateway__TrustedProxies", "Gateway__ForwardLimit",
        "RateLimits__AuthPerMinute", "RateLimits__AuthPerIpPerMinute", "RateLimits__DevicePerMinute", "RateLimits__GlobalPerMinute",
        "RateLimits__GlobalPerIpPerMinute", "RateLimits__FirmwarePerMinute",
    ];

    static TestWebAppFactory()
    {
        foreach (var name in FormerlyExportedVariables)
        {
            Environment.SetEnvironmentVariable(name, null);
        }

        // No file watchers on appsettings*.json. Every host otherwise starts its own
        // reload-on-change watchers, which cost about a third of a warm boot (145 ms -> 95 ms,
        // measured 2026-09-28) across the thousands of hosts a run boots, and no test edits a
        // configuration file under a running host. One value for the whole process.
        Environment.SetEnvironmentVariable("DOTNET_hostBuilder__reloadConfigOnChange", "false");
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // Program.cs reads builder.Configuration DURING its own execution — the connection
        // string is captured at AddDbContext registration time. Under the minimal hosting model
        // that happens before ConfigureAppConfiguration hooks fire, so config layered on THERE
        // does not reach it.
        //
        // UseSetting does. WebApplicationFactory hands these to WebApplication.CreateBuilder as
        // host settings, applied before Program.cs's first read and outranking appsettings.json
        // and environment variables (verified 2026-09-28: a UseSetting connection string is the
        // one the registered DbContext carries). And they are PER HOST.
        //
        // This used to be done with Environment.SetEnvironmentVariable, which is process-wide:
        // two factories booting at once raced, and the loser silently got the other's
        // connection string, rate limits or proxy trust. That race is why every Postgres-backed
        // class once ran in ONE serial xUnit collection (25-43 minutes). Nothing here may go
        // back to an environment variable; TestWebAppFactoryIsolationTests boots factories
        // concurrently and reads back what each one got.
        //
        // A null property sets nothing, so appsettings.json's value stands: no connection string
        // override means the placeholder, which with AutoMigrateOnStartup off is never dialled.
        builder.UseSetting("Database:AutoMigrateOnStartup", ConnectionString is null ? "false" : "true");
        builder.UseSetting("Jwt:Secret", "test-only-signing-key-not-used-in-any-real-environment");
        // A REAL-shaped member-code master key (member-code §3.1), because a factory built with
        // EnvironmentName = "Production" must start: Production refuses the development key and
        // every placeholder.
        builder.UseSetting("MemberCodes:MasterKey", TestMemberCodeMasterKey);

        if (ConnectionString is not null)
        {
            builder.UseSetting("ConnectionStrings:DefaultConnection", ConnectionString);
        }

        // Program.cs reads the gateway trust configuration while it builds.
        if (TrustedProxies is not null)
        {
            builder.UseSetting("Gateway:TrustedProxies", TrustedProxies);
        }

        if (ForwardLimit is { } forwardLimit)
        {
            builder.UseSetting("Gateway:ForwardLimit", forwardLimit.ToString());
        }

        // Read by Program.cs at limiter-registration time.
        foreach (var (key, fallback) in DefaultRateLimits)
        {
            var value = RateLimits is not null && RateLimits.TryGetValue(key, out var v) ? v : fallback;
            builder.UseSetting($"RateLimits:{key}", value.ToString());
        }

        // "Testing" rather than "Development": Program.cs runs the Seeder under
        // IsDevelopment(), and the Seeder talks to the database.
        builder.UseEnvironment(EnvironmentName ?? "Testing");

        // The console gets warnings and errors only. At the app's own Information level every
        // EF command was printed with its SQL: 2.2 million lines (243 MB) a full run, measured
        // 2026-09-30 in the run's trx, formatted on the test's own thread and marshalled through
        // the runner's stdout pipe — output no test reads and no person could. Other providers,
        // and any a test adds to capture logs, keep their levels.
        builder.ConfigureLogging(logging => logging.AddFilter<ConsoleLoggerProvider>(null, LogLevel.Warning));

        builder.ConfigureServices(services =>
        {
            // The background workers poll the database on a timer. They swallow
            // their own exceptions, so they would not fail a test — but they would
            // spend the whole run retrying a connection that is never coming, which
            // makes real failures harder to read.
            services.RemoveAll<IHostedService>();

            // The production IEmailService QUEUES; the admin notice dispatcher talks to the
            // transport. A test that swaps IEmailService for a capturing stub means "the mail
            // that leaves", so the transport follows whatever IEmailService is registered when it
            // is first used — which is after every per-test override.
            services.RemoveAll<Crusaders.Mainframe.Api.Email.IEmailTransport>();
            services.AddSingleton<Crusaders.Mainframe.Api.Email.IEmailTransport>(
                sp => new ForwardingEmailTransport(sp.GetRequiredService<Crusaders.Mainframe.Api.Email.IEmailService>()));

            // Never PayFast's real validate endpoint from a test — see PayFastValidation.
            services.RemoveAll<IPayFastItnValidator>();
            services.AddSingleton<IPayFastItnValidator>(ItnValidator);

            // A startup filter runs ahead of everything Program.cs adds, so the remote
            // address is in place before UseForwardedHeaders looks at it.
            if (RemoteIpAddress is { } remote)
            {
                services.AddTransient<IStartupFilter>(_ => new RemoteAddressFilter(remote));
            }
        });
    }

    /// <summary>Stands in for the SMTP transport by handing every message to the test's own <see cref="Crusaders.Mainframe.Api.Email.IEmailService"/>.</summary>
    private sealed class ForwardingEmailTransport(Crusaders.Mainframe.Api.Email.IEmailService inner) : Crusaders.Mainframe.Api.Email.IEmailTransport
    {
        public Task SendAsync(Crusaders.Mainframe.Api.Email.EmailMessage message, CancellationToken ct = default) => inner.SendAsync(message, ct);
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

/// <summary>
/// Stands in for PayFast's <c>/eng/query/validate</c>: answers one fixed verdict and counts the
/// calls, so a test can prove the ITN path asked (or, on a no-op retry, did not).
/// </summary>
public sealed class StubItnValidator(ItnValidation answer) : IPayFastItnValidator
{
    private int _calls;

    public int Calls => Volatile.Read(ref _calls);

    public Task<ItnValidation> ValidateAsync(
        IReadOnlyList<KeyValuePair<string, string>> fields, PerTenantCredentials creds, CancellationToken ct)
    {
        Interlocked.Increment(ref _calls);
        return Task.FromResult(answer);
    }
}
