using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// One club's fault rows, swept past its own <c>device_error_retention_days</c>.
///
/// <para>
/// <b>The sweep is asymmetric, and the asymmetry is the whole point.</b> A RESOLVED row past
/// the cutoff is DELETED; an OPEN row past it is AUTO-RESOLVED with
/// <see cref="MonitoringSettings.AgedOutNote"/> and kept. An "open errors" count that silently
/// drops rows nobody looked at is a count that LIES about the club's estate — the number goes
/// down, the boards are exactly as broken, and the one surface that would have said so is the
/// one that quietly stopped saying it. Ageing out keeps the number honest and keeps the
/// history; it also frees the filtered unique index on that fingerprint, so a board that starts
/// failing again in month four opens a FRESH row with a truthful <c>FirstSeenAt</c> rather than
/// resurrecting a stale one.
/// </para>
///
/// <para>
/// <b>The two branches age off different columns, and that is deliberate rather than an
/// oversight.</b> An open row ages by <c>LastSeenAt</c> — when the club last heard the fault —
/// which is also the column the list ranges on, so a row the page can no longer show is exactly
/// a row this sweep attends to. A resolved row ages by <c>ResolvedAt</c> — when the club
/// stopped caring. Ageing a resolved row by its last sighting instead would delete every
/// aged-out row on the following night's sweep, one day after it was written, which makes "keeps
/// the history" false in the same file that claims it.
/// </para>
/// </summary>
public static class DeviceErrorRetention
{
    /// <summary>What one sweep did to one club.</summary>
    /// <param name="Deleted">Resolved rows removed, whose resolution is older than the club's retention.</param>
    /// <param name="AgedOut">Open rows closed with the aged-out note, and kept.</param>
    public readonly record struct Sweep(int Deleted, int AgedOut);

    /// <summary>
    /// Sweeps one tenant. The caller has already set the tenant context, so both reads are
    /// tenant-filtered by the context's global query filter rather than by a comparison here.
    /// </summary>
    public static async Task<Sweep> SweepAsync(
        MainframeDbContext db, TenantSettingsView settings, DateTimeOffset now, CancellationToken ct)
    {
        // Clamped on read, because a hand-edited settings document is not a PUT and this is the
        // sharpest case of that rule in the tree: the number decides what gets DELETED.
        var cutoff = now.AddDays(-MonitoringSettings.RetentionDays(settings)).ToUniversalTime();

        var expired = await db.DeviceErrors
            .Where(e => e.ResolvedAt != null && e.ResolvedAt < cutoff)
            .ToListAsync(ct);
        if (expired.Count > 0) db.DeviceErrors.RemoveRange(expired);

        var stale = await db.DeviceErrors
            .Where(e => e.ResolvedAt == null && e.LastSeenAt < cutoff)
            .ToListAsync(ct);
        foreach (var row in stale)
        {
            row.ResolvedAt = now.ToUniversalTime();

            // No resolver, deliberately. Nobody attended to this fault, and putting an admin's
            // name against it would make the page assert that somebody did.
            row.ResolvedByUserId = null;
            row.ResolutionNote = MonitoringSettings.AgedOutNote;
        }

        if (expired.Count == 0 && stale.Count == 0) return new Sweep(0, 0);

        await db.SaveChangesAsync(ct);
        return new Sweep(expired.Count, stale.Count);
    }
}
