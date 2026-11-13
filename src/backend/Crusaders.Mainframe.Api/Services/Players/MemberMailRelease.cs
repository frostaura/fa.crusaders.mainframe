using System.Text.Json;
using Crusaders.Mainframe.Api.Domain;
using Crusaders.Mainframe.Api.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crusaders.Mainframe.Api.Services;

/// <summary>What the outbox does with one member mail at the moment it would leave (C8).</summary>
/// <param name="PayloadJson">The facts to send, re-derived from current state. Null when dropped.</param>
/// <param name="DropReason">Why the mail is no longer true, when it is not. Null when it goes.</param>
public sealed record ReleaseVerdict(string? PayloadJson, string? DropReason)
{
    public static ReleaseVerdict Send(string payloadJson) => new(payloadJson, null);

    public static ReleaseVerdict Drop(string reason) => new(null, reason);

    public bool Dropped => DropReason is not null;
}

/// <summary>Everything one release judgement reads: the row, its club's settings, the instant, and the row's scope.</summary>
public sealed record ReleaseContext(
    IServiceProvider Services, MainframeDbContext Db, AdminNotification Row, TenantSettingsView Settings, DateTimeOffset Now);

/// <summary>
/// Re-derives a member mail from CURRENT state when it leaves the outbox (review round 2, C8).
///
/// <para>
/// <b>Why at the send and not at the staging.</b> A mail staged in quiet hours waits until 07:00,
/// and by then the game it describes may be cancelled, the invite answered, the result withdrawn
/// or the share changed twice. The frozen payload said what was true at 23:00; the member read it
/// at 07:05 and acted on it — a confirm link for a withdrawn 3–0, an invite to a cancelled game,
/// "your share is now 16.00" beside "now 0.00". So every non-urgent member mail is judged again
/// here, whatever held it (quiet hours or a backoff):
/// </para>
/// <list type="bullet">
/// <item><b>Dropped</b> when what it asks or announces is no longer so — the invite is not open,
/// the game is off, the seat is gone, the result is not pending, the share is paid, the return
/// has posted.</item>
/// <item><b>Re-rendered</b> otherwise, with the figures as they are now (court, start, share,
/// score, deadline).</item>
/// <item><b>Coalesced</b> per (member, booking, kind) for the kinds that can repeat — only the
/// latest pending one goes; the earlier are superseded.</item>
/// </list>
///
/// <para>
/// <b>Receipts are never re-derived</b> (<see cref="MemberEventCatalogue.IsUrgent"/>): a share that
/// moved and a game that was cancelled are facts about the past, sent at once, and a later change
/// does not unmake them. <b>A lapse and a waiting return are told once per seat</b> by
/// construction and name one partner each, so they are never coalesced — an organiser with two
/// partners' returns waiting must hear about both.
/// </para>
/// </summary>
public static class MemberMailRelease
{
    public const string Superseded = "superseded";
    public const string InviteClosed = "invite_closed";
    public const string GameOff = "game_off";
    public const string SeatGone = "seat_gone";
    public const string SharePaid = "share_paid";
    public const string BackOnGame = "back_on_game";
    public const string ReturnPosted = "return_posted";
    public const string ResultNotPending = "result_not_pending";
    public const string NotAsked = "not_asked";
    public const string ShortfallSplit = "shortfall_split";

    /// <summary>The kinds whose later mail about the same booking replaces an earlier one still waiting.</summary>
    private static readonly HashSet<string> Coalesced = new(StringComparer.Ordinal)
    {
        MemberEventCatalogue.Invited, MemberEventCatalogue.ClubSeat, MemberEventCatalogue.Reminder,
        MemberEventCatalogue.GameChanged, MemberEventCatalogue.ResultToConfirm,
    };

    public static async Task<ReleaseVerdict> JudgeAsync(ReleaseContext c, CancellationToken ct)
    {
        var row = c.Row;
        if (MemberEventCatalogue.IsUrgent(row.Kind)) return ReleaseVerdict.Send(row.PayloadJson);
        if (await SupersededAsync(c, ct)) return ReleaseVerdict.Drop(Superseded);

        switch (row.Kind)
        {
            case MemberEventCatalogue.Invited:
                return await InviteAsync(c, ct);
            case MemberEventCatalogue.ClubSeat:
                return await ClubSeatAsync(c, ct);
            case MemberEventCatalogue.Reminder:
                return await ReminderAsync(c, ct);
            case MemberEventCatalogue.GameChanged:
                return await ChangedAsync(c, ct);
            case MemberEventCatalogue.ReturnWaiting:
                return await ReturnWaitingAsync(c, ct);
            case MemberEventCatalogue.ResultToConfirm:
                return await ResultToConfirmAsync(c, ct);
            case MemberEventCatalogue.Shortfall:
                return await ShortfallAsync(c, ct);
            default:
                return ReleaseVerdict.Send(row.PayloadJson);
        }
    }

    /// <summary>The booking a member payload is about — every member payload names one.</summary>
    public static Guid? BookingIdOf(string payloadJson)
    {
        try
        {
            using var doc = JsonDocument.Parse(payloadJson);
            return doc.RootElement.ValueKind == JsonValueKind.Object
                   && doc.RootElement.TryGetProperty("booking_id", out var id)
                   && id.ValueKind == JsonValueKind.String
                   && id.TryGetGuid(out var guid)
                ? guid
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// A LATER mail of the same kind to the same member about the same booking is waiting or has
    /// gone: this one is superseded and only that one speaks. Claims run oldest first, so the
    /// earlier normally arrives here first and steps aside; a later one already SENT (this one
    /// was backing off) counts too, or the retry would repeat what the later mail replaced. A
    /// later one that was itself dropped does not — this row's own judgement decides.
    /// </summary>
    private static async Task<bool> SupersededAsync(ReleaseContext c, CancellationToken ct)
    {
        var row = c.Row;
        if (!Coalesced.Contains(row.Kind) || BookingIdOf(row.PayloadJson) is not { } bookingId) return false;
        var later = await c.Db.AdminNotifications.IgnoreQueryFilters().AsNoTracking()
            .Where(n => n.TenantId == row.TenantId && n.Audience == NotificationAudience.Member
                        && n.RecipientUserId == row.RecipientUserId && n.Kind == row.Kind
                        && (n.State == AdminNotificationState.Pending || n.State == AdminNotificationState.Sent)
                        && n.Id != row.Id && n.CreatedAt > row.CreatedAt)
            .Select(n => n.PayloadJson)
            .ToListAsync(ct);
        return later.Any(p => BookingIdOf(p) == bookingId);
    }

    private static async Task<ReleaseVerdict> InviteAsync(ReleaseContext c, CancellationToken ct)
    {
        var p = Read<InvitePayload>(c.Row);
        var (booking, seat) = await GameAndSeatAsync(c, p.BookingId, p.SeatId ?? SeatInPath(p.Path), ct);
        if (booking is null || seat is null) return ReleaseVerdict.Drop(SeatGone);
        if (!GameOn(booking)) return ReleaseVerdict.Drop(GameOff);
        if (!InviteOpen(booking, seat, c)) return ReleaseVerdict.Drop(InviteClosed);

        var game = await GameText.ForAsync(c.Db, booking, c.Settings, ct);
        return Send(p with { CourtName = game.CourtName, StartsAtLocal = game.StartsLocal, ShareMinutes = seat.ShareMinutes, SeatId = seat.Id });
    }

    private static async Task<ReleaseVerdict> ClubSeatAsync(ReleaseContext c, CancellationToken ct)
    {
        var p = Read<ClubSeatPayload>(c.Row);
        var (booking, seat) = await GameAndSeatAsync(c, p.BookingId, p.SeatId ?? SeatInPath(p.Path), ct);
        if (booking is null || seat is null || !seat.IsLive) return ReleaseVerdict.Drop(SeatGone);
        if (!GameOn(booking)) return ReleaseVerdict.Drop(GameOff);

        var game = await GameText.ForAsync(c.Db, booking, c.Settings, ct);
        var accepted = seat.Status == ParticipantStatus.Accepted;
        return Send(p with
        {
            CourtName = game.CourtName,
            StartsAtLocal = game.StartsLocal,
            ShareMinutes = seat.ShareMinutes,
            Accepted = accepted,
            Path = accepted ? $"/bookings/{booking.Id}" : PlayerNotices.InvitePath(seat.Id),
            SeatId = seat.Id,
        });
    }

    /// <summary>A reminder asks for an answer or a payment: gone once the seat is answered, off, closed or paid.</summary>
    private static async Task<ReleaseVerdict> ReminderAsync(ReleaseContext c, CancellationToken ct)
    {
        var p = Read<ReminderPayload>(c.Row);
        var (booking, seat) = await GameAndSeatAsync(c, p.BookingId, p.SeatId ?? SeatInPath(p.Path), ct);
        if (booking is null || seat is null || !seat.IsLive) return ReleaseVerdict.Drop(SeatGone);
        if (!GameOn(booking)) return ReleaseVerdict.Drop(GameOff);
        if (seat.LapsedAt is not null || c.Now >= PlayerSettings.ShareDeadline(booking, c.Settings)) return ReleaseVerdict.Drop(InviteClosed);
        if (seat.Status == ParticipantStatus.Accepted
            && await c.Services.GetRequiredService<ShareLedger>().UnpaidAsync(booking, seat, ct) <= 0)
        {
            return ReleaseVerdict.Drop(SharePaid);
        }

        var game = await GameText.ForAsync(c.Db, booking, c.Settings, ct);
        return Send(p with
        {
            CourtName = game.CourtName,
            StartsAtLocal = game.StartsLocal,
            ShareMinutes = seat.ShareMinutes,
            DeadlineLocal = GameText.Local(PlayerSettings.ShareDeadline(booking, c.Settings), c.Settings),
            SeatId = seat.Id,
        });
    }

    /// <summary>
    /// A removal stands unless the member is back on the game; a share change goes with the share
    /// as it is now, or not at all when the seat or the game is gone.
    /// </summary>
    private static async Task<ReleaseVerdict> ChangedAsync(ReleaseContext c, CancellationToken ct)
    {
        var p = Read<GameChangedPayload>(c.Row);
        if (p.Removed)
        {
            var back = await c.Db.BookingParticipants.AsNoTracking().AnyAsync(s =>
                s.BookingId == p.BookingId && s.UserId == c.Row.RecipientUserId
                && (s.Status == ParticipantStatus.Invited || s.Status == ParticipantStatus.Accepted), ct);
            return back ? ReleaseVerdict.Drop(BackOnGame) : ReleaseVerdict.Send(c.Row.PayloadJson);
        }

        var (booking, seat) = await GameAndSeatAsync(c, p.BookingId, p.SeatId, ct);
        if (booking is null || seat is null || !seat.IsLive) return ReleaseVerdict.Drop(SeatGone);
        if (!GameOn(booking)) return ReleaseVerdict.Drop(GameOff);

        var game = await GameText.ForAsync(c.Db, booking, c.Settings, ct);
        return Send(p with
        {
            CourtName = game.CourtName,
            StartsAtLocal = game.StartsLocal,
            NewShareMinutes = seat.ShareMinutes,
            NeedsConsent = PlayerNotices.NeedsConsent(booking, seat),
            SeatId = seat.Id,
            SettledOutside = seat.SettledOutsideAt is not null,
        });
    }

    /// <summary>"Your money is waiting" is dropped once it is not: the return posted, or is no longer due.</summary>
    /// <summary>
    /// "Part of a share is left to cover" only while it still is: once the organiser has split it (any
    /// re-split clears every seat's shortfall), or the seat or the game is gone, the mail says nothing new.
    /// </summary>
    private static async Task<ReleaseVerdict> ShortfallAsync(ReleaseContext c, CancellationToken ct)
    {
        var p = Read<ShortfallPayload>(c.Row);
        var (booking, seat) = await GameAndSeatAsync(c, p.BookingId, p.SeatId, ct);
        if (booking is null || seat is null || !seat.IsLive) return ReleaseVerdict.Drop(SeatGone);
        if (!GameOn(booking)) return ReleaseVerdict.Drop(GameOff);
        return seat.ShortfallMinutes > 0 ? ReleaseVerdict.Send(c.Row.PayloadJson) : ReleaseVerdict.Drop(ShortfallSplit);
    }

    private static async Task<ReleaseVerdict> ReturnWaitingAsync(ReleaseContext c, CancellationToken ct)
    {
        var p = Read<ReturnWaitingPayload>(c.Row);
        if (p.SeatId is not { } seatId) return ReleaseVerdict.Send(c.Row.PayloadJson);
        var waiting = await c.Db.BookingParticipants.AsNoTracking()
            .AnyAsync(s => s.Id == seatId && s.ReturnPendingSince != null, ct);
        return waiting ? ReleaseVerdict.Send(c.Row.PayloadJson) : ReleaseVerdict.Drop(ReturnPosted);
    }

    /// <summary>
    /// "Is this result right?" only while a result on the booking is pending and the reader is on
    /// its confirming side — and with THAT result's score, which may not be the one first recorded.
    /// </summary>
    private static async Task<ReleaseVerdict> ResultToConfirmAsync(ReleaseContext c, CancellationToken ct)
    {
        var p = Read<ResultToConfirmPayload>(c.Row);
        var result = await c.Db.MatchResults.AsNoTracking().Include(r => r.Players)
            .FirstOrDefaultAsync(r => r.BookingId == p.BookingId && r.Status == MatchResultStatus.Pending, ct);
        if (result is null || (result.ConfirmDueAt is { } due && c.Now >= due)) return ReleaseVerdict.Drop(ResultNotPending);
        var asked = PlayNotices.MembersOf(result, MatchSide.Other(PlayNotices.SubmittingSide(result)));
        if (c.Row.RecipientUserId is not { } reader || !asked.Contains(reader)) return ReleaseVerdict.Drop(NotAsked);

        var booking = await c.Db.Bookings.AsNoTracking().FirstAsync(b => b.Id == result.BookingId, ct);
        var court = await c.Db.Courts.AsNoTracking().Where(x => x.Id == booking.CourtId).Select(x => x.Name).FirstOrDefaultAsync(ct);
        var people = result.Players.Where(x => x.UserId != null).Select(x => x.UserId!.Value).Append(result.SubmittedByUserId);
        var context = new ResultContext(booking, court ?? "the court", c.Settings, await PlayNotices.NamesAsync(c.Db, people, ct));
        return Send(PlayNotices.ToConfirmPayload(result, context));
    }

    private static async Task<(Booking? Booking, BookingParticipant? Seat)> GameAndSeatAsync(
        ReleaseContext c, Guid bookingId, Guid? seatId, CancellationToken ct)
    {
        var booking = await c.Db.Bookings.AsNoTracking().FirstOrDefaultAsync(b => b.Id == bookingId, ct);
        if (booking is null) return (null, null);
        var seats = c.Db.BookingParticipants.AsNoTracking().Where(s => s.BookingId == bookingId);
        // An older row names no seat: the reader's most recent seat on the booking stands in.
        var seat = seatId is { } id
            ? await seats.FirstOrDefaultAsync(s => s.Id == id, ct)
            : await seats.Where(s => s.UserId == c.Row.RecipientUserId).OrderByDescending(s => s.CreatedAt).FirstOrDefaultAsync(ct);
        return (booking, seat);
    }

    /// <summary>The game is still on: booked, or played. Cancelled, blocked or a no-show game asks nobody anything.</summary>
    private static bool GameOn(Booking booking) => booking.Status is BookingStatus.Booked or BookingStatus.Completed;

    private static bool InviteOpen(Booking booking, BookingParticipant seat, ReleaseContext c) =>
        seat.Status == ParticipantStatus.Invited && seat.LapsedAt is null && c.Now < PlayerSettings.ShareDeadline(booking, c.Settings);

    /// <summary>The seat id in an <c>/invites/{id}</c> path — the seat an older invite row names.</summary>
    private static Guid? SeatInPath(string path)
    {
        const string prefix = "/invites/";
        return path.StartsWith(prefix, StringComparison.Ordinal) && Guid.TryParse(path[prefix.Length..], out var id) ? id : null;
    }

    private static T Read<T>(AdminNotification row) => JsonSerializer.Deserialize<T>(row.PayloadJson, AdminEventCatalogue.Json)
        ?? throw new InvalidOperationException($"member notice {row.Id} ({row.Kind}) carries no payload");

    private static ReleaseVerdict Send<T>(T payload) where T : notnull =>
        ReleaseVerdict.Send(JsonSerializer.Serialize(payload, AdminEventCatalogue.Json));
}
