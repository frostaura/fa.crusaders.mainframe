using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
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

        g.MapPost("/", async (CreateWebhookRequest req, HttpContext ctx, MainframeDbContext db, ITenantContext tenant, CancellationToken ct) =>
        {
            var userId = ctx.User.Id() ?? Guid.Empty;
            var validation = ValidateUrl(req.UrlTemplate, allowLan: true);
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

        admin.MapPost("/", async (CreateWebhookRequest req, MainframeDbContext db, ITenantContext tenant, CancellationToken ct) =>
        {
            var validation = ValidateUrl(req.UrlTemplate, allowLan: true);
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
                .Select(d => new { d.Id, d.EventType, d.Url, d.ResponseStatus, d.LatencyMs, d.Attempt, d.FinalState, d.CreatedAt, d.ResponseBodyExcerpt })
                .ToListAsync(ct);
            return Results.Ok(rows);
        });

        return app;
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

    private static string? ValidateUrl(string? url, bool allowLan)
    {
        if (string.IsNullOrWhiteSpace(url)) return "url_required";
        if (!Uri.TryCreate(url.Replace("{", "%7B").Replace("}", "%7D"), UriKind.Absolute, out var u)) return "url_invalid";
        if (u.Scheme != "http" && u.Scheme != "https") return "scheme_must_be_http_or_https";
        if (!allowLan && (u.Scheme == "http" && !u.Host.StartsWith("localhost"))) return "https_required";
        return null;
    }
}

public sealed record CreateWebhookRequest(string UrlTemplate, string? EventFilter, string? Description);
