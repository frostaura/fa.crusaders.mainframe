namespace Crusaders.Mainframe.Api.Services.Realtime;

/// <summary>
/// The share of the database pool that open Server-Sent Events streams may use at once (review round
/// 18, scalability lane).
///
/// <para>
/// <b>What a stream costs, measured.</b> An open stream holds NO database connection: the bus is
/// in-process (<see cref="InProcessRealtimeBus"/>), one fan-out for every subscriber, and a quiet
/// stream only waits on its channel — 500 streams held for 35 s left at most 8 connections busy. What
/// a stream does do is <i>read</i>: its opening frame (the balance and what is held of it — several
/// queries), and before every keep-alive and every frame its guard (the session's epoch and refresh
/// family, cached 15 s per account, so a 25 s keep-alive misses the cache every time). Those reads
/// arrive together: streams opened together keep-alive together, and a reconnect storm — a gateway
/// restart, a phone fleet waking — opens them all at once. Unbounded, 150 openings at once took 67
/// connections busy and grew the pool to the server's limit.
/// </para>
///
/// <para>
/// So every stream-side read goes through this gate: at most <see cref="Permits"/> of them run at
/// once, the rest queue here, in memory, instead of in front of the pool where the members' own
/// requests queue. A storm of streams then costs the pool a fixed handful of connections, and a
/// member booking a court in the middle of it waits for no stream. The queue drains in well under a
/// second at the measured cost of a guard read (a few milliseconds), which a keep-alive or an opening
/// frame can afford and a booking should not have to.
/// </para>
/// </summary>
public sealed class StreamDbGate
{
    private readonly SemaphoreSlim _permits;

    public StreamDbGate(int permits)
    {
        if (permits < 1) throw new ArgumentOutOfRangeException(nameof(permits), permits, "A stream gate needs at least one permit.");
        Permits = permits;
        _permits = new SemaphoreSlim(permits, permits);
    }

    /// <summary>How many stream-side database reads may run at once.</summary>
    public int Permits { get; }

    /// <summary>
    /// The permits for a pool of <paramref name="maxPoolSize"/>: a fifth of it, and never fewer than
    /// two — streams keep a working lane, and the members' requests keep the other four fifths.
    /// </summary>
    public static int PermitsFor(int maxPoolSize)
    {
        return Math.Max(2, maxPoolSize / 5);
    }

    /// <summary>Runs one stream-side read under a permit. Cancelling while queued gives up the place in the queue.</summary>
    public async Task<T> RunAsync<T>(Func<CancellationToken, Task<T>> read, CancellationToken ct)
    {
        await _permits.WaitAsync(ct);
        try
        {
            return await read(ct);
        }
        finally
        {
            _permits.Release();
        }
    }

    /// <summary>
    /// A <see cref="SseGuard"/> whose re-check runs under a permit — the read every open stream makes
    /// before every keep-alive and frame.
    /// </summary>
    public SseGuard Guard(TimeSpan keepAlive, Func<CancellationToken, Task<bool>> stillAllowed)
    {
        return new SseGuard(keepAlive, ct => RunAsync(stillAllowed, ct));
    }
}
