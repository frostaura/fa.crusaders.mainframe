using System.Threading.Channels;

namespace Crusaders.Mainframe.Api.Services.Realtime;

/// <summary>
/// The fan-out behind every Server-Sent Events stream in this API — the member's wallet, the
/// admin control board, and the IoT monitoring feed.
///
/// <para>
/// One abstraction for three channels, replacing <c>BalanceBroadcaster</c>, which knew only
/// about balances and keyed on a bare user id (D2-B22).
/// </para>
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
/// </summary>
public interface IRealtimeBus
{
    /// <summary>
    /// Takes a subscription on <paramref name="topic"/>. The caller MUST pass the returned
    /// channel back to <see cref="Unsubscribe"/> — including on an exception, so in a
    /// <c>finally</c> — or the topic keeps a writer nobody reads.
    /// </summary>
    Channel<RealtimeMessage> Subscribe(RealtimeTopic topic);

    /// <summary>Releases a subscription and completes its channel, which ends the subscriber's pump.</summary>
    void Unsubscribe(RealtimeTopic topic, Channel<RealtimeMessage> channel);

    /// <summary>
    /// Writes one frame to every live subscriber of a topic. Never blocks and never throws for
    /// want of one: a publish that can fail a request would make a wall screen able to break a
    /// court activation.
    /// </summary>
    void Publish(RealtimeTopic topic, RealtimeMessage message);

    /// <summary>How many subscribers a topic currently has. For tests and for the posture check on leaks.</summary>
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
