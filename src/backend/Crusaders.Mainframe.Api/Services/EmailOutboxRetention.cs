using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Clears the email outbox of rows that have finished. A sent row has already dropped its body and
/// attachments and is kept only as the record that a mail went; a failed row is kept longer, because
/// somebody may still be asking what was lost. Neither horizon is a club setting: they bound a
/// system queue, not member data.
/// </summary>
public static class EmailOutboxRetention
{
    public static readonly TimeSpan SentKept = TimeSpan.FromDays(7);
    public static readonly TimeSpan FailedKept = TimeSpan.FromDays(30);

    /// <summary>Rows removed per pass; the nightly caller simply catches up over a few nights after a long gap.</summary>
    public const int BatchSize = 5000;

    public static async Task<int> PurgeAsync(MainframeDbContext db, DateTimeOffset now, CancellationToken ct)
    {
        var sentCutoff = (now - SentKept).Storable();
        var failedCutoff = (now - FailedKept).Storable();
        var old = await db.EmailOutbox
            .Where(m => (m.State == EmailOutboxState.Sent && m.FinishedAt < sentCutoff)
                        || (m.State == EmailOutboxState.Failed && m.FinishedAt < failedCutoff))
            .Take(BatchSize)
            .ToListAsync(ct);
        db.EmailOutbox.RemoveRange(old);
        await db.SaveChangesAsync(ct);
        return old.Count;
    }
}
