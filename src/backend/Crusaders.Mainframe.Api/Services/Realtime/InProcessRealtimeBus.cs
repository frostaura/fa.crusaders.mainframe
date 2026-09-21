using System.Collections.Concurrent;
using System.Threading.Channels;

namespace Crusaders.Mainframe.Api.Services.Realtime;

/// <summary>
/// The in-process fan-out. Correct for this deployment and wrong the moment a second API
/// container runs — see the remarks.
///
/// <para>
/// <b>An empty topic is removed, and that is why this is not a copy of
/// <c>BalanceBroadcaster</c>.</b> That type's <c>GetOrAdd</c>-then-<c>lock</c> pattern is only
/// safe BECAUSE entries are never removed: a subscriber that took a list reference just before
/// a remover deleted the key would add itself to a list nobody publishes to, and never hear
/// anything again. Removing the key naively converts a slow leak into a silent deafness, which
/// is worse. This implementation makes the removal safe by RETIRING the bucket under its own
/// lock and having <see cref="Subscribe"/> retry when it finds a retired one — so a subscriber
/// either joins a live bucket or loops, and can never attach to an orphan.
/// </para>
///
/// <para>
/// <b>Multi-instance.</b> The production compose file runs one <c>backend</c> service with no
/// <c>deploy:</c>, <c>replicas:</c> or <c>scale:</c>, so this is correct today; a second
/// container would break it SILENTLY — an admin pinned to instance A sees nothing when a fault
/// is recorded on instance B. The seam for a Postgres <c>LISTEN</c>/<c>NOTIFY</c> backplane is
/// the <see cref="IRealtimeBus"/> interface itself, and the posture test in
/// <c>DeploymentPostureTests</c> fails the build if a compose file grows replicas. It must be
/// said plainly rather than implied: <b>the rest of this system is not multi-instance-ready
/// either</b> — the webhook retry worker claims no rows, the no-show sweep's postings have no
/// ledger idempotency, and the lights-cue worker runs one global un-tenanted sweep. A second
/// replica is a separate piece of work, and this seam does not make it a config change.
/// </para>
/// </summary>
public sealed class InProcessRealtimeBus : IRealtimeBus
{
    /// <summary>
    /// How many frames a slow subscriber may fall behind before the oldest is dropped.
    ///
    /// <para>
    /// Deeper than the wallet's eight because a control board carries a court delta per event
    /// on a league night, and shallower than anything that would let a wedged socket hold a
    /// megabyte of snapshots. Dropping the OLDEST is right for both streams: a stale court
    /// tile and a stale fault count are both superseded by the next frame, and the periodic
    /// full snapshot is what makes a dropped delta self-heal.
    /// </para>
    /// </summary>
    public const int Capacity = 32;

    private sealed class Bucket
    {
        public readonly List<Channel<RealtimeMessage>> Channels = [];
        public bool Retired;
    }

    private readonly ConcurrentDictionary<RealtimeTopic, Bucket> _topics = new();

    public Channel<RealtimeMessage> Subscribe(RealtimeTopic topic)
    {
        var channel = Channel.CreateBounded<RealtimeMessage>(new BoundedChannelOptions(Capacity)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });

        while (true)
        {
            var bucket = _topics.GetOrAdd(topic, _ => new Bucket());
            lock (bucket)
            {
                // Retired under somebody else's Unsubscribe between the GetOrAdd and this
                // lock. The key is already gone or about to be; loop and take a fresh one.
                if (bucket.Retired) continue;
                bucket.Channels.Add(channel);
                return channel;
            }
        }
    }

    public void Unsubscribe(RealtimeTopic topic, Channel<RealtimeMessage> channel)
    {
        if (_topics.TryGetValue(topic, out var bucket))
        {
            lock (bucket)
            {
                bucket.Channels.Remove(channel);
                if (bucket.Channels.Count == 0 && !bucket.Retired)
                {
                    bucket.Retired = true;
                    _topics.TryRemove(topic, out _);
                }
            }
        }

        // Completing the writer is what ends the reader's pump; done outside the lock and
        // unconditionally, so a channel handed back twice, or one whose topic has already
        // gone, still terminates its stream rather than spinning keep-alives at a response
        // nobody is reading.
        channel.Writer.TryComplete();
    }

    public void Publish(RealtimeTopic topic, RealtimeMessage message)
    {
        if (!_topics.TryGetValue(topic, out var bucket)) return;

        Channel<RealtimeMessage>[] snapshot;
        lock (bucket) { snapshot = [.. bucket.Channels]; }

        // TryWrite, never WriteAsync: the publisher is a request thread that has just
        // committed, and a wall screen that stopped reading must not be able to hold up a
        // court activation. A bounded drop-oldest channel makes the failure "the screen misses
        // a delta", which the periodic snapshot then corrects.
        foreach (var ch in snapshot) ch.Writer.TryWrite(message);
    }

    public int SubscriberCount(RealtimeTopic topic)
    {
        if (!_topics.TryGetValue(topic, out var bucket)) return 0;
        lock (bucket) { return bucket.Channels.Count; }
    }

    /// <summary>
    /// D2-B44's observable. <see cref="SubscriberCount"/> answers zero both for a topic whose
    /// bucket is empty and for one that was never here, so it cannot tell a released
    /// subscription from a leaked dictionary entry — which is the bug itself. This can.
    /// </summary>
    public int TopicCount => _topics.Count;
}
