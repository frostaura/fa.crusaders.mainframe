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

    private async Task TickAsync(CancellationToken ct)
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
}
