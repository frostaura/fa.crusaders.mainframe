using System.Text.Json;
using System.Threading.Channels;

namespace Crusaders.Mainframe.Api.Webhooks;

public interface IEventBus
{
    ValueTask EmitAsync(DomainEvent evt, CancellationToken ct = default);
    ChannelReader<DomainEvent> Reader { get; }
}

public sealed class InMemoryEventBus : IEventBus
{
    private readonly Channel<DomainEvent> _channel = Channel.CreateUnbounded<DomainEvent>(new UnboundedChannelOptions
    {
        SingleReader = true,
        SingleWriter = false,
    });
    public ChannelReader<DomainEvent> Reader => _channel.Reader;
    public ValueTask EmitAsync(DomainEvent evt, CancellationToken ct = default) => _channel.Writer.WriteAsync(evt, ct);
}

public sealed record DomainEvent(
    string Id,
    string Type,
    Guid TenantId,
    string TenantSlug,
    DateTimeOffset OccurredAt,
    Guid? ActorUserId,
    bool ActorIsAdmin,
    Guid? SubjectUserId,
    Dictionary<string, object?> Data)
{
    /// <summary>Standard envelope JSON used for templating + signing.</summary>
    public string ToEnvelopeJson() => JsonSerializer.Serialize(new
    {
        id = Id,
        type = Type,
        tenant_id = TenantId,
        tenant_slug = TenantSlug,
        occurred_at = OccurredAt,
        occurred_at_unix = OccurredAt.ToUnixTimeSeconds(),
        actor = new { user_id = ActorUserId, is_admin = ActorIsAdmin },
        subject = new { user_id = SubjectUserId },
        data = Data,
    });
}
