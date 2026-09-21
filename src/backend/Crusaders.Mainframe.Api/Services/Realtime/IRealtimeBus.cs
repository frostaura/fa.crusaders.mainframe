using System.Threading.Channels;

namespace Crusaders.Mainframe.Api.Services.Realtime;

/// <summary>
/// Server→client fan-out for the two admin streams this lane adds.
///
/// <para>
/// <b>Why SSE and not WebSockets.</b> The decision is the deployment's, not a preference: the
/// wallet stream already ships <c>text/event-stream</c> with <c>X-Accel-Buffering: no</c> through
/// this exact nginx and this exact Cloudflare tunnel, with a solved header-less auth story
/// (a one-minute purpose-scoped ticket, minted by POST so it never reaches an access log).
/// nginx's WebSocket <c>Upgrade</c> block was <b>deliberately deleted</b>, with the reasoning
/// recorded in the file. Every channel here is one-directional, so bidirectionality — the only
/// thing a WebSocket adds — buys nothing.
/// </para>
///
/// <para>
/// <b>The wallet stream is deliberately NOT moved onto this bus.</b> It keeps its own
/// <c>BalanceBroadcaster</c> and its own pump, untouched: the money lane owns the wallet frame's
/// shape and its publish-after-commit ordering, and two lanes rewriting one broadcaster in
/// parallel is how a merge loses a fix. <see cref="RealtimeScope.Wallet"/> exists on the topic
/// enum so that migration is a move rather than a redesign when one lane owns both.
/// </para>
/// </summary>
public interface IRealtimeBus
{
    /// <summary>
    /// Takes a subscription on <paramref name="topic"/>. The caller MUST pass the returned
    /// channel back to <see cref="Unsubscribe"/> — including on an exception — or the topic
    /// keeps a writer nobody reads.
    /// </summary>
    Channel<RealtimeMessage> Subscribe(RealtimeTopic topic);

    /// <summary>Drops a subscription and completes its channel, which is what ends the reader's pump.</summary>
    void Unsubscribe(RealtimeTopic topic, Channel<RealtimeMessage> channel);

    /// <summary>
    /// Fans <paramref name="message"/> out to every current subscriber of
    /// <paramref name="topic"/>. Never blocks and never throws: a publish that can fail a
    /// request would make a wall screen able to break a court activation.
    /// </summary>
    void Publish(RealtimeTopic topic, RealtimeMessage message);

    /// <summary>How many subscribers a topic currently has. For tests and for the posture check on leaks.</summary>
    int SubscriberCount(RealtimeTopic topic);
}
