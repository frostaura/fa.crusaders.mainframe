using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>A member as a result shows them: name and photo. Every membership — history keeps its names.</summary>
public sealed record PlayPerson(Guid UserId, string Name, string? PhotoUrl);

/// <summary>
/// The wire shapes of a result (<c>docs/specs/play.md</c> §6.1, §6.3): <c>result</c>, <c>player</c>
/// and <c>admin_result</c>. Answers are snake_case, times ISO-8601 UTC, and no money ever appears.
/// </summary>
public static class ResultViews
{
    /// <summary>Names and photos of <paramref name="userIds"/> — every membership of this club, active or not.</summary>
    public static async Task<Dictionary<Guid, PlayPerson>> PeopleAsync(MainframeDbContext db, IEnumerable<Guid> userIds, CancellationToken ct)
    {
        var ids = userIds.Distinct().ToList();
        if (ids.Count == 0) return [];
        return await db.Memberships.AsNoTracking().Where(m => ids.Contains(m.UserId))
            .Select(m => new PlayPerson(m.UserId, m.FullName, m.PhotoUrl))
            .ToDictionaryAsync(m => m.UserId, ct);
    }

    /// <summary>Every member a view of <paramref name="results"/> will name.</summary>
    public static IEnumerable<Guid> PeopleIn(IEnumerable<MatchResult> results) =>
        results.SelectMany(r => r.Players.Where(p => p.UserId != null).Select(p => p.UserId!.Value)
            .Append(r.SubmittedByUserId)
            .Concat(r.ConfirmedByUserId is { } c ? [c] : [])
            .Concat(r.DisputedByUserId is { } d ? [d] : []));

    /// <summary><c>player</c>: <c>{player_key, kind, user_id, name, photo_url}</c>.</summary>
    public static object Player(LineupCandidate c, IReadOnlyDictionary<Guid, PlayPerson> people)
    {
        var person = c.UserId is { } u && people.TryGetValue(u, out var p) ? p : null;
        return new
        {
            player_key = c.Key,
            kind = c.IsGuest ? "guest" : "member",
            user_id = c.UserId,
            name = person?.Name ?? c.GuestName,
            photo_url = person?.PhotoUrl,
        };
    }

    private static object Player(MatchResultPlayer p, IReadOnlyDictionary<Guid, PlayPerson> people)
    {
        var key = p.UserId is { } u ? Lineup.MemberKey(u) : Lineup.GuestKey(p.ParticipantId ?? Guid.Empty);
        return Player(new LineupCandidate(key, p.UserId, p.ParticipantId, p.GuestName, p.Position), people);
    }

    private static object? Who(Guid? userId, IReadOnlyDictionary<Guid, PlayPerson> people)
    {
        if (userId is not { } id) return null;
        return new { user_id = id, name = people.TryGetValue(id, out var p) ? p.Name : null };
    }

    /// <summary>
    /// <c>result</c> as a dictionary, so the admin shape and the list shape can add their fields
    /// beside it. <paramref name="viewer"/> null leaves out <c>viewer_*</c> (the admin shape).
    /// </summary>
    public static Dictionary<string, object?> Result(MatchResult r, IReadOnlyDictionary<Guid, PlayPerson> people, Guid? viewer)
    {
        var view = new Dictionary<string, object?>
        {
            ["result_id"] = r.Id,
            ["booking_id"] = r.BookingId,
            ["status"] = r.Status,
            ["format"] = r.Format,
            ["games"] = ResultGames.Read(r.GamesJson).Select(g => new { a = g.A, b = g.B }).ToList(),
            ["games_won"] = new { a = (int)r.GamesWonA, b = (int)r.GamesWonB },
            ["winner"] = r.WinnerSide,
            ["sides"] = new { a = Side(r, MatchSide.A, people), b = Side(r, MatchSide.B, people) },
            ["submitted_by"] = Who(r.SubmittedByUserId, people),
            ["submitted_at"] = r.SubmittedAt,
            ["edited_at"] = r.EditedAt,
            ["version"] = r.Version,
            ["confirm_due_at"] = r.Status == MatchResultStatus.Pending ? r.ConfirmDueAt : null,
            ["confirmed_at"] = r.ConfirmedAt,
            ["auto_confirmed"] = r.AutoConfirmed,
            ["confirmed_by"] = Who(r.ConfirmedByUserId, people),
            ["disputed_at"] = r.DisputedAt,
            ["disputed_by"] = Who(r.DisputedByUserId, people),
            ["dispute_note"] = r.DisputeNote,
            ["closed_at"] = r.ClosedAt,
            ["closed_by_admin"] = ClosedByAdmin(r),
        };
        if (viewer is { } me)
        {
            var side = r.Players.FirstOrDefault(p => p.UserId == me)?.Side;
            view["viewer_side"] = side;
            view["viewer_outcome"] = side is null ? null : side == r.WinnerSide ? "won" : "lost";
        }
        return view;
    }

    /// <summary>
    /// True when an admin closed or decided the result: voided it, or kept it after a dispute. A
    /// member's own withdrawal is not the club's.
    /// </summary>
    public static bool ClosedByAdmin(MatchResult r) =>
        r.ClosedByUserId is not null && r.Status is MatchResultStatus.Voided or MatchResultStatus.Confirmed;

    private static List<object> Side(MatchResult r, string side, IReadOnlyDictionary<Guid, PlayPerson> people) =>
        r.Players.Where(p => p.Side == side).OrderBy(p => p.Position).Select(p => Player(p, people)).ToList();
}
