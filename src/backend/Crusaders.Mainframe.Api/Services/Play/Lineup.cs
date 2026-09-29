using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// Somebody who may appear in a result's lineup (§3.2): a player of the booking (<c>u:{userId}</c>)
/// or a live guest seat (<c>g:{participantId}</c>). <see cref="Seat"/> is the seat they hold, 1 for a
/// booker nobody added seats for.
/// </summary>
public sealed record LineupCandidate(string Key, Guid? UserId, Guid? ParticipantId, string? GuestName, int Seat)
{
    public bool IsGuest => GuestName is not null;
}

/// <summary>A lineup that passed §3.2, or the reason it did not.</summary>
public sealed record LineupCheck(string? Reason, IReadOnlyList<LineupCandidate> SideA, IReadOnlyList<LineupCandidate> SideB)
{
    public bool Ok => Reason is null;

    public static LineupCheck Refuse(string reason) => new(reason, [], []);
}

/// <summary>
/// A result's own lineup (<c>docs/specs/play.md</c> §3.2) — singles or doubles, from the booking's
/// players and guest seats, with the submitter in it. <b>Not the seats' teams</b>: P11 seats a
/// singles partner on seat 2, team A, so seat teams would record every singles game as two
/// team-mates. The seat teams only pre-fill <see cref="DefaultSides"/>.
/// </summary>
public static class Lineup
{
    public const string SideSize = "side_size";
    public const string UnevenSides = "uneven_sides";
    public const string UnknownPlayer = "unknown_player";
    public const string DuplicatePlayer = "duplicate_player";
    public const string SubmitterNotInLineup = "submitter_not_in_lineup";

    public static string MemberKey(Guid userId) => $"u:{userId}";

    public static string GuestKey(Guid participantId) => $"g:{participantId}";

    /// <summary>The booking's players (the booker and every accepted member seat) and its live guest seats, in seat order.</summary>
    public static async Task<List<LineupCandidate>> CandidatesAsync(MainframeDbContext db, Booking booking, CancellationToken ct)
    {
        if (booking.UserId is not { } booker) return [];
        var seats = await db.BookingParticipants.AsNoTracking()
            .Where(p => p.BookingId == booking.Id
                        && ((p.UserId != null && p.Status == ParticipantStatus.Accepted)
                            || (p.GuestName != null && (p.Status == ParticipantStatus.Invited || p.Status == ParticipantStatus.Accepted))))
            .OrderBy(p => p.Seat).ThenBy(p => p.CreatedAt)
            .ToListAsync(ct);

        var list = new List<LineupCandidate>();
        var bookerSeat = seats.FirstOrDefault(s => s.UserId == booker)?.Seat ?? 1;
        list.Add(new LineupCandidate(MemberKey(booker), booker, null, null, bookerSeat));
        foreach (var s in seats)
        {
            if (s.GuestName is { } guest) list.Add(new LineupCandidate(GuestKey(s.Id), null, s.Id, guest, s.Seat));
            else if (s.UserId is { } u && list.All(c => c.UserId != u)) list.Add(new LineupCandidate(MemberKey(u), u, null, null, s.Seat));
        }
        return list.OrderBy(c => c.Seat).ToList();
    }

    /// <summary>
    /// Checks a submitted lineup (§3.2): each side one or two, the sides even, every key a
    /// candidate, nobody twice, and the submitter in it.
    /// </summary>
    public static LineupCheck Validate(
        IReadOnlyList<string>? sideA, IReadOnlyList<string>? sideB, IReadOnlyList<LineupCandidate> candidates, Guid submitter)
    {
        var a = sideA ?? [];
        var b = sideB ?? [];
        if (a.Count is < 1 or > 2 || b.Count is < 1 or > 2) return LineupCheck.Refuse(SideSize);
        if (a.Count != b.Count) return LineupCheck.Refuse(UnevenSides);

        var keys = a.Concat(b).ToList();
        if (keys.Distinct(StringComparer.Ordinal).Count() != keys.Count) return LineupCheck.Refuse(DuplicatePlayer);

        var byKey = candidates.ToDictionary(c => c.Key, StringComparer.Ordinal);
        if (keys.Any(k => !byKey.ContainsKey(k))) return LineupCheck.Refuse(UnknownPlayer);
        if (!keys.Contains(MemberKey(submitter), StringComparer.Ordinal)) return LineupCheck.Refuse(SubmitterNotInLineup);

        return new LineupCheck(null, a.Select(k => byKey[k]).ToList(), b.Select(k => byKey[k]).ToList());
    }

    /// <summary>
    /// The PWA's pre-filled sides (§3.2): seats 1–2 against seats 3–4 when both teams are populated
    /// and even, else the booker against the first other candidate.
    /// </summary>
    public static (IReadOnlyList<string> A, IReadOnlyList<string> B) DefaultSides(IReadOnlyList<LineupCandidate> candidates)
    {
        var teamA = candidates.Where(c => c.Seat <= 2).Select(c => c.Key).ToList();
        var teamB = candidates.Where(c => c.Seat >= 3).Select(c => c.Key).ToList();
        if (teamA.Count > 0 && teamA.Count == teamB.Count) return (teamA, teamB);
        if (candidates.Count < 2) return (candidates.Select(c => c.Key).ToList(), []);
        return ([candidates[0].Key], [candidates[1].Key]);
    }
}
