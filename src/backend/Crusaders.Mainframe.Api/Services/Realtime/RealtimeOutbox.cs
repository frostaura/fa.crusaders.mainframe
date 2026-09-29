namespace Crusaders.Mainframe.Api.Services.Realtime;

/// <summary>
/// Holds "tell the world" work until the transaction that produced it has actually committed.
///
/// <para>
/// <b>D2-B07.</b> <c>LedgerService</c> read the balance, published it to the live wallet stream
/// and mirrored it to every webhook consumer immediately after <c>SaveChangesAsync</c> — and on
/// the four <c>PayerLock</c> paths that save is inside an <b>uncommitted</b> transaction. When
/// it later rolled back, the member's wallet chip and every webhook consumer had already been
/// told money moved that did not, and the chip stayed wrong until some unrelated movement
/// posted. The reproduction is two concurrent payer reassignments on one booking: the loser
/// returns <c>NotChargeable</c> without committing, so <c>DisposeAsync</c> rolls back — after
/// the postings have been published.
/// </para>
///
/// <para>
/// It was survivable while one channel carried one decimal. Item 8 feeds three channels from
/// this same seam, and a court tile that flashes "lights on" and then silently reverts is worse
/// on an unattended wall screen than one that is a second late.
/// </para>
///
/// <para>
/// <b>Scoped, and deliberately not clever.</b> When nothing has opened a deferral — the admin
/// adjust path, the PayFast ITN — an enqueue publishes immediately, exactly as before. When a
/// <see cref="PayerLock"/> is open, the work queues and is drained by that lock's commit, or
/// dropped by its rollback. Depth is counted because <c>PayerLock.BeginAsync</c> joins an
/// ambient transaction rather than opening its own, so locks nest; only the outermost one
/// publishes, and any rollback anywhere poisons the whole queue, because a nested lock's
/// rollback takes the outer transaction with it.
/// </para>
/// </summary>
public sealed class RealtimeOutbox
{
    private readonly List<Func<CancellationToken, Task>> _pending = [];
    private int _depth;
    private bool _poisoned;

    /// <summary>How much work is waiting. For tests, and for the assertion that a rollback published nothing.</summary>
    public int PendingCount => _pending.Count;

    /// <summary>
    /// Publishes now, or queues until the enclosing transaction commits.
    ///
    /// <para>
    /// The action runs <b>after</b> the commit, so anything it reads — a balance, a booking's
    /// status — is read from a committed world rather than from inside the transaction that may
    /// still disappear. That is not a detail: publishing a balance computed pre-commit and then
    /// committing something else would put a number on the member's screen that no row supports.
    /// </para>
    /// </summary>
    public async Task EnqueueAsync(Func<CancellationToken, Task> publish, CancellationToken ct)
    {
        if (_depth == 0)
        {
            await publish(ct);
            return;
        }

        _pending.Add(publish);
    }

    /// <summary>A transaction has opened; hold everything from here.</summary>
    public void Enter() => _depth++;

    /// <summary>
    /// A transaction has ended. <paramref name="committed"/> false poisons the queue, and the
    /// outermost frame either drains it or drops it.
    ///
    /// <para>
    /// Draining is best-effort and swallows: the money is already committed by the time this
    /// runs, and a failed channel write must not turn a completed booking into a 500. That is
    /// the same posture <c>LedgerService.MirrorAsync</c> already documents — emitting is a
    /// channel write and cannot fail the money path.
    /// </para>
    /// </summary>
    public async Task LeaveAsync(bool committed, CancellationToken ct)
    {
        if (!committed) _poisoned = true;
        if (--_depth > 0) return;

        _depth = 0;
        var work = _pending.ToList();
        _pending.Clear();
        var poisoned = _poisoned;
        _poisoned = false;

        if (poisoned) return;

        foreach (var publish in work)
        {
            try
            {
                await publish(ct);
            }
            catch (Exception)
            {
                // Intentionally swallowed; see above. The alternative is a member who paid for a
                // court being told the booking failed because a socket was slow.
            }
        }
    }
}
