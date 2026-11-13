namespace Crusaders.Mainframe.Api.Domain;

public enum WebhookOwnerKind
{
    Tenant = 0,   // tenant-wide; receives all events for the tenant
    User = 1,     // retired (BP-08): no route creates one and nothing delivers to one; kept so the value keeps its meaning
}

public sealed class WebhookEndpoint : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }

    public WebhookOwnerKind OwnerKind { get; set; } = WebhookOwnerKind.Tenant;
    public Guid? OwnerUserId { get; set; }

    public required string UrlTemplate { get; set; }
    public string EventFilter { get; set; } = "*"; // comma-sep or "*"
    public required string Secret { get; set; }
    public bool Enabled { get; set; } = true;
    public string? Description { get; set; }

    public int FailureCount { get; set; }
    public DateTimeOffset? LastSuccessAt { get; set; }
    public DateTimeOffset? LastFailureAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class WebhookDelivery : ITenantScoped
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid EndpointId { get; set; }

    public required string EventId { get; set; }
    public required string EventType { get; set; }
    public required string Url { get; set; }              // resolved URL after templating
    public required string RequestBody { get; set; }      // JSON
    public int? ResponseStatus { get; set; }
    public string? ResponseBodyExcerpt { get; set; }      // capped at ~512 chars
    public int LatencyMs { get; set; }
    public int Attempt { get; set; }
    public DateTimeOffset? NextRetryAt { get; set; }
    public string FinalState { get; set; } = "pending";   // pending | delivered | failed | abandoned

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
