using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;

namespace Crusaders.Mainframe.Api.Workers;

/// <summary>
/// Phase 8.8 — Retention worker (per blueprint D.1, "stored for two years").
///
/// Nightly job that anonymises personally-identifying signals on records older than
/// <c>tenant_settings.retention_years</c> (default 2). The actual rows are kept so aggregate
/// analytics still work; we just null out <c>UserId</c>, <c>SubjectUserId</c>, and
/// <c>MatchedUserId</c> (where applicable) so the data can no longer be tied to a member.
///
/// Idempotent: re-running on already-anonymised rows is a no-op.
///
/// <para>
/// <b><c>user_preferences</c> is deliberately not swept.</b> This worker retires usage HISTORY —
/// rows describing something a member did on a date. A preferences row describes no event and
/// has no age that means anything: it is the member's current choice of theme and opt-ins, read
/// on every page load, and anonymising it would not make the club forget anything about
/// anyone's movements; it would silently reset a living member's settings two years after they
/// last touched them.
/// </para>
/// </summary>
public sealed class RetentionWorker : BackgroundService
{
    private static readonly Guid AnonymisedUserSentinel = Guid.Parse("00000000-0000-0000-0000-000000000001");

    /// <summary>How long an expired member-ident code is kept before it is purged.</summary>
    public const int AccessCodeGraveHours = 24;

    /// <summary>
    /// How long an expired booking-activation code is kept. Longer than an ident code by
    /// the whole event horizon (<see cref="Endpoints.DeviceEventEndpoints.MaxEventAge"/>):
    /// a box back from a long outage uploads scans whose roster codes expired at the
    /// slot's end, and the code is the only thing that turns that scan into attendance
    /// and undoes the no-show sweep. Purged a day after that horizon, the way ident codes
    /// are purged a day after theirs.
    /// </summary>
    public static readonly int BookingCodeGraveHours = (int)Endpoints.DeviceEventEndpoints.MaxEventAge.TotalHours + AccessCodeGraveHours;
    private readonly IServiceProvider _services;
    private readonly ILogger<RetentionWorker> _logger;

    public RetentionWorker(IServiceProvider services, ILogger<RetentionWorker> logger)
    { _services = services; _logger = logger; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Stagger startup so we don't run immediately on boot — wait until first scheduled hour.
        await Task.Delay(TimeSpan.FromMinutes(5), stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            try { await TickAsync(stoppingToken); }
            catch (Exception ex) { _logger.LogError(ex, "RetentionWorker tick failed"); }
            // Once per day. Off-peak is fine — anonymisation is read-light, write-light.
            await Task.Delay(TimeSpan.FromHours(24), stoppingToken);
        }
    }

    /// <summary>
    /// One sweep over every tenant. Public so the suite can drive the real worker rather than a
    /// copy of its arithmetic, the way <c>NoShowWorker</c> already is — a retention rule proved
    /// against a re-implementation proves nothing about the rule that deletes rows in production.
    /// </summary>
    public async Task TickAsync(CancellationToken ct)
    {
        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MainframeDbContext>();
        var tenantContext = scope.ServiceProvider.GetRequiredService<ITenantContext>();
        var settingsAccessor = scope.ServiceProvider.GetRequiredService<TenantSettingsAccessor>();

        var tenants = await db.Tenants.IgnoreQueryFilters().ToListAsync(ct);
        foreach (var tenant in tenants)
        {
            tenantContext.Set(tenant.Id, tenant.Slug);
            var settings = await settingsAccessor.GetAsync(ct);
            var cutoff = DateTimeOffset.UtcNow.AddYears(-settings.RetentionYears);
            var totalAnonymised = 0;

            // The door trail, DELETED, before anything below anonymises anything.
            //
            // W1.9, and the residual door-gate.md §6 wrote down and left open. Anonymising is
            // enough for a booking and is NOT enough for a door: the row still says which door,
            // at what minute, and a racquet club's membership is small enough that a pattern is
            // a person. The club's own page states the number this deletes against, so a row
            // surviving past it would make that sentence false.
            await PurgeDoorTrailAsync(db, tenant, settings, ct);

            // The IoT fault log, on its own horizon and with its own asymmetry: resolved rows
            // past the cutoff are DELETED and open ones are AGED OUT rather than dropped. See
            // DeviceErrorRetention for why — an "open errors" count that silently loses rows
            // nobody looked at is a count that lies about the club's estate — and for why it
            // logs its own result instead of handing this method a condition to branch on.
            await DeviceErrorRetention.SweepAsync(db, settings, DateTimeOffset.UtcNow, _logger, tenant.Slug, ct);

            // Bookings — anonymise the user link on completed/no-show/cancelled rows older than the cutoff.
            var oldBookings = await db.Bookings
                .Where(b => b.CreatedAt < cutoff
                    && (b.Status == BookingStatus.Completed || b.Status == BookingStatus.NoShow || b.Status == BookingStatus.Cancelled)
                    && (b.UserId != null && b.UserId != AnonymisedUserSentinel))
                .ToListAsync(ct);
            foreach (var b in oldBookings)
            {
                b.UserId = AnonymisedUserSentinel;
                b.BookedByUserId = AnonymisedUserSentinel;
                b.PaidByUserId = AnonymisedUserSentinel;
                totalAnonymised++;
            }

            // Biometric match events — drop the matched_user_id link.
            var oldMatches = await db.BiometricMatchEvents
                .Where(m => m.AttemptedAt < cutoff && m.MatchedUserId != null && m.MatchedUserId != AnonymisedUserSentinel)
                .ToListAsync(ct);
            foreach (var m in oldMatches)
            {
                m.MatchedUserId = AnonymisedUserSentinel;
                totalAnonymised++;
            }

            // Audit log — null out the subject user id (actor is kept since it's an admin operation reference).
            var oldAudit = await db.AuditLogs
                .Where(a => a.CreatedAt < cutoff && a.SubjectUserId != null && a.SubjectUserId != AnonymisedUserSentinel)
                .ToListAsync(ct);
            foreach (var a in oldAudit)
            {
                a.SubjectUserId = AnonymisedUserSentinel;
                totalAnonymised++;
            }

            // Access codes — the handles a member's phone shows a court box. An ident code
            // is dead a day after it expires: long enough for a dispute about "my code did
            // not work" to be looked into, and no longer, because a table of every code
            // ever shown is a table of every member's movements. A booking code lives
            // longer — it is the evidence a box back from a long outage uploads, and a
            // purged code is a no-show that can never be reversed. Deleted outright, not
            // anonymised — there is no aggregate anybody wants from them.
            var identCutoff = DateTimeOffset.UtcNow.AddHours(-AccessCodeGraveHours);
            var bookingCutoff = DateTimeOffset.UtcNow.AddHours(-BookingCodeGraveHours);
            var staleCodes = await db.AccessCodes
                .Where(c => (c.Purpose == AccessCodePurpose.MemberIdent && c.ExpiresAt < identCutoff)
                            || (c.Purpose == AccessCodePurpose.BookingActivation && c.ExpiresAt < bookingCutoff))
                .ToListAsync(ct);
            if (staleCodes.Count > 0)
            {
                db.AccessCodes.RemoveRange(staleCodes);
                await db.SaveChangesAsync(ct);
                _logger.LogInformation("Retention purged {Count} expired access codes for tenant {Slug}", staleCodes.Count, tenant.Slug);
            }

            await PurgeMemberCodeRowsAsync(db, ct);

            await PurgeRefreshTokensAsync(db, ct);

            await PurgeSeenCelebrationsAsync(db, settings, ct);

            if (totalAnonymised > 0)
            {
                db.AuditLogs.Add(new AuditLog
                {
                    TenantId = tenant.Id,
                    ActorUserId = AnonymisedUserSentinel,
                    Action = "retention.anonymised",
                    DetailsJson = System.Text.Json.JsonSerializer.Serialize(new
                    {
                        cutoff,
                        bookings = oldBookings.Count,
                        biometric_matches = oldMatches.Count,
                        audit_subjects = oldAudit.Count,
                    }),
                });
                await db.SaveChangesAsync(ct);
                _logger.LogInformation("Retention swept tenant {Slug}: anonymised {Count} records older than {Cutoff:o}", tenant.Slug, totalAnonymised, cutoff);
            }
        }
    }

    /// <summary>
    /// Deletes one club's door rows and door receipts past their own, shorter horizons.
    ///
    /// <para>
    /// <b>Two cutoffs, and the second is deliberately the later of two numbers.</b> The audit
    /// rows go at <c>door_log_retention_days</c> — clamped on read, because a hand-edited column
    /// is not a PUT and this is the sharpest case of that rule in the tree: the number decides
    /// what gets DELETED. The receipts go at <c>max(that, MaxEventAge)</c>, because a receipt is
    /// what makes an upload idempotent: a board may upload an event, lose the link before
    /// reading the response, and upload it again, and a receipt purged inside the event horizon
    /// turns that ordinary retry into a second row for one scan. A club on the seven-day minimum
    /// therefore still keeps its door receipts for thirty days, holding nothing but a device id,
    /// a sequence number and a kind.
    /// </para>
    ///
    /// <para>
    /// Both reads are tenant-filtered by the context's global query filter, which the caller has
    /// already set for this tenant — the isolation is structural rather than a comparison here.
    /// </para>
    /// </summary>
    private async Task PurgeDoorTrailAsync(
        MainframeDbContext db, Domain.Tenant tenant, TenantSettingsView settings, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var retentionDays = DoorSettings.LogRetentionDays(settings);
        var rowCutoff = now.AddDays(-retentionDays);
        var receiptCutoff = now.AddDays(-Math.Max(retentionDays, Endpoints.DeviceEventEndpoints.MaxEventAge.TotalDays));

        var rows = await db.AuditLogs
            .Where(DoorTrail.IsPurgeableRow)
            .Where(a => a.CreatedAt < rowCutoff)
            .ToListAsync(ct);
        if (rows.Count > 0) db.AuditLogs.RemoveRange(rows);

        var receipts = await db.DeviceEventReceipts
            .Where(r => (r.Kind == Endpoints.DeviceEventEndpoints.GateOpenKind
                         || r.Kind == Endpoints.DeviceEventEndpoints.UnknownScanKind)
                        && r.OccurredAt < receiptCutoff)
            .ToListAsync(ct);
        if (receipts.Count > 0) db.DeviceEventReceipts.RemoveRange(receipts);

        if (rows.Count == 0 && receipts.Count == 0) return;

        await db.SaveChangesAsync(ct);
        _logger.LogInformation(
            "Retention purged {Rows} door rows and {Receipts} door receipts for tenant {Slug}",
            rows.Count, receipts.Count, tenant.Slug);
    }

    /// <summary>
    /// Play celebrations (D14) the member has acknowledged, on the inbox's own horizon — one number
    /// for "how long a read notice lives". Unseen ones are never pruned. Loaded and removed rather
    /// than ExecuteDelete, like every purge here: the unit suites run this on the in-memory provider.
    /// </summary>
    private static async Task PurgeSeenCelebrationsAsync(MainframeDbContext db, TenantSettingsView settings, CancellationToken ct)
    {
        var cutoff = DateTimeOffset.UtcNow.AddDays(-PlayerSettings.NotificationRetentionDays(settings));
        var seen = await db.PlayCelebrations.Where(c => c.SeenAt != null && c.SeenAt < cutoff).ToListAsync(ct);
        if (seen.Count == 0) return;
        db.PlayCelebrations.RemoveRange(seen);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Refresh links a day past their own expiry (B1): an expired link mints nothing, and a replay
    /// of one is refused as unknown, so nothing reads them. Deleted — a table of every sign-in is a
    /// table of movements. Runs inside the loop's tenant context, so the query filter scopes it.
    /// </summary>
    private static async Task PurgeRefreshTokensAsync(MainframeDbContext db, CancellationToken ct)
    {
        var cutoff = DateTimeOffset.UtcNow.AddDays(-1);
        var stale = await db.RefreshTokens.Where(t => t.ExpiresAt < cutoff).ToListAsync(ct);
        if (stale.Count == 0) return;
        db.RefreshTokens.RemoveRange(stale);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// The member-code tables' day-long rows (§4.4, §9): lifted out of the tenant loop for the
    /// complexity gate. Runs inside the loop's tenant context, so the query filters scope it.
    /// </summary>
    private static async Task PurgeMemberCodeRowsAsync(MainframeDbContext db, CancellationToken ct)
    {
        // Member-code uses (§4.4). A code is worth nothing ninety seconds after it was shown and
        // an uploaded event older than a day is re-checked against an empty table — which is
        // the forgery check's own window, not a hole: a day is past every step it searches.
        // Deleted, like the access codes above: a table of every scan is a table of movements.
        var useCutoff = DateTimeOffset.UtcNow.Subtract(MemberCodeService.UseRetention);
        var staleUses = await db.MemberCodeUses.Where(u => u.UsedAt < useCutoff).ToListAsync(ct);
        if (staleUses.Count > 0)
        {
            db.MemberCodeUses.RemoveRange(staleUses);
            await db.SaveChangesAsync(ct);
        }

        // Pay-for quotes (§9, §13): a quote is a question the glass asked for one choice
        // window, and a day is past any confirm that could still answer it.
        var staleQuotes = await db.DevicePayForQuotes.Where(q => q.QuotedAt < useCutoff).ToListAsync(ct);
        if (staleQuotes.Count > 0)
        {
            db.DevicePayForQuotes.RemoveRange(staleQuotes);
            await db.SaveChangesAsync(ct);
        }
    }
}
