using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// <c>GET /api/v1/me/bookings/upcoming</c> (review round 1, B2): every game still ahead of the
/// caller — as organiser, or on an ACCEPTED partner seat — soonest first, at most
/// <see cref="Cap"/>. A partner had no way back to a game they had joined: the grid marked only
/// the organiser's own cells as theirs, and nothing listed what they had said yes to.
///
/// <para>
/// A game in progress is still "upcoming" (its end is ahead) — the member at the door is looking
/// for exactly that one. Players are shown as the grid shows anybody: name and photo only, live
/// seats only. <c>my_share_credits</c> is the caller's own share (the organiser's is what they
/// carry after the partners' shares); <c>needs_action</c> is a partner asked for more than they
/// agreed to, or still owing while the seat is open.
/// </para>
/// </summary>
public sealed class UpcomingGames
{
    public const int Cap = 50;

    private readonly MainframeDbContext _db;
    private readonly ShareLedger _shares;
    private readonly PlayersQuery _people;

    public UpcomingGames(MainframeDbContext db, ShareLedger shares, PlayersQuery people)
    {
        _db = db; _shares = shares; _people = people;
    }

    public async Task<List<object>> ForAsync(Guid me, DateTimeOffset now, CancellationToken ct)
    {
        var partnerOn = BookingPlayerQueries.PartnerBookingIds(_db, me);
        var bookings = await _db.Bookings.AsNoTracking()
            .Where(b => b.Status == BookingStatus.Booked && b.EndsAt > now
                        && (b.UserId == me || partnerOn.Contains(b.Id)))
            .OrderBy(b => b.StartsAt).ThenBy(b => b.Id)
            .Take(Cap)
            .ToListAsync(ct);
        if (bookings.Count == 0) return [];

        var ids = bookings.Select(b => b.Id).ToList();
        var seats = (await _db.BookingParticipants.AsNoTracking().Where(p => ids.Contains(p.BookingId)).ToListAsync(ct))
            .ToLookup(p => p.BookingId);
        var courtIds = bookings.Select(b => b.CourtId).Distinct().ToList();
        var courts = await _db.Courts.AsNoTracking().Where(c => courtIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, c => c.Name, ct);
        var people = await _people.MembersAsync(
            seats.SelectMany(g => g.Select(s => s.UserId)).Concat(bookings.Select(b => b.UserId)), ct);

        var items = new List<object>(bookings.Count);
        foreach (var b in bookings) items.Add(await ItemAsync(b, [.. seats[b.Id]], me, courts, people, ct));
        return items;
    }

    private async Task<object> ItemAsync(
        Booking b, List<BookingParticipant> seats, Guid me, Dictionary<Guid, string> courts,
        Dictionary<Guid, PublicMember> people, CancellationToken ct)
    {
        var organiser = b.UserId == me;
        var mySeat = seats.FirstOrDefault(s => s.UserId == me && s.Seat > 1 && s.Status == ParticipantStatus.Accepted);
        var live = seats.Where(s => s.IsLive).OrderBy(s => s.Seat).ToList();
        var players = live.Count == 0
            ? [Player(b.UserId, null, "accepted", people)]
            : live.Select(s => Player(s.UserId, s.GuestName, PlayerViews.StatusName(s.Status), people)).ToList();

        decimal myShare;
        var needsAction = false;
        if (organiser)
        {
            var partnersShare = live.Where(s => s.IsPartner).Sum(s => s.ShareCredits);
            myShare = Math.Max(0m, b.AmountChargedCredits - partnersShare);
        }
        else
        {
            myShare = mySeat?.ShareCredits ?? 0m;
            needsAction = mySeat is not null
                && (mySeat.ShareCredits > mySeat.ConsentedCredits || await _shares.UnpaidAsync(b, mySeat, ct) > 0m);
        }

        return new
        {
            booking_id = b.Id,
            court_name = courts.GetValueOrDefault(b.CourtId),
            starts_at = b.StartsAt,
            ends_at = b.EndsAt,
            role = organiser ? "organiser" : "partner",
            status = PlayerViews.BookingStatusName(b.Status),
            players,
            my_share_credits = myShare,
            needs_action = needsAction,
        };
    }

    private static object Player(Guid? userId, string? guestName, string status, Dictionary<Guid, PublicMember> people)
    {
        var member = userId is { } id && people.TryGetValue(id, out var m) ? m : null;
        return new { name = member?.Name ?? guestName, photo_url = member?.PhotoUrl, status };
    }
}
