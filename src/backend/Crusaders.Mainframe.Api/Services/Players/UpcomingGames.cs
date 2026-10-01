using System.Text.Json.Serialization;
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
/// seats only, each with its seat <c>status</c>. <c>my_share_minutes</c> is the caller's own share
/// — a partner's seat share, or what the organiser carries after the ACCEPTED partners' shares (an
/// invitation nobody has answered reduces nothing: review round 3, M-3). <c>my_paid_minutes</c> is
/// what the game has cost the caller so far, off their own wallet, net; <c>my_owing_minutes</c> is
/// what a partner still owes on an open seat. <c>needs_action</c> is a partner asked for more than
/// they agreed to, or still owing while the seat is open.
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

    public async Task<List<GameItem>> ForAsync(Guid me, DateTimeOffset now, CancellationToken ct)
    {
        var partnerOn = BookingPlayerQueries.PartnerBookingIds(_db, me);
        var bookings = await _db.Bookings.AsNoTracking()
            .Where(b => b.Status == BookingStatus.Booked && b.EndsAt > now
                        && (b.UserId == me || partnerOn.Contains(b.Id)))
            .OrderBy(b => b.StartsAt).ThenBy(b => b.Id)
            .Take(Cap)
            .ToListAsync(ct);
        return await ItemsAsync(bookings, me, ct);
    }

    /// <summary>
    /// <c>GET /api/v1/me/bookings/recent</c> (review round 2, C3): the caller's games — as
    /// organiser or on an accepted partner seat — that ENDED within the club's result window
    /// (<c>result_record_days</c>, 7), newest first, at most <see cref="Cap"/>, each with its
    /// result's state and whether the caller may record one now. <b>Why:</b> once a game ended it
    /// left "upcoming" and nothing listed it, so "Record a result" and "Confirm" had no way in.
    /// A cancelled or blocked slot is not a game; a no-show still is (it may have been played
    /// and scanned late).
    /// </summary>
    public async Task<List<GameItem>> RecentAsync(Guid me, DateTimeOffset now, TenantSettingsView settings, CancellationToken ct)
    {
        var from = now.AddDays(-PlaySettings.RecordDays(settings));
        var partnerOn = BookingPlayerQueries.PartnerBookingIds(_db, me);
        var bookings = await _db.Bookings.AsNoTracking()
            .Where(b => (b.Status == BookingStatus.Booked || b.Status == BookingStatus.Completed || b.Status == BookingStatus.NoShow)
                        && b.EndsAt <= now && b.EndsAt > from
                        && (b.UserId == me || partnerOn.Contains(b.Id)))
            .OrderByDescending(b => b.StartsAt).ThenBy(b => b.Id)
            .Take(Cap)
            .ToListAsync(ct);
        var items = await ItemsAsync(bookings, me, ct);
        if (items.Count == 0) return items;

        var ids = bookings.Select(b => b.Id).ToList();
        var results = (await _db.MatchResults.AsNoTracking()
                .Where(r => ids.Contains(r.BookingId) && MatchResultStatus.Live.Contains(r.Status))
                .Select(r => new { r.BookingId, r.Status, r.ConfirmDueAt })
                .ToListAsync(ct))
            .ToLookup(r => r.BookingId);
        for (var i = 0; i < bookings.Count; i++)
        {
            var b = bookings[i];
            var live = results[b.Id].FirstOrDefault();
            var status = live is null ? "none"
                : live.Status == MatchResultStatus.Pending && live.ConfirmDueAt <= now ? MatchResultStatus.Confirmed // settled on its next read
                : live.Status;
            var candidates = live is null ? (await Lineup.CandidatesAsync(_db, b, ct)).Count : 0;
            var canRecord = live is null && ResultService.NotRecordableReason(b, candidates, settings, now) is null;
            items[i] = items[i] with { ResultStatus = status, CanRecord = canRecord };
        }
        return items;
    }

    private async Task<List<GameItem>> ItemsAsync(List<Booking> bookings, Guid me, CancellationToken ct)
    {
        if (bookings.Count == 0) return [];

        var ids = bookings.Select(b => b.Id).ToList();
        var seats = (await _db.BookingParticipants.AsNoTracking().Where(p => ids.Contains(p.BookingId)).ToListAsync(ct))
            .ToLookup(p => p.BookingId);
        var courtIds = bookings.Select(b => b.CourtId).Distinct().ToList();
        var courts = await _db.Courts.AsNoTracking().Where(c => courtIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, c => c.Name, ct);
        var people = await _people.MembersAsync(
            seats.SelectMany(g => g.Select(s => s.UserId)).Concat(bookings.Select(b => b.UserId)), ct);
        // The caller's own ledger rows on these games, in one read: what each has cost them.
        var mine = (await _db.LedgerEntries.AsNoTracking()
                .Where(l => l.UserId == me && l.RelatedBookingId != null && ids.Contains(l.RelatedBookingId.Value))
                .Select(l => new { BookingId = l.RelatedBookingId!.Value, l.AmountMinutes })
                .ToListAsync(ct))
            .GroupBy(l => l.BookingId)
            .ToDictionary(g => g.Key, g => g.Sum(l => l.AmountMinutes));

        var context = new ItemContext { Courts = courts, People = people, MyNet = mine };
        var items = new List<GameItem>(bookings.Count);
        foreach (var b in bookings) items.Add(await ItemAsync(b, [.. seats[b.Id]], me, context, ct));
        return items;
    }

    /// <summary>
    /// What every item on one list reads from: court names, people, and the caller's net ledger per
    /// game. A class with init properties rather than a positional record: lizard reads a positional
    /// record's generic parameters as extra parameters and trips the 6-parameter gate.
    /// </summary>
    private sealed class ItemContext
    {
        public required Dictionary<Guid, string> Courts { get; init; }
        public required Dictionary<Guid, PublicMember> People { get; init; }
        public required Dictionary<Guid, int> MyNet { get; init; }
    }

    private async Task<GameItem> ItemAsync(
        Booking b, List<BookingParticipant> seats, Guid me, ItemContext context, CancellationToken ct)
    {
        var organiser = b.UserId == me;
        var mySeat = seats.FirstOrDefault(s => s.UserId == me && s.Seat > 1 && s.Status == ParticipantStatus.Accepted);
        var live = seats.Where(s => s.IsLive).OrderBy(s => s.Seat).ToList();
        var players = live.Count == 0
            ? [Player(b.UserId, null, "accepted", context.People)]
            : live.Select(s => Player(s.UserId, s.GuestName, PlayerViews.StatusName(s.Status), context.People)).ToList();

        // Paid: the caller's own wallet on this game, net — the charge less refunds and shares
        // received for the organiser, the share transfers for a partner. A share settled outside
        // the app moved no credits, so it is counted as paid from both ends (M-3).
        var paid = Math.Max(0, -context.MyNet.GetValueOrDefault(b.Id));
        int myShare;
        var owing = 0;
        var needsAction = false;
        if (organiser)
        {
            var partners = live.Where(s => s.IsPartner).ToList();
            var acceptedShare = partners.Where(s => s.Status == ParticipantStatus.Accepted).Sum(s => s.ShareMinutes);
            myShare = Math.Max(0, b.AmountChargedMinutes - acceptedShare);
            paid = Math.Max(0, paid - partners.Where(s => s.SettledOutsideAt is not null).Sum(s => s.ShareMinutes));
        }
        else
        {
            myShare = mySeat?.ShareMinutes ?? 0;
            owing = mySeat is null ? 0 : await _shares.UnpaidAsync(b, mySeat, ct);
            if (mySeat?.SettledOutsideAt is not null) paid = Math.Max(paid, mySeat.ShareMinutes);
            needsAction = mySeat is not null && (mySeat.ShareMinutes > mySeat.ConsentedMinutes || owing > 0);
        }

        return new GameItem(
            b.Id, context.Courts.GetValueOrDefault(b.CourtId), b.StartsAt, b.EndsAt, organiser ? "organiser" : "partner",
            PlayerViews.BookingStatusName(b.Status), players, myShare, needsAction)
        {
            MyPaidMinutes = paid,
            MyOwingMinutes = owing,
        };
    }

    private static object Player(Guid? userId, string? guestName, string status, Dictionary<Guid, PublicMember> people)
    {
        var member = userId is { } id && people.TryGetValue(id, out var m) ? m : null;
        return new { name = member?.Name ?? guestName, photo_url = member?.PhotoUrl, status };
    }
}

/// <summary>
/// One game on the member's own lists — upcoming (B2) and recent (C3). The two recent-only fields
/// are left off the upcoming list rather than sent as null.
/// </summary>
public sealed record GameItem(
    [property: JsonPropertyName("booking_id")] Guid BookingId,
    [property: JsonPropertyName("court_name")] string? CourtName,
    [property: JsonPropertyName("starts_at")] DateTimeOffset StartsAt,
    [property: JsonPropertyName("ends_at")] DateTimeOffset EndsAt,
    [property: JsonPropertyName("role")] string Role,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("players")] IReadOnlyList<object> Players,
    [property: JsonPropertyName("my_share_minutes")] int MyShareMinutes,
    [property: JsonPropertyName("needs_action")] bool NeedsAction)
{
    /// <summary>What the game has cost the caller so far, off their own wallet, net (review round 3, M-3).</summary>
    [JsonPropertyName("my_paid_minutes")]
    public int MyPaidMinutes { get; init; }

    /// <summary>What a partner still owes on an open seat; 0 for the organiser (review round 3, M-3).</summary>
    [JsonPropertyName("my_owing_minutes")]
    public int MyOwingMinutes { get; init; }

    /// <summary><c>none</c> · <c>pending</c> · <c>confirmed</c> · <c>disputed</c> — the booking's live result. Recent only.</summary>
    [JsonPropertyName("result_status")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ResultStatus { get; init; }

    /// <summary>The caller may record a result on it now (checked in, started, in the window, no live result). Recent only.</summary>
    [JsonPropertyName("can_record")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? CanRecord { get; init; }
}
