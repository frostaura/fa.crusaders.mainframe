using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Multitenancy;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Security;
using Crusaders.Mainframe.Api.Services;
using Crusaders.Mainframe.Api.Services.Realtime;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// D14 — the admin's side of play (<c>docs/specs/play.md</c> §6.3): the disputes list and its count
/// (the nav badge's source), voiding and upholding a result with a reason — every write in
/// <c>admin_change_log</c> — and a member's play summary, which is counts only.
/// </summary>
public static class AdminPlayEndpoints
{
    public const int DefaultLimit = 20;
    public const int MaxLimit = 100;

    private static readonly string[] Statuses =
        [MatchResultStatus.Disputed, MatchResultStatus.Pending, MatchResultStatus.Confirmed, MatchResultStatus.Voided, MatchResultStatus.Withdrawn, "all"];

    public static IEndpointRouteBuilder MapAdminPlayEndpoints(this IEndpointRouteBuilder app)
    {
        var reads = app.MapGroup("/api/v1/admin").RequireAuthorization(p => p.RequireRole("admin"));
        reads.MapGet("/play/results", ListAsync);
        reads.MapGet("/play/results/disputed/count", CountAsync);
        reads.MapGet("/members/{userId:guid}/play", MemberAsync);

        var writes = app.MapGroup("/api/v1/admin/play/results")
            .RequireAuthorization(p => p.RequireRole("admin"))
            .RequireRateLimiting(RateLimitPolicies.Writes);
        writes.MapPost("/{resultId:guid}/void", VoidAsync);
        writes.MapPost("/{resultId:guid}/uphold", UpholdAsync);
        return app;
    }

    private static async Task<IResult> ListAsync(string? status, string? cursor, int? limit, PlayQuery query, CancellationToken ct)
    {
        var which = string.IsNullOrWhiteSpace(status) ? MatchResultStatus.Disputed : status.Trim();
        if (!Statuses.Contains(which)) return Results.BadRequest(new { error = "status_invalid", allowed = Statuses });
        var take = limit ?? DefaultLimit;
        if (take is < 1 or > MaxLimit) return Results.BadRequest(new { error = "limit_invalid", min = 1, max = MaxLimit });
        return Results.Ok(await query.AdminResultsAsync(which, cursor, take, ct));
    }

    private static async Task<IResult> CountAsync(MainframeDbContext db, CancellationToken ct)
    {
        return Results.Ok(new { count = await db.MatchResults.AsNoTracking().CountAsync(r => r.Status == MatchResultStatus.Disputed, ct) });
    }

    /// <summary>
    /// Counts only. Not logged as a view: every figure but the match record is on the member's
    /// bookings tab already (§14 Q3).
    /// </summary>
    private static async Task<IResult> MemberAsync(Guid userId, PlayQuery query, CancellationToken ct)
    {
        var summary = await query.AdminMemberAsync(userId, DateTimeOffset.UtcNow, ct);
        return summary is null ? Results.NotFound(new { error = "member_not_found" }) : Results.Ok(summary);
    }

    private static async Task<IResult> VoidAsync(Guid resultId, AdminResultRequest? req, HttpContext ctx, [AsParameters] AdminDeps deps, CancellationToken ct) =>
        await AnswerAsync(ctx, deps, await deps.Results.VoidAsync(resultId, Me(ctx), req?.Reason, DateTimeOffset.UtcNow, ct), ct);

    private static async Task<IResult> UpholdAsync(Guid resultId, AdminResultRequest? req, HttpContext ctx, [AsParameters] AdminDeps deps, CancellationToken ct) =>
        await AnswerAsync(ctx, deps, await deps.Results.UpholdAsync(resultId, Me(ctx), req?.Reason, DateTimeOffset.UtcNow, ct), ct);

    /// <summary>The admin writes' services, bound as one parameter for the complexity gate.</summary>
    public sealed record AdminDeps(ResultService Results, PlayQuery Query, MainframeDbContext Db, IRealtimeBus Bus, ITenantContext Tenant);

    private static async Task<IResult> AnswerAsync(HttpContext ctx, AdminDeps deps, ResultOutcome outcome, CancellationToken ct)
    {
        if (outcome.Changed && outcome.Affected is { Count: > 0 } affected)
        {
            await MemberNotices.PublishUnreadAsync(deps.Db, deps.Bus, deps.Tenant.TenantId, affected, CancellationToken.None);
            await ctx.AfterPlayAsync(affected);
        }
        if (!outcome.IsOk) return PlayEndpoints.Refusal(outcome);
        return Results.Json(await deps.Query.AdminResultAsync(outcome.Result!, ct), statusCode: outcome.StatusCode);
    }

    private static Guid Me(HttpContext ctx) => ctx.User.Id() ?? Guid.Empty;
}

/// <summary>An admin's void or uphold: the reason, required (1–500).</summary>
public sealed record AdminResultRequest(string? Reason = null);
