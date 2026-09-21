namespace Crusaders.Mainframe.Api.Services.Realtime;

/// <summary>Which stream a message belongs to.</summary>
public enum RealtimeScope
{
    /// <summary>A member's own balance. Reserved — the wallet stream still runs on its own broadcaster; see <see cref="IRealtimeBus"/>.</summary>
    Wallet = 0,

    /// <summary>The admin control board (GOAL item 10). One topic per tenant, no subject.</summary>
    ControlBoard = 1,

    /// <summary>The admin IoT monitoring page (GOAL item 7). One topic per tenant, no subject.</summary>
    Monitoring = 2,
}

/// <summary>
/// The fan-out key. <b><see cref="TenantId"/> is on every topic, always.</b>
///
/// <para>
/// Not because a GUID collision is plausible, but because the isolation rule in this
/// repository is structural — every persisted entity carries a tenant id, every endpoint
/// resolves tenant first — and a fan-out keyed on a bare subject id is the one place in the
/// system where it would not be. The wallet's existing broadcaster is keyed on
/// <c>userId</c> alone, which is a hole nobody has fallen into and which this type declines
/// to reproduce for two new audiences.
/// </para>
///
/// <para>
/// <see cref="SubjectId"/> is null for the two admin scopes: a control board is the club's,
/// not one admin's, and two screens in the same club see the same courts.
/// </para>
/// </summary>
public readonly record struct RealtimeTopic(Guid TenantId, RealtimeScope Scope, Guid? SubjectId)
{
    /// <summary>The club-wide control-board topic for one tenant.</summary>
    public static RealtimeTopic ControlBoard(Guid tenantId) => new(tenantId, RealtimeScope.ControlBoard, null);

    /// <summary>The club-wide monitoring topic for one tenant.</summary>
    public static RealtimeTopic Monitoring(Guid tenantId) => new(tenantId, RealtimeScope.Monitoring, null);
}

/// <summary>
/// One frame, already serialised.
///
/// <para>
/// The payload is a JSON string rather than an object because the bus fans one message out to
/// every subscriber, and serialising once per publish rather than once per subscriber is the
/// difference between a wall screen and six of them costing the same. It also keeps the bus
/// free of any knowledge of what a control board or a fault looks like.
/// </para>
/// </summary>
/// <param name="Event">The SSE event name — <c>snapshot</c>, <c>court</c>, <c>error_opened</c>…</param>
/// <param name="JsonPayload">The <c>data:</c> line's body, already serialised.</param>
public sealed record RealtimeMessage(string Event, string JsonPayload);
