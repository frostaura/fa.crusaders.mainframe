using System.Text.RegularExpressions;
using Npgsql;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A Postgres database of this test CLASS's own: a clone of one migrated template, created
/// before the class's first test and dropped after its last.
///
/// <para>
/// <b>Use it as a class fixture</b> — <c>public sealed class FooHttpTests(PostgresFixture pg)
/// : IClassFixture&lt;PostgresFixture&gt;</c> — and do NOT put the class in a
/// <c>[Collection]</c>. Each class is then its own xUnit collection, xUnit runs collections in
/// parallel, and because every class has its own database nothing one class writes can be read
/// by another. This replaced a single <c>postgres-http</c> collection that ran all ~90
/// Postgres-backed classes one after another against one shared database (25–43 minutes).
/// </para>
///
/// <para>
/// Why a clone and not a fresh database per class: migrating an empty database costs seconds;
/// <c>CREATE DATABASE … TEMPLATE</c> of an already-migrated one is a file copy. The template is
/// migrated ONCE per test process through the real startup path (<see cref="PostgresDatabases"/>),
/// so "the migrations apply cleanly to an empty database" is proven by every run before any
/// class starts, and a broken migration fails every Postgres-backed test loudly rather than one.
/// A test that needs an EMPTY database — a migration test — asks for one with
/// <see cref="PostgresDatabases.CreateEmptyAsync"/>.
/// </para>
///
/// <para>
/// Skips cleanly when <c>API_BOUNDARY_TEST_CONNECTION_STRING</c> is absent, and throws when
/// <c>REQUIRE_BOUNDARY_TESTS=true</c> says it must not be absent — see
/// <see cref="PostgresDatabases.ServerConnectionString"/>.
/// </para>
/// </summary>
public sealed class PostgresFixture : IAsyncLifetime
{
    public string? ConnectionString { get; private set; }
    public bool Available => ConnectionString is not null;

    private TestDatabase? _database;
    private SharedHostFactory? _sharedHost;

    /// <summary>
    /// ONE host over this class's database, booted by the first test that asks for it and
    /// disposed with the fixture — never by a test. A test's <c>await using var factory =
    /// CreateFactory()</c> is left exactly as written: disposing the shared host is a no-op.
    ///
    /// <para>
    /// Why: booting a host costs about a second of CPU (the DI container, 200 endpoint delegates,
    /// the first request's pipeline), measured 2026-09-30, and most Postgres-backed tests booted
    /// one each — some 2,100 boots a run for the ~3,000 tests. The tests in a class already share
    /// this database, run one after another, and each seeds its own club, so a shared host
    /// changes nothing they can observe. The isolation BETWEEN classes is untouched: every class
    /// still has its own database and now its own host.
    /// </para>
    ///
    /// <para>
    /// <b>Only for a plain host.</b> A test that needs a host configured differently — rate
    /// limits, proxy trust, a replaced service, a pinned clock — keeps building its own
    /// (<c>new TestWebAppFactory { … }</c> or <c>WithWebHostBuilder</c>, which derives a separate
    /// host from this one). And a test must never mutate this host's singletons: the next test in
    /// the class would inherit it.
    /// </para>
    /// </summary>
    public TestWebAppFactory SharedHost => _sharedHost ??= new SharedHostFactory { ConnectionString = ConnectionString };

    public async Task InitializeAsync()
    {
        if (PostgresDatabases.ServerConnectionString() is null)
        {
            return;
        }

        _database = await PostgresDatabases.CloneTemplateAsync();
        ConnectionString = _database.ConnectionString;
    }

    public async Task DisposeAsync()
    {
        if (_sharedHost is not null)
        {
            await _sharedHost.ReleaseAsync();
        }

        if (_database is not null)
        {
            await _database.DisposeAsync();
        }
    }
}

/// <summary>
/// The class-wide host behind <see cref="PostgresFixture.SharedHost"/>: disposing it from a test
/// does nothing; <see cref="ReleaseAsync"/>, called by the fixture after the class's last test,
/// disposes it for real.
/// </summary>
internal sealed class SharedHostFactory : TestWebAppFactory
{
    private bool _released;

    public override ValueTask DisposeAsync() => _released ? base.DisposeAsync() : ValueTask.CompletedTask;

    public ValueTask ReleaseAsync()
    {
        _released = true;
        return base.DisposeAsync();
    }

    protected override void Dispose(bool disposing)
    {
        if (_released)
        {
            base.Dispose(disposing);
        }
    }
}

/// <summary>A database this process created and will drop. Dispose it to drop it.</summary>
public sealed class TestDatabase(string name, string connectionString) : IAsyncDisposable
{
    public string Name { get; } = name;
    public string ConnectionString { get; } = connectionString;

    public ValueTask DisposeAsync() => new(PostgresDatabases.DropAsync(Name, ConnectionString));
}

/// <summary>
/// Creates and drops the suite's databases on the server named by
/// <c>API_BOUNDARY_TEST_CONNECTION_STRING</c>. Only the server, user and password of that string
/// are used — the database it names is never touched, so two runs pointed at the same string
/// cannot collide.
///
/// <para>
/// Every name starts with <c>TEST_DB_PREFIX</c> (default <c>boundary</c>): the template is
/// <c>{prefix}_tpl_{guid}</c> and each class's clone <c>{prefix}_{guid}</c>. Give concurrent
/// agents or runs different prefixes when you want to tell their databases apart in
/// <c>pg_database</c>; the GUIDs already keep them from colliding.
/// </para>
/// </summary>
public static partial class PostgresDatabases
{
    public const string ConnectionStringVariable = "API_BOUNDARY_TEST_CONNECTION_STRING";
    public const string PrefixVariable = "TEST_DB_PREFIX";

    private static readonly object TemplateGate = new();
    private static Task<string>? _template;

    // CREATE DATABASE … TEMPLATE refuses while any other session is connected to the template.
    // Clones are taken one at a time so that no two ever overlap on it — a clone is a file copy
    // of a small database, so serialising them costs little and removes the question.
    private static readonly SemaphoreSlim CloneGate = new(1, 1);

    [GeneratedRegex("^[a-z][a-z0-9_]{0,30}$")]
    private static partial Regex PrefixShape();

    public static string Prefix
    {
        get
        {
            var configured = Environment.GetEnvironmentVariable(PrefixVariable);
            if (string.IsNullOrWhiteSpace(configured))
            {
                return "boundary";
            }

            // Interpolated into DDL, so its shape is checked rather than trusted.
            return PrefixShape().IsMatch(configured)
                ? configured
                : throw new InvalidOperationException(
                    $"{PrefixVariable}='{configured}' must be lower-case letters, digits and underscores, " +
                    "starting with a letter, at most 31 characters.");
        }
    }

    /// <summary>
    /// The configured server, or null when none is configured and none is required.
    ///
    /// <para>
    /// These tests must never silently skip in the job that exists to run them, but they must
    /// skip cleanly everywhere else. Keying that on <c>CI=true</c> does not work: GitHub sets it
    /// in every job, including <c>backend</c>, which deliberately provisions no Postgres. So the
    /// integration job sets <c>REQUIRE_BOUNDARY_TESTS</c> explicitly — if that is on and the
    /// connection string is missing, the pipeline is broken and should say so.
    /// </para>
    /// </summary>
    public static string? ServerConnectionString()
    {
        var configured = Environment.GetEnvironmentVariable(ConnectionStringVariable);
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured;
        }

        var required = string.Equals(
            Environment.GetEnvironmentVariable("REQUIRE_BOUNDARY_TESTS"), "true",
            StringComparison.OrdinalIgnoreCase);

        return required
            ? throw new InvalidOperationException(
                $"REQUIRE_BOUNDARY_TESTS is set but {ConnectionStringVariable} is not. These are the only " +
                "tests that exercise real SQL and real migrations — they must not be skipped here.")
            : null;
    }

    /// <summary>A new database cloned from the migrated template.</summary>
    public static async Task<TestDatabase> CloneTemplateAsync()
    {
        var template = await TemplateAsync();
        var name = $"{Prefix}_{Guid.NewGuid():N}";

        await CloneGate.WaitAsync();
        try
        {
            await ExecAsync(AdminConnectionString(), $"CREATE DATABASE \"{name}\" TEMPLATE \"{template}\"");
        }
        finally
        {
            CloneGate.Release();
        }

        return new TestDatabase(name, ConnectionStringFor(name));
    }

    /// <summary>
    /// A new, EMPTY database — no schema, no migrations history. For the tests whose subject is
    /// the migrations themselves.
    /// </summary>
    public static async Task<TestDatabase> CreateEmptyAsync()
    {
        var name = $"{Prefix}_{Guid.NewGuid():N}";
        await ExecAsync(AdminConnectionString(), $"CREATE DATABASE \"{name}\"");
        return new TestDatabase(name, ConnectionStringFor(name));
    }

    public static async Task DropAsync(string name, string connectionString)
    {
        // This database's pool only. ClearAllPools would also close every idle connection of
        // every class running beside this one.
        ClearPools(connectionString);
        await ExecAsync(AdminConnectionString(), $"DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)");
    }

    /// <summary>R19 BE19L: seconds a test pool keeps a connection nobody is using. See <see cref="ConnectionStringFor"/>.</summary>
    private const int IdleLifetimeSeconds = 3;

    /// <summary>How often a test pool looks for idle connections to close; under <see cref="IdleLifetimeSeconds"/>.</summary>
    private const int PruningIntervalSeconds = 1;

    public static string ConnectionStringFor(string database)
    {
        var builder = new NpgsqlConnectionStringBuilder(Required()) { Database = database };

        // Durability buys a test database nothing, and every commit otherwise waits for an
        // fsync. Per SESSION, so it changes nothing about the shared server anyone else uses,
        // and nothing a test can observe: visibility and locking are identical.
        builder.Options = string.IsNullOrWhiteSpace(builder.Options)
            ? "-c synchronous_commit=off"
            : builder.Options + " -c synchronous_commit=off";

        // R19 BE19L: an idle pooled connection gives its server slot back within seconds, not
        // Npgsql's 300. Every class has its own database and so its own pool, the sharded run puts
        // ~30 classes on one server at once, and their idle sessions alone filled its 100 slots — the
        // next burst was refused 53300 and answered 503 service_busy (R19TestServerSlotsTests). The
        // API's pool is the bounded copy of this string (DatabasePool.Bound), so it inherits both.
        builder.ConnectionIdleLifetime = IdleLifetimeSeconds;
        builder.ConnectionPruningInterval = PruningIntervalSeconds;
        return builder.ConnectionString;
    }

    private static string Required() =>
        ServerConnectionString()
        ?? throw new InvalidOperationException($"{ConnectionStringVariable} is not set.");

    // Block body for lizard: an expression-bodied `=> new X { … }` makes it mis-scope the file
    // (memory/gotchas-gates.md).
    private static string AdminConnectionString()
    {
        var builder = new NpgsqlConnectionStringBuilder(Required()) { Database = "postgres", Pooling = false };
        return builder.ConnectionString;
    }

    // Built once per process. A FAULTED build is cached too, deliberately: every class then fails
    // with the same migration error instead of each re-running a migration known to be broken.
    private static Task<string> TemplateAsync()
    {
        lock (TemplateGate)
        {
            return _template ??= Task.Run(BuildTemplateAsync);
        }
    }

    private static async Task<string> BuildTemplateAsync()
    {
        var name = $"{Prefix}_tpl_{Guid.NewGuid():N}";
        var admin = AdminConnectionString();
        await ExecAsync(admin, $"CREATE DATABASE \"{name}\"");
        AppDomain.CurrentDomain.ProcessExit += (_, _) => DropOnExit(admin, name);

        var connectionString = ConnectionStringFor(name);
        try
        {
            // The real startup path: Database:AutoMigrateOnStartup is on whenever the factory
            // has a connection string, so booting the host IS `MigrateAsync` against an empty
            // database — exactly what a club's first deployment does.
            await using var factory = new TestWebAppFactory { ConnectionString = connectionString };
            _ = factory.Services;
        }
        finally
        {
            ClearPools(connectionString);
        }

        // Nothing may connect to the template once it is migrated: a stray session makes every
        // later CREATE DATABASE … TEMPLATE fail with "source database is being accessed".
        await ExecAsync(admin, $"ALTER DATABASE \"{name}\" WITH ALLOW_CONNECTIONS false");
        return name;
    }

    /// <summary>
    /// Closes the idle connections of every pool a host over <paramref name="connectionString"/> uses.
    /// Npgsql keys a pool by the WHOLE connection string, and the API bounds the one it is given
    /// (R18, <see cref="Crusaders.Mainframe.Api.Persistence.DatabasePool"/>) — so the host's pool is
    /// the bounded string's, not this one's, and clearing only this one left the migrating host's
    /// sessions on the template, where every clone then failed with "source database is being accessed".
    /// </summary>
    private static void ClearPools(string connectionString)
    {
        NpgsqlConnection.ClearPool(new NpgsqlConnection(connectionString));
        NpgsqlConnection.ClearPool(new NpgsqlConnection(Crusaders.Mainframe.Api.Persistence.DatabasePool.Bound(connectionString, null)));
    }

    private static void DropOnExit(string admin, string name)
    {
        try
        {
            using var conn = new NpgsqlConnection(admin);
            conn.Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = $"DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)";
            cmd.ExecuteNonQuery();
        }
        catch (NpgsqlException)
        {
            // The process is exiting; a template left behind is named with the prefix and a
            // GUID, holds no data, and is dropped by hand. Throwing here would only hide the
            // run's real result.
        }
    }

    private static async Task ExecAsync(string connectionString, string sql)
    {
        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        await cmd.ExecuteNonQueryAsync();
    }
}
