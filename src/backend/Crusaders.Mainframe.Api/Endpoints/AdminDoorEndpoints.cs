namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The doors area — W1.1, W1.3 and W1.5 on one admin route group.
///
/// <para>
/// <b>A group of its own, and not more routes on <c>/admin/devices</c>.</b> A door and a court
/// box are the same table and almost nothing else: a box sells court time and stamps
/// attendance, a door does neither and its whole record is audit rows. A2.5 settles the
/// console side of that — <c>/admin/doors</c> is the only place a gate is named, shut,
/// reopened or deleted, and <c>/admin/devices</c> renders gates read-only — and the API
/// follows, so a reader asking "what can an admin do to a door" has one file to open.
/// </para>
///
/// <para>
/// <b>Nothing here is on <c>/api/v1/device/*</c>, and that is load-bearing.</b>
/// <c>DeviceForbiddenMeansOutOfServiceTests</c> pins, in both directions, that a <c>403</c> on
/// that route group can mean one thing only: this board is out of service. Every route below
/// is admin-JWT and answers <c>403</c> to a member, which is why it must live outside that
/// group — a single admin route mounted under <c>/device</c> would make the firmware's
/// authoritative signal ambiguous.
/// </para>
/// </summary>
public static class AdminDoorEndpoints
{
    public static IEndpointRouteBuilder MapAdminDoorEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/doors").RequireAuthorization(p => p.RequireRole("admin"));

        g.MapGet("/", AdminDoorsOverviewEndpoint.HandleAsync);

        // Declared before "/activity" so the literal wins; the two are distinct paths, but the
        // ordering also reads in the order a console uses them.
        g.MapGet("/activity.csv", AdminDoorLogEndpoint.CsvAsync);
        g.MapGet("/activity", AdminDoorLogEndpoint.HandleAsync);

        g.MapPost("/shut-all", AdminDoorFleetEndpoint.ShutAllAsync);
        g.MapPost("/reopen-all", AdminDoorFleetEndpoint.ReopenAllAsync);

        return app;
    }
}
