namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// What each token this application issues is allowed to be used for.
/// </summary>
/// <remarks>
/// <para>
/// Every token is signed with the same key, for the same issuer and audience, so the
/// <c>purpose</c> claim is the only thing separating a fifteen-minute session credential from
/// the one-minute token a member's phone displays at the court. Without the separation the QR
/// on the screen is a valid Authorization header for the whole API as that member.
/// </para>
/// </remarks>
public static class TokenPurposes
{
    /// <summary>A full session credential. Valid everywhere.</summary>
    public const string Access = "access";

    /// <summary>
    /// A ticket for the wallet SSE stream, and for nothing else.
    ///
    /// <para>
    /// <c>EventSource</c> cannot set request headers, so the credential has to travel in the URL
    /// — where nginx's access log records it verbatim, on every reconnect, for as long as the
    /// log is kept. Putting the full access token there meant a log file held working sessions.
    /// This one is minted by a POST, lives about a minute, and opens one read-only stream.
    /// </para>
    /// </summary>
    public const string WalletStream = "wallet_stream";

    /// <summary>How long a stream ticket is good for — long enough to open one EventSource.</summary>
    public static readonly TimeSpan WalletStreamTicketTtl = TimeSpan.FromMinutes(1);

    /// <summary>The one path a wallet-stream ticket authenticates.</summary>
    public const string WalletStreamPath = "/api/v1/wallet/stream";

    /// <summary>
    /// A ticket for the admin control-board stream, and for nothing else.
    ///
    /// <para>
    /// <b>Its own purpose rather than a shared "sse" one, and that is the whole reason there
    /// are three.</b> One multiplexed stream with a <c>?channels=</c> parameter would put a
    /// single authorisation decision in front of two different audiences — a member's wallet
    /// and a club's whole estate — which is the shape that produces cross-audience leaks. A
    /// control-board ticket must not open a wallet stream, and a wallet ticket must not open a
    /// control board; separate purposes accepted on separate paths is what makes that a
    /// property of the token rather than a rule somebody has to remember.
    /// </para>
    /// </summary>
    public const string ControlBoardStream = "control_board_stream";

    /// <summary>The one path a control-board ticket authenticates.</summary>
    public const string ControlBoardStreamPath = "/api/v1/admin/control-board/stream";

    /// <summary>A ticket for the admin IoT monitoring stream, and for nothing else. See <see cref="ControlBoardStream"/>.</summary>
    public const string MonitoringStream = "monitoring_stream";

    /// <summary>The one path a monitoring ticket authenticates.</summary>
    public const string MonitoringStreamPath = "/api/v1/admin/monitoring/stream";

    /// <summary>
    /// Is this token's purpose acceptable on this path?
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>StartsWithSegments</c> matches on segment boundaries, so <c>/api/v1/wallet/stream-ticket</c>
    /// is deliberately NOT covered — a stream ticket cannot be used to mint another one. The
    /// same holds for the two admin paths, whose ticket-minting routes are
    /// <c>…/control-board/stream-ticket</c> and <c>…/monitoring/stream-ticket</c>.
    /// </para>
    /// <para>
    /// Each purpose is matched against its OWN path and no other. A single "is this any stream
    /// ticket on any stream path" test would let a control-board ticket open a wallet, which is
    /// precisely the separation these purposes exist to make.
    /// </para>
    /// </remarks>
    public static bool IsValidFor(string? purpose, PathString path)
        => string.Equals(purpose, Access, StringComparison.Ordinal)
        || (string.Equals(purpose, WalletStream, StringComparison.Ordinal)
            && path.StartsWithSegments(WalletStreamPath))
        || (string.Equals(purpose, ControlBoardStream, StringComparison.Ordinal)
            && path.StartsWithSegments(ControlBoardStreamPath))
        || (string.Equals(purpose, MonitoringStream, StringComparison.Ordinal)
            && path.StartsWithSegments(MonitoringStreamPath));

    /// <summary>
    /// Every path on which a ticket may ride in the query string, so the JWT middleware's
    /// <c>OnMessageReceived</c> tests one list rather than three conditions that drift.
    /// </summary>
    public static readonly string[] TicketPaths =
    [
        WalletStreamPath, ControlBoardStreamPath, MonitoringStreamPath,
    ];

    /// <summary>
    /// The <c>HttpContext.Items</c> key the bearer handler sets when the token came from
    /// <c>?ticket=</c> rather than the Authorization header: such a token must be a stream
    /// ticket, never an <see cref="Access"/> token (BP-18).
    /// </summary>
    public const string FromQueryItem = "auth.token_from_query";

    /// <summary>Whether a ticket in <c>?ticket=</c> should be read on this path at all.</summary>
    public static bool AcceptsTicketInQuery(PathString path)
        => TicketPaths.Any(p => path.StartsWithSegments(p));
}
