using System.Collections.Concurrent;
using System.Threading.Channels;

namespace Crusaders.Mainframe.Api.Services.Realtime;

/// <summary>
/// The fan-out behind every Server-Sent Events stream in this API.
///
/// <para>
/// One abstraction for three channels, replacing <c>BalanceBroadcaster</c>, which knew only
/// about balances and keyed on a bare user id (D2-B22).
/// </para>
/// </summary>
public interface IRealtimeBus
{
    /// <summary>Takes a subscription. The caller must <see cref="Unsubscribe"/> it, in a finally.</summary>
    Channel<RealtimeMessage> Subscribe(RealtimeTopic topic);

    /// <summary>Releases a subscription and completes its channel, which ends the subscriber's pump.</summary>
    void Unsubscribe(RealtimeTopic topic, Channel<RealtimeMessage> channel);

    /// <summary>Writes one frame to every live subscriber of a topic. Never throws for want of one.</summary>
    void Publish(RealtimeTopic topic, RealtimeMessage message);

    /// <summary>How many subscribers a topic currently has. For tests and for the posture check.</summary>
    int SubscriberCount(RealtimeTopic topic);

    /// <summary>
    /// How many topics the bus is holding at all.
    ///
    /// <para>
    /// Exposed deliberately, and only for the test that pins D2-B44: <c>SubscriberCount</c>
    /// answers zero for a topic whose list is empty AND for one that was never there, so it
    /// cannot tell a released subscription from a leaked dictionary entry — which is precisely
    /// the bug. In a singleton holding one entry per member who ever opened the app, the
    /// difference is the process's memory.
    /// </para>
    /// </summary>
    int TopicCount { get; }
}

/// <summary>
/// The in-process implementation — correct for the single API container
/// <c>docker-compose.prod.yml</c> actually runs, and the reason the seam above exists rather
/// than the implementation being assumed.
///
/// <para>
/// <b>It breaks SILENTLY the moment a second container runs</b>: a member pinned to instance A
/// sees nothing when their top-up is posted on instance B. That is not a config change away
/// from being fixed. <c>WebhookRetryWorker</c> has no row claim, <c>NoShowWorker</c>'s postings
/// have no ledger idempotency, and <c>LightsCueWorker</c> runs one global un-tenanted sweep —
/// so a second replica is a separate piece of work, and <c>DeploymentPostureTests</c> is what
/// stops a compose file quietly declaring one.
/// </para>
///
/// <para>
/// <b>The dictionary entry is removed when the last subscriber leaves</b> (D2-B44:
/// <c>BalanceBroadcaster</c> leaked one entry per user, for ever, in a singleton). That is safe
/// here and was not safe there: the old <c>GetOrAdd</c>-then-<c>lock</c> pattern is only
/// correct while entries are never removed, because a subscriber can otherwise take the lock on
/// a list that has already been dropped from the dictionary. This type holds one lock over both
/// operations instead, which is why D2 said replace the structure rather than patch it.
/// </para>
/// </summary>
public sealed class InProcessRealtimeBus : IRealtimeBus
{
    /// <summary>
    /// Bounded with <c>DropOldest</c>: a slow subscriber loses STALE frames, never newer ones,
    /// and every stream re-reads its own state on connect. Eight is enough for the burst a
    /// cancellation makes — a refund and a penalty are two rows in one breath — without letting
    /// one wedged socket hold a megabyte of court state.
    /// </summary>
    private const int Capacity = 8;

    private readonly ConcurrentDictionary<RealtimeTopic, List<Channel<RealtimeMessage>>> _subs = new();
    private readonly object _gate = new();

    public Channel<RealtimeMessage> Subscribe(RealtimeTopic topic)
    {
        var channel = Channel.CreateBounded<RealtimeMessage>(new BoundedChannelOptions(Capacity)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });

        lock (_gate)
        {
            if (!_subs.TryGetValue(topic, out var list))
            {
                list = [];
                _subs[topic] = list;
            }
            list.Add(channel);
        }

        return channel;
    }

    public void Unsubscribe(RealtimeTopic topic, Channel<RealtimeMessage> channel)
    {
        lock (_gate)
        {
            if (_subs.TryGetValue(topic, out var list))
            {
                list.Remove(channel);
                // D2-B44. The key goes too, or a club with ten thousand members accumulates ten
                // thousand empty lists in a singleton that lives as long as the process.
                if (list.Count == 0) _subs.TryRemove(topic, out _);
            }
        }

        channel.Writer.TryComplete();
    }

    public void Publish(RealtimeTopic topic, RealtimeMessage message)
    {
        List<Channel<RealtimeMessage>> snapshot;
        lock (_gate)
        {
            if (!_subs.TryGetValue(topic, out var list) || list.Count == 0) return;
            snapshot = [.. list];
        }

        // Outside the lock: a write to a bounded DropOldest channel cannot block, but holding a
        // process-wide lock across a fan-out is how one wedged subscriber stops the club.
        foreach (var channel in snapshot) channel.Writer.TryWrite(message);
    }

    public int SubscriberCount(RealtimeTopic topic)
    {
        lock (_gate)
        {
            return _subs.TryGetValue(topic, out var list) ? list.Count : 0;
        }
    }

    public int TopicCount
    {
        get { lock (_gate) { return _subs.Count; } }
    }
}
