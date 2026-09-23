using System.Data.Common;
using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Delivers the admin notice outbox: claims due rows, works out who they go to, mails them, and
/// backs off when the mail server says no (R23).
///
/// <para>
/// <b>A singleton the worker drives, rather than logic inside the worker.</b> The test hosts
/// remove every hosted service, so a delivery loop that lived in a <c>BackgroundService</c> would
/// be unreachable from a test except by starting it and waiting. Tests resolve this and call
/// <see cref="DeliverDueAsync"/> at a stated instant instead — the same shape
/// <c>PeripheralHealthWorker.TickAsync(now, ct)</c> takes, for the same reason.
/// </para>
///
/// <para>
/// <b>At least once per admin, and never twice to the same admin for one row.</b> A claim is a
/// lease, not a lock held across SMTP: the claim statement stamps <see cref="AdminNotification.LockedUntil"/>
/// and commits at once, so a worker that dies mid-send leaves a row that becomes claimable again
/// when the lease runs out. Every successful send is recorded on the row before the next is
/// attempted, so the retry mails only the admins who did not get it. The one window left is a
/// crash between SMTP accepting a message and that record being written, which duplicates one
/// message to one admin — the price of not being able to enlist a mail server in a transaction.
/// </para>
/// </summary>
public sealed class AdminNotificationDispatcher
{
    /// <summary>Rows claimed per pass. Small: each costs one SMTP round trip per admin.</summary>
    public const int BatchSize = 20;

    /// <summary>
    /// How long a claim holds a row. Comfortably longer than a pass can take — twenty rows, a
    /// handful of admins, fifteen seconds per send at the transport's own ceiling — because a
    /// lease that expires under a slow worker is how one row gets mailed by two.
    /// </summary>
    public static readonly TimeSpan Lease = TimeSpan.FromMinutes(10);

    /// <summary>
    /// The waits after each failed attempt. The last attempt is the one after the last wait; a
    /// row that fails it is marked failed and logged as an error, never retried for ever.
    /// </summary>
    public static readonly TimeSpan[] Backoffs =
    [
        TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(15),
        TimeSpan.FromHours(1), TimeSpan.FromHours(6),
    ];

    /// <summary>Claims a row may have before it is given up on.</summary>
    public static int MaxAttempts => Backoffs.Length + 1;

    /// <summary>
    /// Top-up failures of one reason inside this window are one mail. A gateway having a bad
    /// quarter of an hour fails every member who tries; the club needs to hear it once.
    /// </summary>
    public static readonly TimeSpan TopUpFailureCooldown = TimeSpan.FromMinutes(30);

    /// <summary>
    /// One admin overdrawing one member inside this window is one mail. A bulk booking of twenty
    /// courts below zero is one decision, and twenty mails to every colleague would teach them to
    /// ignore the kind that exists so they will not.
    /// </summary>
    public static readonly TimeSpan OverdraftCooldown = TimeSpan.FromMinutes(15);

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<AdminNotificationDispatcher> _logger;

    public AdminNotificationDispatcher(IServiceScopeFactory scopes, ILogger<AdminNotificationDispatcher> logger)
    {
        _scopes = scopes; _logger = logger;
    }

    /// <summary>One pass: claim what is due at <paramref name="now"/> and deliver each. Answers how many rows it finished.</summary>
    public async Task<int> DeliverDueAsync(DateTimeOffset now, CancellationToken ct)
    {
        var at = now.ToUniversalTime().Storable();
        var claimed = await ClaimAsync(at, ct);
        var finished = 0;
        foreach (var id in claimed)
        {
            try
            {
                if (await DeliverOneAsync(id, at, ct)) finished++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // One club's broken row must not stop every other club's notices. The lease
                // expires and the row is claimed again, so this is not a silent loss.
                _logger.LogError(ex, "Admin notice {Id} could not be delivered", id);
            }
        }
        return finished;
    }

    /// <summary>
    /// Claims up to <see cref="BatchSize"/> due rows across every club, and answers their ids.
    ///
    /// <para>
    /// On Postgres it is one statement: <c>FOR UPDATE SKIP LOCKED</c> picks rows no other worker
    /// is claiming, and the same statement stamps the lease and counts the attempt, so two workers
    /// can never both believe they hold a row. The in-memory provider the unit suites run on has
    /// no row locks and no SQL; it takes the plain read-then-write, which is only honest for one
    /// worker and is only ever run by one.
    /// </para>
    /// </summary>
    internal async Task<IReadOnlyList<Guid>> ClaimAsync(DateTimeOffset now, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        if (db.Database.IsNpgsql()) return await ClaimOnPostgresAsync(db, now, ct);

        var due = await db.AdminNotifications.IgnoreQueryFilters()
            .Where(n => n.State == AdminNotificationState.Pending && n.DueAt <= now
                        && (n.LockedUntil == null || n.LockedUntil <= now))
            .OrderBy(n => n.DueAt).ThenBy(n => n.Id)
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
        UPDATE admin_notifications AS n
           SET "LockedUntil" = @lease, "Attempts" = n."Attempts" + 1
          FROM (SELECT "Id" FROM admin_notifications
                 WHERE "State" = 0 AND "DueAt" <= @now
                   AND ("LockedUntil" IS NULL OR "LockedUntil" <= @now)
                 ORDER BY "DueAt", "Id"
                 LIMIT @batch
                 FOR UPDATE SKIP LOCKED) AS due
         WHERE n."Id" = due."Id"
        RETURNING n."Id"
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

            var ids = new List<Guid>();
            await using var reader = await command.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) ids.Add(reader.GetGuid(0));
            return ids;
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

    /// <summary>
    /// Everything one row needs to be judged and sent: its own scope, with the row's club set on
    /// it, because recipients, opt-outs, the club's identity and its settings are all that club's.
    /// </summary>
    private sealed record Delivery(
        MainframeDbContext Db, AdminNotification Row, AdminEventKind Kind, TenantSettingsView Settings, ClubIdentity Club)
    {
        public required IEmailService Email { get; init; }
        public required string BaseUrl { get; init; }
    }

    /// <summary>Delivers one claimed row. Answers true when the row reached a final state.</summary>
    private async Task<bool> DeliverOneAsync(Guid id, DateTimeOffset now, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();

        var row = await db.AdminNotifications.IgnoreQueryFilters().FirstOrDefaultAsync(n => n.Id == id, ct);
        if (row is null || row.State != AdminNotificationState.Pending) return false;

        // The backoff gives up only on a failed SEND. A row whose pass throws somewhere else —
        // the recipient query, the settings read — is re-claimed when its lease runs out, and the
        // claim counts the attempt, so this is where that row stops instead of being claimed
        // every ten minutes for ever.
        if (row.Attempts > MaxAttempts)
        {
            _logger.LogError(
                "Admin notice {Id} ({Kind}) for tenant {Tenant} given up after {Attempts} claims that never finished",
                row.Id, row.Kind, row.TenantId, row.Attempts);
            return await FinishAsync(db, row, AdminNotificationState.Failed, now, "attempts_exhausted", ct);
        }

        var tenant = await db.Tenants.IgnoreQueryFilters().AsNoTracking().FirstOrDefaultAsync(t => t.Id == row.TenantId, ct);
        if (tenant is null) return await FinishAsync(db, row, AdminNotificationState.Failed, now, "tenant_missing", ct);
        scope.ServiceProvider.GetRequiredService<ITenantContext>().Set(tenant.Id, tenant.Slug);

        var kind = AdminEventCatalogue.Find(row.Kind);
        if (kind is null)
        {
            _logger.LogError("Admin notice {Id} names kind '{Kind}', which this build does not know", row.Id, row.Kind);
            return await FinishAsync(db, row, AdminNotificationState.Failed, now, "unknown_kind", ct);
        }

        var settings = await scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>().GetAsync(ct);
        if (await CooledDownAsync(db, row, Cooldown(row.Kind, settings), ct))
        {
            return await FinishAsync(db, row, AdminNotificationState.Suppressed, now, null, ct);
        }

        var delivery = new Delivery(db, row, kind, settings, ClubIdentityResolver.For(tenant, settings))
        {
            Email = scope.ServiceProvider.GetRequiredService<IEmailService>(),
            BaseUrl = scope.ServiceProvider.GetRequiredService<IConfiguration>()["App:PublicBaseUrl"] ?? "http://localhost:8088",
        };
        var error = await SendAllAsync(delivery, ct);
        if (error is null) return await FinishAsync(db, row, AdminNotificationState.Sent, now, null, ct);
        return await BackOffAsync(db, row, now, error, ct);
    }

    /// <summary>
    /// Mails every recipient this row has not reached yet, recording each as it goes. Answers the
    /// first failure's message, or null when nobody is left unmailed.
    /// </summary>
    private async Task<string?> SendAllAsync(Delivery d, CancellationToken ct)
    {
        var done = ReadIds(d.Row.DeliveredToJson);
        string? firstError = null;

        foreach (var r in await AdminRecipients.ResolveAsync(d.Db, d.Row, d.Kind, ct))
        {
            if (done.Contains(r.UserId)) continue;
            try
            {
                var message = AdminEventCatalogue.Compose(
                    new AdminMailContext(d.Club, r.Email, d.Row, r.IsSubject, d.BaseUrl, d.Settings));
                await d.Email.SendAsync(message, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                firstError ??= $"{r.UserId:N}: {ex.GetType().Name}: {ex.Message}";
                _logger.LogWarning(ex, "Admin notice {Id} ({Kind}) to {To} failed", d.Row.Id, d.Row.Kind, r.Email);
                continue;
            }

            // Recorded before the next send, so a crash from here on cannot mail this admin again.
            done.Add(r.UserId);
            d.Row.DeliveredToJson = JsonSerializer.Serialize(done);
            d.Row.RecipientCount = done.Count;
            await d.Db.SaveChangesAsync(ct);
        }

        return firstError;
    }

    /// <summary>A failed pass: try again after the next backoff, or give up loudly after the last one.</summary>
    private async Task<bool> BackOffAsync(
        MainframeDbContext db, AdminNotification row, DateTimeOffset now, string error, CancellationToken ct)
    {
        if (row.Attempts >= MaxAttempts)
        {
            _logger.LogError(
                "Admin notice {Id} ({Kind}) for tenant {Tenant} given up after {Attempts} attempts: {Error}",
                row.Id, row.Kind, row.TenantId, row.Attempts, error);
            return await FinishAsync(db, row, AdminNotificationState.Failed, now, error, ct);
        }

        var wait = Backoffs[Math.Clamp(row.Attempts - 1, 0, Backoffs.Length - 1)];
        row.DueAt = now + wait;
        row.LockedUntil = null;
        row.LastError = Clip(error);
        await db.SaveChangesAsync(ct);
        return false;
    }

    private static async Task<bool> FinishAsync(
        MainframeDbContext db, AdminNotification row, AdminNotificationState state, DateTimeOffset now, string? error, CancellationToken ct)
    {
        row.State = state;
        row.SentAt = now;
        row.LockedUntil = null;
        row.LastError = error is null ? null : Clip(error);
        await db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>
    /// The window inside which a second notice of this kind and scope is suppressed. Zero for the
    /// kinds whose dedupe key already says everything — one outage, one registration, one change.
    /// Block body for the lizard reason in <c>memory/gotchas-build.md</c>.
    /// </summary>
    public static TimeSpan Cooldown(string kind, TenantSettingsView settings)
    {
        switch (kind)
        {
            case AdminEventCatalogue.FaultSpike:
            case AdminEventCatalogue.RefusalSpike:
                return AdminNotificationSettings.SpikeCooldown(settings);
            case AdminEventCatalogue.TopUpFailed:
                return TopUpFailureCooldown;
            case AdminEventCatalogue.OverdraftAuthorised:
                return OverdraftCooldown;
            default:
                return TimeSpan.Zero;
        }
    }

    /// <summary>
    /// Whether another notice of this kind and scope was MAILED to anybody within the cooldown of
    /// this one. Counted from the mailed ones only: a suppressed notice does not extend the
    /// window, or a steady trickle would suppress the whole kind for ever.
    ///
    /// <para>
    /// <b>"Mailed" is "reached somebody", not "finished".</b> A notice that reached every admin
    /// but one goes back to <c>Pending</c> to retry the one; counting only <c>Sent</c> rows meant
    /// it counted as nothing, so every sibling raised while it waited was mailed in full — three
    /// overdraft mails inside one fifteen-minute cooldown to the admins whose mailboxes worked.
    /// A notice finished as <c>Sent</c> to nobody (everybody opted out, or the only admin was the
    /// actor) reached nobody, and does not withhold the next one from an admin who is listening.
    /// </para>
    ///
    /// <para>
    /// <b>Both sides of this row, and only before it has reached anybody.</b> A row that failed
    /// outright and is retried after a later sibling was mailed must not mail a second time
    /// inside the same window; once a row has reached somebody it has spoken for the window and
    /// its retry is owed to the admins it missed.
    /// </para>
    /// </summary>
    private static async Task<bool> CooledDownAsync(
        MainframeDbContext db, AdminNotification row, TimeSpan cooldown, CancellationToken ct)
    {
        if (cooldown <= TimeSpan.Zero || row.RecipientCount > 0) return false;
        var from = row.CreatedAt - cooldown;
        var to = row.CreatedAt + cooldown;
        return await db.AdminNotifications.AsNoTracking().AnyAsync(n =>
            n.Id != row.Id
            && n.Kind == row.Kind
            && n.CooldownScope == row.CooldownScope
            && n.RecipientCount > 0
            && n.CreatedAt >= from
            && n.CreatedAt <= to, ct);
    }

    private static HashSet<Guid> ReadIds(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<HashSet<Guid>>(json) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static string Clip(string error) =>
        error.Length <= AdminNotification.LastErrorMaxLength ? error : error[..AdminNotification.LastErrorMaxLength];
}

/// <summary>One person a notice is mailed to, and whether they are its subject rather than an administrator.</summary>
public sealed record AdminRecipient(Guid UserId, string Email, bool IsSubject);

/// <summary>
/// Who a notice goes to (R23): the club's active administrators with a confirmed address, minus
/// the admin whose action caused it, minus those who have opted out of its kind — unless the kind
/// is one nobody may opt out of — plus, for a kind that notifies its subject, the subject.
///
/// <para>
/// <b>Tenant-filtered, and only ever run with the row's own club set on the context.</b> The
/// dispatcher sets it from the row before calling, so another club's admins are not merely
/// excluded by a predicate here — they are not in the set the predicate runs over.
/// </para>
///
/// <para>
/// <b>An unconfirmed address is not mailed.</b> Registration never makes an admin, so an
/// unconfirmed admin is one a deployment configured by hand or one whose address changed; either
/// way the club has no evidence the address reaches the person, and some of these messages carry
/// members' names and money.
/// </para>
/// </summary>
public static class AdminRecipients
{
    public static async Task<IReadOnlyList<AdminRecipient>> ResolveAsync(
        MainframeDbContext db, AdminNotification row, AdminEventKind kind, CancellationToken ct)
    {
        var admins = await db.Users.AsNoTracking()
            .Where(u => u.IsAdmin && u.Status == "active" && u.EmailVerified)
            .Where(u => row.ActorUserId == null || u.Id != row.ActorUserId)
            .Select(u => new { u.Id, u.Email })
            .ToListAsync(ct);

        var optedOut = kind.OptOutable ? await OptedOutAsync(db, admins.Select(a => a.Id).ToList(), row.Kind, ct) : [];
        var subjectId = kind.NotifiesSubject ? row.SubjectUserId : null;

        var recipients = admins
            .Where(a => !optedOut.Contains(a.Id) && a.Id != subjectId)
            .Select(a => new AdminRecipient(a.Id, a.Email, IsSubject: false))
            .ToList();

        if (subjectId is { } sid)
        {
            var subject = await db.Users.AsNoTracking().Where(u => u.Id == sid).Select(u => u.Email).FirstOrDefaultAsync(ct);
            if (subject is not null) recipients.Add(new AdminRecipient(sid, subject, IsSubject: true));
        }

        return recipients;
    }

    /// <summary>The admins among <paramref name="adminIds"/> whose opt-out list names <paramref name="kind"/>.</summary>
    private static async Task<HashSet<Guid>> OptedOutAsync(
        MainframeDbContext db, List<Guid> adminIds, string kind, CancellationToken ct)
    {
        var rows = await db.UserPreferences.AsNoTracking()
            .Where(p => adminIds.Contains(p.UserId))
            .Select(p => new { p.UserId, p.AdminNotificationOptoutsJson })
            .ToListAsync(ct);

        return rows
            .Where(p => UserPreferencesRules.ReadOptouts(p.AdminNotificationOptoutsJson).Contains(kind, StringComparer.Ordinal))
            .Select(p => p.UserId)
            .ToHashSet();
    }
}
