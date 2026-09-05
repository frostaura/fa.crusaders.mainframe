namespace Crusaders.Mainframe.Api.Security;

/// <summary>
/// The response headers that decide what another origin may do with this one.
/// </summary>
/// <remarks>
/// <para>
/// Nothing in this product sent any of them. A headed pass over the production build behind the
/// real gateway config found the whole signed-in app rendering inside
/// <c>&lt;iframe src="http://…/schedule"&gt;</c> served from a different origin — header, live
/// booking grid and the member's balance chip — with no <c>X-Frame-Options</c>, no CSP
/// <c>frame-ancestors</c>, no <c>nosniff</c> and no <c>Referrer-Policy</c> on any hop, gateway or
/// Kestrel. That is clickjacking with money on the other side of it: a transparent decoy over
/// that frame gets a member to press <i>Book for 50.00 cr</i> or <i>Confirm cancellation</i>, and
/// an admin to press <i>Adjust credit</i>, <i>Suspend member</i> or <i>Regenerate key</i> — every
/// one of them a single click.
/// </para>
/// <para>
/// The headers live in three places on purpose, because the app is served from three and any one
/// of them can be the only hop in a given deployment: this middleware for everything Kestrel
/// answers, <c>src/frontend/nginx.conf</c> for the SPA image that serves the document, and
/// <c>nginx/nginx.conf</c> for the gateway that fronts both. The gateway hides the upstream copy
/// before adding its own so exactly one of each reaches the client.
/// </para>
/// <para>
/// <c>Cache-Control: no-store</c> and <c>Vary: Authorization</c> are here for a second reason
/// beyond the shared-computer one. The service worker's <c>mayCache()</c>
/// (<c>src/frontend/public/sw.js</c>) refuses to store a response carrying either — a deliberate
/// second line of defence behind its <c>/api/</c> path check — and the API supplied neither, so
/// that defence was resting on the path check alone.
/// </para>
/// </remarks>
public static class SecurityHeaders
{
    /// <summary>The pre-CSP framing refusal, still honoured by every browser that ships today.</summary>
    public const string FrameOptions = "DENY";

    /// <summary>Never guess a content type; a JSON body must not become script because a path ends in .js.</summary>
    public const string ContentTypeOptions = "nosniff";

    /// <summary>
    /// Deliberately narrow. <c>frame-ancestors</c> is the modern half of <see cref="FrameOptions"/>;
    /// <c>base-uri</c> stops an injected <c>&lt;base&gt;</c> re-pointing every relative URL on the
    /// page, and <c>object-src</c> closes the plugin surface. There is intentionally no
    /// <c>script-src</c> or <c>form-action</c>: a top-up hands the member to PayFast by form post
    /// to another origin, and a policy that breaks the payment path would be reverted wholesale —
    /// taking the framing defence with it.
    /// </summary>
    public const string ContentSecurityPolicy = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

    /// <summary>
    /// No referrer at all, not <c>strict-origin-when-cross-origin</c>: URLs here carry booking and
    /// member identifiers, and the club's own host name is worth nothing to a third party.
    /// </summary>
    public const string ReferrerPolicy = "no-referrer";

    /// <summary>The header names this middleware owns, so a gateway can hide exactly these.</summary>
    public static IReadOnlyList<string> Names { get; } =
    [
        "X-Frame-Options",
        "X-Content-Type-Options",
        "Content-Security-Policy",
        "Referrer-Policy",
    ];

    /// <summary>
    /// Sets the headers on every response, and marks authenticated API responses unstorable.
    /// </summary>
    /// <remarks>
    /// Registered first in the pipeline so a static file, a 404 and an unhandled 500 all carry
    /// them; a defence that only covers the routes that matched is not a defence.
    /// </remarks>
    public static IApplicationBuilder UseSecurityHeaders(this IApplicationBuilder app)
    {
        return app.Use(async (context, next) =>
        {
            var headers = context.Response.Headers;
            headers["X-Frame-Options"] = FrameOptions;
            headers["X-Content-Type-Options"] = ContentTypeOptions;
            headers["Content-Security-Policy"] = ContentSecurityPolicy;
            headers["Referrer-Policy"] = ReferrerPolicy;

            // Only /api/. The uploaded member photos under /uploads/ are content-addressed static
            // files that a phone should be allowed to keep; the JSON that carries a balance is not.
            //
            // Set before the endpoint runs rather than after, so a handler that needs something
            // else still wins: the wallet stream replaces this with "no-cache, no-transform",
            // which is what keeps a proxy from buffering an SSE body. Vary is appended, not
            // assigned, because the CORS middleware downstream adds "Origin" to the same header.
            if (context.Request.Path.StartsWithSegments("/api"))
            {
                headers.CacheControl = "no-store";
                headers.Append("Vary", "Authorization");
            }

            await next();
        });
    }
}
