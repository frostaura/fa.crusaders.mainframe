using Microsoft.AspNetCore.Hosting;
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

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // Program.cs reads builder.Configuration DURING its own execution — the
        // connection string is captured at AddDbContext registration time. Under the
        // minimal hosting model that happens before ConfigureAppConfiguration hooks
        // fire, so layering config here does not reach it. Environment variables do,
        // because WebApplication.CreateBuilder reads them when it builds.
        Environment.SetEnvironmentVariable("Database__AutoMigrateOnStartup", ConnectionString is null ? "false" : "true");
        Environment.SetEnvironmentVariable("Jwt__Secret", "test-only-signing-key-not-used-in-any-real-environment");
        if (ConnectionString is not null)
        {
            Environment.SetEnvironmentVariable("ConnectionStrings__DefaultConnection", ConnectionString);
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
        });
    }
}
