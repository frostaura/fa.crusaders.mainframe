using Crusaders.Mainframe.Api.Email;
using Crusaders.Mainframe.Api.Multitenancy;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// Which club this address serves, in the form the app's own chrome needs it (go-live FM-8).
/// </summary>
/// <remarks>
/// <para>
/// <b>Why it exists.</b> The member app named "Crusaders Squash" in its crest, its sign-in band,
/// its pass and every tab title, in a product that is multi-tenant by construction: a second
/// club's members would have signed in to Crusaders. <c>whoami</c> cannot carry the name for a
/// visitor who is not signed in, because it is tenant-exempt and resolves no club at all. This is
/// the anonymous read that does.
/// </para>
/// <para>
/// <b>Under <c>/api/v1/auth/</c> on purpose.</b> That prefix is anonymous AND tenant-scoped in
/// <see cref="TenantResolutionMiddleware"/> (JWT, then the host's subdomain, then the configured
/// default), and a must-change-password session may still reach it, which the sign-in screen
/// needs. A token naming one club on another club's host is the middleware's 403, as everywhere.
/// </para>
/// <para>
/// <b>Only what the sign-in screen already shows a stranger:</b> the slug and the club's own
/// <see cref="Domain.Tenant.DisplayName"/> through <see cref="ClubIdentityResolver"/> — the one
/// source the club's emails use, so a mail and a screen cannot name the club differently.
/// Nothing from the club's settings, no contact detail, no member data.
/// </para>
/// </remarks>
public static class ClubEndpoints
{
    public const string Route = "/api/v1/auth/club";

    public static IEndpointRouteBuilder MapClubEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet(Route, async (ITenantContext tenant, ClubIdentityResolver clubs, CancellationToken ct) =>
        {
            var club = await clubs.GetAsync(ct);
            return Results.Ok(new { slug = tenant.TenantSlug, name = club.Name });
        }).AllowAnonymous();
        return app;
    }
}
