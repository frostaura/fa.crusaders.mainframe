using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// One court's lights cues, serialised (review round 13, E13-1's last race): a transaction-scoped
/// Postgres advisory lock keyed on (tenant, court).
///
/// <para>
/// <b>Why.</b> <c>LightsCueWorker</c> decides a booking's <c>booking.lights_off</c> from whether the
/// next booking on the court is lit (checked in). A check-in that committed between that read and
/// the send announced its <c>lights_on</c> first, so the off arrived after it and read the new
/// session dark. Both sides now hold this lock: the sweep across read → decide → save → SEND, and
/// every <c>booking.lights_on</c> emitter across its send — which comes after its check-in commit.
/// Whichever is second therefore sees the other: a sweep after the check-in reads it lit and sends
/// no off; a check-in after the sweep announces its on after the off.
/// </para>
///
/// <para>
/// <b>No deadlock, by construction.</b> The key is the TWO-int form, whose key space Postgres keeps
/// apart from the single-bigint keys every other lock here uses (<see cref="PayerLock"/>, the seat
/// lock, the device and admin-role locks), so it can never collide with one. The lock is the
/// innermost: a holder takes no other advisory lock while holding it, the sweep's only row write is
/// the booking it is cueing, and an emitter takes it only after its own commits, holding no row
/// locks. Nothing slow happens under it — an event is a channel write; no HTTP is ever made.
/// R14 E14-4: a reversal's emitter that finds its session covered by a lit survivor sends nothing and
/// stamps that one booking's cue instead — the sweep's own order (lock, then the booking's row).
/// </para>
///
/// <para>
/// An ambient transaction is joined rather than nested, as <see cref="PayerLock"/> does; no caller
/// has one today. Not on Postgres (the in-memory test host) it is a no-op.
/// </para>
/// </summary>
public sealed class CourtCueLock : IAsyncDisposable
{
    /// <summary>The first int of the two-int key: this lock's own namespace ("CUE " in ASCII).</summary>
    private const int Namespace = 0x43554520;

    private readonly IDbContextTransaction? _transaction;
    private bool _committed;

    private CourtCueLock(IDbContextTransaction? transaction) => _transaction = transaction;

    /// <summary>Takes the court's lock, in a transaction of its own unless one is already open.</summary>
    public static async Task<CourtCueLock> BeginAsync(MainframeDbContext db, Guid tenantId, Guid courtId, CancellationToken ct)
    {
        if (!db.Database.IsNpgsql()) return new CourtCueLock(null);
        var owned = db.Database.CurrentTransaction is null ? await db.Database.BeginTransactionAsync(ct) : null;
        await db.Database.ExecuteSqlRawAsync(
            "SELECT pg_advisory_xact_lock({0}, {1})", [Namespace, KeyFor(tenantId, courtId)], ct);
        return new CourtCueLock(owned);
    }

    /// <summary>Commits the owned transaction, which releases the lock.</summary>
    public async Task CommitAsync(CancellationToken ct)
    {
        if (_transaction is not null) await _transaction.CommitAsync(ct);
        _committed = true;
    }

    /// <summary>Rolls an uncommitted owned transaction back (a lost save); either way the lock is released.</summary>
    public async ValueTask DisposeAsync()
    {
        if (_transaction is null) return;
        if (!_committed)
        {
            try { await _transaction.RollbackAsync(); }
            catch (Exception) { /* the server already ended it; the lock went with it */ }
        }
        await _transaction.DisposeAsync();
    }

    /// <summary>The second int: FNV-1a over the tenant and court ids. A collision only serialises two courts.</summary>
    internal static int KeyFor(Guid tenantId, Guid courtId)
    {
        var hash = 2166136261u;
        Span<byte> bytes = stackalloc byte[32];
        tenantId.TryWriteBytes(bytes[..16]);
        courtId.TryWriteBytes(bytes[16..]);
        foreach (var b in bytes)
        {
            hash ^= b;
            hash *= 16777619u;
        }
        return unchecked((int)hash);
    }
}
