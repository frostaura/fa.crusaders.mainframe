using System.Reflection;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Liveness and readiness, split (IO-16, BP-15), each naming the build it is (IO-05).
///
/// <para>
/// <b><c>/healthz</c> — liveness.</b> The process is up and answering. It touches nothing, so it
/// stays cheap and never fails because a dependency did: restarting a healthy API because
/// Postgres blinked would only add an outage.
/// </para>
///
/// <para>
/// <b><c>/readyz</c> — readiness.</b> The API can do its job: a <c>SELECT 1</c> on the club's
/// database within <see cref="DatabaseTimeout"/>. <c>/healthz</c> alone said "ok" with Postgres
/// gone, so an outage read as a healthy API answering 503 <c>service_busy</c> to everyone, and
/// nothing alerted. The container healthcheck and any external uptime monitor point here. The
/// failure body says which dependency failed and never why in detail (no connection string, no
/// exception text) — it is anonymous.
/// </para>
///
/// <para>
/// <b>Both name the build</b>: <c>version</c> (the assembly's) and <c>revision</c> (the commit,
/// stamped by <c>docker build --build-arg BUILD_SHA=…</c> into the assembly's informational
/// version; <c>"unknown"</c> on a build that was not given one). Nobody could say which commit the
/// club ran, so neither the owed migrations nor firmware/backend compatibility could be checked.
/// </para>
/// </summary>
public static class HealthEndpoints
{
    /// <summary>How long the readiness probe waits for the database.</summary>
    public static readonly TimeSpan DatabaseTimeout = TimeSpan.FromSeconds(2);

    /// <summary>The service name both replies carry.</summary>
    public const string Service = "crusaders.mainframe";

    public static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder app)
    {
        var build = BuildInfo.Current;

        app.MapGet("/healthz", () => Results.Ok(new
        {
            status = "ok", service = Service, version = build.Version, revision = build.Revision, time = DateTimeOffset.UtcNow,
        })).AllowAnonymous();

        app.MapGet("/readyz", async (MainframeDbContext db, ILoggerFactory logs, CancellationToken ct) =>
        {
            var database = await PingAsync(db, logs.CreateLogger("Readiness"), ct);
            var ready = database == "ok";
            return Results.Json(new
            {
                status = ready ? "ready" : "not_ready", service = Service, database,
                version = build.Version, revision = build.Revision, time = DateTimeOffset.UtcNow,
            }, statusCode: ready ? StatusCodes.Status200OK : StatusCodes.Status503ServiceUnavailable);
        }).AllowAnonymous();

        return app;
    }

    /// <summary><c>ok</c>, <c>timeout</c> or <c>unreachable</c>. The detail goes to the log, never to the caller.</summary>
    private static async Task<string> PingAsync(MainframeDbContext db, ILogger logger, CancellationToken requestAborted)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(requestAborted);
        deadline.CancelAfter(DatabaseTimeout);
        try
        {
            await db.Database.ExecuteSqlRawAsync("SELECT 1", deadline.Token);
            return "ok";
        }
        catch (OperationCanceledException) when (!requestAborted.IsCancellationRequested)
        {
            logger.LogWarning("Readiness: the database did not answer within {Timeout}", DatabaseTimeout);
            return "timeout";
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Readiness: the database is unreachable");
            return "unreachable";
        }
    }
}

/// <summary>The version and commit this build is, read once from the assembly.</summary>
public sealed record BuildInfo(string Version, string Revision)
{
    /// <summary>What a build stamped with no commit reports.</summary>
    public const string UnknownRevision = "unknown";

    public static BuildInfo Current { get; } = From(
        typeof(BuildInfo).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion);

    /// <summary>
    /// Splits an informational version — <c>1.0.0+3f2c…</c>, as the SDK writes it from
    /// <c>SourceRevisionId</c> — into the version and the revision.
    /// </summary>
    public static BuildInfo From(string? informational)
    {
        if (string.IsNullOrWhiteSpace(informational)) return new BuildInfo("0.0.0", UnknownRevision);
        var plus = informational.IndexOf('+');
        if (plus < 0) return new BuildInfo(informational, UnknownRevision);
        var revision = informational[(plus + 1)..];
        return new BuildInfo(informational[..plus], revision.Length == 0 ? UnknownRevision : revision);
    }
}
