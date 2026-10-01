using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>Wire words for the players feature. Lower-case, closed sets the frontend switches on.</summary>
public static class PlayerViews
{
    public static string StatusName(ParticipantStatus status)
    {
        switch (status)
        {
            case ParticipantStatus.Invited: return "invited";
            case ParticipantStatus.Accepted: return "accepted";
            case ParticipantStatus.Declined: return "declined";
            case ParticipantStatus.Withdrawn: return "withdrawn";
            case ParticipantStatus.Removed: return "removed";
            default: return "lapsed";
        }
    }

    public static string BookingStatusName(BookingStatus status)
    {
        switch (status)
        {
            case BookingStatus.Booked: return "booked";
            case BookingStatus.Cancelled: return "cancelled";
            case BookingStatus.NoShow: return "no_show";
            case BookingStatus.Completed: return "completed";
            default: return "blocked";
        }
    }

    public static string KindOf(BookingParticipant p)
    {
        if (p.Seat == 1) return "organiser";
        if (p.GuestName is not null) return "guest";
        return p.UserId is null ? "open_link" : "member";
    }

    /// <summary>Seats 1–2 are team A, 3–4 team B.</summary>
    public static string TeamOf(int seat) => seat <= 2 ? "A" : "B";
}

/// <summary>A member as another member may see them: id, name, photo. Nothing else, ever — the grid's own rule.</summary>
public sealed record PublicMember(Guid UserId, string Name, string? PhotoUrl);

/// <summary>
/// Everything the players feature READS: the booking detail, a member's open invites, their
/// recent partners and favourites, and the club directory (D11–D13).
///
/// <para>
/// <b>Photo and name only, for every other member.</b> The booking grid's invariant — no email,
/// no phone, no membership number visible to other players — holds on every projection here, and
/// the directory adds the opt-in on top: a member is findable by name only once they said so.
/// </para>
/// </summary>
public sealed partial class PlayersQuery
{
    private readonly MainframeDbContext _db;
    private readonly TenantSettingsAccessor _settings;
    private readonly ShareLedger _shares;
    private readonly LedgerService _ledger;
    private readonly BookingRules _rules;

    public PlayersQuery(MainframeDbContext db, TenantSettingsAccessor settings, ShareLedger shares, LedgerService ledger, BookingRules rules)
    {
        _db = db; _settings = settings; _shares = shares; _ledger = ledger; _rules = rules;
    }

    public async Task<Dictionary<Guid, PublicMember>> MembersAsync(IEnumerable<Guid?> ids, CancellationToken ct)
    {
        var wanted = ids.Where(i => i is not null).Select(i => i!.Value).Distinct().ToList();
        if (wanted.Count == 0) return [];
        return await _db.Memberships.AsNoTracking()
            .Where(m => wanted.Contains(m.UserId))
            .Select(m => new PublicMember(m.UserId, m.FullName, m.PhotoUrl))
            .ToDictionaryAsync(m => m.UserId, ct);
    }

    // ------------------------------------------------------------------ booking detail

    /// <summary>
    /// <c>GET /api/v1/bookings/{id}</c>: the booking as its players see it — seats, shares, the
    /// money panel and attendance. Null (a 404) for anybody who is not the organiser, not on a
    /// seat of it, and not an admin: a booking id is not proof of anything.
    /// </summary>
    public async Task<object?> DetailAsync(Guid bookingId, Guid viewer, bool viewerIsAdmin, CancellationToken ct)
    {
        var booking = await _db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        if (booking?.UserId is null || booking.Status == BookingStatus.AdminBlock) return null;

        var seats = await _db.BookingParticipants.AsNoTracking().Where(p => p.BookingId == bookingId).OrderBy(p => p.Seat).ToListAsync(ct);

        // Only a LIVE seat makes the viewer a player. A member who declined, withdrew, lapsed or
        // was taken off is nobody to this booking any more and reads the same 404 as a stranger.
        var mySeat = seats.FirstOrDefault(s => s.UserId == viewer && s.IsLive);
        var role = RoleOf(booking, viewer, mySeat, viewerIsAdmin);
        if (role is null) return null;

        var settings = await _settings.GetAsync(ct);
        var owed = await _shares.OwedAsync(booking, ct);
        var people = await MembersAsync(seats.Select(s => s.UserId).Append(booking.UserId), ct);
        var court = await _db.Courts.AsNoTracking().Where(c => c.Id == booking.CourtId).Select(c => c.Name).FirstOrDefaultAsync(ct);
        var table = await TableAsync(new DetailContext(booking, seats, people, owed, role, mySeat?.Id, settings), ct);
        var (refunded, penalty) = await SettledAsync(booking, ct);

        return new
        {
            booking_id = booking.Id,
            court_id = booking.CourtId,
            court_name = court,
            starts_at = booking.StartsAt,
            ends_at = booking.EndsAt,
            sold_ends_at = BookingService.OriginalEndsAt(booking),
            status = PlayerViews.BookingStatusName(booking.Status),
            split_mode = seats.FirstOrDefault(s => s.Seat == 1)?.SplitMode ?? SplitModes.Equal,
            viewer = new { role, participant_id = mySeat?.Id },
            organiser = Member(booking.UserId, people),
            players = table.Players,
            money = new
            {
                price_minutes = booking.AmountChargedMinutes,
                organiser_owed_minutes = owed,
                shares_received_minutes = table.Received,
                organiser_net_minutes = owed - table.Received,
                unpaid_minutes = table.Unpaid,
                share_deadline = PlayerSettings.ShareDeadline(booking, settings),
                is_split = seats.Any(s => s.IsPartner && s.IsLive && s.ShareMinutes > 0) || table.Received != 0,
                // R5 (M5-3/M5-7, lane D1's ask): what the club gave back and kept, from the payer's
                // own rows — the client derived both and was wrong beside an admin compensation.
                refunded_minutes = refunded,
                penalty_minutes = penalty,
            },
            attendance = new
            {
                checked_in_at = booking.CheckedInAt,
                players_checked_in = seats.Count(s => s.CheckedInAt is not null),
            },
            permissions = Permissions(booking, settings, role, mySeat),

            // The club's zone, top level, so a member who opens this booking cold — a link in a
            // mail, on a phone in another zone — reads its times in the club's day and not the
            // phone's. The client learns it from any response that carries it (lib/clubZone).
            timezone = DoorClock.ZoneOf(settings).Name,
        };
    }

    /// <summary>Who the viewer is to this booking — or null, which is a 404.</summary>
    private static string? RoleOf(Booking booking, Guid viewer, BookingParticipant? mySeat, bool viewerIsAdmin)
    {
        if (booking.UserId == viewer) return "organiser";
        if (mySeat is not null) return "player";
        return viewerIsAdmin ? "admin" : null;
    }

    private sealed record DetailContext(
        Booking Booking, List<BookingParticipant> Seats, Dictionary<Guid, PublicMember> People, int Owed, string Role, Guid? MySeatId,
        TenantSettingsView Settings);

    private sealed record DetailTable(List<object> Players, int Received, int Unpaid);

    /// <summary>
    /// The player table and its two money sums. Dead seats are shown to the organiser and admins
    /// (the history of who said no); a player sees the live table and their own row.
    /// </summary>
    private async Task<DetailTable> TableAsync(DetailContext d, CancellationToken ct)
    {
        var players = new List<object>();
        int received = 0, unpaid = 0;
        foreach (var s in d.Seats)
        {
            var paid = await _shares.PaidAsync(s, ct);
            var open = await OpenAsync(d, s, ct);
            received += s.IsPartner ? paid : 0;
            unpaid += open;
            if (!IsShown(s, d.Role, d.MySeatId)) continue;
            var closed = ShareLedger.IsClosed(d.Booking, s, d.Settings, DateTimeOffset.UtcNow);
            var money = new SeatMoney(paid, ShareLedger.TargetFor(d.Booking, s, d.Owed, paid, closed), open,
                s.IsPartner ? await ShareLedger.ReturnedOfAsync(_db, s, ct, CancelledSince(d.Booking)) : 0);
            players.Add(SeatView(s, d.People, money));
        }
        if (d.Seats.Count == 0) players.Add(ImplicitOrganiser(d.Booking, d.People));
        return new DetailTable(players, received, unpaid);
    }

    /// <summary>
    /// The payer's refund rows for this booking, and the penalties kept (late cancel or no-show,
    /// as a positive figure), in one read. Zero for a booking nothing was settled on.
    /// </summary>
    private async Task<(int Refunded, int Penalty)> SettledAsync(Booking booking, CancellationToken ct)
    {
        var payer = ShareLedger.PayerOf(booking);
        var rows = await _db.LedgerEntries.AsNoTracking()
            .Where(l => l.RelatedBookingId == booking.Id && l.UserId == payer
                        && (l.Type == LedgerEntryType.CancellationRefund || l.Type == LedgerEntryType.LateCancellationPenalty
                            || l.Type == LedgerEntryType.NoShowPenalty))
            .GroupBy(l => l.Type == LedgerEntryType.CancellationRefund)
            .Select(g => new { Refund = g.Key, Sum = g.Sum(l => l.AmountMinutes) })
            .ToListAsync(ct);
        var refunded = rows.Where(r => r.Refund).Sum(r => r.Sum);
        var penalty = -rows.Where(r => !r.Refund).Sum(r => r.Sum);
        return (refunded, penalty);
    }

    /// <summary>
    /// On a cancelled game, <c>returned_minutes</c> is what the CANCELLATION sent back (M4-4), not
    /// every return the seat ever had; elsewhere it stays the running total.
    /// </summary>
    private static DateTimeOffset? CancelledSince(Booking b) =>
        b.Status == BookingStatus.Cancelled ? b.CancelledAt : null;

    /// <summary>
    /// Whether a seat is a row of the viewer's table: every live seat; a dead one (who said no)
    /// to the organiser and admins, never the organiser's own seat, and to a player only their own.
    /// </summary>
    private static bool IsShown(BookingParticipant s, string role, Guid? mySeatId) =>
        s.IsLive || !(s.Seat == 1 || (role == "player" && s.Id != mySeatId));

    /// <summary>
    /// What one live partner seat still owes. An OPEN LINK SEAT (nobody has claimed it yet) owes
    /// its whole share — whoever takes the link will be asked for it — until the seat closes
    /// (review round 1, B4: "Shares not paid yet" read 80 on a booking where 120 was owed, because
    /// the share rule gives an unclaimed seat no target at all).
    /// </summary>
    private async Task<int> OpenAsync(DetailContext d, BookingParticipant s, CancellationToken ct)
    {
        if (!s.IsPartner || !s.IsLive) return 0;
        if (s.UserId is not null) return await _shares.UnpaidAsync(d.Booking, s, ct);
        var closed = ShareLedger.IsClosed(d.Booking, s, d.Settings, DateTimeOffset.UtcNow);
        var live = d.Booking.Status is BookingStatus.Booked or BookingStatus.Completed;
        return closed || !live ? 0 : s.ShareMinutes;
    }

    /// <summary>One seat's money: paid (net of returns), its target, what is still open, and what came back.</summary>
    private sealed record SeatMoney(int Paid, int Target, int Unpaid, int Returned);

    private static object SeatView(BookingParticipant s, Dictionary<Guid, PublicMember> people, SeatMoney money)
    {
        var (paid, target, unpaid) = (money.Paid, money.Target, money.Unpaid);
        var member = s.UserId is { } id && people.TryGetValue(id, out var m) ? m : null;
        return new
        {
            participant_id = s.Id,
            seat = s.Seat,
            team = PlayerViews.TeamOf(s.Seat),
            kind = PlayerViews.KindOf(s),
            user_id = s.UserId,
            name = member?.Name ?? s.GuestName,
            photo_url = member?.PhotoUrl,
            status = PlayerViews.StatusName(s.Status),
            share_minutes = s.ShareMinutes,
            weight = s.ShareWeight,
            consented_minutes = s.ConsentedMinutes,
            paid_minutes = paid,
            target_minutes = target,
            unpaid_minutes = unpaid,
            // F2-4: share minutes that came BACK to this seat — paid_minutes nets them out, so a
            // cancelled game read "paid 0" with no word of the refund.
            returned_minutes = money.Returned,
            needs_consent = s.IsPartner && s.Status == ParticipantStatus.Accepted && s.ShareMinutes > s.ConsentedMinutes,
            settled_outside = s.SettledOutsideAt is not null,
            lapsed = s.LapsedAt is not null || s.Status == ParticipantStatus.Lapsed,
            checked_in_at = s.CheckedInAt,
            invited_at = s.InvitedAt,
            responded_at = s.RespondedAt,
        };
    }

    /// <summary>A booking nobody added players to is "just the booker": one seat, the whole price.</summary>
    private static object ImplicitOrganiser(Booking b, Dictionary<Guid, PublicMember> people)
    {
        var member = people.TryGetValue(b.UserId!.Value, out var m) ? m : null;
        return new
        {
            participant_id = (Guid?)null,
            seat = 1,
            team = "A",
            kind = "organiser",
            user_id = b.UserId,
            name = member?.Name,
            photo_url = member?.PhotoUrl,
            status = "accepted",
            share_minutes = b.AmountChargedMinutes,
            weight = 1,
            consented_minutes = 0,
            paid_minutes = 0,
            target_minutes = 0,
            unpaid_minutes = 0,
            returned_minutes = 0,
            needs_consent = false,
            settled_outside = false,
            lapsed = false,
            checked_in_at = b.CheckedInAt,
            invited_at = b.CreatedAt,
            responded_at = b.CreatedAt,
        };
    }

    private static object Member(Guid? id, Dictionary<Guid, PublicMember> people)
    {
        var m = id is { } v && people.TryGetValue(v, out var found) ? found : null;
        return new { user_id = id, name = m?.Name, photo_url = m?.PhotoUrl };
    }

    private static object Permissions(Booking b, TenantSettingsView settings, string role, BookingParticipant? mine)
    {
        var now = DateTimeOffset.UtcNow;
        var open = b.Status is BookingStatus.Booked or BookingStatus.Completed && now < PlayerSettings.ShareDeadline(b, settings);
        var organiser = role == "organiser" && open && (b.PaidByUserId is null || b.PaidByUserId == b.UserId);
        return new
        {
            can_invite = organiser,
            can_change_split = organiser,
            can_cancel = role == "organiser" && b.Status == BookingStatus.Booked && b.StartsAt > now,
            can_accept = open && mine is { Status: ParticipantStatus.Invited or ParticipantStatus.Accepted, Seat: > 1 }
                         && mine.LapsedAt is null && mine.SettledOutsideAt is null,
            can_decline = mine is { Status: ParticipantStatus.Invited },
            can_withdraw = mine is { Status: ParticipantStatus.Accepted, Seat: > 1 } && b.Status == BookingStatus.Booked
                           && now < b.StartsAt.AddMinutes(-settings.PenaltyWindowMinutes),
            withdraw_closes_at = b.StartsAt.AddMinutes(-settings.PenaltyWindowMinutes),
        };
    }

    // ------------------------------------------------------------------ invites

    /// <summary>
    /// The caller's open invitations — seats addressed to them still waiting for a yes, or accepted
    /// and short of their share — for the Invites tab and its badge. Each carries what the accept
    /// sheet needs: the share, the balance after paying it, and whether it would break their cap.
    /// </summary>
    public async Task<List<object>> InvitesAsync(Guid me, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        var now = DateTimeOffset.UtcNow;
        var rows = await _db.BookingParticipants.AsNoTracking()
            .Where(p => p.UserId == me && p.Seat > 1 && p.LapsedAt == null && p.SettledOutsideAt == null
                        && (p.Status == ParticipantStatus.Invited || p.Status == ParticipantStatus.Accepted))
            .Join(_db.Bookings.Where(b => b.Status == BookingStatus.Booked || b.Status == BookingStatus.Completed),
                p => p.BookingId, b => b.Id, (p, b) => new { Seat = p, Booking = b })
            .ToListAsync(ct);

        var items = new List<object>();
        // The caller's wallet once for the whole list, not once per invite (review (b)).
        var wallet = await WalletAsync(me, ct);
        foreach (var x in rows.Where(x => now < PlayerSettings.ShareDeadline(x.Booking, settings)).OrderBy(x => x.Booking.StartsAt))
        {
            var unpaid = await _shares.UnpaidAsync(x.Booking, x.Seat, ct);
            if (x.Seat.Status == ParticipantStatus.Accepted && unpaid <= 0) continue;
            items.Add(await InviteViewAsync(x.Booking, x.Seat, me, settings, ct, wallet));
        }
        return items;
    }

    /// <summary>One invite as the accept sheet reads it. Also the answer to opening a link.</summary>
    /// <param name="viewer">
    /// Who is looking. An open link seat is priced and cap-checked as if <paramref name="viewer"/>
    /// had claimed it, while still reading <c>open_link: true</c>.
    /// </param>
    /// <param name="wallet">The viewer's balance and hold, when the caller already read them for a list.</param>
    public async Task<object> InviteViewAsync(
        Booking booking, BookingParticipant seat, Guid viewer, TenantSettingsView settings, CancellationToken ct, Wallet? wallet = null)
    {
        var openLink = seat.UserId is null;
        if (openLink) seat = AsClaimedBy(seat, viewer);
        var unpaid = await _shares.UnpaidAsync(booking, seat, ct);
        // The raw balance, and what the accept will check: that less anything this member holds
        // for partners of their own (D11) — both shown, so the sheet can say why.
        var (balance, held) = wallet ?? await WalletAsync(viewer, ct);
        var spendable = balance - held.Reserved;
        var people = await MembersAsync([booking.UserId], ct);
        var court = await _db.Courts.AsNoTracking().Where(c => c.Id == booking.CourtId).Select(c => c.Name).FirstOrDefaultAsync(ct);
        var cap = seat.Status == ParticipantStatus.Invited && seat.UserId is { } me && booking.StartsAt > DateTimeOffset.UtcNow
            ? await _rules.PartnerCapRefusalAsync(me, booking, settings, ct)
            : null;
        var players = await _db.BookingParticipants.AsNoTracking()
            .CountAsync(p => p.BookingId == booking.Id && (p.Status == ParticipantStatus.Invited || p.Status == ParticipantStatus.Accepted), ct);

        return new
        {
            participant_id = seat.Id,
            booking_id = booking.Id,
            status = PlayerViews.StatusName(seat.Status),
            seat = seat.Seat,
            team = PlayerViews.TeamOf(seat.Seat),
            open_link = openLink,
            court_name = court,
            starts_at = booking.StartsAt,
            ends_at = BookingService.OriginalEndsAt(booking),
            organiser = Member(booking.UserId, people),
            players = Math.Max(players, 1),
            share_minutes = seat.ShareMinutes,
            to_pay_minutes = unpaid,
            needs_consent = seat.Status == ParticipantStatus.Accepted && seat.ShareMinutes > seat.ConsentedMinutes,
            balance_minutes = balance,
            spendable_minutes = spendable,
            held_minutes = held.Held,
            owed_back_minutes = held.OwedBack,
            balance_after_minutes = balance - unpaid,
            short_by_minutes = Math.Max(0, unpaid - spendable),
            share_deadline = PlayerSettings.ShareDeadline(booking, settings),
            cap = cap is null ? null : PlayersService.CapFigures(cap),

            // The answer to opening /j/{token} cold, from a mail: carries the club's zone like
            // the booking detail does, so its court time is the club's and not the phone's.
            timezone = DoorClock.ZoneOf(settings).Name,
        };
    }

    /// <summary>A member's raw balance and what of it is held — read once, shown together.</summary>
    public sealed record Wallet(int Balance, HeldMinutes Held);

    private async Task<Wallet> WalletAsync(Guid userId, CancellationToken ct) =>
        new(await _ledger.GetBalanceAsync(userId, ct), await _ledger.GetHeldAsync(userId, ct));

    private static BookingParticipant AsClaimedBy(BookingParticipant seat, Guid viewer)
    {
        return new BookingParticipant
        {
            Id = seat.Id,
            TenantId = seat.TenantId,
            BookingId = seat.BookingId,
            Seat = seat.Seat,
            UserId = viewer,
            Status = seat.Status,
            ShareMinutes = seat.ShareMinutes,
            ConsentedMinutes = seat.ConsentedMinutes,
        };
    }

    // ------------------------------------------------------------------ partners

    /// <summary>
    /// The people the caller actually played with in the last <c>recent_partner_days</c>: members
    /// on an ACCEPTED seat of a booking the caller was also accepted on (or organised), that has
    /// STARTED and that the court box checked in — a game that has not happened yet, or that nobody
    /// turned up to, is not "played with" (review round 1, B11: "Played 2 times · last on Fri 2 Oct",
    /// read on 29 Sep). Derived, never stored — there is nothing to keep in step.
    /// </summary>
    public async Task<List<object>> RecentAsync(Guid me, CancellationToken ct)
    {
        var settings = await _settings.GetAsync(ct);
        var now = DateTimeOffset.UtcNow;
        var since = now.AddDays(-PlayerSettings.RecentPartnerDays(settings));
        var mine = _db.BookingParticipants
            .Where(p => p.UserId == me && p.Status == ParticipantStatus.Accepted)
            .Select(p => p.BookingId);

        var rows = await _db.BookingParticipants.AsNoTracking()
            .Where(p => mine.Contains(p.BookingId) && p.UserId != null && p.UserId != me && p.Status == ParticipantStatus.Accepted)
            .Join(_db.Bookings.Where(b => b.StartsAt >= since && b.StartsAt <= now && b.CheckedInAt != null
                                          && b.Status != BookingStatus.Cancelled && b.Status != BookingStatus.AdminBlock),
                p => p.BookingId, b => b.Id, (p, b) => new { UserId = p.UserId!.Value, b.StartsAt })
            .ToListAsync(ct);

        var grouped = rows.GroupBy(r => r.UserId)
            .Select(g => new { UserId = g.Key, Last = g.Max(r => r.StartsAt), Games = g.Count() })
            .OrderByDescending(g => g.Last).Take(20).ToList();
        var people = await ActiveMembersAsync(grouped.Select(g => g.UserId), ct);
        return grouped.Where(g => people.ContainsKey(g.UserId))
            .Select(g => (object)new { user_id = g.UserId, name = people[g.UserId].Name, photo_url = people[g.UserId].PhotoUrl, last_played_at = g.Last, games = g.Games })
            .ToList();
    }

    public async Task<List<object>> FavouritesAsync(Guid me, CancellationToken ct)
    {
        var ids = await _db.PartnerFavourites.AsNoTracking().Where(f => f.UserId == me)
            .OrderBy(f => f.CreatedAt).Select(f => f.PartnerUserId).ToListAsync(ct);
        var people = await ActiveMembersAsync(ids, ct);
        return ids.Where(people.ContainsKey)
            .Select(id => (object)new { user_id = id, name = people[id].Name, photo_url = people[id].PhotoUrl })
            .ToList();
    }

    /// <summary>Active members only: a suspended or departed member drops out of every picker without anyone deleting anything.</summary>
    public async Task<Dictionary<Guid, PublicMember>> ActiveMembersAsync(IEnumerable<Guid> ids, CancellationToken ct)
    {
        var wanted = ids.Distinct().ToList();
        if (wanted.Count == 0) return [];
        return await _db.Memberships.AsNoTracking()
            .Where(m => wanted.Contains(m.UserId) && m.Status == MembershipStatus.Active
                        && _db.Users.Any(u => u.Id == m.UserId && u.Status == "active"))
            .Select(m => new PublicMember(m.UserId, m.FullName, m.PhotoUrl))
            .ToDictionaryAsync(m => m.UserId, ct);
    }

    // ------------------------------------------------------------------ directory

    /// <summary>Shortest query the directory answers. One letter is a list of the whole club.</summary>
    public const int MinQueryLength = 2;

    public const int MaxResults = 20;

    /// <summary>
    /// D13 — members who opted in to being found, whose name contains <paramref name="q"/>. Active
    /// members only, never the caller, id + name + photo only. Nobody is findable by default.
    /// </summary>
    public async Task<List<PublicMember>> DirectoryAsync(Guid me, string q, CancellationToken ct)
    {
        var pattern = $"%{EscapeLike(q.Trim())}%";
        var query = _db.Memberships.AsNoTracking()
            .Where(m => m.UserId != me && m.Status == MembershipStatus.Active
                        && _db.Users.Any(u => u.Id == m.UserId && u.Status == "active")
                        && _db.UserPreferences.Any(p => p.UserId == m.UserId && p.Findable));

        query = _db.Database.IsNpgsql()
            ? query.Where(m => EF.Functions.ILike(m.FullName, pattern, "\\"))
            : query.Where(m => m.FullName.ToLower().Contains(q.Trim().ToLower()));

        return await query.OrderBy(m => m.FullName).Take(MaxResults)
            .Select(m => new PublicMember(m.UserId, m.FullName, m.PhotoUrl))
            .ToListAsync(ct);
    }

    private static string EscapeLike(string s) => s.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_");
}
