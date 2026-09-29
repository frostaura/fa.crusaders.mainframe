using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// <c>POST /api/v1/admin/members/{userId}/admin</c> — grant or revoke a member's admin rights (R20).
///
/// <para>
/// <b>Keyed on the USER id, unlike the lifecycle routes beside it</b>, which take a membership
/// id. Admin rights live on <c>users</c>, and an account can hold them with no membership row at
/// all — the bootstrap admin is exactly that — so a membership id could not name every account
/// this route has to be able to act on.
/// </para>
///
/// <para>
/// The rules are <see cref="AdminRoleService"/>'s; this file only maps its outcome to a status
/// code. Every refusal is a distinct error string because the console says something different
/// for each — "you are the last administrator" and "confirm you mean yourself" are not the same
/// sentence, and "this address is set in the server configuration" needs an operator, not a
/// retry.
/// </para>
/// </summary>
public static class AdminRoleEndpoints
{
    public static IEndpointRouteBuilder MapAdminRoleEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/v1/admin/members").RequireAuthorization(p => p.RequireRole("admin"));

        g.MapPost("/{userId:guid}/admin", async (
            Guid userId, AdminRoleBody body, HttpContext ctx, AdminRoleService roles, CancellationToken ct) =>
        {
            if (body.Grant is not { } grant) return Results.BadRequest(new { error = "grant_required" });
            // Both ways since review round 1 (B10): making somebody an administrator is the change
            // that decides who reads every other one, and "why was this person given the keys?"
            // is asked as often as "why was I removed?".
            if (string.IsNullOrWhiteSpace(body.Reason)) return Results.BadRequest(new { error = "reason_required" });

            var result = await roles.ChangeAsync(new AdminRoleRequest
            {
                ActorUserId = ctx.User.Id() ?? Guid.Empty,
                TargetUserId = userId,
                Grant = grant,
                Reason = body.Reason,
                ConfirmSelf = (body.ConfirmSelf ?? body.ConfirmSelfCamel) == true,
            }, ct);
            return Answer(userId, result);
        });

        return app;
    }

    private static IResult Answer(Guid userId, AdminRoleResult result)
    {
        switch (result.Outcome)
        {
            case AdminRoleOutcome.Changed:
            case AdminRoleOutcome.Unchanged:
                return Results.Ok(new
                {
                    user_id = userId,
                    is_admin = result.IsAdmin,
                    admin_source = result.AdminSource,
                    changed = result.Outcome == AdminRoleOutcome.Changed,
                });
            case AdminRoleOutcome.NotFound:
                return Results.NotFound(new { error = "member_not_found" });
            case AdminRoleOutcome.ActorNotAdmin:
                return Results.Json(new { error = "actor_not_admin" }, statusCode: StatusCodes.Status403Forbidden);
            default:
                return Results.Json(new { error = ConflictCode(result.Outcome) }, statusCode: StatusCodes.Status409Conflict);
        }
    }

    private static string ConflictCode(AdminRoleOutcome outcome)
    {
        switch (outcome)
        {
            case AdminRoleOutcome.NotActiveMember: return "not_active_member";
            case AdminRoleOutcome.LastAdmin: return "last_admin";
            case AdminRoleOutcome.ConfirmSelfRequired: return "confirm_self_required";
            case AdminRoleOutcome.InheritedFromConfig: return "admin_inherited_from_config";
            default: return "conflict";
        }
    }
}

/// <summary>
/// The request body. <c>grant</c> is nullable so its absence is a 400 rather than a silent
/// revoke — a bool defaulting to false would turn a malformed request into a demotion.
///
/// <para>
/// <b>Both spellings of <c>confirm_self</c> bind</b>, for the reason <c>AdjustRequest</c>
/// documents: the console's client sends camelCase, and <c>confirmSelf: true</c> bound to
/// nothing, so an admin who had ticked "yes, remove my own rights" was answered
/// <c>confirm_self_required</c> forever.
/// </para>
/// </summary>
public sealed class AdminRoleBody
{
    [JsonPropertyName("grant")] public bool? Grant { get; init; }
    [JsonPropertyName("reason")] public string? Reason { get; init; }
    [JsonPropertyName("confirm_self")] public bool? ConfirmSelf { get; init; }
    [JsonPropertyName("confirmSelf")] public bool? ConfirmSelfCamel { get; init; }
}
