using System.Text.Json.Serialization;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// <c>PUT /api/v1/admin/members/{userId}/groups</c> — set one member's groups in one call.
///
/// <para>
/// <b>Why it exists: D2 deleted the class endpoint.</b> <c>POST /admin/members/{id}/class</c>
/// was how the members screen moved a person between the two tariffs; with the class gone, the
/// same screen assigns groups, and doing that one group at a time through
/// <c>/admin/member-groups/{id}/members</c> would be N calls per member and N chances to leave
/// them half-moved. The body is the WHOLE set — replace, not patch — because "which groups is
/// this person in" is the question the screen answers.
/// </para>
///
/// <para>
/// <b>Recorded per group, in the vocabulary the groups surface already writes.</b> One
/// <c>group.members_changed</c> row for every group whose membership this call changed, shaped
/// exactly like the one <c>MemberGroupEndpoints</c> stages, so the change record reads the same
/// whichever screen moved the person. <b>And once under the member</b>: one
/// <c>member.groups_changed</c> audit row (<see cref="MemberGroupAudit"/>) with the tariff before
/// and after, so the member's trace answers who moved them and what it did to their rate. All of
/// it flushes with the membership rows it describes.
/// </para>
///
/// <para>
/// <b>An ARCHIVED group may be kept, never joined.</b> Keeping a membership an admin already
/// has is harmless (an archived group binds nothing) and refusing it would make the whole set
/// unsavable; joining one is almost certainly a mis-click on a stale list, and is refused.
/// Tenant isolation is structural: every read is tenant-filtered, so another club's user id
/// answers <c>404 member_not_found</c> and another club's group id <c>400 group_not_found</c>.
/// </para>
/// </summary>
public static class AdminMemberGroupsEndpoint
{
    public static IEndpointRouteBuilder MapAdminMemberGroupsEndpoint(this IEndpointRouteBuilder app)
    {
        app.MapPut("/api/v1/admin/members/{userId:guid}/groups", SetAsync)
            .RequireAuthorization(p => p.RequireRole("admin"));
        return app;
    }

    private static async Task<IResult> SetAsync(
        Guid userId, MemberGroupsSetRequest req, [AsParameters] GroupDeps deps,
        TenantSettingsAccessor settings, HttpContext ctx, CancellationToken ct)
    {
        var db = deps.Db;
        if (!await db.Users.AnyAsync(u => u.Id == userId, ct))
        {
            return Results.NotFound(new { error = AdminMemberDetailEndpoints.MemberNotFound });
        }

        if (req.EffectiveGroupIds is not { } asked) return Results.BadRequest(new { error = "group_ids_required" });
        var wanted = asked.Distinct().ToList();
        if (wanted.Count > GroupRules.MaxGroupsPerTenant)
        {
            return Results.BadRequest(new { error = "too_many_groups", max = GroupRules.MaxGroupsPerTenant });
        }

        var current = await db.MemberGroupMembers.Where(m => m.UserId == userId).ToListAsync(ct);
        var currentIds = current.Select(c => c.GroupId).ToList();
        var groups = await db.MemberGroups.AsNoTracking()
            .Where(g => wanted.Contains(g.Id) || currentIds.Contains(g.Id))
            .ToDictionaryAsync(g => g.Id, ct);

        if (Refuse(wanted, current, groups) is { } refusal) return refusal;

        var s = await settings.GetAsync(ct);
        var before = await MemberTariffs.ForAsync(db, userId, s, ct);
        var added = wanted.Where(id => current.All(c => c.GroupId != id)).ToList();
        var removed = current.Where(c => !wanted.Contains(c.GroupId)).ToList();

        foreach (var groupId in added)
        {
            db.MemberGroupMembers.Add(new MemberGroupMember
            {
                TenantId = deps.Tenant.TenantId,
                GroupId = groupId,
                UserId = userId,
                AddedByUserId = ctx.User.Id() ?? Guid.Empty,
            });
        }
        db.MemberGroupMembers.RemoveRange(removed);

        await StageAsync(deps, ctx, new MembershipMove(userId, added, removed.Select(r => r.GroupId).ToList(), groups, req.Reason), ct);
        if (added.Count > 0 || removed.Count > 0)
        {
            // The member-side row (review D2-P2), with the tariff the new set resolves to by the
            // same rule every reader uses — computed, not re-read, so it flushes with the move.
            var after = MemberTariffs.Resolve(
                wanted.Select(id => groups[id]).Where(g => g.Status == MemberGroupStatus.Active)
                    .Select(MemberTariffs.From).ToList(),
                s.CreditsPerZarRegular);
            MemberGroupAudit.Stage(db, new MemberGroupMove(
                deps.Tenant.TenantId, ctx.User.Id() ?? Guid.Empty, userId,
                added.Select(id => groups[id]).ToList(), removed.Select(r => groups[r.GroupId]).ToList(),
                before, after, req.Reason));
        }
        await db.SaveChangesAsync(ct);

        var tariff = await MemberTariffs.ForAsync(db, userId, s, ct);
        return Results.Ok(new
        {
            user_id = userId,
            groups = AdminMemberEndpoints.GroupsWire(tariff.Groups),
            added,
            removed = removed.Select(r => r.GroupId).ToList(),
            tariff = new
            {
                top_up_credits_per_zar = tariff.TopUpRate,
                rate_group_id = tariff.RateGroup?.Id,
                peak_priority = tariff.PeakPriority,
                peak_withheld_by = tariff.PeakWithheldBy,
            },
        });
    }

    /// <summary>The refusal for a set naming a group this club does not hold, or newly joining an archived one.</summary>
    private static IResult? Refuse(
        IReadOnlyList<Guid> wanted, IReadOnlyList<MemberGroupMember> current, IReadOnlyDictionary<Guid, MemberGroup> groups)
    {
        foreach (var id in wanted)
        {
            if (!groups.TryGetValue(id, out var group))
            {
                return Results.BadRequest(new { error = "group_not_found", group_id = id });
            }
            if (group.Status == MemberGroupStatus.Archived && current.All(c => c.GroupId != id))
            {
                return Results.BadRequest(new { error = "group_archived", group_id = id, name = group.Name });
            }
        }
        return null;
    }

    /// <summary>One <c>group.members_changed</c> row per group this call changed.</summary>
    private static async Task StageAsync(GroupDeps deps, HttpContext ctx, MembershipMove move, CancellationToken ct)
    {
        if (move.Added.Count == 0 && move.Removed.Count == 0) return;

        var names = await PersonNames.ForAsync(deps.Db, [(Guid?)move.UserId], ct);
        var person = new[] { new { user_id = move.UserId, name = PersonNames.Of(move.UserId, names) } };
        var nobody = person.Take(0).ToArray();

        foreach (var groupId in move.Added.Concat(move.Removed))
        {
            var joined = move.Added.Contains(groupId);
            var group = move.Groups[groupId];
            await deps.Changes.StageAsync(new AdminChange(
                Action: AdminChangeActions.GroupMembersChanged,
                ActorUserId: ctx.User.Id() ?? Guid.Empty,
                SubjectKind: AdminChangeSubjects.Group,
                SubjectId: group.Id,
                SubjectLabel: group.Name,
                Reason: move.Reason?.Trim(),
                After: new
                {
                    added = joined ? person : nobody,
                    removed = joined ? nobody : person,
                }), ct);
        }
    }

    private sealed record MembershipMove(
        Guid UserId, List<Guid> Added, List<Guid> Removed, IReadOnlyDictionary<Guid, MemberGroup> Groups, string? Reason);
}

/// <summary>
/// The member's whole group set. <c>groupIds</c> or <c>group_ids</c> — the settings surface's
/// either-spelling posture, so a console written in either convention is not silently ignored.
/// </summary>
public sealed record MemberGroupsSetRequest(
    IReadOnlyList<Guid>? GroupIds = null,
    [property: JsonPropertyName("group_ids")] IReadOnlyList<Guid>? GroupIdsSnake = null,
    string? Reason = null)
{
    /// <summary>The set under either spelling; null when neither was sent.</summary>
    public IReadOnlyList<Guid>? EffectiveGroupIds => GroupIds ?? GroupIdsSnake;
}
