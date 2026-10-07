using System.Data.Common;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Sends the email outbox: claims due rows, hands each to the mail server, and backs off when the
/// server says no. When the last attempt fails it raises an admin notice for the club the mail
/// was for and gives up.
///
/// <para>
/// <b>A singleton the worker drives</b>, for the same reason <see cref="AdminNotificationDispatcher"/>
/// is: the test hosts remove every hosted service, so a test resolves this and calls
/// <see cref="DeliverDueAsync"/> at a stated instant.
/// </para>
///
/// <para>
/// <b>At least once.</b> A claim is a lease, not a lock held across SMTP: the claim stamps
/// <see cref="EmailOutboxMessage.LockedUntil"/> and commits at once, so a worker that dies mid-send
/// leaves a row that becomes claimable again. The one window left is a crash between the server
/// accepting a message and the row being marked sent, which sends one message twice — the price of
/// not being able to enlist a mail server in a transaction.
/// </para>
/// </summary>
public sealed class EmailOutboxDispatcher
{
    /// <summary>Rows claimed per pass.</summary>
    public const int BatchSize = 20;

    /// <summary>Sends running at once inside a pass, so one slow server connection does not hold the rest of the batch.</summary>
    public const int Parallelism = 4;

    /// <summary>
    /// How long a claim holds a row. Longer than a full batch can take at the transport's own
    /// fifteen-second ceiling (twenty rows, four at a time), because a lease that expires under a
    /// slow worker is how one row is sent twice.
    /// </summary>
    public static readonly TimeSpan Lease = TimeSpan.FromMinutes(5);

    /// <summary>The waits after each failed attempt; the attempt after the last wait is the last.</summary>
    public static readonly TimeSpan[] Backoffs =
    [
        TimeSpan.FromSeconds(30), TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(10),
        TimeSpan.FromHours(1), TimeSpan.FromHours(6),
    ];

    public static int MaxAttempts => Backoffs.Length + 1;

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<EmailOutboxDispatcher> _logger;

    public EmailOutboxDispatcher(IServiceScopeFactory scopes, ILogger<EmailOutboxDispatcher> logger)
    {
        _scopes = scopes; _logger = logger;
    }

    /// <summary>One pass: claim what is due at <paramref name="now"/> and send each. Answers how many rows reached a final state.</summary>
    public async Task<int> DeliverDueAsync(DateTimeOffset now, CancellationToken ct)
    {
        var at = now.ToUniversalTime().Storable();
        var claimed = await ClaimAsync(at, ct);
        var finished = 0;
        await Parallel.ForEachAsync(
            claimed, new ParallelOptions { MaxDegreeOfParallelism = Parallelism, CancellationToken = ct },
            async (id, token) =>
            {
                try
                {
                    if (await DeliverOneAsync(id, at, token)) Interlocked.Increment(ref finished);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // One broken row must not stop the rest. The lease expires and the row is claimed
                    // again, and the claim counts the attempt, so this is not a silent loss.
                    _logger.LogError(ex, "Email {Id} could not be processed", id);
                }
            });
        return finished;
    }

    /// <summary>
    /// Claims up to <see cref="BatchSize"/> due rows. On Postgres it is one statement:
    /// <c>FOR UPDATE SKIP LOCKED</c> picks rows no other worker is claiming and the same statement
    /// stamps the lease and counts the attempt, so two workers never both hold a row. The in-memory
    /// provider the unit suites run on has no row locks; it takes the plain read-then-write.
    /// </summary>
    internal async Task<IReadOnlyList<Guid>> ClaimAsync(DateTimeOffset now, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        if (db.Database.IsNpgsql()) return await ClaimOnPostgresAsync(db, now, ct);

        var due = await db.EmailOutbox
            .Where(m => m.State == EmailOutboxState.Pending && m.DueAt <= now && (m.LockedUntil == null || m.LockedUntil <= now))
            .OrderBy(m => m.DueAt).ThenBy(m => m.CreatedAt).ThenBy(m => m.Id)
            .Take(BatchSize)
            .ToListAsync(ct);
        foreach (var row in due)
        {
            row.LockedUntil = now + Lease;
            row.Attempts++;
        }
        await db.SaveChangesAsync(ct);
        return due.Select(r => r.Id).ToList();
    }

    private const string ClaimSql = """
        UPDATE email_outbox AS m
           SET "LockedUntil" = @lease, "Attempts" = m."Attempts" + 1
          FROM (SELECT "Id" FROM email_outbox
                 WHERE "State" = 0 AND "DueAt" <= @now
                   AND ("LockedUntil" IS NULL OR "LockedUntil" <= @now)
                 ORDER BY "DueAt", "CreatedAt", "Id"
                 LIMIT @batch
                 FOR UPDATE SKIP LOCKED) AS due
         WHERE m."Id" = due."Id"
        RETURNING m."Id", m."DueAt", m."CreatedAt"
        """;

    private static async Task<IReadOnlyList<Guid>> ClaimOnPostgresAsync(MainframeDbContext db, DateTimeOffset now, CancellationToken ct)
    {
        var connection = db.Database.GetDbConnection();
        var opened = connection.State != System.Data.ConnectionState.Open;
        if (opened) await connection.OpenAsync(ct);
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = ClaimSql;
            AddParameter(command, "lease", now + Lease);
            AddParameter(command, "now", now);
            AddParameter(command, "batch", BatchSize);

            // RETURNING promises no order, whatever the sub-select's: the order is re-imposed here.
            var rows = new List<(Guid Id, DateTime DueAt, DateTime CreatedAt)>();
            await using var reader = await command.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) rows.Add((reader.GetGuid(0), reader.GetDateTime(1), reader.GetDateTime(2)));
            return rows.OrderBy(r => r.DueAt).ThenBy(r => r.CreatedAt).ThenBy(r => r.Id).Select(r => r.Id).ToList();
        }
        finally
        {
            if (opened) await connection.CloseAsync();
        }
    }

    private static void AddParameter(DbCommand command, string name, object value)
    {
        var p = command.CreateParameter();
        p.ParameterName = name;
        p.Value = value;
        command.Parameters.Add(p);
    }

    /// <summary>Sends one claimed row. Answers true when the row reached a final state.</summary>
    private async Task<bool> DeliverOneAsync(Guid id, DateTimeOffset now, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var row = await db.EmailOutbox.FirstOrDefaultAsync(m => m.Id == id, ct);
        if (row is null || row.State != EmailOutboxState.Pending) return false;

        // The backoff gives up only on a failed SEND. A row whose pass throws somewhere else is
        // re-claimed when its lease runs out, and the claim counts the attempt, so this is where
        // that row stops instead of being claimed every five minutes for ever.
        if (row.Attempts > MaxAttempts) return await GiveUpAsync(db, row, now, "attempts_exhausted", ct);

        EmailMessage? message;
        try
        {
            message = JsonSerializer.Deserialize<EmailMessage>(row.PayloadJson, EmailOutboxService.Json);
        }
        catch (JsonException)
        {
            message = null;
        }
        // A payload nobody can read will not read better on a retry.
        if (message is null) return await GiveUpAsync(db, row, now, "unreadable_payload", ct);

        try
        {
            await scope.ServiceProvider.GetRequiredService<IEmailTransport>().SendAsync(message, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Email {Id} to {To} failed on attempt {Attempt}", row.Id, row.ToAddress, row.Attempts);
            return await BackOffAsync(db, row, now, $"{ex.GetType().Name}: {ex.Message}", ct);
        }

        // Sent: the body and any attachment are not kept. The row stays, briefly, as the record.
        row.State = EmailOutboxState.Sent;
        row.PayloadJson = "{}";
        row.FinishedAt = now;
        row.LockedUntil = null;
        row.LastError = null;
        await db.SaveChangesAsync(ct);
        return true;
    }

    private async Task<bool> BackOffAsync(MainframeDbContext db, EmailOutboxMessage row, DateTimeOffset now, string error, CancellationToken ct)
    {
        if (row.Attempts >= MaxAttempts) return await GiveUpAsync(db, row, now, error, ct);

        row.DueAt = now + Backoffs[Math.Clamp(row.Attempts - 1, 0, Backoffs.Length - 1)];
        row.LockedUntil = null;
        row.LastError = Clip(error);
        await db.SaveChangesAsync(ct);
        return false;
    }

    /// <summary>
    /// The terminal state: the row is failed, the failure is logged as an error, and — when the mail
    /// belonged to a club — that club's administrators are told through the admin notice outbox,
    /// which mails them directly. Both writes are one save, so a failed mail never goes unannounced.
    /// </summary>
    private async Task<bool> GiveUpAsync(MainframeDbContext db, EmailOutboxMessage row, DateTimeOffset now, string error, CancellationToken ct)
    {
        _logger.LogError("Email {Id} to {To} given up after {Attempts} attempts: {Error}", row.Id, row.ToAddress, row.Attempts, error);
        row.State = EmailOutboxState.Failed;
        row.PayloadJson = "{}";
        row.FinishedAt = now;
        row.LockedUntil = null;
        row.LastError = Clip(error);

        if (row.TenantId is { } tenantId)
        {
            AdminNotices.Stage(db, tenantId, AdminNotices.EmailUndeliverable(row.Id, row.ToAddress, row.Subject, Reason(error)), now);
        }
        await db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>The server's words, shortened for a mail to an admin.</summary>
    private static string Reason(string error) => error.Length <= 200 ? error : error[..200];

    private static string Clip(string s) => s.Length <= EmailOutboxMessage.LastErrorMaxLength ? s : s[..EmailOutboxMessage.LastErrorMaxLength];
}
