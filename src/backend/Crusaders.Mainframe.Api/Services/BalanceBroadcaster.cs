using System.Collections.Concurrent;
using System.Threading.Channels;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Per-user balance fan-out used by the wallet SSE endpoint. Each Subscribe call returns a
/// fresh bounded channel; Publish writes the new balance to every subscriber for that user.
/// Singleton-scoped so the channels survive across requests.
/// </summary>
public sealed class BalanceBroadcaster
{
    private readonly ConcurrentDictionary<Guid, List<Channel<decimal>>> _subs = new();

    public Channel<decimal> Subscribe(Guid userId)
    {
        // Bounded with DropOldest — if a subscriber is slow we drop stale balance values, not
        // newer ones. Subscribers always re-read the latest balance on connect anyway.
        var ch = Channel.CreateBounded<decimal>(new BoundedChannelOptions(8)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });
        var list = _subs.GetOrAdd(userId, _ => new List<Channel<decimal>>());
        lock (list) { list.Add(ch); }
        return ch;
    }

    public void Unsubscribe(Guid userId, Channel<decimal> channel)
    {
        if (_subs.TryGetValue(userId, out var list))
        {
            lock (list) { list.Remove(channel); }
        }
        channel.Writer.TryComplete();
    }

    public void Publish(Guid userId, decimal balanceZar)
    {
        if (!_subs.TryGetValue(userId, out var list)) return;
        List<Channel<decimal>> snapshot;
        lock (list) { snapshot = new List<Channel<decimal>>(list); }
        foreach (var ch in snapshot) ch.Writer.TryWrite(balanceZar);
    }
}
