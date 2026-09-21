using System.Threading.Channels;

namespace Crusaders.Mainframe.Api.Services.Realtime;

/// <summary>
/// The shared mechanics of a Server-Sent Events response: the headers that survive this
/// deployment's proxies, the named keep-alive, the subscribe-then-send ordering that opens a
/// stream, and the pump loop.
///
/// <para>
/// Lifted out of <c>WalletEndpoints</c> <b>unchanged in behaviour</b> so three streams can share
/// it. <b>The pump is not re-derived, and that is the point of this type existing.</b> The
/// wallet stream's loop carried two real, browser-reproduced defects, and both are properties of
/// the SHAPE rather than of balances:
/// </para>
/// <list type="number">
///   <item>racing a fresh <c>ReadAsync</c> against a timer and abandoning the loser leaves a
///   queued reader on the channel, so the next published frame is handed to a task nobody
///   awaits and is gone — the twenty-five-second cliff after which a member's balance froze;
///   and</item>
///   <item><c>PeriodicTimer</c> permits exactly one outstanding waiter, so the turn after a
///   frame <i>was</i> delivered threw <c>InvalidOperationException</c> out of the handler with
///   the response already started — an unhandled 500 and a torn stream.</item>
/// </list>
/// <para>
/// Between them, a session was deaf from its first keep-alive onward. Writing that loop a second
/// and third time for two new streams is how one of them acquires the bug back. Nothing here is
/// abandoned: <c>WaitToReadAsync</c> observes availability without consuming, the only
/// consumption is the <c>TryRead</c> on the line that writes, and the quiet period ends by a
/// linked <c>CancellationTokenSource</c> which deregisters its waiter rather than orphaning it.
/// The inner drain matters because the channel is bounded with drop-oldest and several frames
/// can land while one write is in flight.
/// </para>
/// </summary>
public static class SseStream
{
    /// <summary>
    /// Sets the four headers this deployment needs before any body is written.
    ///
    /// <para>
    /// <c>X-Accel-Buffering: no</c> is not optional and is not belt-and-braces: nginx buffers
    /// proxied responses by default, and a buffered SSE stream delivers nothing until the
    /// buffer fills — which for a control board that publishes one small frame a minute is
    /// never. <c>no-transform</c> stops an intermediary compressing the stream, which would
    /// re-introduce buffering from the other end.
    /// </para>
    /// </summary>
    public static void WriteHeaders(HttpContext ctx)
    {
        ctx.Response.Headers["Content-Type"] = "text/event-stream";
        ctx.Response.Headers["Cache-Control"] = "no-cache, no-transform";
        ctx.Response.Headers["Connection"] = "keep-alive";
        ctx.Response.Headers["X-Accel-Buffering"] = "no";
    }

    /// <summary>Writes one named frame and flushes it.</summary>
    public static async Task WriteEventAsync(HttpContext ctx, RealtimeMessage message, CancellationToken ct)
    {
        await ctx.Response.WriteAsync($"event: {message.Event}\ndata: {message.JsonPayload}\n\n", ct);
        await ctx.Response.Body.FlushAsync(ct);
    }

    /// <summary>
    /// The keep-alive, as a NAMED event rather than an SSE comment.
    ///
    /// <para>
    /// A comment line defeats proxy buffering, which is all a keep-alive was ever asked to do
    /// — but <c>EventSource</c> does not surface comments, so from the browser's side a stream
    /// delivering keep-alives and a stream that has silently gone deaf look identical. As a
    /// named event it does both jobs, and the client can arm a silence watchdog on it.
    /// </para>
    /// </summary>
    public static async Task WriteKeepAliveAsync(HttpContext ctx, CancellationToken ct)
    {
        await ctx.Response.WriteAsync("event: ping\ndata: {}\n\n", ct);
        await ctx.Response.Body.FlushAsync(ct);
    }

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
            // The caller never receives the channel, so it could never unsubscribe it.
            bus.Unsubscribe(topic, channel);
            throw;
        }
    }

    /// <summary>
    /// Writes every published frame to one open SSE response, with a keep-alive whenever the
    /// topic has been quiet for <paramref name="keepAlive"/>. See the type's remarks for the two
    /// defects that decide the shape of this loop.
    /// </summary>
    public static async Task PumpAsync(
        ChannelReader<RealtimeMessage> reader,
        TimeSpan keepAlive,
        Func<RealtimeMessage, CancellationToken, Task> write,
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
            while (reader.TryRead(out var message)) await write(message, ct);
        }
    }

    /// <summary>
    /// Runs one whole stream: headers, opening frame, pump, and an unsubscribe that happens on
    /// every exit path including a client disconnect.
    ///
    /// <para>
    /// A single entry point rather than four lines repeated per route, because the line that
    /// gets forgotten when it is repeated is the <c>finally</c> — and a forgotten unsubscribe
    /// is a channel the bus writes to for the lifetime of the process.
    /// </para>
    /// </summary>
    public static async Task RunAsync(
        HttpContext ctx, IRealtimeBus bus, RealtimeTopic topic, TimeSpan keepAlive,
        Func<Task> writeOpening, CancellationToken ct)
    {
        WriteHeaders(ctx);

        Channel<RealtimeMessage>? channel = null;
        try
        {
            channel = await SubscribeThenSendAsync(bus, topic, writeOpening);
            await PumpAsync(
                channel.Reader, keepAlive,
                (message, token) => WriteEventAsync(ctx, message, token),
                token => WriteKeepAliveAsync(ctx, token),
                ct);
        }
        catch (OperationCanceledException) { /* the client closed the tab */ }
        finally
        {
            if (channel is not null) bus.Unsubscribe(topic, channel);
        }
    }
}
