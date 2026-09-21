namespace Crusaders.Mainframe.Api.Services.Realtime;

/// <summary>
/// Which live channel a message belongs to. One scope per audience, never one multiplexed
/// stream: a member's wallet and a wall-mounted control board are not the same thing, and one
/// authorisation decision in front of two audiences is the shape that produces a leak.
/// </summary>
public enum RealtimeScope
{
    /// <summary>One member's own balance. <c>SubjectId</c> is the member.</summary>
    Wallet = 0,

    /// <summary>The club's courts, lights and current slots. Admin-only; <c>SubjectId</c> is null.</summary>
    ControlBoard = 1,

    /// <summary>Device faults and their counts. Admin-only; <c>SubjectId</c> is null.</summary>
    Monitoring = 2,
}

/// <summary>
/// The key a subscriber and a publisher must agree on.
///
/// <para>
/// <b><see cref="TenantId"/> is on every topic, always, including the wallet one.</b> D2-B22:
/// <c>BalanceBroadcaster</c> keyed on the bare <c>userId</c>. Nothing leaked, because user ids
/// are GUIDs — but the isolation rule in this repo is structural rather than probabilistic
/// ("every persisted entity carries tenant_id; every endpoint resolves tenant first"), and a
/// fan-out keyed on a bare id was the one place in the system where it was not. Resting
/// isolation on a collision argument is how the argument eventually gets lost.
/// </para>
/// </summary>
/// <param name="SubjectId">
/// The one member a wallet topic belongs to. Null on the club-wide scopes, which is what makes
/// "every admin of tenant X" a single topic rather than a fan-out over a roster.
/// </param>
public readonly record struct RealtimeTopic(Guid TenantId, RealtimeScope Scope, Guid? SubjectId)
{
    /// <summary>One member's wallet.</summary>
    public static RealtimeTopic Wallet(Guid tenantId, Guid userId)
        => new(tenantId, RealtimeScope.Wallet, userId);

    /// <summary>A club's control board.</summary>
    public static RealtimeTopic ControlBoard(Guid tenantId) => new(tenantId, RealtimeScope.ControlBoard, null);

    /// <summary>A club's device monitoring.</summary>
    public static RealtimeTopic Monitoring(Guid tenantId) => new(tenantId, RealtimeScope.Monitoring, null);
}

/// <summary>
/// One frame, already serialised.
///
/// <para>
/// <see cref="Event"/> is the SSE event name, so a client uses <c>addEventListener</c> rather
/// than parsing a discriminator out of the payload. The empty string means the legacy unnamed
/// frame, which the wallet stream still emits alongside its named one so a client written
/// against the old shape keeps working through the rollout.
/// </para>
///
/// <para>
/// The payload is a JSON string rather than an object because the bus is a transport: it must
/// not need to know the shape of anything, and serialising once at publish time rather than
/// once per subscriber is also the cheaper end of the trade.
/// </para>
/// </summary>
public sealed record RealtimeMessage(string Event, string JsonPayload);
