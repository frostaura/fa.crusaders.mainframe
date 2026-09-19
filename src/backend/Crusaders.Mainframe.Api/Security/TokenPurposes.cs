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
    /// Is this token's purpose acceptable on this path?
    /// </summary>
    /// <remarks>
    /// <c>StartsWithSegments</c> matches on segment boundaries, so <c>/api/v1/wallet/stream-ticket</c>
    /// is deliberately NOT covered — a stream ticket cannot be used to mint another one.
    /// </remarks>
    public static bool IsValidFor(string? purpose, PathString path)
        => string.Equals(purpose, Access, StringComparison.Ordinal)
        || (string.Equals(purpose, WalletStream, StringComparison.Ordinal)
            && path.StartsWithSegments(WalletStreamPath));
}
