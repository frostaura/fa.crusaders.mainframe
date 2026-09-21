using System.Threading.Channels;

namespace Crusaders.Mainframe.Api.Services.Realtime;

/// <summary>
/// The loop behind every Server-Sent Events response in this API, and the subscribe-then-send
/// ordering that opens one.
///
/// <para>
/// Lifted out of <c>WalletEndpoints</c> <b>unchanged in behaviour</b> so two more streams can
/// use it. That is the whole reason it is a shared type: the doc comments below record two real
/// defects that took three independent browser finders to pin down, and re-deriving this loop
/// for a control board and a fault feed would re-derive both.
/// </para>
/// </summary>
public static class SseStream
{
    /// <summary>
    /// Takes the subscription, <b>then</b> sends whatever the stream opens on.
    ///
    /// <para>
    /// The order is the whole point, and it used to be the other way round: the state was read,
    /// written, and only then was the subscription taken. Anything that committed inside that
    /// window — the round trip of a database read — had no subscriber to publish to and was
    /// simply gone, and the member's chip then sat on a figure that was already out of date for
    /// as long as nothing else moved. Subscribing first cannot lose it: the movement is queued,
    /// and the read afterwards already reflects it, so the worst case is the same figure
    /// written twice.
    /// </para>
    /// </summary>
    public static async Task<Channel<RealtimeMessage>> SubscribeThenSendAsync(
        IRealtimeBus bus,
        RealtimeTopic topic,
        Func<Task> writeOpeningState)
    {
        var channel = bus.Subscribe(topic);
        try
        {
            await writeOpeningState();
            return channel;
        }
        catch
        {
            // The caller never gets the channel, so it could never unsubscribe it.
            bus.Unsubscribe(topic, channel);
            throw;
        }
    }

    /// <summary>
    /// Writes every published frame to one open SSE response, with a keep-alive whenever the
    /// topic has been quiet for <paramref name="keepAlive"/>.
    ///
    /// <para>
    /// This loop used to race a fresh <c>ReadAsync</c> against a fresh
    /// <c>PeriodicTimer.WaitForNextTickAsync</c> on every turn and abandon the loser, which
    /// broke the live balance twice over. An abandoned <c>ReadAsync</c> stays queued on the
    /// channel as a reader, so the next published frame was handed to a task nobody was
    /// awaiting and vanished — the member watched a stale figure until they reloaded. And
    /// <c>PeriodicTimer</c> permits exactly one outstanding waiter, so the turn after a frame
    /// <i>was</i> delivered threw <c>InvalidOperationException</c> out of the handler, after the
    /// response had started: an unhandled 500 in the log and a torn stream. Between them, a
    /// session was deaf from its first keep-alive onward.
    /// </para>
    ///
    /// <para>
    /// Nothing is abandoned here. <c>WaitToReadAsync</c> observes availability without consuming
    /// anything, so the only way an item leaves the channel is the <c>TryRead</c> on the line
    /// that writes it; and the wait is ended by a linked <c>CancellationTokenSource</c>, which
    /// deregisters the waiter rather than orphaning it. The inner drain matters because the
    /// channel is bounded with <c>DropOldest</c> — several frames can land while one write is in
    /// flight.
    /// </para>
    /// </summary>
    public static async Task PumpAsync<T>(
        ChannelReader<T> reader,
        TimeSpan keepAlive,
        Func<T, CancellationToken, Task> write,
        Func<CancellationToken, Task> writeKeepAlive,
        CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            bool more;
            using (var quiet = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                quiet.CancelAfter(keepAlive);
                try
                {
                    more = await reader.WaitToReadAsync(quiet.Token);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    await writeKeepAlive(ct);
                    continue;
                }
            }

            // The bus completed the channel — the subscription is over.
            if (!more) return;
            while (reader.TryRead(out var item)) await write(item, ct);
        }
    }
}
