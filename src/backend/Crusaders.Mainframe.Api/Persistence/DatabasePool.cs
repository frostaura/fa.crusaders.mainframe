using System.Data.Common;
using Npgsql;

namespace Crusaders.Mainframe.Api.Persistence;

/// <summary>
/// How many PostgreSQL connections this API may hold, and what a request is answered when it could
/// not get one (review round 18, scalability lane).
///
/// <para>
/// <b>Why the pool is bounded here and not left at Npgsql's default.</b> Npgsql's default
/// <c>Maximum Pool Size</c> is 100, and so is PostgreSQL's default <c>max_connections</c> — the
/// compose stack's <c>postgres:16-alpine</c> runs with exactly that. With the two equal the API alone
/// can take every slot the server has, and nothing in the application ever asked it not to: a burst
/// of concurrent requests (measured: 150 wallet streams opening at once) grew the pool to 99 and the
/// server answered <c>53300 sorry, too many clients already</c> to everything else — the requests
/// that needed a fresh physical connection, a second process, an operator's <c>psql</c>. The pool is
/// a queue in front of the database; it is only a queue while it is smaller than the database.
/// </para>
///
/// <para>
/// <b>The bound.</b> A connection string that names its own <c>Maximum Pool Size</c> keeps it — that
/// is a deliberate deployment decision. Otherwise <c>Database:MaxPoolSize</c>, and when that is unset
/// <see cref="DefaultMaxPoolSize"/>: well under the server's 100, so two API replicas, a migration
/// run and an operator still fit. A request that finds every pooled connection busy waits for one
/// (Npgsql's <c>Timeout</c>, 15 s by default) rather than opening a 101st, and if none frees up in
/// that time it is answered <c>503 service_busy</c> with <c>Retry-After</c>
/// (<see cref="IsUnavailable"/>), never a 500.
/// </para>
/// </summary>
public static class DatabasePool
{
    /// <summary>The configuration key that bounds the pool when the connection string does not.</summary>
    public const string MaxPoolSizeKey = "Database:MaxPoolSize";

    /// <summary>The bound when neither the connection string nor <see cref="MaxPoolSizeKey"/> names one. See the type's remarks.</summary>
    public const int DefaultMaxPoolSize = 40;

    /// <summary>The error code a request that could not get a database connection is answered with (503).</summary>
    public const string ServiceBusy = "service_busy";

    /// <summary>The <c>Retry-After</c> seconds on that 503: a burst that filled the pool drains in a second or two.</summary>
    public const int RetryAfterSeconds = 2;

    /// <summary>PostgreSQL refusing a new session because every slot is taken (<c>too_many_connections</c>).</summary>
    private const string TooManyConnections = "53300";

    /// <summary>PostgreSQL starting up or shutting down (<c>cannot_connect_now</c>).</summary>
    private const string CannotConnectNow = "57P03";

    /// <summary>The spellings Npgsql accepts for the pool bound, any of which means the deployment chose one.</summary>
    private static readonly string[] MaxPoolSizeKeywords = ["Maximum Pool Size", "Max Pool Size", "MaxPoolSize", "MaximumPoolSize"];

    /// <summary>
    /// <paramref name="connectionString"/> with its pool bounded — unchanged when it already names a
    /// bound, otherwise given <paramref name="configured"/> (<see cref="MaxPoolSizeKey"/>) or
    /// <see cref="DefaultMaxPoolSize"/>.
    /// </summary>
    public static string Bound(string connectionString, int? configured)
    {
        var given = new DbConnectionStringBuilder { ConnectionString = connectionString };
        if (MaxPoolSizeKeywords.Any(given.ContainsKey)) return connectionString;

        var size = configured ?? DefaultMaxPoolSize;
        if (size < 1) throw new InvalidOperationException($"{MaxPoolSizeKey} must be at least 1 (was {size}).");
        return new NpgsqlConnectionStringBuilder(connectionString) { MaxPoolSize = size }.ConnectionString;
    }

    /// <summary>The pool bound a connection string carries — Npgsql's own reading of it.</summary>
    public static int MaxPoolSizeOf(string connectionString)
    {
        return new NpgsqlConnectionStringBuilder(connectionString).MaxPoolSize;
    }

    /// <summary>
    /// Whether <paramref name="ex"/>, or anything it wraps, is this request failing to get a database
    /// connection at all: the pool stayed exhausted for the whole wait, or the server refused a new
    /// session (full, or starting up). Nothing ran, so nothing committed — asking again shortly is the
    /// right answer, and it is the server being busy rather than broken.
    /// </summary>
    public static bool IsUnavailable(Exception? ex)
    {
        for (var e = ex; e is not null; e = e.InnerException)
        {
            if (e is PostgresException { SqlState: TooManyConnections or CannotConnectNow }) return true;

            // Npgsql's pool timeout: an NpgsqlException wrapping a TimeoutException, raised before any
            // command was sent. Matched on both, not on the message alone.
            if (e is NpgsqlException { InnerException: TimeoutException } && e is not PostgresException
                && e.Message.Contains("pool", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }
}
