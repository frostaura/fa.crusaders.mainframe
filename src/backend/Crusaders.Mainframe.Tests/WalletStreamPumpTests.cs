using System.Collections.Concurrent;
using System.Diagnostics;
using Crusaders.Mainframe.Api.Endpoints;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The wallet SSE pump — the loop behind the header balance chip.
///
/// <para>
/// Three independent browser finders reported the same symptom in round 2: a member's live
/// balance updates for roughly the first twenty-five seconds of a page's life and then
/// freezes until they reload. Everything else about the connection looks healthy — the
/// socket stays open, keep-alives keep arriving, the client never sees an error, so its
/// reconnect never fires — and the ledger itself is correct the whole time. What is lost
/// is only the push.
/// </para>
///
/// <para>
/// The cause was one loop racing a fresh <c>ReadAsync</c> against a fresh
/// <c>PeriodicTimer.WaitForNextTickAsync</c> on every turn and abandoning whichever lost,
/// which is two defects wearing one shape:
/// </para>
/// <list type="number">
///   <item>an abandoned <c>ReadAsync</c> is still a queued reader on the channel, so the
///   next published balance is handed to a task nobody awaits and is gone — that is the
///   twenty-five-second cliff; and</item>
///   <item><c>PeriodicTimer</c> allows one outstanding waiter, so the turn after a balance
///   <i>was</i> delivered threw out of the handler with the response already started —
///   the unhandled 500s in the API log.</item>
/// </list>
///
/// <para>
/// These tests are on <see cref="WalletEndpoints.PumpAsync"/> rather than on the HTTP
/// endpoint deliberately: the defect is in the loop's arithmetic of who is waiting on what,
/// it only appears after a keep-alive interval has elapsed, and driving it here lets the
/// interval be milliseconds instead of the twenty-five seconds production uses. The real
/// <see cref="BalanceBroadcaster"/> is on the other end, so the channel's bounded,
/// drop-oldest, single-reader configuration is the one that ships.
/// </para>
/// </summary>
public class WalletStreamPumpTests
{
    private static readonly TimeSpan KeepAlive = TimeSpan.FromMilliseconds(60);

    /// <summary>Long enough that a machine under load does not fail this, short enough to notice.</summary>
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(5);

    /// <summary>Collects what the pump writes, so a test can assert on the stream a member would see.</summary>
    private sealed class Sink
    {
        public ConcurrentQueue<decimal> Balances { get; } = new();
        private int _keepAlives;
        public int KeepAlives => Volatile.Read(ref _keepAlives);

        public Func<decimal, CancellationToken, Task> WriteBalance => (b, _) =>
        {
            Balances.Enqueue(b);
            return Task.CompletedTask;
        };

        public Func<CancellationToken, Task> WriteKeepAlive => _ =>
        {
            Interlocked.Increment(ref _keepAlives);
            return Task.CompletedTask;
        };
    }

    private static async Task<bool> WaitUntilAsync(Func<bool> condition)
    {
        var sw = Stopwatch.StartNew();
        while (sw.Elapsed < Deadline)
        {
            if (condition()) return true;
            await Task.Delay(15);
        }
        return condition();
    }

    /// <summary>
    /// The finding itself: a movement posted after the stream has gone quiet long enough to
    /// keep-alive must still reach the member.
    ///
    /// <para>
    /// Against the abandoned-<c>ReadAsync</c> loop this hangs on an empty queue until the
    /// deadline — which is exactly what a member watching a stale balance experiences.
    /// </para>
    /// </summary>
    [Fact]
    public async Task ABalancePublishedAfterAKeepAliveIsStillDelivered()
    {
        var broadcaster = new BalanceBroadcaster();
        var userId = Guid.NewGuid();
        var channel = broadcaster.Subscribe(userId);
        var sink = new Sink();
        using var cts = new CancellationTokenSource();

        var pump = WalletEndpoints.PumpAsync(
            channel.Reader, KeepAlive, sink.WriteBalance, sink.WriteKeepAlive, cts.Token);

        // Past the cliff: at least two keep-alive intervals have gone by with no traffic.
        Assert.True(await WaitUntilAsync(() => sink.KeepAlives >= 2), "the pump never wrote a keep-alive");

        broadcaster.Publish(userId, 1766.00m);

        Assert.True(await WaitUntilAsync(() => sink.Balances.Count == 1),
            "a balance published after a keep-alive never reached the stream");
        Assert.Equal(1766.00m, Assert.Single(sink.Balances));

        await cts.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pump);
    }

    /// <summary>
    /// The other half of the same defect: delivering a balance must not poison the loop.
    ///
    /// <para>
    /// The old shape left an outstanding <c>WaitForNextTickAsync</c> behind whenever the read
    /// won the race, and the next turn's call threw
    /// <c>InvalidOperationException</c> — after the SSE response had started, so Kestrel logged
    /// an unhandled 500 and the member's stream died. Here the pump has to be alive, unfaulted
    /// and still keeping the connection warm afterwards.
    /// </para>
    /// </summary>
    [Fact]
    public async Task DeliveringABalanceDoesNotKillTheKeepAlive()
    {
        var broadcaster = new BalanceBroadcaster();
        var userId = Guid.NewGuid();
        var channel = broadcaster.Subscribe(userId);
        var sink = new Sink();
        using var cts = new CancellationTokenSource();

        var pump = WalletEndpoints.PumpAsync(
            channel.Reader, KeepAlive, sink.WriteBalance, sink.WriteKeepAlive, cts.Token);

        broadcaster.Publish(userId, 12.00m);
        Assert.True(await WaitUntilAsync(() => sink.Balances.Count == 1), "the first balance never arrived");

        var after = sink.KeepAlives;
        Assert.True(await WaitUntilAsync(() => sink.KeepAlives >= after + 2),
            "the pump stopped keeping the connection alive once it had delivered a balance");
        Assert.False(pump.IsCompleted, "the pump ended by itself while the stream was still open");

        // …and it is still delivering, which is what the member actually cares about.
        broadcaster.Publish(userId, 13.00m);
        Assert.True(await WaitUntilAsync(() => sink.Balances.Count == 2), "the second balance never arrived");

        await cts.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pump);
    }

    /// <summary>
    /// Money posted while a write is in flight is not dropped.
    ///
    /// <para>
    /// A real write goes to a socket, so it can take longer than the gap between two ledger
    /// postings — a cancellation refund and its penalty are two rows in one breath. The
    /// broadcaster's channel is bounded at eight with <c>DropOldest</c>; the pump therefore
    /// drains everything the channel holds rather than taking one item per turn.
    /// </para>
    /// </summary>
    [Fact]
    public async Task BalancesPostedWhileAWriteIsInFlightAreAllDelivered()
    {
        var broadcaster = new BalanceBroadcaster();
        var userId = Guid.NewGuid();
        var channel = broadcaster.Subscribe(userId);
        var written = new ConcurrentQueue<decimal>();
        var firstWriteStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirstWrite = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cts = new CancellationTokenSource();

        var pump = WalletEndpoints.PumpAsync(
            channel.Reader,
            KeepAlive,
            async (b, _) =>
            {
                if (written.IsEmpty)
                {
                    firstWriteStarted.TrySetResult();
                    await releaseFirstWrite.Task;
                }
                written.Enqueue(b);
            },
            _ => Task.CompletedTask,
            cts.Token);

        broadcaster.Publish(userId, 100.00m);
        await firstWriteStarted.Task.WaitAsync(Deadline);

        // Two more movements land while the socket is busy with the first.
        broadcaster.Publish(userId, 90.00m);
        broadcaster.Publish(userId, 95.00m);
        releaseFirstWrite.TrySetResult();

        Assert.True(await WaitUntilAsync(() => written.Count == 3), "a movement was dropped while a write was in flight");
        Assert.Equal(new[] { 100.00m, 90.00m, 95.00m }, written.ToArray());

        await cts.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pump);
    }

    /// <summary>
    /// A movement that commits while the opening balance is being read still reaches the
    /// member.
    ///
    /// <para>
    /// The endpoint read the balance, wrote it, and only then subscribed — so anything
    /// published inside that window, the round trip of a database read, had no subscriber
    /// and was gone. Far narrower than the keep-alive defect, and the same wrong number left
    /// on the screen. Found while proving the keep-alive fix in a real browser: a desk
    /// adjustment fired at the instant the page connected never appeared.
    /// </para>
    /// </summary>
    [Fact]
    public async Task AMovementDuringTheOpeningReadIsNotLost()
    {
        var broadcaster = new BalanceBroadcaster();
        var userId = Guid.NewGuid();
        var sink = new Sink();
        using var cts = new CancellationTokenSource();

        // The desk posts +8 while this read is in flight, and the read returns the balance
        // as it stood before it — the ordering a slow query makes ordinary.
        var channel = await WalletEndpoints.SubscribeThenSendAsync(
            broadcaster, userId,
            async () =>
            {
                await Task.Yield();
                broadcaster.Publish(userId, 108.00m);
                return 100.00m;
            },
            balance => sink.WriteBalance(balance, cts.Token));

        var pump = WalletEndpoints.PumpAsync(
            channel.Reader, KeepAlive, sink.WriteBalance, sink.WriteKeepAlive, cts.Token);

        Assert.True(await WaitUntilAsync(() => sink.Balances.Count == 2),
            "the movement posted during the opening read never reached the stream");
        Assert.Equal(new[] { 100.00m, 108.00m }, sink.Balances.ToArray());

        broadcaster.Unsubscribe(userId, channel);
        await pump.WaitAsync(Deadline);
    }

    /// <summary>
    /// Unsubscribing completes the channel, and the pump then returns rather than spinning
    /// keep-alives at a response nobody is reading.
    /// </summary>
    [Fact]
    public async Task ThePumpEndsWhenTheSubscriptionIsClosed()
    {
        var broadcaster = new BalanceBroadcaster();
        var userId = Guid.NewGuid();
        var channel = broadcaster.Subscribe(userId);
        var sink = new Sink();
        using var cts = new CancellationTokenSource();

        var pump = WalletEndpoints.PumpAsync(
            channel.Reader, KeepAlive, sink.WriteBalance, sink.WriteKeepAlive, cts.Token);

        broadcaster.Unsubscribe(userId, channel);

        await pump.WaitAsync(Deadline);
        Assert.True(pump.IsCompletedSuccessfully);
    }
}
