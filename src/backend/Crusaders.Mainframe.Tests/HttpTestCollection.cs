namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Every Postgres-backed HTTP test class belongs to this collection, so they run
/// sequentially and share one database.
///
/// <para>
/// Not an optimisation — a correctness requirement. <c>TestWebAppFactory</c> configures
/// the application through <b>process environment variables</b>, because
/// <c>Program.cs</c> captures its configuration during its own execution, before any
/// <c>ConfigureAppConfiguration</c> hook fires. Environment variables are process-wide:
/// two factories built concurrently in two test classes race, and the loser silently
/// gets the other's connection string or rate limits. xUnit parallelises across
/// classes by default, so without this collection that race is live.
/// </para>
/// </summary>
[CollectionDefinition(Name)]
public sealed class HttpTestCollection : ICollectionFixture<PostgresFixture>
{
    public const string Name = "postgres-http";
}
