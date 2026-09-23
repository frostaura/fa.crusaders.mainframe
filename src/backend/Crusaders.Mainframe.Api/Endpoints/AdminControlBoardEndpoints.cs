using System.Text.Json;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The control board — GOAL item 10. One read, one ticket, one stream.
///
/// <para>
/// <b>It is a mirror, not a control panel.</b> There is no "turn the lights off" button here
/// and there deliberately will not be one in this programme: the relay is driven by the box,
/// the relay client is not even registered in the container, and adding an actuation control
/// to a read model is how a wall screen becomes a way to switch off a court somebody is
/// playing on.
/// </para>
/// </summary>
public static class AdminControlBoardEndpoints
{
    public static IEndpointRouteBuilder MapAdminControlBoardEndpoints(this IEndpointRouteBuilder app)
    {
        // Full paths on the root builder rather than a group with a "/" child: a group's
        // root child maps the TRAILING-SLASH form only, and the console asks for
        // `/api/v1/admin/control-board`.
        app.MapGet("/api/v1/admin/control-board", async (ControlBoardReader reader, CancellationToken ct) =>
                Results.Ok(await reader.BuildAsync(ct)))
            .RequireAuthorization(p => p.RequireRole("admin"));

        app.MapPost("/api/v1/admin/control-board/stream-ticket", MintTicket)
            .RequireAuthorization(p => p.RequireRole("admin"));

        // The stream is on the ROOT group rather than the admin one: its credential is the
        // purpose-scoped ticket in the query string, which EventSource cannot send as a header
        // — so the role policy cannot be what admits it. The purpose itself is the
        // authorisation, and Program.cs accepts that purpose on this path and no other.
        app.MapGet("/api/v1/admin/control-board/stream", StreamAsync)
            .RequireAuthorization();

        return app;
    }

    /// <summary>
    /// Mints the one-minute, purpose-scoped credential the stream is opened with.
    ///
    /// <para>
    /// Minted by a POST so it never reaches an access log: nginx records <c>$request</c> —
    /// query string included — on every connect and every reconnect, and a full access token
    /// there meant a log file held working sessions. This one lives about a minute and opens
    /// one read-only stream.
    /// </para>
    /// </summary>
    private static IResult MintTicket(HttpContext ctx, IJwtIssuer jwt, ITenantContext tenant)
    {
        var userId = ctx.User.Id();
        if (userId is null) return Results.Unauthorized();

        // THE ROLES TRAVEL WITH THE TICKET, and without them this route was 403 for
        // everybody — including the admin who had just minted the ticket one request earlier.
        // The base IssueOneTime carries no role claims, so the handler's own IsInRole("admin")
        // check could never pass. The check is right and stays: the purpose alone says which
        // PATH a ticket opens, not who may open it, and a member who came by one must not be
        // able to read the club's whole evening with it.
        var ticket = jwt.IssueOneTime(
            userId.Value, tenant.TenantId, tenant.TenantSlug,
            TokenPurposes.ControlBoardStream, TokenPurposes.WalletStreamTicketTtl, ["admin"]);

        return Results.Ok(new
        {
            ticket,
            expires_in_seconds = (int)TokenPurposes.WalletStreamTicketTtl.TotalSeconds,
        });
    }

    /// <summary>
    /// The live board: a full snapshot on connect, court deltas as they are published, and a
    /// fresh snapshot every <c>control_board_resync_seconds</c>.
    ///
    /// <para>
    /// <b>The periodic snapshot is how a client that missed a delta heals itself.</b> Deltas
    /// alone are a state machine the browser has to get right for hours on an unattended
    /// screen; a resync makes a dropped frame cost at most one resync interval of staleness
    /// rather than a permanently wrong court. Every snapshot carries <c>generated_at</c>, and
    /// the page shows it — a screen that cannot say when it was last right is a screen nobody
    /// can trust.
    /// </para>
    /// </summary>
    private static async Task StreamAsync(
        HttpContext ctx, [AsParameters] ControlBoardStreamServices services, CancellationToken ct)
    {
        // The ticket proves its purpose, and the purpose is accepted only on this path — but
        // the ROLE still has to hold. A member who somehow obtained a control-board ticket
        // must not be able to read the club's whole evening with it.
        if (!ctx.User.IsInRole("admin")) { ctx.Response.StatusCode = 403; return; }

        var (reader, bus, tenant, settings, scopes) = services;
        var s = await settings.GetAsync(ct);
        var topic = RealtimeTopic.ControlBoard(tenant.TenantId);

        using var resync = new CancellationTokenSource();
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, resync.Token);

        // A publisher on its own loop rather than a branch inside the pump. The pump's shape
        // is load-bearing — nothing abandoned, one waiter — and threading a second timer
        // through it is how the two defects its doc comment records came back.
        var resyncSeconds = RealtimeSettings.ResyncSeconds(s);
        var snapshots = Task.Run(async () =>
        {
            try
            {
                while (!linked.Token.IsCancellationRequested)
                {
                    await Task.Delay(TimeSpan.FromSeconds(resyncSeconds), linked.Token);
                    using var scope = scopes.CreateScope();
                    scope.ServiceProvider.GetRequiredService<ITenantContext>()
                        .Set(tenant.TenantId, tenant.TenantSlug);
                    var fresh = scope.ServiceProvider.GetRequiredService<ControlBoardReader>();
                    bus.Publish(topic, Snapshot(await fresh.BuildAsync(linked.Token)));
                }
            }
            catch (OperationCanceledException) { /* the stream closed */ }
        }, linked.Token);

        // The role is re-asked before every frame, not only here: a demoted admin's open board
        // must stop, not run until the connection drops. See SseStream.RunAsync's guard.
        await SseStream.RunAsync(
            ctx, bus, topic, AdminStreamGuard.For(ctx, RealtimeSettings.KeepAlive(s)),
            async () => await SseStream.WriteEventAsync(ctx, Snapshot(await reader.BuildAsync(ct)), ct),
            ct);

        await resync.CancelAsync();
        try { await snapshots; } catch (OperationCanceledException) { /* expected */ }
    }

    private static RealtimeMessage Snapshot(Dictionary<string, object?> payload)
    {
        return new RealtimeMessage("snapshot", JsonSerializer.Serialize(payload));
    }
}

/// <summary>
/// What the stream handler needs, bundled — the same reason as <c>HeartbeatServices</c>: a
/// minimal-API handler's parameter list is its injection point, and listing these individually
/// puts the method past the complexity gate's parameter bound on a count that says nothing
/// about how hard it is to reason about.
/// </summary>
public sealed record ControlBoardStreamServices(
    ControlBoardReader Reader,
    IRealtimeBus Bus,
    ITenantContext Tenant,
    TenantSettingsAccessor Settings,
    /// <summary>
    /// For the resync loop. It outlives the request's own scope by design — the response
    /// stays open for hours — so a snapshot built on the request's <c>DbContext</c> would be
    /// built on a context that was disposed at the first await.
    /// </summary>
    IServiceScopeFactory Scopes);
