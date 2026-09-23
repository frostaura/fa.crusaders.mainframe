using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Crusaders.Mainframe.Api.Services;

namespace Crusaders.Mainframe.Api.Endpoints;

/// <summary>
/// The member-side record of a group move: one <c>audit_logs</c> row,
/// <c>member.groups_changed</c>, whose subject is the MEMBER.
///
/// <para>
/// <b>Why a second row beside the group's change-record row (review D2-P2).</b> Before D2, moving
/// a member between tariffs was <c>POST /admin/members/{id}/class</c>, which wrote
/// <c>member.class_changed</c> with the member as subject, so the member's trace answered "who
/// moved this person to the regular rate, and when". D2 made group membership the tariff, and
/// the group surface records in the GROUP area, keyed by group — a member appears only inside the
/// row's JSON, which nothing filters by. The invariant is that every admin action is
/// representable as <c>{actor, subject: end_user_id}</c>; this row is that representation. It
/// carries the tariff before and after, because the money consequence is the thing a member asks
/// about, and it is staged in the same unit of work as the membership rows it describes.
/// </para>
/// </summary>
internal static class MemberGroupAudit
{
    /// <summary>The audit action.</summary>
    public const string GroupsChanged = "member.groups_changed";

    /// <summary>Stages the row; the caller's <c>SaveChangesAsync</c> flushes it with the move.</summary>
    public static void Stage(MainframeDbContext db, MemberGroupMove move)
    {
        db.AuditLogs.Add(new AuditLog
        {
            TenantId = move.TenantId,
            ActorUserId = move.ActorUserId,
            SubjectUserId = move.UserId,
            Action = GroupsChanged,
            DetailsJson = JsonSerializer.Serialize(new
            {
                added = move.Added.Select(g => new { id = g.Id, name = g.Name }).ToList(),
                removed = move.Removed.Select(g => new { id = g.Id, name = g.Name }).ToList(),
                reason = string.IsNullOrWhiteSpace(move.Reason) ? null : move.Reason.Trim(),
                tariff_before = Tariff(move.Before),
                tariff_after = Tariff(move.After),
            }),
        });
    }

    private static object Tariff(MemberTariff t)
    {
        return new
        {
            top_up_credits_per_zar = t.TopUpRate,
            rate_group_id = t.RateGroup?.Id,
            peak_priority = t.PeakPriority,
        };
    }
}

/// <summary>One member's group move, as <see cref="MemberGroupAudit"/> records it.</summary>
internal sealed record MemberGroupMove(
    Guid TenantId,
    Guid ActorUserId,
    Guid UserId,
    IReadOnlyList<MemberGroup> Added,
    IReadOnlyList<MemberGroup> Removed,
    MemberTariff Before,
    MemberTariff After,
    string? Reason);
