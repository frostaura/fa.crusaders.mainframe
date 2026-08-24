using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Serialises "read this member's balance, then spend against it".
///
/// <para>
/// Balance is the sum of immutable ledger entries and is never a stored field, which is the
/// right design and is not negotiable — but it means there is no row to constrain and no
/// column to check. <c>GetBalanceAsync</c> is an unlocked <c>SUM</c>, so two requests for the
/// same member both read 200, both find it sufficient, and both debit 200. A member with one
/// booking's worth of credits could take two courts at once and finish at −200; the GiST
/// exclusion constraint protects the <i>slot</i> and nothing protected the <i>balance</i>.
/// </para>
///
/// <para>
/// A transaction-scoped Postgres advisory lock is the smallest thing that closes it. It adds
/// no schema, stores no balance, and is released by the transaction ending however it ends —
/// commit, rollback, or the connection dropping — so a crashed request cannot leave a member
/// unable to book. The key is derived from tenant and payer together, so two clubs' members
/// never queue behind each other.
/// </para>
///
/// <para>
/// <b>It locks the payer, not the court.</b> Concurrent bookings by different members do not
/// contend at all, which is what the club actually does at 18:00 on a Tuesday; two requests
/// from one member are the rare case and are the only case that has to be serial.
/// </para>
///
/// <para>
/// On any provider that is not Npgsql this is a no-op that still runs the caller's work. The
/// in-memory provider has no transactions to begin — and the guarantee cannot be tested
/// there either, which is why the test for it lives in the Postgres-backed suite.
/// </para>
/// </summary>
public sealed class PayerLock : IAsyncDisposable
{
    private readonly IDbContextTransaction? _transaction;
    private bool _committed;

    private PayerLock(IDbContextTransaction? transaction) => _transaction = transaction;

    /// <summary>
    /// Takes the lock, opening a transaction to scope it to. Returns a no-op guard when the
    /// provider cannot support one.
    /// </summary>
    public static async Task<PayerLock> BeginAsync(
        MainframeDbContext db, Guid tenantId, Guid payerUserId, CancellationToken ct)
    {
        if (!db.Database.IsNpgsql())
        {
            return new PayerLock(null);
        }

        // An ambient transaction means somebody up the stack already owns the boundary;
        // joining it silently and then committing it here would end their unit of work
        // early. Take the lock inside theirs and leave the commit to them.
        var owned = db.Database.CurrentTransaction is null
            ? await db.Database.BeginTransactionAsync(ct)
            : null;

        await db.Database.ExecuteSqlRawAsync(
            "SELECT pg_advisory_xact_lock({0})", [KeyFor(tenantId, payerUserId)], ct);

        return new PayerLock(owned);
    }

    /// <summary>
    /// Publishes the work done under the lock. Not calling this rolls it back, which is the
    /// wanted behaviour on every refusal path — a member who could not afford the court must
    /// leave no trace of having tried.
    /// </summary>
    public async Task CommitAsync(CancellationToken ct)
    {
        if (_transaction is not null)
        {
            await _transaction.CommitAsync(ct);
        }
        _committed = true;
    }

    public async ValueTask DisposeAsync()
    {
        if (_transaction is null)
        {
            return;
        }

        if (!_committed)
        {
            // Rollback can itself throw if the connection is already gone, and by then the
            // transaction is over anyway — the server ended it, which is exactly what was
            // wanted. Letting that mask the original failure would be worse.
            try
            {
                await _transaction.RollbackAsync();
            }
            catch (Exception)
            {
                // Intentionally swallowed; see above.
            }
        }

        await _transaction.DisposeAsync();
    }

    /// <summary>
    /// A stable 64-bit key from the tenant and payer.
    ///
    /// <para>
    /// FNV-1a over both Guids rather than <c>GetHashCode</c>, which is randomised per process
    /// in .NET — two API instances behind the same database would hash the same member to
    /// different keys and never contend, which is the one thing this must not do.
    /// </para>
    /// </summary>
    internal static long KeyFor(Guid tenantId, Guid payerUserId)
    {
        const ulong offsetBasis = 14695981039346656037UL;
        const ulong prime = 1099511628211UL;

        var hash = offsetBasis;
        Span<byte> bytes = stackalloc byte[32];
        tenantId.TryWriteBytes(bytes[..16]);
        payerUserId.TryWriteBytes(bytes[16..]);

        foreach (var b in bytes)
        {
            hash ^= b;
            hash *= prime;
        }

        return unchecked((long)hash);
    }
}
