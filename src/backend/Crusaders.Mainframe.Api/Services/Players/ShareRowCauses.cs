using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>
/// One share row, read back: which seat's pair it is, who the partner and the organiser were, which
/// way it went, and why (one of <see cref="WalletShareCauses"/>).
/// </summary>
public sealed record ShareRowWhy(string Cause, Guid PartnerUserId, Guid OrganiserUserId, bool Collection);

/// <summary>
/// R15 E15-3 / J15-4 / E15-10: why a share row moved, read back off the club's RECORD for the Night
/// and the member's CSV — the ledger row itself carries no cause (a deliberate R11 decision: the
/// frame carries it live, and the row stays the money only).
///
/// <para>
/// <b>The act is the newest record at or before the row</b> on that seat (a removal, a withdrawal, a
/// split change, a settle-outside, a collect) or on its booking (a cancellation, a no-show sweep, a
/// displacement, a late check-in's reversal). Every act writes its record before, or in the same save
/// as, the pair it causes (R15 E15-4 moved the last one that did not), so the newest one at the row
/// is the one that moved it — a split change at 10:00 and a cancellation at 11:00 each explain their
/// own return. A row no record explains is <see cref="WalletShareCauses.ShareBack"/> (a return) or
/// <see cref="WalletShareCauses.SharePaid"/> (a payment): never an act guessed at, which is the same
/// rule the live frame keeps (R14 review M1/L1).
/// </para>
/// </summary>
public static class ShareRowCauses
{
    /// <summary>How far a record may trail the row it explains — a collect's record and its pair are built in one save, microseconds apart either way.</summary>
    private static readonly TimeSpan SameSave = TimeSpan.FromSeconds(2);

    private static readonly string[] SeatActs =
    [
        TraceKinds.PlayerRemovedAction, TraceKinds.PartnerWithdrewAction, TraceKinds.SplitChangedAction,
        TraceKinds.SettledOutsideAction, TraceKinds.ShareCollectedAction,
    ];

    private static readonly string[] BookingActs = ["booking.cancelled", "booking.no_show", "booking.displaced", "booking.no_show_reversed"];

    /// <summary>One act on the record, reduced to what the decision needs.</summary>
    private sealed record Act(string Action, DateTimeOffset At, Guid? Seat, Guid? Booking, bool ByClub, bool Dark);

    /// <summary>The why of every share row among <paramref name="rows"/>, by ledger id. Rows that are not shares are absent.</summary>
    public static async Task<Dictionary<Guid, ShareRowWhy>> ForAsync(
        MainframeDbContext db, IReadOnlyCollection<LedgerEntry> rows, CancellationToken ct)
    {
        var shares = rows.Where(r => r.Type == LedgerEntryType.ShareTransfer && SeatOf(r.ExternalReference) is not null).ToList();
        if (shares.Count == 0) return [];

        var seatIds = shares.Select(r => SeatOf(r.ExternalReference)!.Value).Distinct().ToList();
        var seats = await db.BookingParticipants.AsNoTracking().Where(p => seatIds.Contains(p.Id))
            .Select(p => new { p.Id, p.UserId, p.BookingId }).ToDictionaryAsync(p => p.Id, ct);
        var bookingIds = seats.Values.Select(s => s.BookingId).Distinct().ToList();
        var bookings = await db.Bookings.AsNoTracking().Where(b => bookingIds.Contains(b.Id))
            .Select(b => new { b.Id, b.UserId, b.PaidByUserId, b.NoShowReversedAt })
            .ToDictionaryAsync(b => b.Id, ct);
        var people = seats.Values.Select(s => s.UserId).Concat(bookings.Values.Select(b => b.UserId)).Where(u => u is not null).Select(u => u!.Value).Distinct().ToList();
        var acts = await ActsAsync(db, people, seatIds, bookingIds, shares.Max(r => r.CreatedAt) + SameSave, ct);

        var result = new Dictionary<Guid, ShareRowWhy>();
        foreach (var row in shares)
        {
            if (!seats.TryGetValue(SeatOf(row.ExternalReference)!.Value, out var seat) || seat.UserId is not { } partner
                || !bookings.TryGetValue(seat.BookingId, out var booking))
            {
                continue;
            }
            var organiser = booking.PaidByUserId ?? booking.UserId ?? Guid.Empty;
            var collection = row.UserId == partner ? row.AmountMinutes < 0 : row.AmountMinutes > 0;
            // A seat act explains its own seat's rows only — Alex's removal never explains Sam's return.
            var mine = acts.Where(a => (a.Seat is { } s ? s == seat.Id : a.Booking == seat.BookingId) && a.At <= row.CreatedAt + SameSave).ToList();
            var cause = collection ? CollectionCause(mine, row, booking.NoShowReversedAt) : ReturnCause(mine, row);
            result[row.Id] = new ShareRowWhy(cause, partner, organiser, collection);
        }
        return result;
    }

    /// <summary>A payment: the club's collect (its record, in the pair's own save), a re-collection after a late check-in, else the partner's own.</summary>
    private static string CollectionCause(List<Act> acts, LedgerEntry row, DateTimeOffset? reversedAt)
    {
        if (acts.Any(a => a.Action == TraceKinds.ShareCollectedAction && (a.At - row.CreatedAt).Duration() <= SameSave))
        {
            return WalletShareCauses.ClubCollected;
        }
        return reversedAt is { } at && row.CreatedAt >= at ? WalletShareCauses.Attended : WalletShareCauses.SharePaid;
    }

    /// <summary>A return: the newest act at the row that sends a share back; nothing on the record says share_back.</summary>
    private static string ReturnCause(List<Act> acts, LedgerEntry row)
    {
        var act = acts.Where(a => a.Action is not (TraceKinds.ShareCollectedAction or "booking.no_show_reversed") && a.At <= row.CreatedAt + SameSave)
            .MaxBy(a => a.At);
        return act?.Action switch
        {
            TraceKinds.PlayerRemovedAction => act.ByClub ? WalletShareCauses.ClubRemoved : WalletShareCauses.OrganiserRemoved,
            TraceKinds.PartnerWithdrewAction => WalletShareCauses.ShareReturned,
            TraceKinds.SplitChangedAction => WalletShareCauses.SplitChanged,
            TraceKinds.SettledOutsideAction => WalletShareCauses.ClubSettled,
            "booking.cancelled" => WalletShareCauses.BookingCancelled,
            "booking.no_show" => act.Dark ? WalletShareCauses.OutageRefund : WalletShareCauses.NoShow,
            "booking.displaced" => WalletShareCauses.Displaced,
            _ => WalletShareCauses.ShareBack,
        };
    }

    /// <summary>
    /// The acts on these seats and bookings up to <paramref name="until"/>: seat acts name the partner
    /// as subject, booking acts the booker — so one read by subject and action, narrowed in memory.
    /// </summary>
    private static async Task<List<Act>> ActsAsync(
        MainframeDbContext db, List<Guid> people, List<Guid> seatIds, List<Guid> bookingIds, DateTimeOffset until, CancellationToken ct)
    {
        var actions = SeatActs.Concat(BookingActs).ToList();
        var rows = await db.AuditLogs.AsNoTracking()
            .Where(a => a.SubjectUserId != null && people.Contains(a.SubjectUserId!.Value) && actions.Contains(a.Action) && a.CreatedAt <= until)
            .Select(a => new { a.Action, a.CreatedAt, a.DetailsJson })
            .ToListAsync(ct);
        var acts = new List<Act>(rows.Count);
        foreach (var r in rows)
        {
            if (Parse(r.Action, r.CreatedAt, r.DetailsJson) is not { } act) continue;
            if ((act.Seat is { } s && seatIds.Contains(s)) || (act.Seat is null && act.Booking is { } b && bookingIds.Contains(b))) acts.Add(act);
        }
        return acts;
    }

    private static Act? Parse(string action, DateTimeOffset at, string? json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return null;
        var seat = Array.IndexOf(SeatActs, action) >= 0 ? GuidOf(root, "participant_id") : null;
        return new Act(action, at, seat, GuidOf(root, "booking_id"), True(root, "by_club"), True(root, "peripheral_outage"));
    }

    private static Guid? GuidOf(JsonElement root, string key)
    {
        return root.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String && v.TryGetGuid(out var id) ? id : null;
    }

    private static bool True(JsonElement root, string key)
    {
        return root.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.True;
    }

    /// <summary>The seat a share reference names (<c>share:{participant:N}:{seq}:out|in</c>), or null.</summary>
    public static Guid? SeatOf(string? reference)
    {
        const string prefix = "share:";
        if (reference is null || !reference.StartsWith(prefix, StringComparison.Ordinal) || reference.Length < prefix.Length + 32) return null;
        return Guid.TryParseExact(reference.AsSpan(prefix.Length, 32), "N", out var id) ? id : null;
    }
}
