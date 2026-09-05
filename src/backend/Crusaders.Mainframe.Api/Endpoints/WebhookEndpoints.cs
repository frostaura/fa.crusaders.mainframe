using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Security.Outbound;
using Crusaders.Mainframe.Api.Webhooks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

public static class WebhookEndpoints
{
    public static IEndpointRouteBuilder MapWebhookEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/webhooks").RequireAuthorization();

        g.MapGet("/", async (HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var rows = await db.WebhookEndpoints
                .Where(w => w.OwnerKind == WebhookOwnerKind.User && w.OwnerUserId == userId)
                .Select(w => Project(w)).ToListAsync(ct);
            return Results.Ok(rows);
        });

        g.MapPost("/", async (CreateWebhookRequest req, HttpContext ctx, MainframeDbContext db, ITenantContext tenant, IOutboundAddressGuard guard, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;

            // honourAllowList: false — a member does not get the lights-controller carve-out.
            // This is the fast, legible refusal; the boundary is at the socket, in
            // WebhookSender.PostAsync, because a name that resolves publicly today can
            // resolve to the relay controller tomorrow.
            var validation = ValidateUrl(req.UrlTemplate, guard, honourAllowList: false);
            if (validation is not null) return Results.BadRequest(new { error = validation });

            var endpoint = new WebhookEndpoint
            {
                TenantId = tenant.TenantId,
                OwnerKind = WebhookOwnerKind.User,
                OwnerUserId = userId,
                UrlTemplate = req.UrlTemplate,
                EventFilter = req.EventFilter ?? "*",
                Secret = TokenHashing.Generate(),
                Description = req.Description,
            };
            db.WebhookEndpoints.Add(endpoint);
            await db.SaveChangesAsync(ct);
            return Results.Ok(Project(endpoint, includeSecret: true));
        });

        g.MapDelete("/{id:guid}", async (Guid id, HttpContext ctx, MainframeDbContext db, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var w = await db.WebhookEndpoints.FirstOrDefaultAsync(x => x.Id == id && x.OwnerUserId == userId, ct);
            if (w is null) return Results.NotFound();
            db.WebhookEndpoints.Remove(w);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        // Admin: tenant-wide endpoints
        var admin = app.MapGroup("/api/v1/admin/webhooks").RequireAuthorization(p => p.RequireRole("admin"));

        admin.MapGet("/", async (MainframeDbContext db, CancellationToken ct) =>
        {
            var rows = await db.WebhookEndpoints.Select(w => Project(w)).ToListAsync(ct);
            return Results.Ok(rows);
        });

        admin.MapPost("/", async (CreateWebhookRequest req, MainframeDbContext db, ITenantContext tenant, IOutboundAddressGuard guard, CancellationToken ct) =>
        {
            var validation = ValidateUrl(req.UrlTemplate, guard);
            if (validation is not null) return Results.BadRequest(new { error = validation });
            var endpoint = new WebhookEndpoint
            {
                TenantId = tenant.TenantId,
                OwnerKind = WebhookOwnerKind.Tenant,
                UrlTemplate = req.UrlTemplate,
                EventFilter = req.EventFilter ?? "*",
                Secret = TokenHashing.Generate(),
                Description = req.Description,
            };
            db.WebhookEndpoints.Add(endpoint);
            await db.SaveChangesAsync(ct);
            return Results.Ok(Project(endpoint, includeSecret: true));
        });

        admin.MapDelete("/{id:guid}", async (Guid id, MainframeDbContext db, CancellationToken ct) =>
        {
            var w = await db.WebhookEndpoints.FirstOrDefaultAsync(x => x.Id == id, ct);
            if (w is null) return Results.NotFound();
            db.WebhookEndpoints.Remove(w);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        admin.MapGet("/{id:guid}/deliveries", async (Guid id, MainframeDbContext db, CancellationToken ct) =>
        {
            var rows = await db.WebhookDeliveries
                .Where(d => d.EndpointId == id)
                .OrderByDescending(d => d.CreatedAt)
                .Take(100)
                // Named explicitly, in snake_case, like every other admin projection here.
                // Shorthand members (`d.Id`) take the serializer's camelCase policy instead,
                // which is how this one endpoint came to answer `createdAt` while the typed
                // client read `CreatedAt` — every cell on the only screen that shows whether
                // webhooks are being delivered rendered "Invalid Date" and "undefinedms".
                .Select(d => new
                {
                    id = d.Id,
                    event_type = d.EventType,
                    url = d.Url,
                    response_status = d.ResponseStatus,
                    latency_ms = d.LatencyMs,
                    attempt = d.Attempt,
                    final_state = d.FinalState,
                    created_at = d.CreatedAt,
                    response_body_excerpt = d.ResponseBodyExcerpt,
                })
                .ToListAsync(ct);
            return Results.Ok(rows);
        });

        return app;
    }

    /// <summary>Everything up to the third slash: scheme, credentials, host and port.</summary>
    private static string SchemeAndAuthority(string url)
    {
        var afterScheme = url.IndexOf("//", StringComparison.Ordinal);
        if (afterScheme < 0) return url;

        var pathStart = url.IndexOf('/', afterScheme + 2);
        return pathStart < 0 ? url : url[..pathStart];
    }

    private static object Project(WebhookEndpoint w, bool includeSecret = false) => new
    {
        id = w.Id,
        owner_kind = w.OwnerKind.ToString(),
        url_template = w.UrlTemplate,
        event_filter = w.EventFilter,
        enabled = w.Enabled,
        description = w.Description,
        failure_count = w.FailureCount,
        last_success_at = w.LastSuccessAt,
        last_failure_at = w.LastFailureAt,
        secret = includeSecret ? w.Secret : null,
    };

    /// <summary>
    /// A courtesy check, not the security boundary.
    ///
    /// <para>
    /// It rejects the obvious cases at registration so an owner finds out immediately
    /// rather than through a silently failing delivery. It cannot be the boundary,
    /// because the host is resolved at delivery time and a name can point somewhere
    /// else by then. The boundary is in the socket — see
    /// <c>GuardedHttpClient.ConnectCallback</c>.
    /// </para>
    ///
    /// <para>
    /// An earlier signature took an <c>allowLan</c> flag that was hardcoded <c>true</c> at
    /// both call sites and gated nothing but an https requirement, and it was removed on the
    /// grounds that an argument which is always the same value is a comment pretending to be
    /// a control. <paramref name="honourAllowList"/> is not that: it is <c>true</c> for the
    /// admin route and <c>false</c> for the member route, and the difference is the whole
    /// point. The private-network allow-list exists so the club can drive its own lights
    /// controller; a member registering a destination does not inherit that licence.
    /// </para>
    /// </summary>
    internal static string? ValidateUrl(string? url, IOutboundAddressGuard guard, bool honourAllowList = true)
    {
        if (string.IsNullOrWhiteSpace(url)) return "url_required";

        // Checked textually, and BEFORE the parse: a brace percent-escapes to %7B, which
        // is not legal in a host, so parsing first would report every templated host as
        // a generic "url_invalid" and hide the actual rule.
        //
        // The rule is a security one, not a parsing limitation. Variables are
        // substituted from event payload fields, which carry member-supplied values —
        // a host assembled from those is a destination the endpoint owner never chose
        // and nobody reviewed. Variables in the path and query stay allowed; they
        // cannot change where the request goes.
        if (SchemeAndAuthority(url).Contains('{')) return "template_variable_not_allowed_in_host";

        // The remaining braces are not legal in a URI either, so they are percent-escaped
        // for the parse only. The stored template keeps them.
        if (!Uri.TryCreate(url.Replace("{", "%7B").Replace("}", "%7D"), UriKind.Absolute, out var u)) return "url_invalid";
        if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps) return "scheme_must_be_http_or_https";

        return guard.CheckHostLiteral(u.Host, honourAllowList);
    }
}

public sealed record CreateWebhookRequest(string UrlTemplate, string? EventFilter, string? Description);
