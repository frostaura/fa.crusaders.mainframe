using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// <c>/api/v1/admin/courts</c> — the club's courts.
///
/// <para>
/// <b>Every write is on the change record, in its own save</b> (review round 4 wave B):
/// <c>court.created</c>, <c>court.updated</c> and <c>court.deactivated</c> were in the vocabulary
/// from the start and nothing wrote them, so "who renamed Court 2" or "who took Court 3 off the
/// grid" had no answer. Only the fields that changed are stored, and an edit that changed nothing
/// records nothing. Lifted out of <c>AdminConfigEndpoints</c>, whose one method held them inline.
/// </para>
/// </summary>
public static class AdminCourtEndpoints
{
    public static IEndpointRouteBuilder MapAdminCourtEndpoints(this IEndpointRouteBuilder app)
    {
        var courts = app.MapGroup("/api/v1/admin/courts").RequireAuthorization(p => p.RequireRole("admin"));
        courts.MapGet("/", ListAsync);
        courts.MapPost("/", CreateAsync);
        courts.MapPatch("/{id:guid}", UpdateAsync);
        courts.MapDelete("/{id:guid}", DeactivateAsync);
        return app;
    }

    /// <summary>What a court write resolves from the container — the gate's six-argument cap.</summary>
    public sealed record CourtDeps(
        MainframeDbContext Db, ITenantContext Tenant, TenantSettingsAccessor Settings, AdminChangeRecorder Changes);

    private static async Task<IResult> ListAsync(MainframeDbContext db, CancellationToken ct)
    {
        var list = await db.Courts.OrderBy(c => c.CourtNumber).ToListAsync(ct);
        return Results.Ok(list.Select(c => new
        {
            id = c.Id,
            court_number = c.CourtNumber,
            name = c.Name,
            court_type = c.CourtType.ToString(),
            is_active = c.IsActive,
        }));
    }

    private static async Task<IResult> CreateAsync(
        CreateCourtRequest req, [AsParameters] CourtDeps deps, HttpContext ctx, CancellationToken ct)
    {
        var (db, tenant) = (deps.Db, deps.Tenant);
        if (string.IsNullOrWhiteSpace(req.Name)) return Results.BadRequest(new { error = "name_required" });
        // No price on a court (P13): a booking costs its length in minutes. An old console's
        // per-slice price is an unknown member now, and ignored rather than refused.

        var maxNo = await db.Courts.IgnoreQueryFilters().Where(c => c.TenantId == tenant.TenantId).MaxAsync(c => (int?)c.CourtNumber, ct) ?? 0;
        var court = new Court
        {
            TenantId = tenant.TenantId,
            CourtNumber = maxNo + 1,
            Name = req.Name.Trim(),
            CourtType = Enum.TryParse<CourtType>(req.CourtType, true, out var t) ? t : CourtType.Squash,
            IsActive = true,
        };
        db.Courts.Add(court);
        await StageAsync(deps, ctx, AdminChangeActions.CourtCreated, court, null, Snapshot(court));
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { id = court.Id, court_number = court.CourtNumber });
    }

    private static async Task<IResult> UpdateAsync(
        Guid id, UpdateCourtRequest req, [AsParameters] CourtDeps deps, HttpContext ctx, CancellationToken ct)
    {
        var db = deps.Db;
        var court = await db.Courts.FirstOrDefaultAsync(c => c.Id == id, ct);
        if (court is null) return Results.NotFound();
        var before = Snapshot(court);
        if (req.Name is not null) court.Name = req.Name.Trim();
        if (req.IsActive is not null) court.IsActive = req.IsActive.Value;

        var (was, now) = AdminChangeFields.Changed(before, Snapshot(court));
        if (now.Count > 0)
        {
            // Taking a court off the grid is a deactivation however it arrives — the DELETE or
            // this PATCH — so the record says so in one word rather than as a field edit.
            var action = before["is_active"] is true && !court.IsActive
                ? AdminChangeActions.CourtDeactivated
                : AdminChangeActions.CourtUpdated;
            await StageAsync(deps, ctx, action, court, was, now);
        }
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { saved = true });
    }

    private static async Task<IResult> DeactivateAsync(
        Guid id, [AsParameters] CourtDeps deps, HttpContext ctx, CancellationToken ct)
    {
        var court = await deps.Db.Courts.FirstOrDefaultAsync(c => c.Id == id, ct);
        if (court is null) return Results.NotFound();

        // Soft delete: deactivate so historical bookings stay coherent. A court already off the
        // grid changes nothing, and records nothing.
        if (court.IsActive)
        {
            court.IsActive = false;
            await StageAsync(deps, ctx, AdminChangeActions.CourtDeactivated, court,
                new Dictionary<string, object?> { ["is_active"] = true },
                new Dictionary<string, object?> { ["is_active"] = false });
        }
        await deps.Db.SaveChangesAsync(ct);
        return Results.Ok(new { deactivated = true });
    }

    /// <summary>The fields a court's record names. Block body for the lizard reason in memory/gotchas.md.</summary>
    private static Dictionary<string, object?> Snapshot(Court court)
    {
        return new Dictionary<string, object?>
        {
            ["name"] = court.Name,
            ["court_number"] = court.CourtNumber,
            ["court_type"] = court.CourtType.ToString(),
            ["is_active"] = court.IsActive,
        };
    }

    private static async Task StageAsync(
        CourtDeps deps, HttpContext ctx, string action, Court court, object? before, object? after)
    {
        await deps.Changes.StageAsync(new AdminChange(
            Action: action,
            ActorUserId: ctx.User.Id() ?? Guid.Empty,
            SubjectKind: AdminChangeSubjects.Court,
            SubjectId: court.Id,
            SubjectLabel: court.Name,
            Before: before,
            After: after), ctx.RequestAborted);
    }
}
